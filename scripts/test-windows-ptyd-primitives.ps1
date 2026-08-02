[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolchain = (& node (Join-Path $PSScriptRoot 'resolve-rust-toolchain.mjs')).Trim()
if (-not $toolchain) {
    throw 'No hay un toolchain Rust compatible con la versión fijada por el proyecto.'
}

$outputDir = Join-Path $root 'src-tauri\target\probes'
$output = Join-Path $outputDir 'windows-ptyd-primitives.exe'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

try {
    & rustup run $toolchain rustc `
        --edition 2021 `
        (Join-Path $PSScriptRoot 'windows-ptyd-primitives.rs') `
        --crate-name windows_ptyd_primitives `
        -o $output
    if ($LASTEXITCODE -ne 0) {
        throw "rustc terminó con código $LASTEXITCODE"
    }
    & $output
    if ($LASTEXITCODE -ne 0) {
        throw "la sonda terminó con código $LASTEXITCODE"
    }
}
finally {
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ([System.IO.Path]::ChangeExtension($output, '.pdb')) `
        -Force -ErrorAction SilentlyContinue
}
