import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows conserva chrome nativo para Snap, Alt+Space y doble clic", async () => {
  const raw = await readFile(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8");
  const config = JSON.parse(raw);
  const win = config.app.windows[0];

  assert.equal(win.decorations, true);
  assert.equal(win.titleBarStyle, "Visible");
  assert.equal(win.hiddenTitle, false);
  assert.equal(win.resizable, true);
  assert.ok(win.minWidth >= 900 && win.minHeight >= 560);
});

test("la barra interna solo se renderiza en macOS y Windows actualiza el título HWND", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /platform === "macos" && <div id="titlebar"/);
  assert.match(app, /getCurrentWindow\(\)\.setTitle\(title\)/);
});
