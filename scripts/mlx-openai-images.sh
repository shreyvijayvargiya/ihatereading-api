#!/usr/bin/env bash
# Local Flux image generation on Apple Silicon via mlx-openai-server.
# pip install mlx-openai-server
set -euo pipefail

if ! command -v mlx-openai-server >/dev/null 2>&1; then
  echo "mlx-openai-server is not installed."
  echo "On this MacBook (Python 3.11+):"
  echo "  python3.11 -m venv .venv && source .venv/bin/activate"
  echo "  pip install mlx-openai-server"
  exit 1
fi

MODEL_PATH="${MLX_IMAGE_MODEL_PATH:-black-forest-labs/FLUX.1-schnell}"
CONFIG="${MLX_IMAGE_CONFIG:-flux-schnell}"
PORT="${MLX_OPENAI_PORT:-8000}"
QUANT="${MLX_IMAGE_QUANTIZE:-8}"
SERVED="${MLX_IMAGE_MODEL:-local-image-generation-model}"

echo "[mlx-images] ${CONFIG}  model=${MODEL_PATH}  port=${PORT}  quantize=${QUANT}"
echo "[mlx-images] OpenAI base URL: http://127.0.0.1:${PORT}/v1"
echo "[mlx-images] Other configs: flux-schnell | flux-dev | flux-krea-dev | flux2-klein-4b | flux2-klein-9b"

exec mlx-openai-server launch \
  --model-type image-generation \
  --model-path "$MODEL_PATH" \
  --config-name "$CONFIG" \
  --quantize "$QUANT" \
  --port "$PORT" \
  --served-model-name "$SERVED"
