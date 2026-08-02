# WinTerm PowerShell integration. Generated into the application config directory.
# This file is executed only inside the child shell; it never modifies $PROFILE.

if ($env:TERM_PROGRAM -ne 'SFTerm' -or $global:__SFTermShellIntegrationLoaded) {
    return
}

$global:__SFTermShellIntegrationLoaded = $true
$global:__SFTermCommandRunning = $false
$global:__SFTermOriginalPrompt = (Get-Item Function:\prompt).ScriptBlock

function global:__SFTermWriteOsc {
    param([Parameter(Mandatory = $true)][string] $Payload)

    [Console]::Write("$([char]27)]$Payload$([char]7)")
}

function global:__SFTermWriteCwd {
    if ($PWD.Provider.Name -ne 'FileSystem') {
        return
    }

    try {
        $uri = [System.Uri]::new($PWD.ProviderPath).AbsoluteUri
        __SFTermWriteOsc "7;$uri"
    }
    catch {
        # A non-standard provider path must never break the user's prompt.
    }
}

function global:prompt {
    $sftermSucceeded = $?
    $sftermExitCode = if ($sftermSucceeded) {
        0
    }
    elseif ($null -ne $global:LASTEXITCODE) {
        [int]$global:LASTEXITCODE
    }
    else {
        1
    }

    if ($global:__SFTermCommandRunning) {
        __SFTermWriteOsc "133;D;$sftermExitCode"
        $global:__SFTermCommandRunning = $false
    }

    __SFTermWriteCwd
    __SFTermWriteOsc '133;A'
    & $global:__SFTermOriginalPrompt
}

try {
    Import-Module PSReadLine -ErrorAction Stop
    $sftermOptions = Get-PSReadLineOption
    $global:__SFTermPreviousHistoryHandler = $sftermOptions.AddToHistoryHandler

    Set-PSReadLineOption -AddToHistoryHandler {
        param([string] $line)

        $safeLine = $line -replace "[$([char]27)$([char]7)\r\n]", ' '
        __SFTermWriteOsc "633;E;$safeLine"
        __SFTermWriteOsc '133;C'
        $global:__SFTermCommandRunning = $true

        if ($null -ne $global:__SFTermPreviousHistoryHandler) {
            return $global:__SFTermPreviousHistoryHandler.Invoke($line)
        }
        return $true
    }
}
catch {
    # PowerShell remains fully usable if PSReadLine is unavailable. OSC 7 and
    # prompt boundaries still work; only command text/pre-exec markers degrade.
}
