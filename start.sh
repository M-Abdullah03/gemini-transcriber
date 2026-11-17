#!/bin/zsh
# Runs the Whisper server by hand with live logs (normally the extension starts it for you).
APP="$HOME/Library/Application Support/GeminiTranscriber"
[[ -x "$APP/venv/bin/python" ]] || { echo "Run ./install.sh first."; exit 1; }
cp "${0:A:h}/server.py" "$APP/server.py"
cp "${0:A:h}/native/extension-id.txt" "$APP/extension-id.txt"
HF_HUB_OFFLINE=1 exec "$APP/venv/bin/python" "$APP/server.py" "$@"
