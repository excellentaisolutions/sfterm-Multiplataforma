[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:SFTERM_WINDOWS_PTYD_APP_EXE = Join-Path $root 'src-tauri\target\debug\app.exe'
$tests = @(
    'ptyd::windows_e2e_tests::terminal_sobrevive_reconexion_y_conserva_pid_y_replay',
    'ptyd::windows_e2e_tests::close_elimina_shell_y_descendiente_sin_huerfanos',
    'ptyd::windows_e2e_tests::dos_config_dirs_no_comparten_daemon_ni_terminales',
    'ptyd::windows_e2e_tests::cliente_lento_no_bloquea_el_pty_ni_el_control',
    'ptyd::windows_e2e_tests::daemon_versionado_permite_reemplazar_el_ejecutable_principal'
)

& node scripts/run-with-project-target.mjs cargo build `
    --manifest-path src-tauri/Cargo.toml `
    --locked `
    --offline `
    --bin app `
    --quiet
if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo compilar app.exe para el E2E de reemplazo.'
}

foreach ($test in $tests) {
    & node scripts/run-with-project-target.mjs cargo test `
        --manifest-path src-tauri/Cargo.toml `
        --locked `
        --offline `
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
