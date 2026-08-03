# Distribucion Windows

La Fase 7 produce dos instaladores x64 desde `windows-latest`:

- NSIS per-user, canal principal sin elevacion.
- MSI para despliegue corporativo.

Ambos incluyen el bootstrapper Evergreen de WebView2, se firman con
Authenticode SHA-256 y timestamp, y generan una firma independiente del updater.
El release queda en borrador hasta que se revisan `SHA256SUMS`, el SBOM CycloneDX
y la evidencia de CI.

## Secretos y variable de GitHub

- `WINDOWS_CERTIFICATE`: PFX de Authenticode codificado en Base64.
- `WINDOWS_CERTIFICATE_PASSWORD`: password de exportacion del PFX.
- `TAURI_SIGNING_PRIVATE_KEY`: clave privada del signer de Tauri.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password de esa clave.
- Variable `SFTERM_UPDATER_PUBKEY`: contenido completo de la clave publica del updater.

La clave privada del updater debe tener copia de seguridad fuera del repositorio.
Perderla impide actualizar instalaciones existentes. La clave publica no es
secreta y se integra en el binario durante el workflow.

## Publicacion y rollback

El workflow `.github/workflows/release.yml` se ejecuta con tags `vX.Y.Z` o de
forma manual. El tag debe coincidir con las versiones de `package.json`,
`src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`.

Los releases se crean como borrador. Tras revisar firmas, hashes, SBOM y una
instalacion limpia, se publican manualmente. Para rollback se publica como
release mas reciente una version anterior firmada por la misma clave; SFTerm
acepta una version distinta aunque su SemVer sea menor, pero nunca un artefacto
sin firma valida.

Mientras este repositorio sea privado, el endpoint GitHub de `latest.json` no es
accesible anonimamente desde los equipos instalados. No se debe publicar el
primer canal automatico hasta hacer publicos los assets o mover `latest.json` y
los instaladores a un endpoint HTTPS publico.

ARM64 se habilitara cuando la matriz nativa (ConPTY, WebView2, WASAPI, updater e
instaladores) tenga la misma evidencia que x64; no se publica un asset nominal
sin paridad comprobada.

## Artefactos de prueba sin certificado

`package-windows-unsigned.yml` es un workflow manual y tambien se activa cuando
cambia el empaquetado. Solo lee el contenido del repositorio y nunca publica
releases. Genera artefactos marcados `UNSIGNED TEST ARTIFACTS - DO NOT
DISTRIBUTE`, los conserva siete dias y nunca crea un GitHub Release. Tambien
ejecuta un ciclo NSIS limpio con una version base y otra de upgrade, comprueba
que el binario instalado arranca sin toolchain y confirma que config y sesion
sobreviven tanto al upgrade como al uninstall silencioso.

El desinstalador interactivo incluye la casilla de borrado de datos de Tauri. El
hook `src-tauri/windows/nsis-hooks.nsh` extiende esa casilla a las rutas reales
de SFTerm (`%APPDATA%\SFTerm` y `%LOCALAPPDATA%\SFTerm`) y la ignora siempre en
modo update.

La CI general ejecuta `npm audit` para dependencias de produccion y el action
oficial `rustsec/audit-check` contra `src-tauri/Cargo.lock`. Una vulnerabilidad
alta de npm o un advisory RustSec hace fallar la puerta de validacion.
