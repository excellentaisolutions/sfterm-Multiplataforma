import assert from "node:assert/strict";
import test from "node:test";

import { claudeResumeCommand, shellEnvPrefix, shellQuote } from "../src/core/shell-command.ts";

test("PowerShell: rutas y prompts se citan sin evaluación", () => {
  assert.equal(shellQuote("C:\\Users\\Iris O'Brien", "powershell"), "'C:\\Users\\Iris O''Brien'");
  assert.equal(
    shellEnvPrefix("CLAUDE_CONFIG_DIR", "C:\\Users\\Iris O'Brien", "powershell"),
    "$env:CLAUDE_CONFIG_DIR='C:\\Users\\Iris O''Brien'; ",
  );
  assert.equal(
    claudeResumeCommand("claude --dangerously-skip-permissions", "abc-123", "C:\\AI Work", "línea 1\nlínea '2'", "powershell"),
    "$env:CLAUDE_CONFIG_DIR='C:\\AI Work'; claude --dangerously-skip-permissions --resume abc-123 'línea 1\nlínea ''2'''",
  );
});

test("POSIX conserva el quoting seguro existente", () => {
  assert.equal(shellQuote("it's safe", "posix"), "'it'\\''s safe'");
  assert.equal(
    claudeResumeCommand("claude", "abc-123", "/Users/me/.claude-bro", "it's ready", "posix"),
    "CLAUDE_CONFIG_DIR='/Users/me/.claude-bro' claude --resume abc-123 'it'\\''s ready'",
  );
});
