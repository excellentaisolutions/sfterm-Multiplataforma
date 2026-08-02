import assert from "node:assert/strict";
import test from "node:test";

import { TerminalCompositionState, terminalPastePayload } from "../src/core/terminal-input.ts";

test("IME no filtra preediciones y entrega una sola confirmación Chromium/WebView2", () => {
  const ime = new TerminalCompositionState();
  ime.start();

  assert.equal(ime.input("n", true), null);
  assert.equal(ime.input("ni", true), null);
  assert.equal(ime.input("你", true), null);
  assert.equal(ime.ownsKeydown(true, 229), true);

  ime.end();
  assert.equal(ime.input("你", false), "你");
  assert.equal(ime.input("", false), null, "el input posterior no duplica el commit");
});

test("IME permite el flush diferido de WebKit y protege composiciones consecutivas", () => {
  const ime = new TerminalCompositionState();
  ime.start();
  assert.equal(ime.input("に", true), null);
  ime.end();

  ime.start();
  assert.equal(ime.input("日本", false), null, "un timer anterior no filtra la nueva preedición");
  ime.end();
  assert.equal(ime.input("日本語", false), "日本語");
});

test("paste conserva Unicode y normaliza LF/CRLF con y sin bracketed paste", () => {
  const text = "línea 1\nemoji 👩🏽‍💻\r\n漢字\rlínea 4";
  const normalized = "línea 1\remoji 👩🏽‍💻\r漢字\rlínea 4";

  assert.equal(terminalPastePayload(text, false), normalized);
  assert.equal(
    terminalPastePayload(text, true),
    `\x1b[200~${normalized}\x1b[201~`,
  );
});
