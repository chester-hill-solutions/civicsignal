#!/usr/bin/env bash
# Run the encoder locally.
#
#     bash scripts/encoder-local.sh            # the CPU, on 8810
#     ENCODER_BACKEND=gpu bash scripts/encoder-local.sh   # the GPU, on 8811
#
# The virtual environment lives in `~/.civicsignal/llmvenv` rather than in the
# system temporary directory, because **the temporary directory is cleared on a
# reboot** — and this is the environment the model is embedded with, so losing
# it means losing the ability to embed with the model at all.
#
# The model file lives in `~/.litert-lm/models/` and survives on its own.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${CIVICSIGNAL_VENV:-$HOME/.civicsignal/llmvenv}"
PORT="${ENCODER_PORT:-8810}"
BACKEND="${ENCODER_BACKEND:-cpu}"
THREADS="${ENCODER_THREADS:-4}"
MODEL="${LITERT_MODEL_PATH:-$HOME/.litert-lm/models/embeddinggemma-2-270m/model.litertlm}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "the encoder's environment is not at $VENV" >&2
  echo "  python3.12 -m venv $VENV && $VENV/bin/pip install 'litert-lm==0.18.1'" >&2
  exit 1
fi

if [ ! -s "$MODEL" ]; then
  echo "the model is not at $MODEL" >&2
  echo "  curl -fsSL 'https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm/resolve/main/embeddinggemma-2-text-270m.litertlm?download=true' -o '$MODEL'" >&2
  exit 1
fi

export LITERT_MODEL_PATH="$MODEL"
export ENCODER_BACKEND="$BACKEND"
export ENCODER_THREADS="$THREADS"
export ENCODER_TOKEN="${ENCODER_TOKEN:-test-token}"

echo "the encoder: $BACKEND on $PORT, model $(basename "$MODEL")"
exec "$VENV/bin/python" "$ROOT/services/encoder/server.py" --port "$PORT"
