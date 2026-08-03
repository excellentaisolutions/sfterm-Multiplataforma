[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$profilePath = (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri\resources\shell\sfterm-profile.ps1')).Path

$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $profilePath,
    [ref] $tokens,
    [ref] $parseErrors
) > $null
if ($parseErrors.Count -gt 0) {
    throw "Invalid PowerShell integration syntax: $($parseErrors[0].Message)"
}
$engines = @(
    Get-Command powershell.exe, pwsh.exe -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source -Unique
)
if ($engines.Count -eq 0) {
    throw 'Neither powershell.exe nor pwsh.exe is available.'
}

$env:SFTERM_TEST_PROFILE = $profilePath
$probe = @'
$ErrorActionPreference = 'Stop'
$env:TERM_PROGRAM = 'SFTerm'
. $env:SFTERM_TEST_PROFILE
$options = Get-PSReadLineOption
if ($null -ne $options.PSObject.Properties['PredictionSource'] -and $options.PredictionSource -ne 'None') {
    throw "Predictive command text remains enabled: $($options.PredictionSource)"
}
$handler = $options.AddToHistoryHandler
$null = $handler.Invoke('Write-Output hello')
$null = prompt
'@

$escape = [char] 27
$bell = [char] 7
$markers = @(
    "$escape]633;E;Write-Output hello$bell",
    "$escape]133;C$bell",
    "$escape]133;D;0$bell",
    "$escape]7;file:///",
    "$escape]133;A$bell"
)

foreach ($engine in $engines) {
    $output = (& $engine -NoLogo -NoProfile -NonInteractive -Command $probe 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "$engine exited with code $LASTEXITCODE. Output: $output"
    }

    $cursor = 0
    foreach ($marker in $markers) {
        $index = $output.IndexOf($marker, $cursor, [System.StringComparison]::Ordinal)
        if ($index -lt 0) {
            throw "$engine did not emit the expected OSC contract in order. Missing marker: $marker"
        }
        $cursor = $index + $marker.Length
    }

    Write-Host "PowerShell OSC integration: OK ($engine)"
}
