//! Tests del motor VT: secuencias reales contra el grid. Sin browser, sin PTY.

use super::grid::{Cell, Color, BOLD, INVERSE, UNDERLINE, WIDE, WIDE_CONT};
use super::term::{MouseMode, Term, TermEvent};

fn mk(cols: usize, rows: usize) -> (Term, vte::Parser) {
    (Term::new(cols, rows, 100), vte::Parser::new())
}

fn feed(t: &mut Term, p: &mut vte::Parser, s: &str) {
    p.advance(t, s.as_bytes());
}

fn line(t: &Term, y: usize) -> String {
    t.grid.screen().lines[y].text()
}

fn cell(t: &Term, x: usize, y: usize) -> Cell {
    t.grid.screen().lines[y].cells[x]
}

#[test]
fn print_wrap_y_scrollback() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "0123456789ABC");
    // wrap automatico a la fila 1
    assert_eq!(line(&t, 0), "0123456789");
    assert_eq!(line(&t, 1), "ABC");
    assert!(t.grid.screen().lines[0].wrapped);
    // llenar hasta empujar al scrollback
    feed(&mut t, &mut p, "\r\nfila2\r\nfila3\r\nfila4");
    assert_eq!(t.grid.scrollback.len(), 2);
    assert_eq!(t.grid.abs_base, 2);
    assert_eq!(t.grid.scrollback[0].text(), "0123456789");
    assert_eq!(line(&t, 2), "fila4");
}

#[test]
fn cup_ed_el() {
    let (mut t, mut p) = mk(20, 5);
    feed(&mut t, &mut p, "aaaaaaaaaa\r\nbbbbbbbbbb\r\ncccccccccc");
    // cursor a 2;5 y borra hasta el final de linea
    feed(&mut t, &mut p, "\x1b[2;5H\x1b[K");
    assert_eq!(line(&t, 1), "bbbb");
    // ED 0: desde cursor al final de pantalla
    feed(&mut t, &mut p, "\x1b[2;3H\x1b[J");
    assert_eq!(line(&t, 1), "bb");
    assert_eq!(line(&t, 2), "");
    // ED 2: todo
    feed(&mut t, &mut p, "\x1b[2J");
    assert_eq!(line(&t, 0), "");
}

#[test]
fn sgr_colores_y_estilos() {
    let (mut t, mut p) = mk(20, 3);
    feed(&mut t, &mut p, "\x1b[1;4;31mX\x1b[0mY");
    let cx = cell(&t, 0, 0);
    assert_eq!(cx.attrs.fg, Color::Indexed(1));
    assert!(cx.attrs.flags & BOLD != 0);
    assert!(cx.attrs.flags & UNDERLINE != 0);
    let cy = cell(&t, 1, 0);
    assert_eq!(cy.attrs.fg, Color::Default);
    assert_eq!(cy.attrs.flags, 0);
    // 256 y truecolor, semicolon y colon
    feed(&mut t, &mut p, "\x1b[38;5;196mA\x1b[38;2;10;20;30mB\x1b[38:2:0:1:2:3mC");
    assert_eq!(cell(&t, 2, 0).attrs.fg, Color::Indexed(196));
    assert_eq!(cell(&t, 3, 0).attrs.fg, Color::Rgb(10, 20, 30));
    assert_eq!(cell(&t, 4, 0).attrs.fg, Color::Rgb(1, 2, 3));
    // bg brillante + inverse
    feed(&mut t, &mut p, "\x1b[7;103mZ");
    let cz = cell(&t, 5, 0);
    assert_eq!(cz.attrs.bg, Color::Indexed(11));
    assert!(cz.attrs.flags & INVERSE != 0);
}

#[test]
fn alt_screen_preserva_primaria() {
    let (mut t, mut p) = mk(20, 5);
    feed(&mut t, &mut p, "primaria");
    feed(&mut t, &mut p, "\x1b[?1049h");
    assert!(t.grid.alt_active);
    assert_eq!(line(&t, 0), "");
    feed(&mut t, &mut p, "alterna");
    assert_eq!(line(&t, 0), "alterna");
    feed(&mut t, &mut p, "\x1b[?1049l");
    assert!(!t.grid.alt_active);
    assert_eq!(line(&t, 0), "primaria");
    // cursor restaurado tras la x de "primaria"
    assert_eq!(t.grid.cursor().x, 8);
}

#[test]
fn scroll_region_su_sd_il_dl() {
    let (mut t, mut p) = mk(10, 5);
    feed(&mut t, &mut p, "L0\r\nL1\r\nL2\r\nL3\r\nL4");
    // region 2-4 (1-based), scroll up 1: L2 desaparece, L3/L4 suben
    feed(&mut t, &mut p, "\x1b[2;4r\x1b[2;1H\x1b[1S");
    assert_eq!(line(&t, 0), "L0");
    assert_eq!(line(&t, 1), "L2");
    assert_eq!(line(&t, 2), "L3");
    assert_eq!(line(&t, 3), "");
    assert_eq!(line(&t, 4), "L4");
    // nada fue al scrollback (region parcial)
    assert_eq!(t.grid.scrollback.len(), 0);
    // IL en fila 2: inserta linea, empuja dentro de la region
    feed(&mut t, &mut p, "\x1b[2;1H\x1b[L");
    assert_eq!(line(&t, 1), "");
    assert_eq!(line(&t, 2), "L2");
    assert_eq!(line(&t, 3), "L3");
    assert_eq!(line(&t, 4), "L4");
    // DL la quita de vuelta
    feed(&mut t, &mut p, "\x1b[M");
    assert_eq!(line(&t, 1), "L2");
    assert_eq!(line(&t, 3), "");
}

#[test]
fn wide_chars_ocupan_dos_celdas() {
    let (mut t, mut p) = mk(6, 3);
    feed(&mut t, &mut p, "海x");
    assert!(cell(&t, 0, 0).attrs.flags & WIDE != 0);
    assert!(cell(&t, 1, 0).attrs.flags & WIDE_CONT != 0);
    assert_eq!(cell(&t, 2, 0).ch, 'x');
    assert_eq!(line(&t, 0), "海x");
    // wide al borde: wrap anticipado
    feed(&mut t, &mut p, "\x1b[1;6H猫");
    assert_eq!(cell(&t, 0, 1).ch, '猫');
    // pisar la mitad de un wide limpia el par
    feed(&mut t, &mut p, "\x1b[1;2HY");
    assert_eq!(cell(&t, 0, 0).ch, ' ');
    assert_eq!(cell(&t, 1, 0).ch, 'Y');
}

#[test]
fn resize_truncado_y_repull() {
    let (mut t, mut p) = mk(10, 4);
    feed(&mut t, &mut p, "a\r\nb\r\nc\r\nd\r\ne\r\nf");
    assert_eq!(t.grid.scrollback.len(), 2);
    let template = Cell::default();
    // encoger: filas de arriba van al scrollback
    t.grid.resize(10, 2, template);
    assert_eq!(line(&t, 0), "e");
    assert_eq!(line(&t, 1), "f");
    assert!(t.grid.scrollback.len() >= 4);
    // crecer: se jalan de vuelta
    t.grid.resize(10, 4, template);
    assert_eq!(line(&t, 0), "c");
    assert_eq!(line(&t, 3), "f");
    // cols
    t.grid.resize(5, 4, template);
    assert_eq!(t.grid.screen().lines[0].cells.len(), 5);
}

#[test]
fn osc_titulo_y_cwd() {
    let (mut t, mut p) = mk(20, 3);
    feed(&mut t, &mut p, "\x1b]0;✳ Mi resumen; con punto y coma\x07");
    assert_eq!(t.title, "✳ Mi resumen; con punto y coma");
    feed(&mut t, &mut p, "\x1b]7;file://mac.local/Users/daniel/Dev%20Site\x07");
    assert_eq!(t.cwd, "/Users/daniel/Dev Site");
    assert!(!t.events.is_empty());
}

#[test]
fn osc_cwd_normaliza_uri_de_windows() {
    let (mut t, mut p) = mk(80, 24);
    feed(&mut t, &mut p, "\x1b]7;file:///C:/Users/Iris/My%20Project\x07");
    assert_eq!(t.cwd, "C:/Users/Iris/My Project");
    assert!(t.events.iter().any(
        |event| matches!(event, TermEvent::Cwd(path) if path == "C:/Users/Iris/My Project")
    ));
}

#[test]
#[cfg(target_os = "windows")]
fn osc_cwd_conserva_host_unc() {
    let (mut t, mut p) = mk(80, 24);
    feed(
        &mut t,
        &mut p,
        "\x1b]7;file://fileserver/Equipo/Proyecto%20Uno\x07",
    );
    assert_eq!(t.cwd, "//fileserver/Equipo/Proyecto Uno");
}

#[test]
fn bloques_osc_133_ciclo_completo() {
    let (mut t, mut p) = mk(40, 10);
    // prompt → comando → output → fin con exit code
    feed(&mut t, &mut p, "\x1b]133;A\x07$ ");
    feed(&mut t, &mut p, "\x1b]633;E;cargo test --all\x07\x1b]133;C\x07\r\n");
    feed(&mut t, &mut p, "corriendo...\r\nok\r\n");
    feed(&mut t, &mut p, "\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    let b = t.blocks.last().unwrap();
    assert_eq!(b.cmd, "cargo test --all");
    assert_eq!(b.exit, Some(0));
    assert!(!b.running());
    assert!(b.duration_ms.is_some());
    assert_eq!(b.start_abs, 0);
    assert_eq!(b.output_abs, 0); // C llego antes del \r\n
    // segundo bloque que falla
    feed(&mut t, &mut p, "\x1b]633;E;false\x07\x1b]133;C\x07\r\n\x1b]133;D;1\x07\x1b]133;A\x07$ ");
    assert_eq!(t.blocks.list.len(), 2);
    assert_eq!(t.blocks.last().unwrap().exit, Some(1));
}

#[test]
fn dsr_y_da_responden() {
    let (mut t, mut p) = mk(20, 5);
    feed(&mut t, &mut p, "\x1b[3;7H\x1b[6n");
    assert_eq!(String::from_utf8_lossy(&t.responses), "\x1b[3;7R");
    t.responses.clear();
    feed(&mut t, &mut p, "\x1b[c");
    assert!(String::from_utf8_lossy(&t.responses).starts_with("\x1b[?62"));
    t.responses.clear();
    // OSC 11 query (deteccion de tema de los CLIs)
    feed(&mut t, &mut p, "\x1b]11;?\x07");
    let r = String::from_utf8_lossy(&t.responses).to_string();
    assert!(r.starts_with("\x1b]11;rgb:"), "respuesta OSC11: {r:?}");
}

#[test]
fn modos_decset() {
    let (mut t, mut p) = mk(20, 5);
    feed(&mut t, &mut p, "\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?25l");
    assert!(t.modes.app_cursor);
    assert!(t.modes.bracketed_paste);
    assert_eq!(t.modes.mouse, MouseMode::Drag);
    assert!(t.modes.mouse_sgr);
    assert!(!t.modes.cursor_visible);
    feed(&mut t, &mut p, "\x1b[?1l\x1b[?1002l\x1b[?25h");
    assert!(!t.modes.app_cursor);
    assert_eq!(t.modes.mouse, MouseMode::None);
    assert!(t.modes.cursor_visible);
}

#[test]
fn charset_line_drawing() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "\x1b(0lqk\x1b(Bx");
    assert_eq!(line(&t, 0), "┌─┐x");
}

#[test]
fn decaln_llena_de_e() {
    let (mut t, mut p) = mk(5, 3);
    feed(&mut t, &mut p, "\x1b#8");
    assert_eq!(line(&t, 0), "EEEEE");
    assert_eq!(line(&t, 2), "EEEEE");
}

#[test]
fn tab_stops() {
    let (mut t, mut p) = mk(30, 3);
    feed(&mut t, &mut p, "\tX");
    assert_eq!(cell(&t, 8, 0).ch, 'X');
    // CBT regresa
    feed(&mut t, &mut p, "\x1b[Z\x1b[ZY");
    assert_eq!(cell(&t, 0, 0).ch, 'Y');
    // TBC 3 limpia todo: tab va al final
    feed(&mut t, &mut p, "\x1b[3g\r\tZ");
    assert_eq!(cell(&t, 29, 0).ch, 'Z');
}

#[test]
fn ich_dch_ech() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "abcdef\x1b[1;1H\x1b[2@");
    assert_eq!(line(&t, 0), "  abcdef");
    feed(&mut t, &mut p, "\x1b[2P");
    assert_eq!(line(&t, 0), "abcdef");
    feed(&mut t, &mut p, "\x1b[2X");
    assert_eq!(line(&t, 0), "  cdef");
}

#[test]
fn ind_ri_nel() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "top\x1b[3;1Hbot");
    // RI en fila 0 hace scroll down
    feed(&mut t, &mut p, "\x1b[1;1H\x1bM");
    assert_eq!(line(&t, 1), "top");
    assert_eq!(line(&t, 0), "");
    // IND en la ultima fila scrollea
    feed(&mut t, &mut p, "\x1b[3;1H\x1bD");
    assert_eq!(line(&t, 0), "top");
}

#[test]
fn cursor_save_restore() {
    let (mut t, mut p) = mk(20, 5);
    feed(&mut t, &mut p, "\x1b[3;5H\x1b[31m\x1b7\x1b[1;1H\x1b[0mX\x1b8Y");
    assert_eq!(cell(&t, 4, 2).ch, 'Y');
    assert_eq!(cell(&t, 4, 2).attrs.fg, Color::Indexed(1));
}

#[test]
fn reverse_video_flag() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "\x1b[?5h");
    assert!(t.modes.reverse_video);
    feed(&mut t, &mut p, "\x1b[?5l");
    assert!(!t.modes.reverse_video);
}

#[test]
fn origen_decom() {
    let (mut t, mut p) = mk(20, 10);
    feed(&mut t, &mut p, "\x1b[3;8r\x1b[?6h\x1b[1;1HX");
    // con origin mode, 1;1 = top de la region (fila 3 fisica, 0-based 2)
    assert_eq!(cell(&t, 0, 2).ch, 'X');
    // DSR responde relativo a la region
    t.responses.clear();
    feed(&mut t, &mut p, "\x1b[6n");
    assert_eq!(String::from_utf8_lossy(&t.responses), "\x1b[1;2R");
}

#[test]
fn rep_repite() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "-\x1b[4b");
    assert_eq!(line(&t, 0), "-----");
}

#[test]
fn tail_text_para_gate() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "uno\r\ndos\r\ntres\r\ncuatro\r\ncinco");
    let tail = t.grid.tail_text(3);
    assert_eq!(tail, "tres\ncuatro\ncinco");
}

#[test]
fn frame_binario_coherente() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "hola");
    let buf = super::frame::build(&mut t, 1);
    // header: seq=1, cols=10, rows=3
    assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(buf[4..6].try_into().unwrap()), 10);
    assert_eq!(u16::from_le_bytes(buf[6..8].try_into().unwrap()), 3);
    // tras el frame, no queda damage
    assert!(!t.grid.has_dirty());
    feed(&mut t, &mut p, "x");
    assert!(t.grid.has_dirty());
}

#[test]
fn block_text_junta_soft_wraps() {
    // linea logica larga que envuelve: block_text la devuelve como UNA linea
    let (mut t, mut p) = mk(10, 5);
    feed(&mut t, &mut p, "\x1b]133;A\x07$ \x1b]633;E;cat x.md\x07\r\n\x1b]133;C\x07");
    feed(&mut t, &mut p, "una linea muy larga\r\ncorta\r\n\x1b]133;D;0\x07");
    let bt = super::block_text_of(&t, None, None).unwrap();
    assert_eq!(bt.cmd, "cat x.md");
    assert_eq!(bt.exit, Some(0));
    assert_eq!(bt.text, "una linea muy larga\ncorta");
}

#[test]
fn frame_block_lleva_readable() {
    let (mut t, mut p) = mk(20, 8);
    // bloque con 1 linea de output: NO readable
    feed(&mut t, &mut p, "\x1b]133;A\x07$ \x1b]633;E;pwd\x07\r\n\x1b]133;C\x07out\r\n\x1b]133;D;0\x07");
    let buf = super::frame::build(&mut t, 1);
    // header fijo = 32 bytes; luego u16 block_count
    let n = u16::from_le_bytes(buf[32..34].try_into().unwrap());
    assert_eq!(n, 1);
    // registro: row u16 | running u8 | has_cmd u8 | readable u8 | exit i32 | dur u32 | id u32
    assert_eq!(buf[36], 0, "running");
    assert_eq!(buf[37], 1, "has_cmd");
    assert_eq!(buf[38], 0, "1 linea de output no es readable");
    assert_eq!(i32::from_le_bytes(buf[39..43].try_into().unwrap()), 0, "exit");
    // segundo bloque con 3+ lineas: SI readable
    feed(&mut t, &mut p, "\x1b]133;A\x07$ \x1b]633;E;cat doc.md\x07\r\n\x1b]133;C\x07uno\r\ndos\r\ntres\r\n\x1b]133;D;0\x07");
    let buf = super::frame::build(&mut t, 2);
    let n = u16::from_le_bytes(buf[32..34].try_into().unwrap());
    assert_eq!(n, 2);
    let rec2 = 34 + 17; // segundo registro (17 bytes por bloque)
    assert_eq!(buf[rec2 + 4], 1, "3 lineas de output = readable");
}

#[test]
fn insert_mode() {
    let (mut t, mut p) = mk(10, 3);
    feed(&mut t, &mut p, "abc\x1b[1;1H\x1b[4hXY\x1b[4l");
    assert_eq!(line(&t, 0), "XYabc");
}

#[test]
fn clear_borra_bloques_visibles_pero_no_la_historia() {
    let (mut t, mut p) = mk(40, 10);
    feed(&mut t, &mut p, "\x1b]133;A\x07$ \x1b]633;E;ls\x07\x1b]133;C\x07\r\nout\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    assert_eq!(t.blocks.visible_in(0, 10).len(), 1);
    // clear (ED 2): el bloque deja de dibujarse pero sigue en la lista
    feed(&mut t, &mut p, "\x1b[2J\x1b[H");
    assert_eq!(t.blocks.visible_in(0, 10).len(), 0);
    assert_eq!(t.blocks.list.len(), 1);
    assert_eq!(t.blocks.last().unwrap().exit, Some(0));
}

#[test]
fn full_reset_conserva_scrollback() {
    let (mut t, mut p) = mk(10, 2);
    feed(&mut t, &mut p, "a\r\nb\r\nc\r\nd");
    let sb = t.grid.scrollback.len();
    assert!(sb > 0);
    feed(&mut t, &mut p, "\x1bc");
    assert_eq!(t.grid.scrollback.len(), sb);
    assert_eq!(line(&t, 0), "");
    assert_eq!(t.grid.cursor().x, 0);
}

#[test]
fn cuf_solo_mueve_cursor_sin_dirty() {
    // El escenario del "espacio invisible" (21 jul 2026): el TUI de claude,
    // ante un espacio al final del input, NO reescribe celdas — solo mueve el
    // cursor (CUF). Eso deja has_dirty()=false, y el ticker ANTES no emitia
    // frame: el cursor en pantalla se quedaba viejo. El fix compara ademas el
    // estado de cursor (mod.rs last_cursor); este test fija el contrato:
    // CUF puro = cero dirty + cursor movido (la señal que el ticker debe ver).
    let (mut t, mut p) = mk(20, 3);
    feed(&mut t, &mut p, "❯ hola");
    let _ = t.grid.take_dirty(); // frame emitido: limpia dirty
    let antes = t.grid.cursor();
    feed(&mut t, &mut p, "\x1b[C"); // cursor forward, sin tocar celdas
    assert!(!t.grid.has_dirty(), "CUF no debe ensuciar filas");
    let despues = t.grid.cursor();
    assert_eq!(despues.x, antes.x + 1, "el cursor SI avanzo");
    assert_eq!(despues.y, antes.y);
}

#[test]
fn dectcem_visibilidad_cursor_sin_dirty() {
    // Mismo contrato para mostrar/ocultar cursor (DECSET/DECRST 25):
    // cambia modes.cursor_visible sin ensuciar filas — el ticker debe
    // emitir frame por el cambio de estado de cursor, no por dirty.
    let (mut t, mut p) = mk(10, 2);
    feed(&mut t, &mut p, "x");
    let _ = t.grid.take_dirty();
    assert!(t.modes.cursor_visible);
    feed(&mut t, &mut p, "\x1b[?25l");
    assert!(!t.modes.cursor_visible);
    assert!(!t.grid.has_dirty(), "DECRST 25 no ensucia filas");
}

#[test]
fn viewport_subido_se_ancla_al_contenido_mientras_llega_output() {
    // REPORTE de Daniel (22 jul 2026): "si estoy leyendo y se va subiendo, me
    // quita la capacidad de leer mientras el agente escribe".
    // Con el viewport SUBIDO, lo que llega no debe arrastrar la ventana: el
    // usuario tiene que seguir viendo EL MISMO contenido (ancla absoluta), que
    // es lo que hacen xterm.js/VSCode. El frontend pinta desde
    // `abs_base - viewport_offset`: ese numero es el invariante a conservar.
    let (mut t, mut p) = mk(10, 3);
    for i in 0..10 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    // el usuario sube 4 lineas a leer
    t.grid.viewport_offset = 4;
    let anclado = t.grid.abs_base - t.grid.viewport_offset as u64;

    // el agente sigue escribiendo
    for i in 10..16 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    assert_eq!(
        t.grid.abs_base - t.grid.viewport_offset as u64,
        anclado,
        "la ventana se deslizo sobre el contenido mientras llegaba output"
    );
}

#[test]
fn viewport_en_el_fondo_sigue_la_salida() {
    // El otro lado del contrato: pegado al fondo (offset 0) se AUTO-SIGUE la
    // salida. Anclar aqui seria peor que el bug original.
    let (mut t, mut p) = mk(10, 3);
    for i in 0..10 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    assert_eq!(t.grid.viewport_offset, 0);
    for i in 10..16 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    assert_eq!(t.grid.viewport_offset, 0, "el fondo vivo debe seguir la salida");
}

#[test]
fn viewport_no_trepa_cuando_el_scrollback_esta_lleno() {
    // Con el scrollback TOPADO, cada linea nueva desaloja una por arriba: el
    // contenido de arriba no crece, asi que el offset NO debe crecer (si no,
    // treparia solo hasta el tope y la vista se iria sola hacia atras).
    let mut t = Term::new(10, 3, 5); // scrollback_max = 5
    let mut p = vte::Parser::new();
    for i in 0..20 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    assert_eq!(t.grid.scrollback.len(), 5, "scrollback topado");
    t.grid.viewport_offset = 3;
    for i in 20..30 {
        feed(&mut t, &mut p, &format!("linea{i}\r\n"));
    }
    assert_eq!(t.grid.viewport_offset, 3, "el offset no debe treparse solo");
    assert!(t.grid.viewport_offset <= t.grid.scrollback.len());
}
