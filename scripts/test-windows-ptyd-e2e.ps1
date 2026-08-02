[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tests = @(
    'ptyd::windows_e2e_tests::terminal_sobrevive_reconexion_y_conserva_pid_y_replay',
    'ptyd::windows_e2e_tests::close_elimina_shell_y_descendiente_sin_huerfanos'
)

foreach ($test in $tests) {
    & node scripts/run-with-project-target.mjs cargo test `
        --manifest-path src-tauri/Cargo.toml `
        --locked `
        $test `
        -- `
        --exact `
        --ignored `
        --nocapture `
        --test-threads=1
    if ($LASTEXITCODE -ne 0) {
        throw "Windows PTY daemon E2E failed: $test"
    }
}

Write-Host 'Windows persistent PTY daemon E2E: OK'
