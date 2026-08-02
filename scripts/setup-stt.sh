#!/bin/zsh
# Dictado por voz de SFTerm: instala las piezas del STT local.
# - ffmpeg: captura el microfono (avfoundation)
# - whisper-cpp: transcribe 100% local (whisper-cli)
# - modelo ggml: large-v3-turbo cuantizado (~550MB, el mejor balance
#   calidad/velocidad en Apple Silicon para español)
set -euo pipefail

MODELS_DIR="$HOME/.config/sfterm/models"
MODEL="ggml-large-v3-turbo-q5_0.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"

echo "▸ SFTerm STT setup"

if ! command -v brew >/dev/null; then
  echo "✗ falta Homebrew (https://brew.sh)"; exit 1
fi

for pkg in ffmpeg whisper-cpp; do
  if brew list "$pkg" >/dev/null 2>&1 || command -v "${pkg/whisper-cpp/whisper-cli}" >/dev/null; then
    echo "✓ $pkg ya instalado"
  else
    echo "▸ instalando $pkg…"
    brew install "$pkg"
  fi
done

mkdir -p "$MODELS_DIR"
if [ -f "$MODELS_DIR/$MODEL" ]; then
  echo "✓ modelo ya descargado: $MODELS_DIR/$MODEL"
else
  echo "▸ descargando modelo (~550MB)…"
  curl -L --progress-bar -o "$MODELS_DIR/$MODEL.part" "$URL"
  mv "$MODELS_DIR/$MODEL.part" "$MODELS_DIR/$MODEL"
  echo "✓ modelo listo: $MODELS_DIR/$MODEL"
fi

echo ""
echo "Listo. Abre SFTerm → ⌘L → 🎤 para dictar."
echo "(La primera vez macOS pide permiso de micrófono: un click y ya.)"
