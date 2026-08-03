# Historial multiproveedor

WinTerm trata el historial como datos locales de cada harness. Abrir una
conversación es siempre una operación de solo lectura: no inicia el agente, no
envía prompts y no requiere que sus credenciales estén disponibles. Continuar
es una acción explícita y abre una terminal nueva con el CLI que creó la sesión.

## Proveedores soportados

| Proveedor | Índice y transcript local | Reanudación |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` y raíces declaradas en `history.claude_roots` | `claude --resume <id> --model <modelo>`; conserva `CLAUDE_CONFIG_DIR` cuando corresponde |
| Codex CLI | `$CODEX_HOME/sessions/**/*.jsonl`, por defecto `~/.codex/sessions` | `codex resume <id> --model <modelo> --cd <cwd>`; conserva `CODEX_HOME` no predeterminado |
| Kimi Code | `$KIMI_CODE_HOME/session_index.jsonl`, `state.json` y `agents/main/wire.jsonl`, por defecto bajo `~/.kimi-code` | `kimi --session <id> --model <modelo>`; conserva `KIMI_CODE_HOME` |

Cada tarjeta conserva proveedor, identificador de sesión, transcript, carpeta
de trabajo, raíz de configuración y último modelo conocido. Al continuar se usa
ese modelo como valor predeterminado. Si el modelo ya no existe o la cuenta no
tiene acceso, el CLI debe mostrar el error: WinTerm no sustituye silenciosamente
el modelo por otro.

El lector y el indexador son multiplataforma. Rust lee colas acotadas del JSONL
directamente y elimina blobs base64 grandes antes de cruzar el IPC; no ejecuta
`tail`, Perl, Bash ni PowerShell. Así, cambiar de sistema operativo no cambia el
contrato del lector y una ruta con espacios o Unicode no se interpreta como un
comando.

## Contrato para añadir otro harness

Un proveedor sólo debe incorporarse a la lista cuando tenga las cuatro piezas:

1. Descubrimiento local acotado y ordenado por actividad.
2. Parser que convierta su formato persistido en mensajes legibles.
3. Identidad suficiente para restaurar sesión, cuenta/configuración, cwd y
   modelo.
4. Comando de reanudación propio, con quoting PowerShell/POSIX y pruebas.

Detectar un proceso para mostrar su pantalla en vivo no lo convierte por sí
solo en proveedor de historial. Tampoco se intenta un resume genérico con otro
CLI: una conversación Codex siempre continúa con Codex, una Kimi con Kimi y una
Claude con Claude.

## Privacidad y repositorio

- Los transcripts, rutas completas, credenciales, tokens y configuraciones se
  leen únicamente en tiempo de ejecución y no se copian al repositorio.
- La lectura no contacta las APIs de Claude, OpenAI ni Kimi.
- Continuar sí requiere que el CLI correspondiente esté instalado y autenticado
  localmente; WinTerm no almacena ni publica esas credenciales.
- Fixtures y documentación usan identificadores y rutas sintéticos. Nunca se
  deben añadir certificados, PFX, claves del updater, huellas, contraseñas ni
  rutas personales reales a Git.

Kimi Code actual usa `~/.kimi-code`. El formato legado de `~/.kimi` no se anuncia
como compatible hasta que tenga indexador, parser y prueba de reanudación propios.
