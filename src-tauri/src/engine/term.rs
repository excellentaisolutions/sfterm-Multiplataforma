//! Term: el interprete VT del motor propio. Implementa vte::Perform sobre el
//! Grid. Mantiene modos, charsets, tab stops, respuestas (DSR/DA/OSC) y el
//! modelo semantico de bloques (OSC 133/633/7).

use super::blocks::Blocks;
use super::grid::{
    Attrs, Cell, Color, Grid, BLINK, BOLD, DIM, HIDDEN, INVERSE, ITALIC, STRIKE, UNDERLINE, WIDE,
    WIDE_CONT,
};
use unicode_width::UnicodeWidthChar;
use vte::{Params, Perform};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MouseMode {
    None,
    X10,   // 1000: press/release
    Drag,  // 1002: + motion con boton
    Any,   // 1003: todo movimiento
}

#[derive(Clone, Copy, Debug)]
pub struct ModeState {
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub cursor_visible: bool,
    pub cursor_blink: bool,
    pub cursor_shape: u8, // 0 block, 1 underline, 2 bar
    pub bracketed_paste: bool,
    pub mouse: MouseMode,
    pub mouse_sgr: bool,
    pub focus_events: bool,
    pub alt_scroll: bool,
    pub insert: bool,
    pub origin: bool,
    pub autowrap: bool,
    pub reverse_video: bool,
    pub synchronized: bool,
}

impl Default for ModeState {
    fn default() -> Self {
        ModeState {
            app_cursor: false,
            app_keypad: false,
            cursor_visible: true,
            cursor_blink: true,
            cursor_shape: 0,
            bracketed_paste: false,
            mouse: MouseMode::None,
            mouse_sgr: false,
            focus_events: false,
            alt_scroll: true,
            insert: false,
            origin: false,
            autowrap: true,
            reverse_video: false,
            synchronized: false,
        }
    }
}

#[derive(Clone, Debug)]
pub enum TermEvent {
    Title(String),
    Bell,
    Cwd(String),
    Clipboard(String),
}

/// Colores del tema activo (para responder OSC 10/11/4 y que los CLIs
/// detecten light/dark correctamente).
#[derive(Clone, Debug)]
pub struct ThemeColors {
    pub fg: (u8, u8, u8),
    pub bg: (u8, u8, u8),
    pub ansi: [(u8, u8, u8); 16],
}

impl Default for ThemeColors {
    fn default() -> Self {
        ThemeColors {
            fg: (0xd7, 0xd9, 0xde),
            bg: (0x11, 0x13, 0x18),
            ansi: [(0, 0, 0); 16],
        }
    }
}

pub struct Term {
    pub grid: Grid,
    pub attrs: Attrs,
    pub modes: ModeState,
    /// designaciones G0/G1 ('B' ascii | '0' DEC line drawing) + set activo
    charsets: [char; 2],
    charset_active: usize,
    tabs: Vec<bool>,
    last_printed: Option<char>,
    pub title: String,
    pub cwd: String,
    pub theme: ThemeColors,
    /// overrides de paleta 256 via OSC 4
    palette: Vec<Option<(u8, u8, u8)>>,
    pub blocks: Blocks,
    pub responses: Vec<u8>,
    pub events: Vec<TermEvent>,
    /// instante en que se activo synchronized output (escape de seguridad)
    pub sync_since: Option<std::time::Instant>,
    /// contador de vida: engine::feed lo bumpea con cada tanda de bytes del
    /// PTY. El nervio (engine/nervio.rs) lo usa para detectar silencio.
    pub activity: u64,
}

fn default_tabs(cols: usize) -> Vec<bool> {
    (0..cols).map(|i| i % 8 == 0 && i != 0).collect()
}

impl Term {
    pub fn new(cols: usize, rows: usize, scrollback: usize) -> Self {
        Term {
            grid: Grid::new(cols, rows, scrollback),
            attrs: Attrs::default(),
            modes: ModeState::default(),
            charsets: ['B', 'B'],
            charset_active: 0,
            tabs: default_tabs(cols),
            last_printed: None,
            title: String::new(),
            cwd: String::new(),
            theme: ThemeColors::default(),
            palette: vec![None; 256],
            blocks: Blocks::new(),
            responses: Vec::new(),
            events: Vec::new(),
            sync_since: None,
            activity: 0,
        }
    }

    fn template(&self) -> Cell {
        Cell {
            ch: ' ',
            attrs: Attrs { fg: Color::Default, bg: self.attrs.bg, flags: 0 },
        }
    }

    fn respond(&mut self, s: &str) {
        self.responses.extend_from_slice(s.as_bytes());
    }

    // ---------- impresion ----------

    fn translate(&self, c: char) -> char {
        if self.charsets[self.charset_active] != '0' {
            return c;
        }
        // DEC Special Graphics (line drawing)
        match c {
            '`' => '◆', 'a' => '▒', 'f' => '°', 'g' => '±',
            'j' => '┘', 'k' => '┐', 'l' => '┌', 'm' => '└',
            'n' => '┼', 'o' => '⎺', 'p' => '⎻', 'q' => '─',
            'r' => '⎼', 's' => '⎽', 't' => '├', 'u' => '┤',
            'v' => '┴', 'w' => '┬', 'x' => '│', 'y' => '≤',
            'z' => '≥', '{' => 'π', '|' => '≠', '}' => '£',
            '~' => '·', '_' => ' ',
            _ => c,
        }
    }

    /// limpia la otra mitad de un par wide si vamos a pisarlo
    fn clean_wide(&mut self, x: usize, y: usize) {
        let cols = self.grid.cols;
        let screen = self.grid.screen_mut();
        let row = &mut screen.lines[y];
        if x < cols && row.cells[x].attrs.flags & WIDE_CONT != 0 && x > 0 {
            row.cells[x - 1].ch = ' ';
            row.cells[x - 1].attrs.flags &= !WIDE;
        }
        if x < cols && row.cells[x].attrs.flags & WIDE != 0 && x + 1 < cols {
            row.cells[x + 1].ch = ' ';
            row.cells[x + 1].attrs.flags &= !WIDE_CONT;
        }
    }

    fn put_char(&mut self, raw: char) {
        let c = self.translate(raw);
        let width = UnicodeWidthChar::width(c).unwrap_or(0);
        if width == 0 {
            return; // combining marks: v1 los omite (documentado)
        }
        let template = self.template();
        let cols = self.grid.cols;

        if self.grid.screen().cursor.pending_wrap && self.modes.autowrap {
            let y = self.grid.screen().cursor.y;
            self.grid.screen_mut().lines[y].wrapped = true;
            self.grid.screen_mut().cursor.x = 0;
            self.grid.linefeed(template);
        }
        self.grid.screen_mut().cursor.pending_wrap = false;

        // wide char al borde: wrap anticipado
        if width == 2 && self.grid.screen().cursor.x + 1 >= cols {
            if self.modes.autowrap {
                let y = self.grid.screen().cursor.y;
                self.grid.screen_mut().lines[y].wrapped = true;
                self.grid.screen_mut().cursor.x = 0;
                self.grid.linefeed(template);
            } else {
                self.grid.screen_mut().cursor.x = cols.saturating_sub(2);
            }
        }

        let x = self.grid.screen().cursor.x;
        let y = self.grid.screen().cursor.y;

        if self.modes.insert {
            let screen = self.grid.screen_mut();
            let row = &mut screen.lines[y];
            for _ in 0..width {
                row.cells.pop();
                row.cells.insert(x, template);
            }
        }

        self.clean_wide(x, y);
        if width == 2 {
            self.clean_wide(x + 1, y);
        }

        let attrs = self.attrs;
        {
            let screen = self.grid.screen_mut();
            let row = &mut screen.lines[y];
            row.cells[x] = Cell {
                ch: c,
                attrs: Attrs {
                    flags: attrs.flags | if width == 2 { WIDE } else { 0 },
                    ..attrs
                },
            };
            if width == 2 && x + 1 < cols {
                row.cells[x + 1] = Cell {
                    ch: ' ',
                    attrs: Attrs { flags: attrs.flags | WIDE_CONT, ..attrs },
                };
            }
        }
        self.grid.mark_dirty(y);
        self.last_printed = Some(raw);

        let new_x = x + width;
        if new_x >= cols {
            self.grid.screen_mut().cursor.x = cols - 1;
            self.grid.screen_mut().cursor.pending_wrap = true;
        } else {
            self.grid.screen_mut().cursor.x = new_x;
        }
    }

    // ---------- movimiento ----------

    fn clamp_cursor(&mut self) {
        let (cols, rows) = (self.grid.cols, self.grid.rows);
        let c = &mut self.grid.screen_mut().cursor;
        c.x = c.x.min(cols - 1);
        c.y = c.y.min(rows - 1);
        c.pending_wrap = false;
    }

    fn move_to(&mut self, x: i64, y: i64) {
        let (top, bot) = if self.modes.origin {
            (self.grid.scroll_top as i64, self.grid.scroll_bottom as i64)
        } else {
            (0, self.grid.rows as i64 - 1)
        };
        let yy = (top + y.max(0)).min(bot).max(0) as usize;
        let xx = x.max(0).min(self.grid.cols as i64 - 1) as usize;
        let c = &mut self.grid.screen_mut().cursor;
        c.x = xx;
        c.y = yy;
        c.pending_wrap = false;
    }

    fn tab_forward(&mut self, n: usize) {
        let cols = self.grid.cols;
        let mut x = self.grid.screen().cursor.x;
        for _ in 0..n {
            x += 1;
            while x < cols - 1 && !self.tabs.get(x).copied().unwrap_or(false) {
                x += 1;
            }
            if x >= cols - 1 {
                x = cols - 1;
                break;
            }
        }
        self.grid.screen_mut().cursor.x = x;
        self.grid.screen_mut().cursor.pending_wrap = false;
    }

    fn tab_back(&mut self, n: usize) {
        let mut x = self.grid.screen().cursor.x;
        for _ in 0..n {
            if x == 0 {
                break;
            }
            x -= 1;
            while x > 0 && !self.tabs.get(x).copied().unwrap_or(false) {
                x -= 1;
            }
        }
        self.grid.screen_mut().cursor.x = x;
        self.grid.screen_mut().cursor.pending_wrap = false;
    }

    // ---------- borrado ----------

    fn erase_display(&mut self, mode: u16) {
        let template = self.template();
        let rows = self.grid.rows;
        let (cx, cy) = {
            let c = self.grid.screen().cursor;
            (c.x, c.y)
        };
        match mode {
            0 => {
                self.erase_line_range(cy, cx, self.grid.cols);
                for y in (cy + 1)..rows {
                    self.blank_row(y, template);
                }
            }
            1 => {
                for y in 0..cy {
                    self.blank_row(y, template);
                }
                self.erase_line_range(cy, 0, cx + 1);
            }
            2 => {
                for y in 0..rows {
                    self.blank_row(y, template);
                }
                // clear: los separadores de bloques de esta pantalla ya no
                // corresponden a nada visible
                if !self.grid.alt_active {
                    let base = self.grid.abs_base;
                    self.blocks.erase_from(base);
                }
            }
            3 => {
                self.grid.scrollback.clear();
                self.grid.viewport_offset = 0;
                self.grid.mark_all_dirty();
            }
            _ => {}
        }
    }

    fn blank_row(&mut self, y: usize, template: Cell) {
        let cols = self.grid.cols;
        let screen = self.grid.screen_mut();
        if let Some(row) = screen.lines.get_mut(y) {
            row.cells = vec![template; cols];
            row.wrapped = false;
        }
        self.grid.mark_dirty(y);
    }

    fn erase_line_range(&mut self, y: usize, from: usize, to: usize) {
        let template = self.template();
        let cols = self.grid.cols;
        let screen = self.grid.screen_mut();
        if let Some(row) = screen.lines.get_mut(y) {
            for x in from..to.min(cols) {
                row.cells[x] = template;
            }
        }
        self.grid.mark_dirty(y);
    }

    // ---------- SGR ----------

    fn sgr(&mut self, items: &[Vec<u16>]) {
        if items.is_empty() {
            self.attrs = Attrs::default();
            return;
        }
        let mut i = 0;
        while i < items.len() {
            let item = &items[i];
            let code = *item.first().unwrap_or(&0);
            match code {
                0 => self.attrs = Attrs::default(),
                1 => self.attrs.flags |= BOLD,
                2 => self.attrs.flags |= DIM,
                3 => self.attrs.flags |= ITALIC,
                4 => self.attrs.flags |= UNDERLINE,
                5 | 6 => self.attrs.flags |= BLINK,
                7 => self.attrs.flags |= INVERSE,
                8 => self.attrs.flags |= HIDDEN,
                9 => self.attrs.flags |= STRIKE,
                21 => self.attrs.flags |= UNDERLINE,
                22 => self.attrs.flags &= !(BOLD | DIM),
                23 => self.attrs.flags &= !ITALIC,
                24 => self.attrs.flags &= !UNDERLINE,
                25 => self.attrs.flags &= !BLINK,
                27 => self.attrs.flags &= !INVERSE,
                28 => self.attrs.flags &= !HIDDEN,
                29 => self.attrs.flags &= !STRIKE,
                30..=37 => self.attrs.fg = Color::Indexed(code as u8 - 30),
                38 | 48 | 58 => {
                    // forma colon: [38,5,n] o [38,2,r,g,b] en un solo item;
                    // forma semicolon: [38] [5] [n] en items consecutivos
                    let (color, consumed) = if item.len() >= 2 {
                        (Self::parse_ext_color(&item[1..]), 0)
                    } else {
                        let rest: Vec<u16> = items[i + 1..]
                            .iter()
                            .map(|v| *v.first().unwrap_or(&0))
                            .collect();
                        let (c, n) = match Self::parse_ext_color_counted(&rest) {
                            Some((c, n)) => (Some(c), n),
                            None => (None, 0),
                        };
                        (c, n)
                    };
                    if let Some(c) = color {
                        match code {
                            38 => self.attrs.fg = c,
                            48 => self.attrs.bg = c,
                            _ => {} // 58: underline color, sin soporte v1
                        }
                    }
                    i += consumed;
                }
                39 => self.attrs.fg = Color::Default,
                40..=47 => self.attrs.bg = Color::Indexed(code as u8 - 40),
                49 => self.attrs.bg = Color::Default,
                90..=97 => self.attrs.fg = Color::Indexed(code as u8 - 90 + 8),
                100..=107 => self.attrs.bg = Color::Indexed(code as u8 - 100 + 8),
                _ => {}
            }
            i += 1;
        }
    }

    fn parse_ext_color(sub: &[u16]) -> Option<Color> {
        match sub.first()? {
            5 => Some(Color::Indexed(*sub.get(1)? as u8)),
            2 => {
                // colon puede traer colorspace: 2:cs:r:g:b — toma los ultimos 3
                if sub.len() >= 4 {
                    let (r, g, b) = (
                        sub[sub.len() - 3] as u8,
                        sub[sub.len() - 2] as u8,
                        sub[sub.len() - 1] as u8,
                    );
                    Some(Color::Rgb(r, g, b))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn parse_ext_color_counted(rest: &[u16]) -> Option<(Color, usize)> {
        match rest.first()? {
            5 => Some((Color::Indexed(*rest.get(1)? as u8), 2)),
            2 => Some((
                Color::Rgb(*rest.get(1)? as u8, *rest.get(2)? as u8, *rest.get(3)? as u8),
                4,
            )),
            _ => None,
        }
    }

    // ---------- modos ----------

    fn set_mode(&mut self, private: bool, code: u16, on: bool) {
        if !private {
            match code {
                4 => self.modes.insert = on,
                _ => {}
            }
            return;
        }
        match code {
            1 => self.modes.app_cursor = on,
            3 => {
                // DECCOLM: no cambiamos de ancho, pero el side effect es clear + home
                self.erase_display(2);
                self.move_to(0, 0);
            }
            5 => {
                if self.modes.reverse_video != on {
                    self.modes.reverse_video = on;
                    self.grid.mark_all_dirty();
                }
            }
            6 => {
                self.modes.origin = on;
                self.move_to(0, 0);
            }
            7 => self.modes.autowrap = on,
            12 => self.modes.cursor_blink = on,
            25 => self.modes.cursor_visible = on,
            47 => self.switch_alt(on, false, false),
            1000 => self.modes.mouse = if on { MouseMode::X10 } else { MouseMode::None },
            1002 => self.modes.mouse = if on { MouseMode::Drag } else { MouseMode::None },
            1003 => self.modes.mouse = if on { MouseMode::Any } else { MouseMode::None },
            1004 => self.modes.focus_events = on,
            1005 => {} // utf8 mouse: sin soporte (SGR lo reemplaza)
            1006 => self.modes.mouse_sgr = on,
            1007 => self.modes.alt_scroll = on,
            1047 => self.switch_alt(on, true, false),
            1048 => {
                if on {
                    self.save_cursor();
                } else {
                    self.restore_cursor();
                }
            }
            1049 => self.switch_alt(on, true, true),
            2004 => self.modes.bracketed_paste = on,
            2026 => {
                self.modes.synchronized = on;
                self.sync_since = on.then(std::time::Instant::now);
            }
            _ => {}
        }
    }

    fn switch_alt(&mut self, to_alt: bool, clear: bool, save_cursor: bool) {
        if to_alt == self.grid.alt_active {
            return;
        }
        if to_alt {
            if save_cursor {
                self.save_cursor();
            }
            self.grid.alt_active = true;
            if clear {
                let template = self.template();
                let cols = self.grid.cols;
                for row in self.grid.alt.lines.iter_mut() {
                    *row = super::grid::Row::blank(cols, template);
                }
            }
            self.grid.alt.cursor = Default::default();
        } else {
            self.grid.alt_active = false;
            if save_cursor {
                self.restore_cursor();
            }
        }
        self.grid.scroll_top = 0;
        self.grid.scroll_bottom = self.grid.rows - 1;
        self.grid.viewport_offset = 0;
        self.grid.mark_all_dirty();
    }

    fn save_cursor(&mut self) {
        let c = self.grid.screen().cursor;
        let a = self.attrs;
        let screen = self.grid.screen_mut();
        screen.saved_cursor = c;
        screen.saved_attrs = a;
    }

    fn restore_cursor(&mut self) {
        let (c, a) = {
            let screen = self.grid.screen();
            (screen.saved_cursor, screen.saved_attrs)
        };
        self.grid.screen_mut().cursor = c;
        self.attrs = a;
        self.clamp_cursor();
    }

    fn full_reset(&mut self) {
        let cols = self.grid.cols;
        let rows = self.grid.rows;
        let sb = self.grid.scrollback_max;
        let abs = self.grid.abs_base;
        let scrollback = std::mem::take(&mut self.grid.scrollback);
        self.grid = Grid::new(cols, rows, sb);
        self.grid.scrollback = scrollback; // RIS conserva historia
        self.grid.abs_base = abs;
        self.attrs = Attrs::default();
        self.modes = ModeState::default();
        self.charsets = ['B', 'B'];
        self.charset_active = 0;
        self.tabs = default_tabs(cols);
        self.grid.mark_all_dirty();
    }

    // ---------- respuestas de color ----------

    fn color_response(idx: u16, (r, g, b): (u8, u8, u8)) -> String {
        format!(
            "\x1b]4;{};rgb:{:02x}{:02x}/{:02x}{:02x}/{:02x}{:02x}\x07",
            idx, r, r, g, g, b, b
        )
    }

    pub fn palette_color(&self, idx: u8) -> (u8, u8, u8) {
        if let Some(o) = self.palette[idx as usize] {
            return o;
        }
        if (idx as usize) < 16 {
            return self.theme.ansi[idx as usize];
        }
        xterm_256(idx)
    }
}

/// paleta xterm estandar para indices 16-255
pub fn xterm_256(idx: u8) -> (u8, u8, u8) {
    let i = idx as u16;
    if i < 16 {
        // fallback si no hay tema
        let base = [
            (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
            (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
            (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
            (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
        ];
        return base[i as usize];
    }
    if i < 232 {
        let n = i - 16;
        let steps = [0u8, 95, 135, 175, 215, 255];
        let r = steps[(n / 36) as usize];
        let g = steps[((n % 36) / 6) as usize];
        let b = steps[(n % 6) as usize];
        return (r, g, b);
    }
    let v = (8 + (i - 232) * 10) as u8;
    (v, v, v)
}

fn params_to_vec(params: &Params) -> Vec<Vec<u16>> {
    params.iter().map(|sub| sub.to_vec()).collect()
}

fn first(items: &[Vec<u16>], i: usize, default: u16) -> u16 {
    let v = items
        .get(i)
        .and_then(|s| s.first())
        .copied()
        .unwrap_or(default);
    if v == 0 && default != 0 { default } else { v }
}

fn b64_decode(s: &[u8]) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u8;
    for &c in s {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = T.iter().position(|&t| t == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

impl Perform for Term {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        let template = self.template();
        match byte {
            0x07 => self.events.push(TermEvent::Bell),
            0x08 => {
                let c = &mut self.grid.screen_mut().cursor;
                c.x = c.x.saturating_sub(1);
                c.pending_wrap = false;
            }
            0x09 => self.tab_forward(1),
            0x0a | 0x0b | 0x0c => self.grid.linefeed(template),
            0x0d => {
                let c = &mut self.grid.screen_mut().cursor;
                c.x = 0;
                c.pending_wrap = false;
            }
            0x0e => self.charset_active = 1,
            0x0f => self.charset_active = 0,
            _ => {}
        }
    }

    fn hook(&mut self, _p: &Params, _i: &[u8], _ignore: bool, _action: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell: bool) {
        let code: u16 = params
            .first()
            .and_then(|p| std::str::from_utf8(p).ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(u16::MAX);
        let join = |from: usize| -> String {
            params[from.min(params.len())..]
                .iter()
                .map(|p| String::from_utf8_lossy(p).to_string())
                .collect::<Vec<_>>()
                .join(";")
        };
        match code {
            0 | 2 => {
                let t = join(1);
                if t != self.title {
                    self.title = t.clone();
                    self.events.push(TermEvent::Title(t));
                }
            }
            4 => {
                // pares index;spec — spec "?" = query
                let mut i = 1;
                while i + 1 < params.len() {
                    let idx: u16 = std::str::from_utf8(params[i])
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    let spec = String::from_utf8_lossy(params[i + 1]).to_string();
                    if spec == "?" {
                        if idx < 256 {
                            let c = self.palette_color(idx as u8);
                            let r = Self::color_response(idx, c);
                            self.respond(&r);
                        }
                    } else if idx < 256 {
                        if let Some(rgb) = parse_color_spec(&spec) {
                            self.palette[idx as usize] = Some(rgb);
                            self.grid.mark_all_dirty();
                        }
                    }
                    i += 2;
                }
            }
            104 => {
                if params.len() <= 1 {
                    self.palette = vec![None; 256];
                } else {
                    for p in &params[1..] {
                        if let Ok(i) = String::from_utf8_lossy(p).parse::<usize>() {
                            if i < 256 {
                                self.palette[i] = None;
                            }
                        }
                    }
                }
                self.grid.mark_all_dirty();
            }
            7 => {
                let uri = join(1);
                // file://host/path
                let path = uri
                    .strip_prefix("file://")
                    .map(|rest| {
                        let slash = rest.find('/').unwrap_or(0);
                        percent_decode(&rest[slash..])
                    })
                    .unwrap_or(uri);
                if path != self.cwd {
                    self.cwd = path.clone();
                    self.events.push(TermEvent::Cwd(path));
                }
            }
            10 | 11 => {
                let q = join(1);
                if q == "?" {
                    let (r, g, b) = if code == 10 { self.theme.fg } else { self.theme.bg };
                    let resp = format!(
                        "\x1b]{};rgb:{:02x}{:02x}/{:02x}{:02x}/{:02x}{:02x}\x07",
                        code, r, r, g, g, b, b
                    );
                    self.respond(&resp);
                }
            }
            52 => {
                // 52;c;<base64> — copy al clipboard del sistema (lo hace la UI)
                if params.len() >= 3 && params[2] != b"?" {
                    if let Some(data) = b64_decode(params[2]) {
                        let text = String::from_utf8_lossy(&data).to_string();
                        if !text.is_empty() {
                            self.events.push(TermEvent::Clipboard(text));
                        }
                    }
                }
            }
            133 => {
                let action = params.get(1).map(|p| p.first().copied().unwrap_or(0));
                let abs = self.grid.cursor_abs();
                match action {
                    Some(b'A') => self.blocks.on_prompt(abs),
                    Some(b'B') => {}
                    Some(b'C') => {
                        let cwd = self.cwd.clone();
                        self.blocks.on_exec(abs, cwd);
                    }
                    Some(b'D') => {
                        let exit: Option<i32> = params
                            .get(2)
                            .and_then(|p| std::str::from_utf8(p).ok())
                            .and_then(|s| s.parse().ok());
                        self.blocks.on_finished(exit, abs);
                    }
                    _ => {}
                }
            }
            633 => {
                if params.get(1).map(|p| p == b"E").unwrap_or(false) {
                    let cmd = join(2);
                    self.blocks.on_cmd(cmd);
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        let items = params_to_vec(params);
        let private = intermediates.first() == Some(&b'?');
        let n = first(&items, 0, 1) as usize;
        let template = self.template();
        match (action, private) {
            ('@', _) => {
                // ICH: inserta n blanks en el cursor
                let (x, y) = {
                    let c = self.grid.screen().cursor;
                    (c.x, c.y)
                };
                let cols = self.grid.cols;
                let screen = self.grid.screen_mut();
                let row = &mut screen.lines[y];
                for _ in 0..n.min(cols - x) {
                    row.cells.pop();
                    row.cells.insert(x, template);
                }
                self.grid.mark_dirty(y);
            }
            ('A', _) => {
                let c = &mut self.grid.screen_mut().cursor;
                c.y = c.y.saturating_sub(n);
                c.pending_wrap = false;
                let top = self.grid.scroll_top;
                let c = &mut self.grid.screen_mut().cursor;
                if self.modes.origin && c.y < top {
                    c.y = top;
                }
            }
            ('B', _) => {
                let bot = if self.modes.origin { self.grid.scroll_bottom } else { self.grid.rows - 1 };
                let c = &mut self.grid.screen_mut().cursor;
                c.y = (c.y + n).min(bot);
                c.pending_wrap = false;
            }
            ('C', _) => {
                let cols = self.grid.cols;
                let c = &mut self.grid.screen_mut().cursor;
                c.x = (c.x + n).min(cols - 1);
                c.pending_wrap = false;
            }
            ('D', _) => {
                let c = &mut self.grid.screen_mut().cursor;
                c.x = c.x.saturating_sub(n);
                c.pending_wrap = false;
            }
            ('E', _) => {
                for _ in 0..n {
                    self.grid.linefeed(template);
                }
                self.grid.screen_mut().cursor.x = 0;
            }
            ('F', _) => {
                for _ in 0..n {
                    self.grid.reverse_index(template);
                }
                self.grid.screen_mut().cursor.x = 0;
            }
            ('G', _) | ('`', _) => {
                let y = self.grid.screen().cursor.y as i64;
                self.move_to(first(&items, 0, 1) as i64 - 1, y - if self.modes.origin { self.grid.scroll_top as i64 } else { 0 });
            }
            ('H', _) | ('f', _) => {
                let row = first(&items, 0, 1) as i64 - 1;
                let col = first(&items, 1, 1) as i64 - 1;
                self.move_to(col, row);
            }
            ('I', _) => self.tab_forward(n),
            ('J', _) => self.erase_display(first(&items, 0, 0).min(3)),
            ('K', _) => {
                let (x, y) = {
                    let c = self.grid.screen().cursor;
                    (c.x, c.y)
                };
                match first(&items, 0, 0) {
                    0 => self.erase_line_range(y, x, self.grid.cols),
                    1 => self.erase_line_range(y, 0, x + 1),
                    2 => self.erase_line_range(y, 0, self.grid.cols),
                    _ => {}
                }
            }
            ('L', _) => {
                // IL: insertar lineas en el cursor (dentro de la region)
                let y = self.grid.screen().cursor.y;
                if y >= self.grid.scroll_top && y <= self.grid.scroll_bottom {
                    let saved_top = self.grid.scroll_top;
                    self.grid.scroll_top = y;
                    self.grid.scroll_down(n, template);
                    self.grid.scroll_top = saved_top;
                }
            }
            ('M', _) => {
                let y = self.grid.screen().cursor.y;
                if y >= self.grid.scroll_top && y <= self.grid.scroll_bottom {
                    let saved_top = self.grid.scroll_top;
                    self.grid.scroll_top = y;
                    self.grid.scroll_up(n, template);
                    self.grid.scroll_top = saved_top;
                }
            }
            ('P', _) => {
                // DCH: borra n chars, jala el resto
                let (x, y) = {
                    let c = self.grid.screen().cursor;
                    (c.x, c.y)
                };
                let cols = self.grid.cols;
                let screen = self.grid.screen_mut();
                let row = &mut screen.lines[y];
                for _ in 0..n.min(cols - x) {
                    row.cells.remove(x);
                    row.cells.push(template);
                }
                self.grid.mark_dirty(y);
            }
            ('S', _) => self.grid.scroll_up(n, template),
            ('T', _) => self.grid.scroll_down(n, template),
            ('X', _) => {
                let (x, y) = {
                    let c = self.grid.screen().cursor;
                    (c.x, c.y)
                };
                self.erase_line_range(y, x, x + n);
            }
            ('Z', _) => self.tab_back(n),
            ('b', _) => {
                if let Some(c) = self.last_printed {
                    for _ in 0..n {
                        self.put_char(c);
                    }
                }
            }
            ('d', _) => {
                let x = self.grid.screen().cursor.x as i64;
                self.move_to(x, first(&items, 0, 1) as i64 - 1);
            }
            ('e', _) => {
                let bot = self.grid.rows - 1;
                let c = &mut self.grid.screen_mut().cursor;
                c.y = (c.y + n).min(bot);
            }
            ('g', _) => match first(&items, 0, 0) {
                0 => {
                    let x = self.grid.screen().cursor.x;
                    if let Some(t) = self.tabs.get_mut(x) {
                        *t = false;
                    }
                }
                3 => self.tabs.iter_mut().for_each(|t| *t = false),
                _ => {}
            },
            ('h', p) => {
                for it in &items {
                    if let Some(&code) = it.first() {
                        self.set_mode(p, code, true);
                    }
                }
            }
            ('l', p) => {
                for it in &items {
                    if let Some(&code) = it.first() {
                        self.set_mode(p, code, false);
                    }
                }
            }
            ('m', false) => self.sgr(&items),
            ('m', true) => {}
            ('n', _) => match first(&items, 0, 0) {
                5 => self.respond("\x1b[0n"),
                6 => {
                    let c = self.grid.screen().cursor;
                    let y = if self.modes.origin { c.y - self.grid.scroll_top } else { c.y };
                    let resp = format!("\x1b[{};{}R", y + 1, c.x + 1);
                    self.respond(&resp);
                }
                _ => {}
            },
            ('c', _) => {
                if intermediates.first() == Some(&b'>') {
                    self.respond("\x1b[>1;10;0c");
                } else {
                    self.respond("\x1b[?62;22c");
                }
            }
            ('q', _) => {
                if intermediates.first() == Some(&b' ') {
                    // DECSCUSR
                    let v = first(&items, 0, 0);
                    self.modes.cursor_shape = match v {
                        3 | 4 => 1,
                        5 | 6 => 2,
                        _ => 0,
                    };
                    self.modes.cursor_blink = matches!(v, 0 | 1 | 3 | 5);
                }
            }
            ('r', false) => {
                let top = (first(&items, 0, 1) as usize).saturating_sub(1);
                let bot = (first(&items, 1, self.grid.rows as u16) as usize)
                    .saturating_sub(1)
                    .min(self.grid.rows - 1);
                if top < bot {
                    self.grid.scroll_top = top;
                    self.grid.scroll_bottom = bot;
                    self.move_to(0, 0);
                }
            }
            ('s', false) => self.save_cursor(),
            ('u', false) => self.restore_cursor(),
            ('t', _) => {
                // window ops: solo reporte de tamaño en chars (18)
                if first(&items, 0, 0) == 18 {
                    let resp = format!("\x1b[8;{};{}t", self.grid.rows, self.grid.cols);
                    self.respond(&resp);
                }
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        let template = self.template();
        match (intermediates.first(), byte) {
            (None, b'7') => self.save_cursor(),
            (None, b'8') => self.restore_cursor(),
            (None, b'D') => self.grid.linefeed(template),
            (None, b'E') => {
                self.grid.linefeed(template);
                self.grid.screen_mut().cursor.x = 0;
            }
            (None, b'H') => {
                let x = self.grid.screen().cursor.x;
                if let Some(t) = self.tabs.get_mut(x) {
                    *t = true;
                }
            }
            (None, b'M') => self.grid.reverse_index(template),
            (None, b'Z') => self.respond("\x1b[?62;22c"),
            (None, b'c') => self.full_reset(),
            (None, b'=') => self.modes.app_keypad = true,
            (None, b'>') => self.modes.app_keypad = false,
            (Some(b'#'), b'8') => {
                // DECALN
                let cols = self.grid.cols;
                let rows = self.grid.rows;
                let cell = Cell { ch: 'E', attrs: Attrs::default() };
                for y in 0..rows {
                    let screen = self.grid.screen_mut();
                    screen.lines[y] = super::grid::Row::blank(cols, cell);
                }
                self.grid.scroll_top = 0;
                self.grid.scroll_bottom = rows - 1;
                self.grid.screen_mut().cursor = Default::default();
                self.grid.mark_all_dirty();
            }
            (Some(b'('), b) => self.charsets[0] = b as char,
            (Some(b')'), b) => self.charsets[1] = b as char,
            _ => {}
        }
    }
}

fn parse_color_spec(spec: &str) -> Option<(u8, u8, u8)> {
    if let Some(hex) = spec.strip_prefix('#') {
        if hex.len() == 6 {
            return Some((
                u8::from_str_radix(&hex[0..2], 16).ok()?,
                u8::from_str_radix(&hex[2..4], 16).ok()?,
                u8::from_str_radix(&hex[4..6], 16).ok()?,
            ));
        }
    }
    if let Some(rgb) = spec.strip_prefix("rgb:") {
        let parts: Vec<&str> = rgb.split('/').collect();
        if parts.len() == 3 {
            let comp = |s: &str| -> Option<u8> {
                let v = u16::from_str_radix(s, 16).ok()?;
                Some(match s.len() {
                    1 => (v * 17) as u8,
                    2 => v as u8,
                    _ => (v >> (4 * (s.len() as u32 - 2))) as u8,
                })
            };
            return Some((comp(parts[0])?, comp(parts[1])?, comp(parts[2])?));
        }
    }
    None
}
