import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeResumeCommand,
  codexResumeCommand,
  kimiResumeCommand,
  shellEnvPrefix,
  shellQuote,
} from "../src/core/shell-command.ts";

test("PowerShell: rutas y prompts se citan sin evaluación", () => {
  assert.equal(shellQuote("C:\\Users\\Example O'Brien", "powershell"), "'C:\\Users\\Example O''Brien'");
  assert.equal(
    shellEnvPrefix("CLAUDE_CONFIG_DIR", "C:\\Users\\Example O'Brien", "powershell"),
    "$env:CLAUDE_CONFIG_DIR='C:\\Users\\Example O''Brien'; ",
  );
  assert.equal(
    claudeResumeCommand("claude --dangerously-skip-permissions", "abc-123", "C:\\AI Work", "línea 1\nlínea '2'", "powershell"),
    "$env:CLAUDE_CONFIG_DIR='C:\\AI Work'; claude --dangerously-skip-permissions --resume abc-123 'línea 1\nlínea ''2'''",
  );
});

test("cada harness reanuda con su sesion, modelo y directorio", () => {
  assert.equal(
    codexResumeCommand("thread-1", "C:\\Work Space", "gpt-5.4", "C:\\Codex Home", undefined, "powershell"),
    "$env:CODEX_HOME='C:\\Codex Home'; codex resume 'thread-1' --model 'gpt-5.4' --cd 'C:\\Work Space'",
  );
  assert.equal(
    kimiResumeCommand("session-1", "k3", "/tmp/kimi home", "posix"),
    "KIMI_CODE_HOME='/tmp/kimi home' kimi --session 'session-1' --model 'k3'",
  );
});

test("POSIX conserva el quoting seguro existente", () => {
  assert.equal(shellQuote("it's safe", "posix"), "'it'\\''s safe'");
  assert.equal(
    claudeResumeCommand("claude", "abc-123", "/Users/me/.claude-bro", "it's ready", "posix"),
    "CLAUDE_CONFIG_DIR='/Users/me/.claude-bro' claude --resume abc-123 'it'\\''s ready'",
  );
});
