# Gemini Live Transcriber (macOS)

Transcribes everything your Mac plays (Zoom/Teams/Slack apps, browser tabs, videos, anything) in realtime with local Whisper (MLX, large-v3-turbo), and shows the text in a small panel above the Gemini prompt box.

## How it works

- `systap/` is a small Swift helper that records all system audio through a Core Audio process tap (macOS 14.2+). Playback is unaffected, and no BlackHole or other virtual device is needed.
- `server.py` runs the helper when you press Start, transcribes with Whisper on the GPU, and streams text to the extension over ws://127.0.0.1:8765.
- `extension/` is the panel on gemini.google.com: Start/Stop, Copy (whole transcript), Clear.

## Install (per Mac)

Requirements: Apple Silicon Mac, macOS 14.2+, Google Chrome.

1. Copy this folder to the Mac, open Terminal in it, and run:
   ./install.sh
   It checks the Mac, installs Apple's Command Line Tools and uv if missing, builds the audio helper,
   downloads Whisper (~2 GB, first time only), and registers the server with Chrome.
   Everything goes into ~/Library/Application Support/GeminiTranscriber.
2. chrome://extensions > Developer mode > Load unpacked > choose the `extension` folder.
3. Open Gemini and press Start. The first time, macOS asks whether "python3.11" may record system audio: click Allow.
   (If you clicked Don't Allow: System Settings > Privacy & Security > Screen & System Audio Recording >
   "System Audio Recording Only" > turn on python3.11.)

Re-run ./install.sh after updating the code. ./uninstall.sh removes everything it installed.

## Use

Open gemini.google.com and press Start in the panel above the prompt box. The extension launches the server
in the background and it shuts down when you close the last Gemini tab.

- Send: puts the transcript into Gemini's prompt box, submits it, and clears the panel.
- Copy / Clear: copy the whole transcript, or empty it.
- Logs: ~/Library/Logs/gemini-transcriber.log
- ./start.sh runs the server by hand with live logs; the extension uses it if it's already running
  (the terminal then needs the System Audio Recording permission instead of Chrome).

## Tuning (server flags)

    ./start.sh --threshold 0.008   # RMS level counted as speech (raise if noise turns into text)
    ./start.sh --silence 0.7       # pause length that locks in a sentence
    ./start.sh --partial-every 1.0 # seconds between live updates

## Notes

- Without the permission, macOS hands the helper silence instead of an error. The helper checks first, and the panel tells you if access is blocked.
- If you switch output devices (e.g. plug in headphones) mid-session, press Stop and Start again.
- The server only listens on 127.0.0.1 and only accepts connections from this extension (fixed ID).
