param(
    [string]$OutputDirectory = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing"),
    [string]$CertificateSubject = "CN=SFTerm Personal Code Signing",
    [int]$ValidityYears = 5
)

$ErrorActionPreference = "Stop"
$expectedDirectory = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath("UserProfile")) ".sfterm-signing"))
$outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($outputDirectory -ne $expectedDirectory) {
    throw "La ruta debe ser exactamente $expectedDirectory"
}
if (Test-Path -LiteralPath $outputDirectory) {
    throw "La ruta ya existe; no se sobrescribira: $outputDirectory"
}
if ($ValidityYears -lt 1 -or $ValidityYears -gt 10) {
    throw "ValidityYears debe estar entre 1 y 10"
}

function New-RandomSecret([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return ([Convert]::ToBase64String($bytes)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$createdCertificate = $null
try {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null

    # Elimina la herencia antes de crear secretos y concede acceso solo al SID actual.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        "FullControl",
        "ContainerInherit,ObjectInherit",
        "None",
        "Allow"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $outputDirectory -AclObject $acl

    $updaterDirectory = New-Item -ItemType Directory -Path (Join-Path $outputDirectory "updater")
    $authenticodeDirectory = New-Item -ItemType Directory -Path (Join-Path $outputDirectory "authenticode")
    $updaterPassword = New-RandomSecret
    $pfxPassword = New-RandomSecret

    $updaterKey = Join-Path $updaterDirectory.FullName "sfterm-updater.key"
    $signerLog = Join-Path ([IO.Path]::GetTempPath()) ("sfterm-signer-{0}.log" -f [Guid]::NewGuid().ToString("N"))
    try {
        & npm run tauri signer generate -- --ci --password $updaterPassword --write-keys $updaterKey *> $signerLog
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri signer termino con codigo $LASTEXITCODE"
        }
    } finally {
        if (Test-Path -LiteralPath $signerLog) {
            Remove-Item -LiteralPath $signerLog -Force
        }
    }
    Set-Content -LiteralPath (Join-Path $updaterDirectory.FullName "sfterm-updater-password.txt") -Value $updaterPassword -NoNewline -Encoding ascii

    $createdCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $CertificateSubject `
        -FriendlyName "SFTerm Personal Code Signing" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears($ValidityYears)

    $pfxPath = Join-Path $authenticodeDirectory.FullName "sfterm-personal-codesign.pfx"
    $cerPath = Join-Path $authenticodeDirectory.FullName "sfterm-personal-codesign.cer"
    $securePfxPassword = ConvertTo-SecureString $pfxPassword -AsPlainText -Force
    Export-PfxCertificate `
        -Cert $createdCertificate `
        -FilePath $pfxPath `
        -Password $securePfxPassword `
        -ChainOption EndEntityCertOnly `
        -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    Export-Certificate -Cert $createdCertificate -FilePath $cerPath -Type CERT | Out-Null
    Set-Content -LiteralPath (Join-Path $authenticodeDirectory.FullName "sfterm-pfx-password.txt") -Value $pfxPassword -NoNewline -Encoding ascii

    $metadata = [ordered]@{
        subject = $createdCertificate.Subject
        thumbprint = $createdCertificate.Thumbprint
        notBefore = $createdCertificate.NotBefore.ToUniversalTime().ToString("o")
        notAfter = $createdCertificate.NotAfter.ToUniversalTime().ToString("o")
        updaterPublicKeyFile = "updater\sfterm-updater.key.pub"
        updaterPrivateKeyFile = "updater\sfterm-updater.key"
        authenticodePfxFile = "authenticode\sfterm-personal-codesign.pfx"
        authenticodePublicCertificateFile = "authenticode\sfterm-personal-codesign.cer"
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory "metadata.json") -Encoding utf8

    $requiredFiles = @($updaterKey, "$updaterKey.pub", $pfxPath, $cerPath, (Join-Path $outputDirectory "metadata.json"))
    foreach ($file in $requiredFiles) {
        if (-not (Test-Path -LiteralPath $file)) {
            throw "No se genero $file"
        }
    }

    Write-Host "signing_root=$outputDirectory"
    Write-Host "certificate_subject=$($createdCertificate.Subject)"
    Write-Host "certificate_thumbprint=$($createdCertificate.Thumbprint)"
    Write-Host "certificate_expires=$($createdCertificate.NotAfter.ToString('yyyy-MM-dd'))"
    Write-Host "updater_keypair=generated"
    Write-Host "passwords=stored_with_restricted_acl_not_printed"
} catch {
    if ($createdCertificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($createdCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ([IO.Path]::GetFullPath($outputDirectory) -eq $expectedDirectory -and (Test-Path -LiteralPath $outputDirectory)) {
        Remove-Item -LiteralPath $outputDirectory -Recurse -Force
    }
    throw
}
