//! Serializacion binaria de frames para el renderer propio (little-endian).
//! Solo filas dirty; frame completo en subscribe/resize/scroll/alt-switch.
//!
//! Layout:
//!   u32 seq | u16 cols | u16 rows
//!   i16 cursor_x | i16 cursor_y          (coords de viewport; -1 = oculto)
//!   u8 cursor_shape (0 block/1 under/2 bar) | u8 flags | u16 _pad
//!     flags: bit0 alt_screen, bit1 reverse_video, bit2 frame completo
//!   u32 modes: bit0 app_cursor, bit1 bracketed, bit2 mouse_x10, bit3 mouse_drag,
//!              bit4 mouse_any, bit5 mouse_sgr, bit6 focus, bit7 alt_scroll,
//!              bit8 app_keypad, bit9 cursor_blink, bit10 cursor_visible
//!   u32 scrollback_len | u32 viewport_offset | u32 abs_base (32 bits bajos)
//!   u16 block_count | por bloque: u16 row, u8 running, u8 has_cmd,
//!                     u8 readable (>=3 filas de output: candidato a modo lectura),
//!                     i32 exit (i32::MIN = n/a), u32 duration_ms, u32 id
//!   u16 dirty_count | por fila: u16 y + cols celdas de 14 bytes:
//!     u32 ch | u32 fg | u32 bg | u16 flags
//!     color: tag<<24 | payload (tag 0 = default, 1 = indexed, 2 = rgb)

use super::grid::{Color, Row};
use super::term::{MouseMode, Term};

fn color_u32(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(i) => (1 << 24) | i as u32,
        Color::Rgb(r, g, b) => (2 << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32,
    }
}

fn push_row(buf: &mut Vec<u8>, y: u16, row: Option<&Row>, cols: usize, blank_ch: u32) {
    buf.extend_from_slice(&y.to_le_bytes());
    for x in 0..cols {
        match row.and_then(|r| r.cells.get(x)) {
            Some(cell) => {
                buf.extend_from_slice(&(cell.ch as u32).to_le_bytes());
                buf.extend_from_slice(&color_u32(cell.attrs.fg).to_le_bytes());
                buf.extend_from_slice(&color_u32(cell.attrs.bg).to_le_bytes());
                buf.extend_from_slice(&cell.attrs.flags.to_le_bytes());
            }
            None => {
                buf.extend_from_slice(&blank_ch.to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
                buf.extend_from_slice(&0u16.to_le_bytes());
            }
        }
    }
}

pub fn build(term: &mut Term, seq: u32) -> Vec<u8> {
    let (all, dirty_rows) = term.grid.take_dirty();
    let cols = term.grid.cols;
    let rows = term.grid.rows;
    let k = term.grid.viewport_offset;
    let abs_base = term.grid.abs_base;
    let from_abs = abs_base.saturating_sub(k as u64);

    let mut buf: Vec<u8> = Vec::with_capacity(64 + dirty_rows.len() * (2 + cols * 14));
    buf.extend_from_slice(&seq.to_le_bytes());
    buf.extend_from_slice(&(cols as u16).to_le_bytes());
    buf.extend_from_slice(&(rows as u16).to_le_bytes());

    let cur = term.grid.cursor();
    let cur_v = cur.y + k;
    let (cx, cy): (i16, i16) = if k == 0 || cur_v < rows {
        (cur.x as i16, cur_v as i16)
    } else {
        (-1, -1)
    };
    buf.extend_from_slice(&cx.to_le_bytes());
    buf.extend_from_slice(&cy.to_le_bytes());
    buf.push(term.modes.cursor_shape);
    let mut flags = 0u8;
    if term.grid.alt_active {
        flags |= 1;
    }
    if term.modes.reverse_video {
        flags |= 2;
    }
    if all {
        flags |= 4;
    }
    buf.push(flags);
    buf.extend_from_slice(&0u16.to_le_bytes());

    let m = &term.modes;
    let mut modes = 0u32;
    if m.app_cursor {
        modes |= 1;
    }
    if m.bracketed_paste {
        modes |= 2;
    }
    if m.mouse == MouseMode::X10 {
        modes |= 4;
    }
    if m.mouse == MouseMode::Drag {
        modes |= 8;
    }
    if m.mouse == MouseMode::Any {
        modes |= 16;
    }
    if m.mouse_sgr {
        modes |= 32;
    }
    if m.focus_events {
        modes |= 64;
    }
    if m.alt_scroll {
        modes |= 128;
    }
    if m.app_keypad {
        modes |= 256;
    }
    if m.cursor_blink {
        modes |= 512;
    }
    if m.cursor_visible {
        modes |= 1024;
    }
    buf.extend_from_slice(&modes.to_le_bytes());

    buf.extend_from_slice(&(term.grid.scrollback.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(k as u32).to_le_bytes());
    buf.extend_from_slice(&(abs_base as u32).to_le_bytes());

    // bloques visibles (separadores + badges). Solo en pantalla primaria.
    let blocks: Vec<(u16, &super::blocks::Block)> = if term.grid.alt_active {
        Vec::new()
    } else {
        term.blocks
            .visible_in(from_abs, from_abs + rows as u64)
            .into_iter()
            .map(|b| (((b.start_abs - from_abs) as usize).min(rows - 1) as u16, b))
            .collect()
    };
    buf.extend_from_slice(&(blocks.len() as u16).to_le_bytes());
    let cursor_abs = term.grid.cursor_abs();
    for (row, b) in blocks {
        buf.extend_from_slice(&row.to_le_bytes());
        buf.push(b.running() as u8);
        buf.push(!b.cmd.is_empty() as u8);
        // candidato a modo lectura: hay suficiente output para leerlo como doc
        let out_end = b.end_abs.unwrap_or(cursor_abs);
        buf.push((out_end.saturating_sub(b.output_abs) >= 3) as u8);
        buf.extend_from_slice(&b.exit.unwrap_or(i32::MIN).to_le_bytes());
        buf.extend_from_slice(&(b.duration_ms.unwrap_or(0) as u32).to_le_bytes());
        buf.extend_from_slice(&(b.id as u32).to_le_bytes());
    }

    // filas: viewport row v muestra la linea absoluta from_abs + v
    let vrows: Vec<u16> = if all {
        (0..rows as u16).collect()
    } else {
        dirty_rows
            .iter()
            .filter_map(|y| {
                let v = y + k;
                (v < rows).then_some(v as u16)
            })
            .collect()
    };
    buf.extend_from_slice(&(vrows.len() as u16).to_le_bytes());
    let blank = ' ' as u32;
    for v in vrows {
        let row = term.grid.line_abs(from_abs + v as u64);
        push_row(&mut buf, v, row, cols, blank);
    }
    buf
}
