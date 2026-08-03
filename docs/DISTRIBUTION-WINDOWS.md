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

## Firma personal autofirmada

### Prerrequisito obligatorio antes de generar un instalador

La identidad autofirmada debe existir **antes** de ejecutar cualquier build
personal del instalador. En una maquina nueva el orden obligatorio es:

1. `npm run signing:personal:generate` (una sola vez).
2. Guardar una copia de seguridad privada de `%USERPROFILE%\.sfterm-signing`.
3. `npm run signing:personal:verify`.
4. `npm run release:personal:windows`.

El ultimo comando falla de forma explicita si no se completo primero la
generacion. La clave cifrada del updater, el PFX, sus contraseñas, el certificado
publico y los metadatos se guardan exclusivamente fuera del workspace en
`%USERPROFILE%\.sfterm-signing`, con herencia de permisos desactivada y acceso
solo para el usuario actual. Perder la clave del updater impide actualizar
instalaciones que ya confien en su clave publica.

### Politica para compartir el repositorio

Nunca se copia ni publica en Git el directorio de firma ni ninguno de sus
archivos: PFX/P12, CER, claves privadas o publicas, contraseñas, Base64,
fingerprints, metadatos o rutas que identifiquen una cuenta local. La
documentacion y los scripts solo contienen nombres y procedimientos genericos.
`.gitignore` bloquea los formatos habituales y `npm run check:distribution`
falla si Git rastrea material de firma, marcadores de clave/certificado o una
ruta personal de Windows.

`npm run signing:personal:verify` instala solo el certificado publico generado en los
almacenes `Root` y `TrustedPublisher` de `CurrentUser`, firma archivos temporales
y verifica ambas identidades. El workflow de release reconoce un PFX
autofirmado y confia temporalmente en su certificado dentro del runner para
validar los artefactos. Cada equipo personal que vaya a instalar SFTerm debe
importar previamente el `.cer`; esto no constituye confianza publica ni elimina
SmartScreen para terceros.

`npm run release:personal:windows` prepara la configuracion con esas claves,
construye NSIS/MSI x64 y exige que ambos instaladores tengan Authenticode
valido, la huella esperada, firma del updater y manifiesto SHA-256.
El build personal omite timestamp externo de forma explicita; la firma sera
valida hasta la caducidad configurada localmente. El release de produccion
mantiene el timestamp configurado por defecto.
