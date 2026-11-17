#!/bin/zsh
# Removes everything install.sh added (the Chrome extension itself is removed in chrome://extensions).
rm -rf "$HOME/Library/Application Support/GeminiTranscriber"
rm -f "$HOME"/Library/Application\ Support/*/NativeMessagingHosts/com.gemini_transcriber.server.json \
      "$HOME"/Library/Application\ Support/*/*/NativeMessagingHosts/com.gemini_transcriber.server.json
rm -f "$HOME/Library/Logs/gemini-transcriber.log"
echo "Uninstalled."
