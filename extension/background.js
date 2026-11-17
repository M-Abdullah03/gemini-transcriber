// Relays between the Gemini panel and the local Whisper server, which captures system audio itself.
// The WebSocket lives here (not in the content script) so Gemini's page CSP can't block it.
// The server is launched on demand through native messaging and exits when the last Gemini tab closes.

const SERVER_URL = "ws://127.0.0.1:8765";
const HOST = "com.gemini_transcriber.server";
const STARTUP_TIMEOUT_MS = 60000; // first launch installs deps and loads the model

let nativePort = null;
let nativeError = "";
const panels = new Set();

function ensureServerProcess() {
  if (nativePort) return;
  nativeError = "";
  try {
    nativePort = chrome.runtime.connectNative(HOST);
  } catch (e) {
    nativeError = String(e?.message || e);
    return;
  }
  nativePort.onDisconnect.addListener(() => {
    // Also fires when a manually started server already owns the port; that's fine.
    nativeError = chrome.runtime.lastError?.message || "";
    nativePort = null;
  });
}

function stopServerProcessIfUnused() {
  if (panels.size === 0 && nativePort) {
    nativePort.disconnect();
    nativePort = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "transcriber") return;
  panels.add(port);
  let ws = null;
  let stopTimer = null;
  let retryTimer = null;
  let stopping = false;
  let wanted = false;

  const post = (msg) => {
    try { port.postMessage(msg); } catch { /* tab gone */ }
  };

  const closeSocket = () => {
    clearTimeout(stopTimer);
    clearTimeout(retryTimer);
    stopping = false;
    const sock = ws;
    ws = null;
    if (sock) { try { sock.close(); } catch {} }
  };

  const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  // Keep trying to reach the server while it boots.
  function connect(deadline) {
    if (!wanted) return;
    const sock = new WebSocket(SERVER_URL);
    ws = sock;
    let opened = false;
    sock.onopen = () => { opened = true; };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "ready") sock.send(JSON.stringify({ type: "start" }));
      post(m);
      // After Stop, close once the last words are finalized.
      if (stopping && (m.type === "final" || (m.type === "partial" && m.text === ""))) closeSocket();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (opened || !wanted) return post({ type: "server", state: "closed" });
      if (Date.now() > deadline) {
        return post({ type: "server", state: "error", message: nativeError || "Whisper server did not start." });
      }
      if (!nativePort && !nativeError) ensureServerProcess();
      post({ type: "server", state: "starting" });
      retryTimer = setTimeout(() => connect(deadline), 700);
    };
  }

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "start":
        closeSocket();
        wanted = true;
        ensureServerProcess();
        connect(Date.now() + STARTUP_TIMEOUT_MS);
        break;
      case "ping":
        // Keeps this service worker and the server session alive during long silences.
        send({ type: "ping" });
        break;
      case "stop":
        wanted = false;
        if (ws?.readyState === WebSocket.OPEN) {
          stopping = true;
          send({ type: "stop" });
          const sock = ws;
          stopTimer = setTimeout(() => { if (ws === sock) closeSocket(); }, 5000);
        } else {
          closeSocket();
        }
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    wanted = false;
    closeSocket();
    panels.delete(port);
    stopServerProcessIfUnused();
  });
});
