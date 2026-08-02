[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "winterm-process-tree-$PID-$([guid]::NewGuid().ToString('N'))"
$childPidFile = Join-Path $testRoot 'child.pid'
$parent = $null
$childPid = 0

try {
    New-Item -ItemType Directory -Path $testRoot > $null
    $env:SFTERM_TREE_TEST_CHILD_PID = $childPidFile
    $childScript = 'Start-Sleep -Seconds 120'
    $childEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $parentScript = @"
`$child = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','$childEncoded') -PassThru
Set-Content -LiteralPath `$env:SFTERM_TREE_TEST_CHILD_PID -Value `$child.Id -NoNewline
Wait-Process -Id `$child.Id
"@
    $parentEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentScript))
    $parent = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $parentEncoded
    ) -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $childPidFile)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw 'The child process did not start before the timeout.'
        }
        Start-Sleep -Milliseconds 50
    }
    $childPid = [int](Get-Content -LiteralPath $childPidFile -Raw)

    & taskkill.exe /PID $parent.Id /T /F > $null 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "taskkill failed with exit code $LASTEXITCODE"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-Process -Id $parent.Id, $childPid -ErrorAction SilentlyContinue) -and
        [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 50
    }
    if (Get-Process -Id $parent.Id, $childPid -ErrorAction SilentlyContinue) {
        throw 'A descendant survived taskkill /T /F.'
    }

    Write-Host 'Windows process-tree termination: OK'
}
finally {
    foreach ($processId in @($childPid, $(if ($null -ne $parent) { $parent.Id } else { 0 }))) {
        if ($processId -gt 0) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $childPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\SFTERM_TREE_TEST_CHILD_PID -ErrorAction SilentlyContinue
}
