param(
    [string]$BundleRoot = "src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
    [string]$ExpectedThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $BundleRoot).Path
$nsis = @(Get-ChildItem -LiteralPath (Join-Path $root "nsis") -Filter "*-setup.exe" -File)
$msi = @(Get-ChildItem -LiteralPath (Join-Path $root "msi") -Filter "*.msi" -File)

if ($nsis.Count -ne 1) { throw "Se esperaba un unico instalador NSIS; encontrados: $($nsis.Count)" }
if ($msi.Count -ne 1) { throw "Se esperaba un unico instalador MSI; encontrados: $($msi.Count)" }

$installers = @($nsis[0], $msi[0])
$normalizedThumbprint = $ExpectedThumbprint.Replace(" ", "").ToUpperInvariant()
foreach ($installer in $installers) {
    if ($installer.Length -le 0) { throw "Artefacto vacio: $($installer.FullName)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.Status -ne "Valid") { throw "Firma Authenticode no valida en $($installer.Name): $($signature.Status)" }
    if ($signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $normalizedThumbprint) {
        throw "Firmante inesperado en $($installer.Name)"
    }
    $updaterSignature = "$($installer.FullName).sig"
    if (-not (Test-Path -LiteralPath $updaterSignature)) { throw "Falta firma updater: $updaterSignature" }
    if ((Get-Item -LiteralPath $updaterSignature).Length -lt 32) { throw "Firma updater vacia o truncada: $updaterSignature" }
}

$artifactDir = Join-Path (Get-Location) "artifacts"
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$signatureFiles = @(
    Get-Item -LiteralPath "$($nsis[0].FullName).sig"
    Get-Item -LiteralPath "$($msi[0].FullName).sig"
)
$hashes = foreach ($file in $installers + $signatureFiles) {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName
    "$($hash.Hash.ToLowerInvariant())  $($file.Name)"
}
$manifestPath = Join-Path $artifactDir "SHA256SUMS"
[IO.File]::WriteAllLines($manifestPath, [string[]]$hashes, (New-Object Text.UTF8Encoding($false)))
Write-Host "release artifacts: Authenticode, updater signatures and SHA-256 manifest OK"
