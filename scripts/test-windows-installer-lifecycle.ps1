param(
    [Parameter(Mandatory = $true)]
    [string]$BaselineInstaller,
    [Parameter(Mandatory = $true)]
    [string]$UpgradeInstaller,
    [switch]$AllowLocalInstall
)

$ErrorActionPreference = "Stop"
if ($env:CI -ne "true" -and -not $AllowLocalInstall) {
    throw "Este test modifica HKCU y LOCALAPPDATA. Ejecutalo en CI o usa -AllowLocalInstall explicitamente."
}

$baseline = (Resolve-Path -LiteralPath $BaselineInstaller).Path
$upgrade = (Resolve-Path -LiteralPath $UpgradeInstaller).Path
$installDir = Join-Path $env:LOCALAPPDATA "SFTerm"
$roamingData = Join-Path $env:APPDATA "SFTerm"
$localData = $installDir
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SFTerm"
$manufacturerKey = "HKCU:\Software\saasfactory\SFTerm"
$testTemp = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$runtimeState = Join-Path $testTemp "sfterm-installer-lifecycle-state"
$markerName = ".sfterm-installer-e2e"
$token = [Guid]::NewGuid().ToString("N")
$installedByTest = $false

function Invoke-Installer([string]$Path, [string[]]$Arguments) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "$([IO.Path]::GetFileName($Path)) termino con codigo $($process.ExitCode)"
    }
}

function Assert-Path([string]$Path, [string]$Message) {
    if (-not (Test-Path -LiteralPath $Path)) { throw $Message }
}

function Remove-OwnedTestDirectory([string]$Path) {
    $marker = Join-Path $Path $markerName
    if ((Test-Path -LiteralPath $marker) -and (Get-Content -Raw -LiteralPath $marker).Trim() -eq $token) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $roamingData)) {
    throw "El runner no esta limpio; se rehusa a tocar una instalacion o datos existentes de SFTerm."
}

try {
    Invoke-Installer $baseline @("/S")
    $installedByTest = $true
    $app = Join-Path $installDir "app.exe"
    $uninstaller = Join-Path $installDir "uninstall.exe"
    Assert-Path $app "NSIS no instalo app.exe en LOCALAPPDATA\SFTerm"
    Assert-Path $uninstaller "NSIS no genero uninstall.exe"
    Assert-Path $uninstallKey "NSIS no registro la desinstalacion en HKCU"
    $baselineVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion

    New-Item -ItemType Directory -Path $roamingData, $runtimeState | Out-Null
    Set-Content -LiteralPath (Join-Path $roamingData $markerName) -Value $token -NoNewline
    Set-Content -LiteralPath (Join-Path $localData $markerName) -Value $token -NoNewline
    Set-Content -LiteralPath (Join-Path $runtimeState $markerName) -Value $token -NoNewline
    Set-Content -LiteralPath (Join-Path $roamingData "config.toml") -Value "phase7 = 'preserve'" -NoNewline
    Set-Content -LiteralPath (Join-Path $localData "session.json") -Value '{"phase7":"preserve"}' -NoNewline

    $previousConfig = $env:SFTERM_CONFIG_DIR
    $env:SFTERM_CONFIG_DIR = $runtimeState
    try {
        $daemon = Start-Process -FilePath $app -ArgumentList @("--ptyd") -PassThru
        Start-Sleep -Seconds 2
        if ($daemon.HasExited) { throw "El binario instalado no pudo arrancar sin toolchain de desarrollo" }
        Stop-Process -Id $daemon.Id -Force
        $daemon.WaitForExit()
    } finally {
        $env:SFTERM_CONFIG_DIR = $previousConfig
    }

    Invoke-Installer $upgrade @("/S")
    Assert-Path $app "El upgrade elimino app.exe"
    Assert-Path (Join-Path $roamingData "config.toml") "El upgrade elimino config.toml"
    Assert-Path (Join-Path $localData "session.json") "El upgrade elimino session.json"

    $displayVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
    if ($displayVersion -eq $baselineVersion) { throw "El upgrade no cambio DisplayVersion ($displayVersion)" }

    Invoke-Installer $uninstaller @("/S")
    $installedByTest = $false
    if (Test-Path -LiteralPath $app) { throw "Uninstall no elimino app.exe" }
    if (Test-Path -LiteralPath $uninstaller) { throw "Uninstall no elimino uninstall.exe" }
    if (Test-Path -LiteralPath $uninstallKey) { throw "Uninstall no elimino su clave HKCU" }
    Assert-Path (Join-Path $roamingData "config.toml") "Uninstall silencioso borro datos roaming sin consentimiento"
    Assert-Path (Join-Path $localData "session.json") "Uninstall silencioso borro datos locales sin consentimiento"

    Write-Host "Windows NSIS lifecycle: clean install + runtime + upgrade + uninstall preserve data OK"
} finally {
    if ($installedByTest -and (Test-Path -LiteralPath (Join-Path $installDir "uninstall.exe"))) {
        Invoke-Installer (Join-Path $installDir "uninstall.exe") @("/S")
    }
    Remove-OwnedTestDirectory $roamingData
    Remove-OwnedTestDirectory $localData
    Remove-OwnedTestDirectory $runtimeState
    if ((Test-Path -LiteralPath $manufacturerKey) -and -not (Get-ChildItem -LiteralPath $manufacturerKey)) {
        Remove-Item -LiteralPath $manufacturerKey -Force
    }
}
