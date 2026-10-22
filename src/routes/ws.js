import { WebSocketServer } from "ws";
import { applySessionInputEvents, normalizeSessionInputEvents } from "../transport/sse/sessionStream.js";

const MAX_CODEX_WS_BUFFER_BYTES = 1024 * 1024;

export function sendCodexEvent(ws, event) {
  if (ws.readyState !== 1) return false;
  const payload = JSON.stringify(event);
  if (ws.bufferedAmount + Buffer.byteLength(payload) > MAX_CODEX_WS_BUFFER_BYTES) {
    ws.terminate();
    return false;
  }
  ws.send(payload);
  return true;
}

export function installWebSocketServer(server, runtime) {
  const wss = new WebSocketServer({ noServer: true });
  runtime.wss = wss;

  wss.on("connection", (ws, req, sessionId, codexSubscription = null) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    if (codexSubscription) {
      try {
        const unsubscribe = runtime.codexThreads.subscribe(codexSubscription.threadId, (event) => {
          sendCodexEvent(ws, event);
        }, codexSubscription);
        ws.on("close", unsubscribe);
      } catch (error) {
        ws.close(1011, "Unable to subscribe to this thread");
      }
      return;
    }

    try {
      runtime.sessionManager.attachClient(sessionId, ws);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: err?.message || String(err) }));
      ws.close();
      return;
    }

    ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(String(raw || "{}"));
        applySessionInputEvents(runtime.sessionManager, sessionId, normalizeSessionInputEvents(payload));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: err?.message || String(err) }));
      }
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, runtime.config.wsHeartbeatMs);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws" && url.pathname !== "/ws/codex") {
      socket.destroy();
      return;
    }

    if (!runtime.isAllowedClient(req)) {
      console.warn(
        `[ws] denied client=${runtime.normalizeIp(runtime.getClientAddress(req)) || "unknown"} reason=client-not-allowed`
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!runtime.isTrustedOrigin(req)) {
      console.warn(
        `[ws] denied client=${runtime.normalizeIp(runtime.getClientAddress(req)) || "unknown"} reason=origin origin=${String(req.headers.origin || "")}`
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!runtime.isAuthorized(req)) {
      console.warn(
        `[ws] denied client=${runtime.normalizeIp(runtime.getClientAddress(req)) || "unknown"} reason=unauthorized`
      );
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws/codex") {
      const threadId = url.searchParams.get("threadId") || "";
      if (!runtime.codexThreads || !/^[a-zA-Z0-9_-]{8,128}$/.test(threadId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return;
      }
      const subscription = { threadId, epoch: url.searchParams.get("epoch") || "", after: Number(url.searchParams.get("after")) || 0 };
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, null, subscription));
      return;
    }
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!sessionId || !runtime.sessionManager.get(sessionId)) {
      console.warn(
        `[ws] denied client=${runtime.normalizeIp(runtime.getClientAddress(req)) || "unknown"} reason=session-not-found sessionId=${sessionId}`
      );
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log(
        `[ws] connected client=${runtime.normalizeIp(runtime.getClientAddress(req)) || "unknown"} sessionId=${sessionId}`
      );
      wss.emit("connection", ws, req, sessionId);
    });
  });

  return {
    wss,
    closeClients(signal = "unknown") {
      for (const ws of wss.clients) {
        try {
          ws.close(1012, `Server restarting (${signal})`);
        } catch {
          ws.terminate();
        }
      }
    },
    stop() {
      clearInterval(heartbeatInterval);
    }
  };
}
