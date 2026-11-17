#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["mlx-whisper", "websockets>=13", "numpy"]
# ///
"""Local realtime transcription server for the Gemini Transcriber extension.

Captures all macOS system audio with the native `systap` helper (Core Audio process tap).

Protocol (ws://127.0.0.1:8765):
  client -> server: {"type": "start"}  begin capturing system audio
                    {"type": "stop"}   stop capturing and finalize the last words
                    {"type": "ping"}   keepalive, ignored
  server -> client: {"type": "ready"}
                    {"type": "capturing"}
                    {"type": "partial", "text": "..."}  in-progress segment, may change
                    {"type": "final",   "text": "..."}  locked-in segment
                    {"type": "error", "code": "permission" | "capture", "message": "..."}
"""

import sys as _sys
print("server.py: process starting", file=_sys.stderr, flush=True)
import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import mlx_whisper
import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

SR = 16000
MODEL = "mlx-community/whisper-large-v3-turbo"
SYSTAP = Path(__file__).resolve().parent / "systap" / "systap"
# Only this extension may connect (its ID is fixed by the public key in manifest.json).
EXTENSION_ID = (Path(__file__).resolve().parent / "extension-id.txt").read_text().strip()
ALLOWED_ORIGIN = f"chrome-extension://{EXTENSION_ID}"

# Whisper likes to invent these on near-silent audio.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
    "you", "bye.", ".", "subtitles by the amara.org community",
}

log = logging.getLogger("transcriber")
executor = ThreadPoolExecutor(max_workers=1)  # MLX inference runs on one thread


def transcribe_sync(audio: np.ndarray) -> str:
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=MODEL,
        language="en",
        condition_on_previous_text=False,
        verbose=None,
    )
    parts = []
    for seg in result.get("segments", []):
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
            continue
        parts.append(seg["text"].strip())
    text = " ".join(p for p in parts if p).strip()
    if text.lower() in HALLUCINATIONS:
        return ""
    return text


async def transcribe(audio: np.ndarray) -> str:
    return await asyncio.get_running_loop().run_in_executor(executor, transcribe_sync, audio)


class Session:
    def __init__(self, ws, args):
        self.ws = ws
        self.thr = args.threshold
        self.silence = int(args.silence * SR)
        self.partial_every = int(args.partial_every * SR)
        self.max_seg = int(args.max_segment * SR)
        self.buf = np.zeros(0, dtype=np.float32)
        self.last_voice = -1        # index in buf of the end of the last voiced chunk, -1 = no speech yet
        self.partial_at = 0         # len(buf) when the last partial was computed
        self.flush = False
        self.closed = False
        self.proc = None
        self.reader = None
        self.stopping = False
        self.wake = asyncio.Event()

    async def send(self, **msg):
        try:
            await self.ws.send(json.dumps(msg))
        except Exception:
            self.closed = True

    def add_audio(self, data: bytes):
        chunk = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
        if chunk.size == 0:
            return
        self.buf = np.concatenate([self.buf, chunk])
        if np.sqrt(np.mean(chunk ** 2)) > self.thr:
            self.last_voice = len(self.buf)
        elif self.last_voice < 0 and len(self.buf) > SR:
            # Nothing said yet: keep only a short lead-in so silence is never sent to Whisper.
            self.buf = self.buf[-int(0.3 * SR):]
            self.partial_at = 0
        self.wake.set()

    async def start_capture(self):
        if self.proc and self.proc.returncode is None:
            return
        self.buf = np.zeros(0, dtype=np.float32)
        self.last_voice, self.partial_at = -1, 0
        self.proc = await asyncio.create_subprocess_exec(
            str(SYSTAP), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.reader = asyncio.create_task(self.read_capture(self.proc))

    async def read_capture(self, proc):
        got_audio = False
        leftover = b""
        while True:
            data = await proc.stdout.read(8192)
            if not data:
                break
            if not got_audio:
                got_audio = True
                await self.send(type="capturing")
            data = leftover + data
            cut = len(data) - len(data) % 2
            leftover = data[cut:]
            self.add_audio(data[:cut])
        code = await proc.wait()
        err = (await proc.stderr.read()).decode(errors="replace")
        if self.stopping or code in (0, -15, -2):
            return
        log.warning("systap exited %s: %s", code, err.strip())
        if code == 2 or "PERMISSION_DENIED" in err:
            await self.send(type="error", code="permission",
                            message="Turn on python3.11 under System Settings > Privacy & Security > Screen & System Audio Recording, then press Start again.")
        else:
            await self.send(type="error", code="capture", message=err.strip() or f"systap exited with {code}")

    async def stop_capture(self):
        self.stopping = True
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                self.proc.kill()
        if self.reader:
            await self.reader
        self.proc = self.reader = None
        self.stopping = False

    async def finalize(self):
        n = len(self.buf)
        audio = self.buf[:n].copy()
        text = await transcribe(audio) if self.last_voice >= 0 else ""
        # Keep audio that arrived during inference.
        self.buf = self.buf[n:]
        self.last_voice = -1
        self.partial_at = 0
        if text:
            await self.send(type="final", text=text)
        else:
            await self.send(type="partial", text="")

    async def worker(self):
        while not self.closed:
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass
            self.wake.clear()
            n = len(self.buf)
            has_voice = self.last_voice >= 0
            if self.flush:
                self.flush = False
                if n:
                    await self.finalize()
            elif has_voice and (n - self.last_voice >= self.silence or n >= self.max_seg):
                await self.finalize()
            elif has_voice and n - self.partial_at >= self.partial_every:
                self.partial_at = n
                text = await transcribe(self.buf[:n].copy())
                await self.send(type="partial", text=text)


async def handler(ws, args):
    origin = ws.request.headers.get("Origin", "")
    if origin != ALLOWED_ORIGIN:
        log.warning("rejected connection from origin %r", origin)
        await ws.close(code=1008, reason="not the Gemini Live Transcriber extension")
        return
    log.info("client connected")
    s = Session(ws, args)
    task = asyncio.create_task(s.worker())
    await s.send(type="ready")
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                continue
            try:
                kind = json.loads(msg).get("type")
            except ValueError:
                continue
            if kind == "start":
                await s.start_capture()
            elif kind == "stop":
                await s.stop_capture()
                s.flush = True
                s.wake.set()
    except ConnectionClosed:
        pass  # tab closed or Chrome quit mid-session; cleanup below still runs
    finally:
        await s.stop_capture()
        s.closed = True
        s.wake.set()
        await task
        log.info("client disconnected")


async def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--threshold", type=float, default=0.008, help="RMS level counted as speech")
    p.add_argument("--silence", type=float, default=0.7, help="seconds of quiet that end a segment")
    p.add_argument("--partial-every", type=float, default=1.0, help="seconds of new audio between partials")
    p.add_argument("--max-segment", type=float, default=20.0, help="force a final after this many seconds")
    p.add_argument("--native", action="store_true", help="launched by Chrome: exit when Chrome closes stdin")
    args = p.parse_args()
    if args.native:
        # Chrome reads stdout as the native messaging channel, so nothing may be printed there.
        os.dup2(2, 1)
        sys.stdout = sys.stderr
        # A server started by hand already owns the port: let the extension use that one.
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", args.port)) == 0:
                print("server already running, native launch not needed", file=sys.stderr)
                return
        # Chrome closes stdin when the extension disconnects (last Gemini tab closed).
        def watch_stdin():
            while os.read(0, 65536):
                pass
            os._exit(0)
        threading.Thread(target=watch_stdin, daemon=True).start()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "huggingface_hub", "websockets.server"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if not SYSTAP.exists():
        raise SystemExit(f"{SYSTAP} not found, run ./start.sh to build it")
    perm = (await (await asyncio.create_subprocess_exec(str(SYSTAP), "--check", stdout=asyncio.subprocess.PIPE)).communicate())[0].decode().strip()
    if perm != "granted":
        log.info("System audio permission is %s; macOS will ask on the first Start.", perm)
    log.info("loading %s ...", MODEL)
    await transcribe(np.zeros(SR, dtype=np.float32))  # warm up
    async with serve(lambda ws: handler(ws, args), "127.0.0.1", args.port, max_size=2**22):
        log.info("ready on ws://127.0.0.1:%d", args.port)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
