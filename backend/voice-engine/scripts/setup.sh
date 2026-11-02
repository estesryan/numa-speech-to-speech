#!/usr/bin/env bash
# Idempotent developer setup for the Numa voice engine. Safe to re-run; it only does what is missing.
#
#   backend/voice-engine/scripts/setup.sh            # fast profile (Qwen3.5-4B, default)
#   backend/voice-engine/scripts/setup.sh quality    # also the optional 9B profile's models
#   backend/voice-engine/scripts/setup.sh all        # every model in the manifest
set -euo pipefail
PROFILE="${1:-fast}"
cd "$(dirname "$0")/.."

# 1. Platform: Apple Silicon (MLX) and uv
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The voice engine needs an Apple Silicon Mac (MLX)." >&2; exit 1
fi
if ! command -v uv >/dev/null; then
  echo "uv is required: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1
fi

# 2. Python 3.12 environment from uv.lock (uv installs Python 3.12 itself if needed)
uv sync --frozen

# 3. Models under <project>/models (or $NUMA_MODELS_DIR), pinned revisions, only this profile's.
#    If a Numa Hugging Face cache (~/.cache/numa/huggingface) exists, reuse it first (APFS clone, no download);
#    download whatever is still missing.
if [[ -d "$HOME/.cache/numa/huggingface/hub" ]]; then
  uv run numa-voice models migrate --profile "$PROFILE" || true
fi
uv run numa-voice models download --profile "$PROFILE"

# 4. Integrity (sizes + SHA-256 from the manifest) and upstream configuration validation
uv run numa-voice models verify --profile "$PROFILE"

# 5. Unit tests (no GPU needed; integration tests: uv run pytest -m integration)
uv run pytest -q

echo
echo "Ready. Start a conversation (headphones recommended):"
echo "  cd backend/voice-engine && uv run numa-voice run --profile ${PROFILE/all/fast}"
