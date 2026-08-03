param(
    [string]$SigningDirectory = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing")
)

$ErrorActionPreference = "Stop"
$expectedDirectory = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing"))
$signingDirectory = [IO.Path]::GetFullPath($SigningDirectory)
if ($signingDirectory -ne $expectedDirectory) {
    throw "La ruta debe ser exactamente $expectedDirectory"
}

$metadata = Get-Content -Raw -LiteralPath (Join-Path $signingDirectory "metadata.json") | ConvertFrom-Json
$thumbprint = $metadata.thumbprint
if ($thumbprint -notmatch "^[A-F0-9]{40,64}$") {
    throw "La huella del certificado no es valida"
}
$certificatePath = Join-Path $signingDirectory $metadata.authenticodePublicCertificateFile
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint"
if (-not $certificate.HasPrivateKey) {
    throw "El certificado personal no contiene clave privada"
}

foreach ($store in @("Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) {
    if (-not (Test-Path -LiteralPath (Join-Path $store $thumbprint))) {
        Import-Certificate -FilePath $certificatePath -CertStoreLocation $store | Out-Null
    }
}

$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
$testDirectory = Join-Path $tempParent ("sfterm-signing-test-{0}" -f [Guid]::NewGuid().ToString("N"))
$testDirectory = [IO.Path]::GetFullPath($testDirectory)
if (-not $testDirectory.StartsWith("$tempParent\sfterm-signing-test-", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Ruta temporal inesperada"
}
New-Item -ItemType Directory -Path $testDirectory | Out-Null

try {
    $authenticodeTest = Join-Path $testDirectory "authenticode-test.ps1"
    Set-Content -LiteralPath $authenticodeTest -Value 'Write-Output "SFTerm signing test"' -Encoding utf8
    $signed = Set-AuthenticodeSignature -FilePath $authenticodeTest -Certificate $certificate -HashAlgorithm SHA256
    if ($signed.Status -ne "Valid") {
        throw "Firma Authenticode invalida: $($signed.Status) $($signed.StatusMessage)"
    }

    $updaterTest = Join-Path $testDirectory "updater-test.bin"
    [IO.File]::WriteAllBytes($updaterTest, [Text.Encoding]::UTF8.GetBytes("SFTerm updater signing test"))
    $previousKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    $previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    try {
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = Join-Path $signingDirectory $metadata.updaterPrivateKeyFile
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw -LiteralPath (Join-Path $signingDirectory "updater\sfterm-updater-password.txt")
        & npm run tauri signer sign -- $updaterTest | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri signer termino con codigo $LASTEXITCODE"
        }
    } finally {
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $previousKeyPath
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
    }
    $signaturePath = "$updaterTest.sig"
    if (-not (Test-Path -LiteralPath $signaturePath) -or (Get-Item -LiteralPath $signaturePath).Length -eq 0) {
        throw "No se genero la firma del updater"
    }

    $rootAcl = Get-Acl -LiteralPath $signingDirectory
    $allowed = @($rootAcl.Access | Where-Object AccessControlType -eq "Allow")
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($allowed.Count -ne 1 -or $allowed[0].IdentityReference.Value -ne $currentIdentity) {
        throw "La ACL de claves no esta restringida exclusivamente al usuario actual"
    }

    Write-Host "authenticode_status=$($signed.Status)"
    Write-Host "updater_signature=generated"
    Write-Host "trusted_root_current_user=$([bool](Test-Path -LiteralPath "Cert:\CurrentUser\Root\$thumbprint"))"
    Write-Host "trusted_publisher_current_user=$([bool](Test-Path -LiteralPath "Cert:\CurrentUser\TrustedPublisher\$thumbprint"))"
    Write-Host "signing_acl_identity=$currentIdentity"
} finally {
    if ($testDirectory.StartsWith("$tempParent\sfterm-signing-test-", [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testDirectory)) {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force
    }
}
