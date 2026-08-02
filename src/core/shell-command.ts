export type ShellFamily = "powershell" | "posix";

export function runtimeShellFamily(): ShellFamily {
  if (typeof navigator === "undefined") return "posix";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /windows|win32|win64/i.test(platform) ? "powershell" : "posix";
}

/** Literal de una sola comilla, sin evaluación de variables ni subexpresiones. */
export function shellQuote(value: string, family: ShellFamily = runtimeShellFamily()): string {
  if (family === "powershell") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Asignación temporal que afecta solo al comando situado a continuación. */
export function shellEnvPrefix(
  name: string,
  value: string | null | undefined,
  family: ShellFamily = runtimeShellFamily(),
): string {
  if (!value) return "";
  const quoted = shellQuote(value, family);
  return family === "powershell"
    ? `$env:${name}=${quoted}; `
    : `${name}=${quoted} `;
}

export function claudeResumeCommand(
  agentCommand: string,
  sid: string,
  configDir?: string | null,
  prompt?: string,
  family: ShellFamily = runtimeShellFamily(),
): string {
  const env = shellEnvPrefix("CLAUDE_CONFIG_DIR", configDir, family);
  const message = prompt === undefined ? "" : ` ${shellQuote(prompt, family)}`;
  return `${env}${agentCommand} --resume ${sid}${message}`;
}

export function quoteShellPaths(paths: string[], family: ShellFamily = runtimeShellFamily()): string {
  return paths.map((path) => shellQuote(path, family)).join(" ");
}

export function worktreeShellCommand(
  timestamp: string,
  branch: string,
  family: ShellFamily = runtimeShellFamily(),
): string {
  if (family === "powershell") {
    const suffix = shellQuote(`-wt-${timestamp}`, family);
    const quotedBranch = shellQuote(branch, family);
    return `$root=(git rev-parse --show-toplevel 2>&1); $code=$LASTEXITCODE; if ($code -ne 0) { Write-Output $root; exit $code }; $name=Split-Path -Leaf $root; $dest=Join-Path (Split-Path -Parent $root) ($name + ${suffix}); $result=(git worktree add -b ${quotedBranch} $dest 2>&1); $code=$LASTEXITCODE; Write-Output $result; if ($code -eq 0) { Write-Output ('OK:' + $dest) } else { exit $code }`;
  }
  return `{ root=$(git rev-parse --show-toplevel) && name=$(basename "$root") && dest="$(dirname "$root")/$name-wt-${timestamp}" && git worktree add -b "${branch}" "$dest" && echo "OK:$dest"; } 2>&1`;
}
