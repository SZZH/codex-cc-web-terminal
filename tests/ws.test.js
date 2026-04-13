import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { WebSocket } from "ws";

import { createKoaApp } from "../src/koa-app.js";
import { installWebSocketServer } from "../src/routes/ws.js";
import { createBaseConfig, createTempDir, login, waitForCondition } from "./helpers/backendTestUtils.js";

function connectWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const queuedMessages = [];
    const pendingResolvers = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      ws.terminate();
      reject(new Error("WebSocket connection timeout"));
    }, 1500);

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    ws.on("message", (raw) => {
      const nextResolver = pendingResolvers.shift();
      if (nextResolver) {
        nextResolver(raw);
        return;
      }
      queuedMessages.push(raw);
    });

    ws.awaitMessage = () => {
      if (queuedMessages.length > 0) {
        return Promise.resolve(queuedMessages.shift());
      }
      return new Promise((resolver) => {
        pendingResolvers.push(resolver);
      });
    };

    ws.once("open", () => finish(resolve, ws));
    ws.once("error", (error) => finish(reject, error));
    ws.once("unexpected-response", (_req, response) => {
      finish(reject, new Error(`Unexpected response status: ${response.statusCode || "unknown"}`));
    });
    ws.once("close", (code) => {
      if (!settled) {
        finish(reject, new Error(`WebSocket closed before open: ${code}`));
      }
    });
  });
}

function closeWebSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // no-op
      }
      resolve();
    }, 250);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

test("websocket rejects unauthenticated clients", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const sessionManager = {
    attachClient() {},
    get() {
      return { id: "session-1" };
    },
    write() {},
    resize() {},
    providerCatalog() {
      return [];
    },
    stats() {
      return { sessions: 0, clients: 0, running: 0, exited: 0 };
    }
  };

  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());
  const wsRuntime = installWebSocketServer(server, runtime);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    wsRuntime.stop();
    await new Promise((resolve) => wsRuntime.wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  await assert.rejects(
    connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1`, {
      headers: { origin: `http://127.0.0.1:${port}` }
    }),
    /401/
  );
});

test("websocket accepts authenticated clients and forwards input events", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const recorded = { inputs: [], resizes: [], attached: [] };
  const sessionManager = {
    attachClient(sessionId, ws) {
      recorded.attached.push(sessionId);
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "snapshot", session: { id: sessionId }, buffer: "" }));
      }, 15).unref?.();
    },
    get(id) {
      return id === "session-1" ? { id } : null;
    },
    write(id, data) {
      recorded.inputs.push({ id, data });
    },
    resize(id, cols, rows) {
      recorded.resizes.push({ id, cols, rows });
    },
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: 1, running: 1, exited: 0 };
    }
  };

  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());
  const wsRuntime = installWebSocketServer(server, runtime);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    wsRuntime.closeClients("test-cleanup");
    wsRuntime.stop();
    await new Promise((resolve) => wsRuntime.wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = await login(baseUrl, config.accessToken);

  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1`, {
    headers: {
      origin: baseUrl,
      cookie: auth.cookies
    }
  });
  t.after(async () => {
    await closeWebSocket(ws);
  });

  const snapshotMessage = JSON.parse(String(await ws.awaitMessage()));
  assert.equal(snapshotMessage.type, "snapshot");
  assert.deepEqual(recorded.attached, ["session-1"]);

  ws.send(JSON.stringify({ type: "input", data: "hello" }));
  ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

  await waitForCondition(() => recorded.inputs.length === 1 && recorded.resizes.length === 1, { timeoutMs: 400 });
  assert.deepEqual(recorded.inputs, [{ id: "session-1", data: "hello" }]);
  assert.deepEqual(recorded.resizes, [{ id: "session-1", cols: 120, rows: 40 }]);
});

test("websocket rejects authenticated clients with untrusted origin", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const sessionManager = {
    attachClient() {},
    get() {
      return { id: "session-1" };
    },
    write() {},
    resize() {},
    providerCatalog() {
      return [];
    },
    stats() {
      return { sessions: 0, clients: 0, running: 0, exited: 0 };
    }
  };

  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());
  const wsRuntime = installWebSocketServer(server, runtime);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    wsRuntime.stop();
    await new Promise((resolve) => wsRuntime.wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = await login(baseUrl, config.accessToken);
  await assert.rejects(
    connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1`, {
      headers: {
        origin: "https://evil.example.com",
        cookie: auth.cookies
      }
    }),
    /403/
  );
});

test("websocket rejects authenticated clients for unknown session", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const sessionManager = {
    attachClient() {},
    get() {
      return null;
    },
    write() {},
    resize() {},
    providerCatalog() {
      return [];
    },
    stats() {
      return { sessions: 0, clients: 0, running: 0, exited: 0 };
    }
  };

  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());
  const wsRuntime = installWebSocketServer(server, runtime);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    wsRuntime.stop();
    await new Promise((resolve) => wsRuntime.wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = await login(baseUrl, config.accessToken);
  await assert.rejects(
    connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=missing`, {
      headers: {
        origin: baseUrl,
        cookie: auth.cookies
      }
    }),
    /404/
  );
});

test("websocket sends error event for malformed frame payload", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const sessionManager = {
    attachClient(_sessionId, ws) {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "snapshot", session: { id: "session-1" }, buffer: "" }));
      }, 15).unref?.();
    },
    get(id) {
      return id === "session-1" ? { id } : null;
    },
    write() {},
    resize() {},
    providerCatalog() {
      return [];
    },
    stats() {
      return { sessions: 1, clients: 1, running: 1, exited: 0 };
    }
  };

  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());
  const wsRuntime = installWebSocketServer(server, runtime);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    wsRuntime.closeClients("test-cleanup");
    wsRuntime.stop();
    await new Promise((resolve) => wsRuntime.wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = await login(baseUrl, config.accessToken);
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1`, {
    headers: {
      origin: baseUrl,
      cookie: auth.cookies
    }
  });
  t.after(async () => {
    await closeWebSocket(ws);
  });

  await ws.awaitMessage();
  ws.send("{invalid-json");
  const message = JSON.parse(String(await ws.awaitMessage()));
  assert.equal(message.type, "error");
});
