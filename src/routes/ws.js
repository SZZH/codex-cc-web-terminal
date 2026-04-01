import { WebSocketServer } from "ws";

export function installWebSocketServer(server, runtime) {
  const wss = new WebSocketServer({ noServer: true });
  runtime.wss = wss;

  wss.on("connection", (ws, req, sessionId) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

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
        if (payload.type === "input") {
          runtime.sessionManager.write(sessionId, payload.data || "");
        } else if (payload.type === "resize") {
          runtime.sessionManager.resize(sessionId, payload.cols, payload.rows);
        }
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
    if (url.pathname !== "/ws") {
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
