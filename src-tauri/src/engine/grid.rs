//! Grid: el modelo de pantalla del motor propio. Celdas + scrollback +
//! cursor + region de scroll. Puro y testeable (sin tauri, sin PTY).

use std::collections::VecDeque;

pub const BOLD: u16 = 1;
pub const DIM: u16 = 2;
pub const ITALIC: u16 = 4;
pub const UNDERLINE: u16 = 8;
pub const INVERSE: u16 = 16;
pub const STRIKE: u16 = 32;
pub const HIDDEN: u16 = 64;
pub const WIDE: u16 = 128;
pub const WIDE_CONT: u16 = 256;
pub const BLINK: u16 = 512;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Color {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Attrs {
    pub fg: Color,
    pub bg: Color,
    pub flags: u16,
}

impl Default for Attrs {
    fn default() -> Self {
        Attrs {
            fg: Color::Default,
            bg: Color::Default,
            flags: 0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Cell {
    pub ch: char,
    pub attrs: Attrs,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            attrs: Attrs::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Row {
    pub cells: Vec<Cell>,
    /// true si esta linea continua en la siguiente (soft-wrap). Para copy y
    /// (futuro) reflow.
    pub wrapped: bool,
}

impl Row {
    pub fn blank(cols: usize, template: Cell) -> Self {
        Row {
            cells: vec![template; cols],
            wrapped: false,
        }
    }

    pub fn text(&self) -> String {
        self.text_raw().trim_end().to_string()
    }

    /// Sin trim: en una fila soft-wrapped los espacios finales son contenido
    /// real (el wrap corta en la columna exacta) y el join los necesita.
    pub fn text_raw(&self) -> String {
        self.cells
            .iter()
            .filter(|c| c.attrs.flags & WIDE_CONT == 0)
            .map(|c| c.ch)
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Cursor {
    pub x: usize,
    pub y: usize,
    pub pending_wrap: bool,
}

/// Una pantalla (primaria o alterna). La primaria tiene scrollback.
pub struct Screen {
    pub lines: Vec<Row>,
    pub cursor: Cursor,
    pub saved_cursor: Cursor,
    pub saved_attrs: Attrs,
}

pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    pub primary: Screen,
    pub alt: Screen,
    pub alt_active: bool,
    pub scrollback: VecDeque<Row>,
    pub scrollback_max: usize,
    /// Lineas que alguna vez salieron por arriba de la pantalla activa
    /// (incluyendo las ya recortadas). Fila absoluta de la linea y = abs_base + y.
    pub abs_base: u64,
    /// region de scroll [top, bottom] inclusive (0-based)
    pub scroll_top: usize,
    pub scroll_bottom: usize,
    /// damage por fila visible + bandera global
    pub dirty: Vec<bool>,
    pub all_dirty: bool,
    /// viewport: 0 = live; k = subido k lineas hacia el scrollback
    pub viewport_offset: usize,
}

impl Grid {
    pub fn new(cols: usize, rows: usize, scrollback_max: usize) -> Self {
        let blank = Cell::default();
        Grid {
            cols,
            rows,
            primary: Screen {
                lines: (0..rows).map(|_| Row::blank(cols, blank)).collect(),
                cursor: Cursor::default(),
                saved_cursor: Cursor::default(),
                saved_attrs: Attrs::default(),
            },
            alt: Screen {
                lines: (0..rows).map(|_| Row::blank(cols, blank)).collect(),
                cursor: Cursor::default(),
                saved_cursor: Cursor::default(),
                saved_attrs: Attrs::default(),
            },
            alt_active: false,
            scrollback: VecDeque::new(),
            scrollback_max,
            abs_base: 0,
            scroll_top: 0,
            scroll_bottom: rows.saturating_sub(1),
            dirty: vec![true; rows],
            all_dirty: true,
            viewport_offset: 0,
        }
    }

    pub fn screen(&self) -> &Screen {
        if self.alt_active {
            &self.alt
        } else {
            &self.primary
        }
    }

    pub fn screen_mut(&mut self) -> &mut Screen {
        if self.alt_active {
            &mut self.alt
        } else {
            &mut self.primary
        }
    }

    pub fn cursor(&self) -> Cursor {
        self.screen().cursor
    }

    pub fn mark_dirty(&mut self, y: usize) {
        if y < self.dirty.len() {
            self.dirty[y] = true;
        }
    }

    pub fn mark_all_dirty(&mut self) {
        self.all_dirty = true;
        for d in self.dirty.iter_mut() {
            *d = true;
        }
    }

    pub fn take_dirty(&mut self) -> (bool, Vec<usize>) {
        let all = self.all_dirty;
        let rows: Vec<usize> = if all {
            (0..self.rows).collect()
        } else {
            self.dirty
                .iter()
                .enumerate()
                .filter(|(_, d)| **d)
                .map(|(i, _)| i)
                .collect()
        };
        self.all_dirty = false;
        for d in self.dirty.iter_mut() {
            *d = false;
        }
        (all, rows)
    }

    pub fn has_dirty(&self) -> bool {
        self.all_dirty || self.dirty.iter().any(|d| *d)
    }

    // ---------- scroll ----------

    /// Sube n lineas dentro de la region. En pantalla primaria con region
    /// completa, lo que sale por arriba va al scrollback.
    pub fn scroll_up(&mut self, n: usize, template: Cell) {
        let (top, bot) = (self.scroll_top, self.scroll_bottom);
        let full = top == 0 && bot == self.rows - 1;
        let n = n.min(bot - top + 1);
        for _ in 0..n {
            let line = {
                let screen = self.screen_mut();
                screen.lines.remove(top)
            };
            if full && !self.alt_active {
                self.scrollback.push_back(line);
                let evicted = if self.scrollback.len() > self.scrollback_max {
                    self.scrollback.pop_front();
                    true
                } else {
                    false
                };
                self.abs_base += 1;
                // ── ANCLA DE LECTURA (22 jul 2026, reporte de Daniel: "si estoy
                // leyendo y se va subiendo, me quita la capacidad de leer
                // mientras el agente escribe").
                // `viewport_offset` es relativo al FONDO VIVO, y el fondo avanza
                // con cada linea que llega. Como el frontend pinta desde
                // `topAbs = abs_base - viewport_offset` (ownterm.ts), dejar el
                // offset quieto hacia deslizar la ventana sobre el contenido: el
                // texto se escapaba hacia arriba solo. Anclamos al CONTENIDO
                // creciendo el offset a la par del fondo — es lo que hacen
                // xterm.js/VSCode, y por eso ahi si se puede leer en streaming.
                // Matices:
                //   offset == 0 → estas siguiendo la salida: NO tocar (auto-follow).
                //   evicted     → el scrollback estaba lleno y se desalojo por
                //                 arriba, asi que el contenido de ARRIBA no crecio
                //                 y el offset debe quedarse (si no, treparia solo).
                if self.viewport_offset > 0 && !evicted {
                    self.viewport_offset = (self.viewport_offset + 1).min(self.scrollback.len());
                }
            }
            let cols = self.cols;
            self.screen_mut()
                .lines
                .insert(bot, Row::blank(cols, template));
        }
        for y in top..=bot {
            self.mark_dirty(y);
        }
        if full && !self.alt_active {
            // todo el viewport se movio
            self.mark_all_dirty();
        }
    }

    /// Baja n lineas dentro de la region (nunca toca scrollback).
    pub fn scroll_down(&mut self, n: usize, template: Cell) {
        let (top, bot) = (self.scroll_top, self.scroll_bottom);
        let n = n.min(bot - top + 1);
        let cols = self.cols;
        for _ in 0..n {
            let screen = self.screen_mut();
            screen.lines.remove(bot);
            screen.lines.insert(top, Row::blank(cols, template));
        }
        for y in top..=bot {
            self.mark_dirty(y);
        }
    }

    pub fn linefeed(&mut self, template: Cell) {
        let bot = self.scroll_bottom;
        let y = self.screen().cursor.y;
        if y == bot {
            self.scroll_up(1, template);
        } else if y < self.rows - 1 {
            self.screen_mut().cursor.y += 1;
            self.mark_dirty(y + 1);
        }
        self.screen_mut().cursor.pending_wrap = false;
    }

    pub fn reverse_index(&mut self, template: Cell) {
        let top = self.scroll_top;
        let y = self.screen().cursor.y;
        if y == top {
            self.scroll_down(1, template);
        } else if y > 0 {
            self.screen_mut().cursor.y -= 1;
        }
        self.screen_mut().cursor.pending_wrap = false;
    }

    // ---------- resize ----------

    pub fn resize(&mut self, cols: usize, rows: usize, template: Cell) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        let old_rows = self.rows;
        self.cols = cols.max(1);
        self.rows = rows.max(1);

        for screen_is_alt in [false, true] {
            // primaria: al encoger, las lineas de arriba van al scrollback;
            // al crecer, se jalan de vuelta.
            if !screen_is_alt {
                if self.rows < old_rows {
                    let excess = (self.primary.cursor.y + 1)
                        .max(self.content_rows())
                        .min(old_rows);
                    let mut to_remove = old_rows - self.rows;
                    // primero recorta filas vacias del fondo
                    while to_remove > 0 && self.primary.lines.len() > excess {
                        self.primary.lines.pop();
                        to_remove -= 1;
                    }
                    for _ in 0..to_remove {
                        let line = self.primary.lines.remove(0);
                        self.scrollback.push_back(line);
                        if self.scrollback.len() > self.scrollback_max {
                            self.scrollback.pop_front();
                        }
                        self.abs_base += 1;
                        if self.primary.cursor.y > 0 {
                            self.primary.cursor.y -= 1;
                        }
                    }
                } else if self.rows > old_rows {
                    let mut need = self.rows - old_rows;
                    while need > 0 {
                        if let Some(line) = self.scrollback.pop_back() {
                            self.primary.lines.insert(0, line);
                            self.abs_base = self.abs_base.saturating_sub(1);
                            self.primary.cursor.y += 1;
                        } else {
                            self.primary.lines.push(Row::blank(self.cols, template));
                        }
                        need -= 1;
                    }
                }
            }
            let screen = if screen_is_alt {
                &mut self.alt
            } else {
                &mut self.primary
            };
            screen
                .lines
                .resize(self.rows, Row::blank(self.cols, template));
            for row in screen.lines.iter_mut() {
                row.cells.resize(self.cols, template);
            }
            screen.cursor.x = screen.cursor.x.min(self.cols - 1);
            screen.cursor.y = screen.cursor.y.min(self.rows - 1);
            screen.cursor.pending_wrap = false;
        }
        for row in self.scrollback.iter_mut() {
            row.cells.resize(self.cols, template);
        }
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.dirty = vec![true; self.rows];
        self.viewport_offset = self.viewport_offset.min(self.scrollback.len());
        self.mark_all_dirty();
    }

    /// filas con contenido (para el resize inteligente)
    fn content_rows(&self) -> usize {
        let mut last = 0;
        for (i, row) in self.primary.lines.iter().enumerate() {
            if !row.text().is_empty() {
                last = i + 1;
            }
        }
        last
    }

    // ---------- lectura ----------

    /// Linea por fila ABSOLUTA (scrollback + pantalla activa). None si ya se recorto.
    pub fn line_abs(&self, abs: u64) -> Option<&Row> {
        if abs >= self.abs_base {
            let y = (abs - self.abs_base) as usize;
            self.screen().lines.get(y)
        } else {
            let back = (self.abs_base - abs) as usize;
            if back > self.scrollback.len() {
                return None;
            }
            self.scrollback.get(self.scrollback.len() - back)
        }
    }

    /// Fila absoluta del cursor.
    pub fn cursor_abs(&self) -> u64 {
        self.abs_base + self.screen().cursor.y as u64
    }

    /// Texto de las ultimas `n` lineas CON contenido (scrollback + pantalla).
    pub fn tail_text(&self, n: usize) -> String {
        let mut lines: Vec<String> = Vec::new();
        for row in self.scrollback.iter() {
            lines.push(row.text());
        }
        for row in self.screen().lines.iter() {
            lines.push(row.text());
        }
        while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        let start = lines.len().saturating_sub(n);
        lines[start..].join("\n")
    }
}
