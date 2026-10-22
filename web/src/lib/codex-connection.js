export function createCodexConnection({ store, createSocket, location, errors, isDisposed,
  onOpen, onMessage, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, handshakeTimeoutMs = 30000, reconnectMs = 2000 } = {}) {
  let socket = null;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let started = false;
  let closed = false;
  let lastForegroundConnect = -Infinity;
  let handshakeStartedAt = null;
  const disposed = () => closed || isDisposed();
  const clearHandshake = () => { clearTimer(handshakeTimer); handshakeTimer = null; };

  function retry() {
    if (disposed()) return;
    clearTimer(reconnectTimer);
    reconnectTimer = setTimer(connect, reconnectMs);
  }

  function unavailable(current) {
    if (disposed() || socket !== current) return;
    clearHandshake();
    socket = null;
    store.state.connection = "offline";
    try { current.close(); } catch { /* Retry does not depend on a close event. */ }
    retry();
  }

  function connect() {
    if (disposed() || !createSocket) return;
    started = true;
    clearTimer(reconnectTimer); reconnectTimer = null;
    clearHandshake();
    const errorToken = errors.begin("connection");
    const generation = store.beginSocket();
    const previous = socket; socket = null;
    try { previous?.close(); } catch { /* Replacing an unavailable transport is safe. */ }
    store.state.connection = "connecting";
    try {
      const params = new URLSearchParams({ threadId: store.state.threadId, epoch: store.state.epoch, after: String(store.state.seq) });
      const protocol = location?.protocol === "https:" ? "wss:" : "ws:";
      const current = createSocket(`${protocol}//${location?.host || "localhost"}/ws/codex?${params}`);
      socket = current;
      handshakeStartedAt = now();
      handshakeTimer = setTimer(function handshakeExpired() {
        if (disposed() || socket !== current || store.state.connection !== "connecting") return;
        errors.fail(errorToken, new Error("实时连接建立超时，正在重试。"));
        unavailable(current);
      }, handshakeTimeoutMs);
      current.onopen = () => {
        if (disposed() || socket !== current) return;
        clearHandshake();
        store.state.connection = "connected";
        errors.succeed(errorToken);
        onOpen?.();
      };
      current.onmessage = (message) => {
        if (!disposed() && socket === current) onMessage?.(message, generation, () => unavailable(current));
      };
      current.onclose = () => unavailable(current);
      current.onerror = () => unavailable(current);
    } catch (error) {
      clearHandshake();
      store.state.connection = "offline";
      errors.fail(errorToken, error);
      retry();
    }
  }

  function resume({ fromHidden = false } = {}) {
    if (!started || disposed()) return;
    if (store.state.connection === "connecting" && !(socket?.readyState > 1)
      && (!fromHidden || now() - handshakeStartedAt < 5000)) return;
    if (store.state.connection === "connected" && !(socket?.readyState > 1)) {
      if (!fromHidden || now() - lastForegroundConnect < 5000) return;
      lastForegroundConnect = now();
    }
    connect();
  }

  function dispose() {
    if (closed) return;
    closed = true;
    clearTimer(reconnectTimer); reconnectTimer = null;
    clearHandshake();
    const previous = socket; socket = null;
    try { previous?.close(); } catch { /* Disposal invalidates every old callback. */ }
  }

  return { connect, resume, dispose };
}
