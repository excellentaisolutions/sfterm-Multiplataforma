param(
    [string]$SigningDirectory = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing")
)

$ErrorActionPreference = "Stop"
$expectedSigningDirectory = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing"))
$signingDirectory = [IO.Path]::GetFullPath($SigningDirectory)
if ($signingDirectory -ne $expectedSigningDirectory) {
    throw "La ruta debe ser exactamente $expectedSigningDirectory"
}

$metadataPath = Join-Path $signingDirectory "metadata.json"
if (-not (Test-Path -LiteralPath $metadataPath)) {
    throw "No existen credenciales personales. Ejecuta primero: npm run signing:personal:generate"
}
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$thumbprint = $metadata.thumbprint
foreach ($store in @("My", "Root", "TrustedPublisher")) {
    if (-not (Test-Path -LiteralPath "Cert:\CurrentUser\$store\$thumbprint")) {
        throw "Falta el certificado $thumbprint en CurrentUser\$store"
    }
}

$workspace = [IO.Path]::GetFullPath((Get-Location).Path)
$bundleRoot = [IO.Path]::GetFullPath((Join-Path $workspace "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"))
$expectedBundleRoot = [IO.Path]::GetFullPath((Join-Path $workspace "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"))
if ($bundleRoot -ne $expectedBundleRoot -or -not $bundleRoot.StartsWith("$workspace\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Ruta de bundle inesperada"
}
foreach ($name in @("nsis", "msi")) {
    $generatedDirectory = Join-Path $bundleRoot $name
    if (Test-Path -LiteralPath $generatedDirectory) {
        Remove-Item -LiteralPath $generatedDirectory -Recurse -Force
    }
}

$previous = @{
    SFTERM_UPDATER_PUBKEY = $env:SFTERM_UPDATER_PUBKEY
    WINDOWS_CERTIFICATE_THUMBPRINT = $env:WINDOWS_CERTIFICATE_THUMBPRINT
    SFTERM_AUTHENTICODE_TIMESTAMP_URL = $env:SFTERM_AUTHENTICODE_TIMESTAMP_URL
    TAURI_SIGNING_PRIVATE_KEY = $env:TAURI_SIGNING_PRIVATE_KEY
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
try {
    $env:SFTERM_UPDATER_PUBKEY = Get-Content -Raw -LiteralPath (Join-Path $signingDirectory $metadata.updaterPublicKeyFile)
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = $thumbprint
    $env:SFTERM_AUTHENTICODE_TIMESTAMP_URL = "none"
    $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $signingDirectory $metadata.updaterPrivateKeyFile
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw -LiteralPath (Join-Path $signingDirectory "updater\sfterm-updater-password.txt")

    & npm run release:config
    if ($LASTEXITCODE -ne 0) { throw "release:config termino con codigo $LASTEXITCODE" }
    & npm run tauri build -- --target x86_64-pc-windows-msvc --config src-tauri/target/release-config.json
    if ($LASTEXITCODE -ne 0) { throw "tauri build termino con codigo $LASTEXITCODE" }
    & npm run release:verify:windows
    if ($LASTEXITCODE -ne 0) { throw "release:verify:windows termino con codigo $LASTEXITCODE" }
} finally {
    $env:SFTERM_UPDATER_PUBKEY = $previous.SFTERM_UPDATER_PUBKEY
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = $previous.WINDOWS_CERTIFICATE_THUMBPRINT
    $env:SFTERM_AUTHENTICODE_TIMESTAMP_URL = $previous.SFTERM_AUTHENTICODE_TIMESTAMP_URL
    $env:TAURI_SIGNING_PRIVATE_KEY = $previous.TAURI_SIGNING_PRIVATE_KEY
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previous.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
