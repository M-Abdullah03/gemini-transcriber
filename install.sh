#!/bin/zsh
# One-step installer for Gemini Live Transcriber. Run from Terminal: ./install.sh
# Safe to re-run (e.g. after updating the code). Everything the server needs is
# installed here, from Terminal, so Chrome only ever launches what's already in place.
set -e
cd "${0:A:h}"
APP="$HOME/Library/Application Support/GeminiTranscriber"
MODEL="mlx-community/whisper-large-v3-turbo"
step() { print -P "\n%B==> $1%b"; }

step "Checking this Mac"
[[ "$(uname -m)" == "arm64" ]] || { echo "Needs an Apple Silicon Mac (M1 or newer)."; exit 1; }
autoload is-at-least
is-at-least 14.2 "$(sw_vers -productVersion)" || { echo "Needs macOS 14.2 or newer."; exit 1; }

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed to build the audio helper."
  echo "A system dialog will open: click Install, wait for it to finish, then run ./install.sh again."
  xcode-select --install || true
  exit 1
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v uv >/dev/null; then
  step "Installing uv (Python package manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
UV="$(command -v uv)"

step "Building the system audio helper"
mkdir -p "$APP/systap"
swiftc -O -o "$APP/systap/systap" systap/main.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker systap/Info.plist

step "Setting up Python and Whisper (first time downloads ~2 GB)"
[[ -x "$APP/venv/bin/python" ]] || "$UV" venv --quiet --python 3.11 "$APP/venv"
"$UV" pip install --quiet --no-cache --python "$APP/venv/bin/python" mlx-whisper "websockets>=13" numpy
# --no-cache: always download fresh from this Terminal session, never reuse files a
# browser-launched process may have cached (macOS flags those and refuses to load them).
"$APP/venv/bin/python" - "$MODEL" <<'PY'
import sys, numpy as np, mlx_whisper
mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=sys.argv[1], language="en")
print("Model ready.")
PY

step "Installing the server"
cp server.py "$APP/server.py"
cp native/extension-id.txt "$APP/extension-id.txt"
cat > "$APP/host.sh" <<'SH'
#!/bin/zsh
# Launched by Chrome (native messaging). Chrome's arguments are ignored.
APP="${0:A:h}"
LOG="$HOME/Library/Logs/gemini-transcriber.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') launched by Chrome" >>"$LOG"
export HF_HUB_OFFLINE=1   # model was downloaded by install.sh
"$APP/venv/bin/python" -u "$APP/server.py" --native 2>>"$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') server exited with code $?" >>"$LOG"
SH
chmod +x "$APP/host.sh"

step "Registering with Chrome"
EXT_ID="$(cat native/extension-id.txt)"
for BROWSER in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  BASE="$HOME/Library/Application Support/$BROWSER"
  [[ -d "$BASE" ]] || continue
  mkdir -p "$BASE/NativeMessagingHosts"
  cat > "$BASE/NativeMessagingHosts/com.gemini_transcriber.server.json" <<JSON
{
  "name": "com.gemini_transcriber.server",
  "description": "Gemini Live Transcriber local Whisper server",
  "path": "$APP/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "  registered for $BROWSER"
done

cat <<MSG

Installed. Two things left to do (once per Mac):

  1. Chrome: open chrome://extensions, turn on Developer mode, click "Load unpacked",
     and choose: $PWD/extension

  2. Open gemini.google.com and press Start in the panel above the prompt box.
     The first time, macOS asks whether "python3.11" may record system audio: click Allow.
MSG
