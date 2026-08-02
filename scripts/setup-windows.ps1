[CmdletBinding()]
param(
    [switch]$InstallPrerequisites,
    [switch]$SkipDependencies,
    [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not $IsWindows) {
    throw "Este bootstrap es exclusivo de Windows."
}

function Install-WinGetPackage {
    param(
        [Parameter(Mandatory)]
        [string]$Id,
        [string]$Override
    )

    $arguments = @(
        "install", "--exact", "--id", $Id,
        "--accept-package-agreements", "--accept-source-agreements"
    )
    if ($Override) {
        $arguments += @("--override", $Override)
    }

    & winget @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "WinGet no pudo instalar $Id (exit $LASTEXITCODE)."
    }
}

Write-Host "WinTerm: preparación reproducible de Windows"

if ($InstallPrerequisites) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "WinGet no está disponible. Instala/actualiza App Installer desde Microsoft Store."
    }

    Install-WinGetPackage -Id "OpenJS.NodeJS.LTS"
    Install-WinGetPackage -Id "Rustlang.Rustup"
    Install-WinGetPackage -Id "Microsoft.EdgeWebView2Runtime"

    $vsConfig = Join-Path $projectRoot ".vsconfig"
    $vsOverride = "--passive --wait --norestart --config `"$vsConfig`""
    Install-WinGetPackage `
        -Id "Microsoft.VisualStudio.2022.BuildTools" `
        -Override $vsOverride

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js no está disponible. Ejecuta de nuevo con -InstallPrerequisites o instala Node 24 LTS."
}
if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) {
    throw "rustup no está disponible. Ejecuta de nuevo con -InstallPrerequisites o instálalo desde rustup.rs."
}

$compatibleToolchain = & node scripts/resolve-rust-toolchain.mjs
if ($LASTEXITCODE -ne 0) {
    & rustup toolchain install 1.97.0 --profile minimal --component rustfmt --component clippy
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo instalar/verificar el toolchain Rust fijado."
    }
} else {
    Write-Host "Rust 1.97.0 ya disponible como $compatibleToolchain; no se duplica."
}

& node scripts/check-environment.mjs
if ($LASTEXITCODE -ne 0) {
    throw "El entorno no cumple los requisitos. Corrige los errores anteriores y repite."
}

if (-not $SkipDependencies) {
    & npm ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci falló."
    }

    & node scripts/run-with-project-target.mjs cargo fetch `
        --manifest-path src-tauri/Cargo.toml --locked
    if ($LASTEXITCODE -ne 0) {
        throw "cargo fetch --locked falló."
    }
}

if (-not $SkipValidation) {
    & npm run validate:frontend
    if ($LASTEXITCODE -ne 0) {
        throw "La validación frontend falló."
    }
}

Write-Host ""
Write-Host "Entorno WinTerm preparado."
Write-Host "Los artefactos Rust se guardarán únicamente en src-tauri/target."
Write-Host "La validación nativa Windows se habilitará al completar la frontera de plataforma de la Fase 1."
