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

    # Isolate this terminal from PowerShell's persistent global history. The
    # file is intentionally never written; PSReadLine still keeps commands in
    # memory so Up/Down work for the lifetime of this terminal.
    $sftermSessionHistory = Join-Path ([System.IO.Path]::GetTempPath()) "sfterm-psreadline-$PID.history"
    Set-PSReadLineOption -HistorySavePath $sftermSessionHistory -HistorySaveStyle SaveNothing

    # A fresh terminal must look fresh. PSReadLine can paint the last global
    # history entry as dim predictive text even with an empty input buffer;
    # visually that looks like WinTerm injected a command. Disable only the
    # prediction inside this child shell. History itself remains untouched.
    try {
        Set-PSReadLineOption -PredictionSource None
    }
    catch {
        # Older PSReadLine versions have no prediction feature/property.
    }

    # PSReadLine may already have loaded the global history before the options
    # above change. Clear only its in-memory copy for this new child shell:
    # the history file is never deleted or rewritten, and commands entered
    # from now on remain available during the current terminal session.
    try {
        [Microsoft.PowerShell.PSConsoleReadLine]::ClearHistory()
    }
    catch {
        # The method is unavailable only on older versions without prediction.
    }

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
