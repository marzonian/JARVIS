#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
VOICE_DIR="$ROOT_DIR/data/voice/piper"
MODEL_NAME="en_US-lessac-high"
MODEL_FILE="$VOICE_DIR/${MODEL_NAME}.onnx"
CONFIG_FILE="$VOICE_DIR/${MODEL_NAME}.onnx.json"
MODEL_URL_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high"

echo "[voice-setup] Root: $ROOT_DIR"

if ! command -v brew >/dev/null 2>&1; then
  echo "[voice-setup] Homebrew is required but not found."
  exit 1
fi

PIPER_BIN_PATH=""
PY_USER_BASE="$(python3 -m site --user-base 2>/dev/null || true)"
PY_USER_PIPER=""
if [ -n "$PY_USER_BASE" ]; then
  PY_USER_PIPER="$PY_USER_BASE/bin/piper"
fi
if command -v piper >/dev/null 2>&1; then
  PIPER_BIN_PATH="$(command -v piper)"
elif [ -n "$PY_USER_PIPER" ] && [ -x "$PY_USER_PIPER" ]; then
  PIPER_BIN_PATH="$PY_USER_PIPER"
elif [ -x "$HOME/Library/Python/3.9/bin/piper" ]; then
  PIPER_BIN_PATH="$HOME/Library/Python/3.9/bin/piper"
elif [ -x "$ROOT_DIR/.local/piper/piper" ]; then
  PIPER_BIN_PATH="$ROOT_DIR/.local/piper/piper"
fi

if [ -z "$PIPER_BIN_PATH" ]; then
  echo "[voice-setup] Installing piper python runtime..."
  if command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user --upgrade piper-tts pathvalidate
    PY_USER_BASE="$(python3 -m site --user-base 2>/dev/null || true)"
    if [ -n "$PY_USER_BASE" ] && [ -x "$PY_USER_BASE/bin/piper" ]; then
      PIPER_BIN_PATH="$PY_USER_BASE/bin/piper"
    elif [ -x "$HOME/Library/Python/3.9/bin/piper" ]; then
      PIPER_BIN_PATH="$HOME/Library/Python/3.9/bin/piper"
    fi
  fi

  if [ -z "$PIPER_BIN_PATH" ]; then
    echo "[voice-setup] Python piper unavailable, falling back to release binary..."
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
      PIPER_ASSET="piper_macos_aarch64.tar.gz"
    elif [ "$ARCH" = "x86_64" ]; then
      PIPER_ASSET="piper_macos_x64.tar.gz"
    else
      echo "[voice-setup] Unsupported macOS architecture: $ARCH"
      exit 1
    fi

    PIPER_VERSION="2023.11.14-2"
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_ASSET}"
    TMP_DIR="$(mktemp -d)"
    mkdir -p "$ROOT_DIR/.local"
    echo "[voice-setup] Downloading $PIPER_ASSET..."
    curl -fL "$PIPER_URL" -o "$TMP_DIR/piper.tar.gz"
    tar -xzf "$TMP_DIR/piper.tar.gz" -C "$ROOT_DIR/.local"
    rm -rf "$TMP_DIR"
    if [ ! -x "$ROOT_DIR/.local/piper/piper" ]; then
      echo "[voice-setup] Piper install failed: binary not found."
      exit 1
    fi
    chmod +x "$ROOT_DIR/.local/piper/piper"
    PIPER_BIN_PATH="$ROOT_DIR/.local/piper/piper"
  fi

  echo "[voice-setup] Piper installed at $PIPER_BIN_PATH"
else
  echo "[voice-setup] Piper already installed at $PIPER_BIN_PATH"
fi

EDGE_TTS_BIN_PATH=""
if command -v edge-tts >/dev/null 2>&1; then
  EDGE_TTS_BIN_PATH="$(command -v edge-tts)"
elif [ -n "$PY_USER_BASE" ] && [ -x "$PY_USER_BASE/bin/edge-tts" ]; then
  EDGE_TTS_BIN_PATH="$PY_USER_BASE/bin/edge-tts"
elif [ -x "$HOME/Library/Python/3.9/bin/edge-tts" ]; then
  EDGE_TTS_BIN_PATH="$HOME/Library/Python/3.9/bin/edge-tts"
fi

if [ -z "$EDGE_TTS_BIN_PATH" ]; then
  echo "[voice-setup] Installing edge-tts..."
  python3 -m pip install --user --upgrade edge-tts >/dev/null 2>&1 || true
  PY_USER_BASE="$(python3 -m site --user-base 2>/dev/null || true)"
  if [ -n "$PY_USER_BASE" ] && [ -x "$PY_USER_BASE/bin/edge-tts" ]; then
    EDGE_TTS_BIN_PATH="$PY_USER_BASE/bin/edge-tts"
  elif [ -x "$HOME/Library/Python/3.9/bin/edge-tts" ]; then
    EDGE_TTS_BIN_PATH="$HOME/Library/Python/3.9/bin/edge-tts"
  fi
fi

if [ -n "$EDGE_TTS_BIN_PATH" ]; then
  echo "[voice-setup] edge-tts ready at $EDGE_TTS_BIN_PATH"
else
  echo "[voice-setup] edge-tts not available. Will skip edge neural fallback."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[voice-setup] Installing ffmpeg..."
  brew install ffmpeg
else
  echo "[voice-setup] ffmpeg already installed."
fi

mkdir -p "$VOICE_DIR"

if [ ! -f "$MODEL_FILE" ]; then
  echo "[voice-setup] Downloading model..."
  curl -fL "$MODEL_URL_BASE/${MODEL_NAME}.onnx" -o "$MODEL_FILE"
else
  echo "[voice-setup] Model already exists."
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[voice-setup] Downloading model config..."
  curl -fL "$MODEL_URL_BASE/${MODEL_NAME}.onnx.json" -o "$CONFIG_FILE"
else
  echo "[voice-setup] Model config already exists."
fi

touch "$ENV_FILE"

upsert_env() {
  local key="$1"
  local value="$2"
  awk -v k="$key" -v v="$value" '
    BEGIN { set = 0 }
    $0 ~ ("^" k "=") { print k "=" v; set = 1; next }
    { print }
    END { if (!set) print k "=" v }
  ' "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

FFMPEG_BIN_PATH="$(command -v ffmpeg || echo ffmpeg)"

upsert_env "ASSISTANT_VOICE_MODE" "quality"
upsert_env "ASSISTANT_VOICE_LATENCY_MODE" "fast"
upsert_env "ASSISTANT_LOCAL_TTS_PROVIDER" "piper"
upsert_env "ASSISTANT_LOCAL_VOICE_PROFILE" "jarvis_prime"
upsert_env "ASSISTANT_NEURAL_PROSODY_ENABLED" "true"
upsert_env "ASSISTANT_LOCAL_TTS_TIMEOUT_MS" "25000"
upsert_env "ASSISTANT_TTS_FAST_MAX_CHARS" "320"
upsert_env "ASSISTANT_AUDIO_ENHANCE_FAST_SKIP" "true"
upsert_env "ASSISTANT_PROVIDER_COOLDOWN_MS" "180000"
upsert_env "ASSISTANT_PROVIDER_COOLDOWN_QUOTA_MS" "1800000"
upsert_env "ASSISTANT_PROVIDER_COOLDOWN_NOT_CONFIGURED_MS" "3600000"
upsert_env "ASSISTANT_AUDIO_ENHANCE_ENABLED" "true"
upsert_env "ASSISTANT_AUDIO_OUTPUT_FORMAT" "mp3"
upsert_env "ASSISTANT_AUDIO_ENHANCE_FILTER" "highpass=f=80,lowpass=f=9200,equalizer=f=2700:width_type=o:width=1.4:g=1.3,acompressor=threshold=-21dB:ratio=1.8:attack=12:release=120,alimiter=limit=0.96"
upsert_env "ASSISTANT_PIPER_BIN" "$PIPER_BIN_PATH"
upsert_env "ASSISTANT_PIPER_MODEL_PATH" "$MODEL_FILE"
upsert_env "ASSISTANT_PIPER_CONFIG_PATH" "$CONFIG_FILE"
upsert_env "ASSISTANT_PIPER_LENGTH_SCALE" "1.03"
upsert_env "ASSISTANT_PIPER_NOISE_SCALE" "0.60"
upsert_env "ASSISTANT_PIPER_NOISE_W_SCALE" "0.72"
upsert_env "ASSISTANT_PIPER_SENTENCE_SILENCE" "0.16"
upsert_env "ASSISTANT_PIPER_VOLUME" "1.00"
upsert_env "ASSISTANT_PIPER_NO_NORMALIZE" "false"
if [ -n "$EDGE_TTS_BIN_PATH" ]; then
  upsert_env "ASSISTANT_EDGE_TTS_BIN" "$EDGE_TTS_BIN_PATH"
fi
upsert_env "ASSISTANT_EDGE_TTS_VOICE" "en-GB-RyanNeural"
upsert_env "ASSISTANT_EDGE_TTS_RATE" "-4%"
upsert_env "ASSISTANT_EDGE_TTS_PITCH" "-8Hz"
upsert_env "ASSISTANT_EDGE_TTS_VOLUME" "+0%"
upsert_env "ASSISTANT_FFMPEG_BIN" "$FFMPEG_BIN_PATH"

echo "[voice-setup] .env updated for local premium voice."

PLIST="$HOME/Library/LaunchAgents/ai.3130.server.plist"
if [ -f "$PLIST" ]; then
  UID_NUM="$(id -u)"
  echo "[voice-setup] Restarting ai.3130.server..."
  launchctl bootout "gui/$UID_NUM/ai.3130.server" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$UID_NUM/ai.3130.server" >/dev/null 2>&1 || true
else
  echo "[voice-setup] LaunchAgent not found, skipped restart."
fi

echo "[voice-setup] Done."
echo "[voice-setup] Model: $MODEL_FILE"
echo "[voice-setup] Config: $CONFIG_FILE"
