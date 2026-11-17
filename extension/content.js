// Gemini Live Transcriber: panel above the Gemini prompt box, audio capture, and transcript state.
(() => {
  if (window.__geminiTranscriber) return;
  window.__geminiTranscriber = true;

  const MAX_PANEL_W = 760;

  // ---------- state ----------
  const finals = [];
  let partial = "";
  let recording = false;
  let port = null;
  let collapsed = false;
  let stickToBottom = true;

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "gemini-live-transcriber";
  host.style.cssText = "position:fixed;z-index:2147483000;display:none;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        --bg: rgba(255,255,255,0.97); --fg: #1f1f1f; --muted: #6b6b6b; --border: #dadce0;
        --btn: #f1f3f4; --btn-hover: #e3e5e8; --accent: #0b57d0; --rec: #d93025;
        box-sizing: border-box; width: 100%;
        font: 13px/1.45 "Google Sans", Roboto, system-ui, sans-serif; color: var(--fg);
        background: var(--bg); border: 1px solid var(--border); border-radius: 16px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.12); overflow: hidden;
      }
      .panel.dark {
        --bg: rgba(30,31,32,0.97); --fg: #e3e3e3; --muted: #9aa0a6; --border: #3c4043;
        --btn: #2d2f31; --btn-hover: #3c4043; --accent: #a8c7fa; --rec: #f28b82;
      }
      .bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px; }
      .status { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
        color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
      .dot.on { background: var(--rec); animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.35; } }
      button {
        font: inherit; font-weight: 500; color: var(--fg); background: var(--btn);
        border: none; border-radius: 999px; padding: 4px 12px; cursor: pointer; flex: none;
      }
      button:hover { background: var(--btn-hover); }
      button.primary { color: var(--accent); }
      button.icon { padding: 4px 8px; }
      .text {
        max-height: 132px; overflow-y: auto; padding: 0 12px 10px; white-space: pre-wrap;
        word-wrap: break-word; user-select: text;
      }
      .text:empty::before { content: "Press Start to transcribe everything your Mac is playing."; color: var(--muted); }
      .partial { color: var(--muted); }
      .collapsed .text { display: none; }
    </style>
    <div class="panel">
      <div class="bar">
        <div class="status"><span class="dot"></span><span class="label">Idle</span></div>
        <button class="primary" data-act="toggle">Start</button>
        <button class="primary" data-act="send" title="Put the transcript in Gemini's prompt box and send it">Send</button>
        <button data-act="copy">Copy</button>
        <button data-act="clear">Clear</button>
        <button class="icon" data-act="collapse" title="Collapse">▾</button>
      </div>
      <div class="text"></div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const panel = $(".panel");
  const textEl = $(".text");
  const dot = $(".dot");
  const label = $(".label");
  const toggleBtn = $('[data-act="toggle"]');
  const copyBtn = $('[data-act="copy"]');
  const sendBtn = $('[data-act="send"]');
  const collapseBtn = $('[data-act="collapse"]');

  const setStatus = (text, on = recording) => {
    label.textContent = text;
    dot.classList.toggle("on", on);
  };

  const fullText = () => [...finals, partial].filter(Boolean).join(" ").trim();

  const render = () => {
    textEl.textContent = "";
    if (finals.length) textEl.append(document.createTextNode(finals.join(" ")));
    if (partial) {
      const span = document.createElement("span");
      span.className = "partial";
      span.textContent = (finals.length ? " " : "") + partial;
      textEl.append(span);
    }
    if (stickToBottom) textEl.scrollTop = textEl.scrollHeight;
  };

  textEl.addEventListener("scroll", () => {
    stickToBottom = textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 8;
  });

  root.addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "toggle") recording ? stop() : start();
    if (act === "send") {
      const t = fullText();
      if (!t) return flash(sendBtn, "Empty");
      const ok = await sendToGemini(t);
      flash(sendBtn, ok ? "Sent" : "Failed");
      if (ok) {
        // Drop only what was sent; words finalized during the send stay for next time.
        const sentText = t;
        const rest = fullText();
        finals.length = 0;
        partial = "";
        if (rest.startsWith(sentText)) {
          const extra = rest.slice(sentText.length).trim();
          if (extra) finals.push(extra);
        }
        stickToBottom = true;
        render();
      }
    }
    if (act === "copy") {
      const t = fullText();
      try {
        await navigator.clipboard.writeText(t);
        flash(copyBtn, t ? "Copied" : "Empty");
      } catch {
        flash(copyBtn, "Failed");
      }
    }
    if (act === "clear") { finals.length = 0; partial = ""; stickToBottom = true; render(); }
    if (act === "collapse") {
      collapsed = !collapsed;
      panel.classList.toggle("collapsed", collapsed);
      collapseBtn.textContent = collapsed ? "▴" : "▾";
      collapseBtn.title = collapsed ? "Expand" : "Collapse";
    }
  });

  function flash(btn, text) {
    const orig = btn.dataset.orig || btn.textContent;
    btn.dataset.orig = orig;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  // ---------- positioning: float just above Gemini's prompt box ----------
  // ---------- send: type the transcript into Gemini's prompt and submit ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findEditor() {
    return (
      document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]')
    );
  }

  function findSendButton() {
    const btn =
      document.querySelector('button.send-button') ||
      document.querySelector('button[aria-label="Send message" i]') ||
      document.querySelector('button[aria-label*="send" i]');
    return btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true" ? btn : null;
  }

  async function sendToGemini(text) {
    const editor = findEditor();
    if (!editor) return false;
    editor.focus();
    // Put the caret at the end so anything already typed (e.g. "Summarize this:") is kept.
    const sel = window.getSelection();
    sel.selectAllChildren(editor);
    sel.collapseToEnd();
    const existing = editor.innerText.trim();
    // insertText goes through the editor's normal input handling, like a paste.
    document.execCommand("insertText", false, (existing ? "\n" : "") + text);

    // Wait for Gemini to enable its send button, then click it; fall back to Enter.
    for (let i = 0; i < 20; i++) {
      const btn = findSendButton();
      if (btn) { btn.click(); return true; }
      await sleep(50);
    }
    const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", enter));
    editor.dispatchEvent(new KeyboardEvent("keyup", enter));
    return true;
  }

  function findPromptBox() {
    const editor =
      document.querySelector('rich-textarea') ||
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!editor) return null;
    return (
      editor.closest("input-area-v2") ||
      editor.closest(".input-area-container") ||
      editor.closest(".text-input-field") ||
      editor.closest("fieldset") ||
      editor
    );
  }

  function isDark() {
    if (document.body.classList.contains("dark-theme")) return true;
    if (document.body.classList.contains("light-theme")) return false;
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (m && m.length >= 3 && (m[3] === undefined || +m[3] > 0)) {
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function place() {
    if (!host.isConnected) document.documentElement.append(host);
    panel.classList.toggle("dark", isDark());
    const box = findPromptBox();
    const r = box?.getBoundingClientRect();
    if (!r || r.width < 50) {
      // No prompt box on screen: keep showing while recording, otherwise hide.
      if (!recording) { host.style.display = "none"; return; }
      Object.assign(host.style, { display: "block", left: "50%", bottom: "16px", width: `min(${MAX_PANEL_W}px, calc(100vw - 32px))`, transform: "translateX(-50%)" });
      return;
    }
    const width = Math.min(r.width, MAX_PANEL_W);
    Object.assign(host.style, {
      display: "block",
      transform: "none",
      width: `${width}px`,
      left: `${r.left + (r.width - width) / 2}px`,
      bottom: `${Math.max(8, window.innerHeight - r.top + 8)}px`,
    });
  }

  let raf = 0;
  const schedulePlace = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  window.addEventListener("resize", schedulePlace);
  new MutationObserver(schedulePlace).observe(document.body, { childList: true, subtree: true });
  setInterval(place, 1000);
  place();

  // ---------- extension messaging ----------
  let pingTimer = 0;

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "transcriber" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (recording) stop(false, "Lost connection to the extension. Press Start again.");
    });
    return port;
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "capturing":
        if (recording) setStatus("Listening to system audio", true);
        break;
      case "error":
        stop(false, msg.code === "permission"
          ? "Mac blocked audio capture. Turn on python3.11 in System Settings > Privacy & Security > Screen & System Audio Recording, then press Start."
          : `Capture error: ${msg.message}`);
        break;
      case "server":
        if (!recording) break;
        if (msg.state === "starting") setStatus("Starting Whisper… (first launch can take a minute)", true);
        else if (msg.state === "error") stop(false, `Could not start Whisper: ${msg.message || "unknown error"}. Run ./install.sh, or ./start.sh manually.`);
        else stop(false, "Whisper server stopped. Press Start again.");
        break;
      case "partial":
        partial = msg.text || "";
        render();
        break;
      case "final":
        if (msg.text) finals.push(msg.text);
        partial = "";
        render();
        break;
    }
  }

  // ---------- start / stop (the server does the actual audio capture) ----------
  function start() {
    if (recording) return;
    recording = true;
    toggleBtn.textContent = "Stop";
    setStatus("Connecting to Whisper…", true);
    getPort().postMessage({ type: "start" });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { port?.postMessage({ type: "ping" }); } catch {} }, 20000);
  }

  function stop(flush = true, message = "Idle") {
    const was = recording;
    recording = false;
    clearInterval(pingTimer);
    toggleBtn.textContent = "Start";
    setStatus(message, false);
    label.title = message;
    if (was && flush && port) port.postMessage({ type: "stop" });
    schedulePlace();
  }
})();
