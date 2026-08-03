import assert from "node:assert/strict";
import test from "node:test";

import { compileBindings, isPrimaryEvent, matchBinding, type KeyEventLike } from "../src/core/keys.ts";
import { captureCombo, formatCombo, nativeShortcutText, normalizeCombo } from "../src/core/keybinds.ts";

function keyEvent(
  code: string,
  key: string,
  mods: Partial<Pick<KeyEventLike, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
): KeyEventLike {
  return {
    code,
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

test("primary es Command en macOS y Control en Windows", () => {
  const mac = compileBindings({ abrir: "primary+k" }, "macos");
  const windows = compileBindings({ abrir: "primary+k" }, "windows");

  assert.equal(matchBinding(keyEvent("KeyK", "k", { metaKey: true }), mac), "abrir");
  assert.equal(matchBinding(keyEvent("KeyK", "k", { ctrlKey: true }), mac), null);
  assert.equal(matchBinding(keyEvent("KeyK", "k", { ctrlKey: true }), windows), "abrir");
  assert.equal(matchBinding(keyEvent("KeyK", "k", { metaKey: true }), windows), null);
  assert.equal(isPrimaryEvent(keyEvent("KeyK", "k", { ctrlKey: true }), "windows"), true);
});

test("cmd/meta y ctrl permanecen como modificadores físicos avanzados", () => {
  const windows = compileBindings({ win: "meta+k", control: "ctrl+l" }, "windows");
  assert.equal(matchBinding(keyEvent("KeyK", "k", { metaKey: true }), windows), "win");
  assert.equal(matchBinding(keyEvent("KeyL", "l", { ctrlKey: true }), windows), "control");
  assert.notEqual(normalizeCombo("primary+k", "macos"), normalizeCombo("ctrl+k", "macos"));
  assert.equal(normalizeCombo("primary+k", "windows"), normalizeCombo("ctrl+k", "windows"));
});

test("captura y presentación usan nombres nativos de cada plataforma", () => {
  assert.equal(captureCombo(keyEvent("KeyJ", "j", { metaKey: true, altKey: true }), "macos"), "primary+alt+j");
  assert.equal(captureCombo(keyEvent("KeyJ", "j", { ctrlKey: true, altKey: true }), "windows"), "primary+alt+j");
  assert.equal(formatCombo("primary+alt+j", "macos"), "⌘⌥J");
  assert.equal(formatCombo("primary+alt+j", "windows"), "Ctrl+Alt+J");
  assert.equal(formatCombo("meta+shift+k", "windows"), "Win+Shift+K");
  assert.equal(
    nativeShortcutText("⌘J · ⌘⌥J · ⌘⇧F", "windows"),
    "Ctrl+J · Ctrl+Alt+J · Ctrl+Shift+F",
  );
});
