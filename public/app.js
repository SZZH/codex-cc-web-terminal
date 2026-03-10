const term = new window.Terminal({
  cursorBlink: false,
  convertEol: true,
  customGlyphs: false,
  fontSize: 14,
  scrollback: 5000,
  smoothScrollDuration: 0,
  theme: {
    background: "#0f1117",
    foreground: "#eef2ff"
  }
});
const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

const tokenInput = document.getElementById("token");
const cwdInput = document.getElementById("cwd");
const nameInput = document.getElementById("session-name");
const connectButton = document.getElementById("connect");
const newSessionButton = document.getElementById("new-session");
const refreshButton = document.getElementById("refresh");
const closeSessionButton = document.getElementById("close-session");
const sessionsRoot = document.getElementById("sessions");
const statusRoot = document.getElementById("status");
const viewConnect = document.getElementById("view-connect");
const viewWorkspace = document.getElementById("view-workspace");
const sessionPanel = document.getElementById("session-panel");
const openPanelButton = document.getElementById("open-panel");
const closePanelButton = document.getElementById("close-panel");
const backToConnectButton = document.getElementById("back-to-connect");
const terminalRoot = document.getElementById("terminal");
const imeBridge = document.getElementById("ime-bridge");
const escKeyButton = document.getElementById("esc-key");

let accessToken = "";
let activeSessionId = "";
let socket = null;
let sessions = [];
let reconnectTimer = null;
let isManualDisconnect = false;
let isAuthenticated = false;
let pendingOutput = "";
let outputFrame = null;
let viewportFrame = null;
let keyboardWasOpen = false;
let imeComposing = false;

const useImeBridge = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const melbourneFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function flushPendingOutput() {
  outputFrame = null;
  if (!pendingOutput) {
    return;
  }

  term.write(pendingOutput);
  pendingOutput = "";
  if (keyboardWasOpen) {
    scrollTerminalToLatest();
  }
}

function queueTerminalOutput(chunk) {
  if (!chunk) {
    return;
  }

  pendingOutput += chunk;
  if (outputFrame === null) {
    outputFrame = window.requestAnimationFrame(flushPendingOutput);
  }
}

function scrollTerminalToLatest({ ensureVisible = false } = {}) {
  window.requestAnimationFrame(() => {
    if (ensureVisible) {
      terminalRoot.scrollIntoView({
        block: "end",
        inline: "nearest"
      });
    }

    term.scrollToBottom?.();
    const viewport = terminalRoot.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  });
}

function resetImeBridge() {
  imeBridge.value = "";
  imeComposing = false;
}

function focusImeBridge() {
  if (!useImeBridge || !hasLiveSession()) {
    return;
  }

  imeBridge.focus({ preventScroll: true });
  const length = imeBridge.value.length;
  imeBridge.setSelectionRange(length, length);
}

function blurImeBridge() {
  if (!useImeBridge) {
    return;
  }

  imeBridge.blur();
}

function flushImeBridgeValue() {
  if (imeComposing) {
    return;
  }

  const value = imeBridge.value;
  if (!value) {
    return;
  }

  sendToSession(value);
  resetImeBridge();
  scrollTerminalToLatest({ ensureVisible: keyboardWasOpen });
}

function applyViewportMetrics() {
  viewportFrame = null;
  const viewport = window.visualViewport;
  const viewportHeight = Math.round(viewport?.height || window.innerHeight);
  const keyboardInset = Math.max(0, window.innerHeight - viewportHeight);
  const keyboardOpen = keyboardInset > 120;
  document.documentElement.style.setProperty("--vvh", `${viewportHeight}px`);
  document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  syncTerminalSize();
  if (keyboardOpen) {
    scrollTerminalToLatest({ ensureVisible: true });
  }
  keyboardWasOpen = keyboardOpen;
}

function requestViewportMetrics() {
  if (viewportFrame !== null) {
    return;
  }

  viewportFrame = window.requestAnimationFrame(applyViewportMetrics);
}

function hasLiveSession() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN && activeSessionId);
}

function setView(name) {
  const workspace = name === "workspace";
  viewConnect.classList.toggle("hidden", workspace);
  viewWorkspace.classList.toggle("hidden", !workspace);
}

function setPanelOpen(open) {
  sessionPanel.classList.toggle("hidden", !open);
}

function updateInputControls() {
  const enabled = hasLiveSession();
  escKeyButton.disabled = !enabled;
  imeBridge.disabled = !enabled;
  if (!enabled) {
    resetImeBridge();
    blurImeBridge();
    clearReconnectTimer();
  }
}

function setStatus(text) {
  statusRoot.textContent = text;
}

function headers() {
  return {
    "Content-Type": "application/json"
  };
}

function formatTime(value) {
  try {
    return `${melbourneFormatter.format(new Date(value))} AEDT`;
  } catch {
    return value || "";
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.headers || {}),
      ...headers()
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401) {
      isAuthenticated = false;
    }
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
}

async function loginWithToken(token) {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  isAuthenticated = true;
}

async function logoutSession() {
  try {
    await request("/api/logout", { method: "POST" });
  } catch {
    // Ignore logout failures during local UI reset.
  }
  isAuthenticated = false;
}

function renderSessions() {
  sessionsRoot.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.innerHTML = `
      <h3>No sessions yet</h3>
      <p>Create a new session here. If you leave the name blank, the first prompt you send will become the title automatically.</p>
    `;
    sessionsRoot.appendChild(empty);
    return;
  }

  const liveSessions = sessions.filter((session) => session.kind === "live");
  const savedSessions = sessions.filter((session) => session.kind === "history");

  if (liveSessions.length) {
    const section = document.createElement("div");
    section.className = "session-section-label";
    section.textContent = "Live in browser";
    sessionsRoot.appendChild(section);
    for (const session of liveSessions) {
      sessionsRoot.appendChild(buildSessionCard(session));
    }
  }

  if (savedSessions.length) {
    const section = document.createElement("div");
    section.className = "session-section-label";
    section.textContent = "Saved Codex sessions";
    sessionsRoot.appendChild(section);
    for (const session of savedSessions) {
      sessionsRoot.appendChild(buildSessionCard(session));
    }
  }
}

function buildSessionCard(session) {
  const card = document.createElement("button");
  const isCurrent = session.kind === "live" && session.id === activeSessionId;
  card.className = `session-card${isCurrent ? " active" : ""}`;
  const preview = session.inputPreview
    ? `<p class="session-preview">${session.inputPreview}</p>`
    : `<p class="session-preview muted">No prompt preview available</p>`;
  const currentBadge = isCurrent ? `<span class="session-badge">Current</span>` : "";
  const kindBadge =
    session.kind === "history"
      ? `<span class="session-badge ghost-badge">Saved</span>`
      : "";
  card.innerHTML = `
    <div class="session-card-head">
      <h3>${session.name}</h3>
      <div class="session-badge-row">
        ${currentBadge}
        ${kindBadge}
      </div>
    </div>
    ${preview}
    <p>Status: ${session.status}</p>
    <p>Folder: ${session.cwd}</p>
    <p>Updated: ${formatTime(session.updatedAt)}</p>
  `;
  card.addEventListener("click", () => activateSessionFromList(session));
  return card;
}

async function activateSessionFromList(session) {
  if (session.kind === "history") {
    try {
      const payload = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          cwd: session.cwd,
          name: session.name,
          resumeSessionId: session.resumeSessionId
        })
      });
      await refreshSessions();
      await openSession(payload.session.id);
    } catch (err) {
      setStatus(err.message || String(err));
    }
    return;
  }

  await openSession(session.id);
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  sessions = payload.sessions || [];
  renderSessions();
}

function syncTerminalSize() {
  fitAddon.fit();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows
      })
    );
  }
}

function disconnectSocket() {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
  updateInputControls();
}

function scheduleReconnect() {
  if (!activeSessionId || !isAuthenticated || document.hidden || reconnectTimer || hasLiveSession()) {
    return;
  }

  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;
    if (!activeSessionId || !isAuthenticated || document.hidden || hasLiveSession()) {
      return;
    }

    try {
      await connectToSession(activeSessionId, { resetTerminal: true, allowReconnect: true });
    } catch (err) {
      setStatus(err.message || String(err));
      scheduleReconnect();
    }
  }, 600);
}

async function connectToSession(sessionId, { resetTerminal = true, allowReconnect = false } = {}) {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }

  activeSessionId = sessionId;
  renderSessions();
  closeSessionButton.disabled = false;
  setPanelOpen(false);
  if (resetTerminal) {
    pendingOutput = "";
    if (outputFrame !== null) {
      window.cancelAnimationFrame(outputFrame);
      outputFrame = null;
    }
    term.reset();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`
  );
  socket = ws;

  ws.addEventListener("open", async () => {
    setStatus(`Connected to ${sessionId}`);
    syncTerminalSize();
    term.focus();
    updateInputControls();
    await refreshSessions();
  });

  ws.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      queueTerminalOutput(payload.buffer || "");
      setStatus(`${payload.session.name} (${payload.session.status})`);
      return;
    }
    if (payload.type === "data") {
      queueTerminalOutput(payload.data || "");
      return;
    }
    if (payload.type === "exit") {
      setStatus(`Session exited with code ${payload.exitCode}`);
      await refreshSessions();
      return;
    }
    if (payload.type === "error") {
      setStatus(payload.error || "Session error");
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) {
      socket = null;
    }
    setStatus("Disconnected");
    updateInputControls();
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", () => {
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect();
    }
  });
}

async function openSession(sessionId) {
  isManualDisconnect = false;
  await connectToSession(sessionId, { resetTerminal: true, allowReconnect: true });
}

function sendToSession(data) {
  if (!hasLiveSession()) {
    setStatus("Open a session first.");
    return;
  }

  socket.send(JSON.stringify({ type: "input", data }));
}

connectButton.addEventListener("click", async () => {
  try {
    accessToken = tokenInput.value.trim();
    if (!accessToken) {
      throw new Error("Enter the access token first.");
    }
    await loginWithToken(accessToken);
    const payload = await request("/api/config");
    accessToken = "";
    tokenInput.value = "";
    cwdInput.value = cwdInput.value.trim() || payload.defaultCwd || "";
    newSessionButton.disabled = false;
    refreshButton.disabled = false;
    setView("workspace");
    setPanelOpen(true);
    setStatus("Connected. Create or open a session.");
    await refreshSessions();
    updateInputControls();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

newSessionButton.addEventListener("click", async () => {
  try {
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        cwd: cwdInput.value.trim(),
        name: nameInput.value.trim()
      })
    });
    await refreshSessions();
    await openSession(payload.session.id);
    nameInput.value = "";
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await refreshSessions();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

closeSessionButton.addEventListener("click", async () => {
  if (!activeSessionId) {
    return;
  }
  try {
    isManualDisconnect = true;
    await request(`/api/sessions/${activeSessionId}`, { method: "DELETE" });
    disconnectSocket();
    pendingOutput = "";
    term.reset();
    activeSessionId = "";
    closeSessionButton.disabled = true;
    updateInputControls();
    await refreshSessions();
    setStatus("Session closed.");
    setPanelOpen(true);
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

openPanelButton.addEventListener("click", () => {
  setPanelOpen(true);
});

closePanelButton.addEventListener("click", () => {
  setPanelOpen(false);
});

backToConnectButton.addEventListener("click", () => {
  isManualDisconnect = true;
  disconnectSocket();
  activeSessionId = "";
  closeSessionButton.disabled = true;
  setPanelOpen(false);
  setView("connect");
  term.reset();
  setStatus("Disconnected");
  logoutSession();
});

if (!useImeBridge) {
  term.onData((data) => {
    sendToSession(data);
  });
}

term.onResize(() => {
  syncTerminalSize();
});

terminalRoot.addEventListener("click", () => {
  if (useImeBridge) {
    focusImeBridge();
    return;
  }

  term.focus();
});

window.addEventListener("resize", () => {
  requestViewportMetrics();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    blurImeBridge();
    return;
  }

  requestViewportMetrics();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.addEventListener("pageshow", () => {
  requestViewportMetrics();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.visualViewport?.addEventListener("resize", requestViewportMetrics);
window.visualViewport?.addEventListener("scroll", requestViewportMetrics);

imeBridge.addEventListener("compositionstart", () => {
  imeComposing = true;
});

imeBridge.addEventListener("compositionend", () => {
  imeComposing = false;
  flushImeBridgeValue();
});

imeBridge.addEventListener("input", () => {
  flushImeBridgeValue();
});

imeBridge.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    flushImeBridgeValue();
    sendToSession("\r");
    resetImeBridge();
    blurImeBridge();
    requestViewportMetrics();
    scrollTerminalToLatest({ ensureVisible: true });
    return;
  }

  if (event.key === "Backspace" && !imeBridge.value && !imeComposing) {
    event.preventDefault();
    sendToSession("\u007f");
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    sendToSession("\t");
    return;
  }

  const arrowMap = {
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowLeft: "\u001b[D",
    ArrowRight: "\u001b[C"
  };
  const controlValue = arrowMap[event.key];
  if (controlValue) {
    event.preventDefault();
    sendToSession(controlValue);
  }
});

escKeyButton.addEventListener("click", () => {
  sendToSession("\u001b");
  if (useImeBridge && keyboardWasOpen) {
    focusImeBridge();
    return;
  }

  term.focus();
});

updateInputControls();
setView("connect");
setPanelOpen(false);
requestViewportMetrics();
