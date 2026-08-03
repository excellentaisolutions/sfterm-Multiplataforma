import assert from "node:assert/strict";
import test from "node:test";

import {
  currentExplorerRoot,
  isAbsolutePath,
  parseDroppedPaths,
  pathBasename,
  pathDirname,
  pathRelative,
} from "../src/core/path-utils.ts";
import { quoteShellPaths, worktreeShellCommand } from "../src/core/shell-command.ts";

test("paths Windows, UNC y POSIX comparten basename y dirname", () => {
  assert.equal(pathBasename("C:\\Developer\\AI\\WinTerm\\"), "WinTerm");
  assert.equal(pathBasename("\\\\server\\share\\folder\\file.txt"), "file.txt");
  assert.equal(pathBasename("C:\\AI Work\\niño_界\\informe final.txt"), "informe final.txt");
  assert.equal(pathBasename("/Users/iris/project/"), "project");
  assert.equal(pathDirname("C:\\Developer\\file.txt"), "C:\\Developer");
  assert.equal(pathDirname("\\\\server\\share\\niño_界\\file.txt"), "\\\\server\\share\\niño_界");
  assert.equal(pathDirname("/Users/iris/file.txt"), "/Users/iris");
  assert.equal(pathRelative("C:\\Developer\\AI", "c:\\Developer\\AI\\src\\main.ts"), "src/main.ts");
  assert.equal(pathRelative("\\\\server\\share", "\\\\server\\share\\dir\\a.txt"), "dir/a.txt");
  assert.equal(
    pathRelative("C:\\AI Work", "c:\\AI Work\\niño_界\\informe final.txt"),
    "niño_界/informe final.txt",
  );
});

test("drag-and-drop acepta drives y UNC pero rechaza texto relativo", () => {
  assert.equal(isAbsolutePath("C:\\Work\\a.txt"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\a.txt"), true);
  assert.equal(isAbsolutePath("notes/a.txt"), false);
  assert.deepEqual(
    parseDroppedPaths(
      "C:\\Work\\a.txt\r\n\\\\server\\share\\niño_界\\informe final.txt\nrelativo.txt\nC:\\Work\\a.txt",
    ),
    ["C:\\Work\\a.txt", "\\\\server\\share\\niño_界\\informe final.txt"],
  );
});

test("el explorador sigue el cwd enfocado y conserva el proyecto como fallback", () => {
  assert.equal(
    currentExplorerRoot("C:\\Developer\\AI\\WinTerm", "C:\\Developer\\AI\\WinTerm\\src"),
    "C:\\Developer\\AI\\WinTerm\\src",
  );
  assert.equal(
    currentExplorerRoot("C:\\Developer\\AI\\WinTerm", null),
    "C:\\Developer\\AI\\WinTerm",
  );
  assert.equal(
    currentExplorerRoot("C:\\Developer\\AI\\WinTerm", ""),
    "C:\\Developer\\AI\\WinTerm",
  );
});

test("paths soltados se citan según el shell activo", () => {
  assert.equal(
    quoteShellPaths(["C:\\AI Work\\O'Brien.txt", "\\\\server\\share\\x.txt"], "powershell"),
    "'C:\\AI Work\\O''Brien.txt' '\\\\server\\share\\x.txt'",
  );
  assert.equal(quoteShellPaths(["/tmp/it's here"], "posix"), "'/tmp/it'\\''s here'");
  assert.match(worktreeShellCommand("2608021200", "agente/2608021200", "powershell"), /Split-Path/);
  assert.match(worktreeShellCommand("2608021200", "agente/2608021200", "posix"), /basename/);
});
