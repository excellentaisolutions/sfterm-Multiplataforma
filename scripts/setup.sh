#!/bin/zsh
# Setup E2E de SFTerm en una Mac nueva (ej. la laptop): deps → build → instalar.
# Uso:  git clone <repo> && cd sfterm && ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ SFTerm setup E2E"

# 1) toolchain
if ! command -v brew >/dev/null; then
  echo "✗ falta Homebrew (https://brew.sh)"; exit 1
fi
if ! command -v node >/dev/null; then
  echo "▸ instalando node…"; brew install node
fi
if ! command -v cargo >/dev/null; then
  echo "▸ instalando rust…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
echo "✓ node $(node -v) · cargo $(cargo --version | cut -d' ' -f2)"

# 2) deps del frontend
echo "▸ npm install…"
npm install

# 3) dictado por voz (ffmpeg + whisper + modelo). No es fatal si falla:
#    la app funciona sin dictado y el boton 🎤 te dice que falta.
./scripts/setup-stt.sh || echo "⚠ STT incompleto (el chat funciona igual, sin 🎤)"

# 4) build release + instalar en /Applications
echo "▸ build release (tarda unos minutos la primera vez)…"
npm run tauri build
APP="src-tauri/target/release/bundle/macos/SFTerm.app"
rm -rf /Applications/SFTerm.app
cp -R "$APP" /Applications/
echo "✓ instalado en /Applications/SFTerm.app"

# 5) el agente del chat (⌘L) usa el comando de general.agent_command del
#    config (~/.config/sfterm/config.toml). Default: claude.
if ! command -v claude >/dev/null; then
  echo "⚠ claude CLI no encontrado: el chat nativo (⌘L) lo necesita."
  echo "  npm install -g @anthropic-ai/claude-code   (y luego: claude login)"
fi

open /Applications/SFTerm.app
echo ""
echo "Listo. ⌘L = chat con el agente · ⌘K = paleta · ⌘J = terminal nueva."
