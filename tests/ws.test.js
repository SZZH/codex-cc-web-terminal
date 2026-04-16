import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import { createKoaApp } from "../src/koa-app.js";
import { installWebSocketServer } from "../src/routes/ws.js";
import { SessionManager } from "../src/sessionManager.js";
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

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
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

test("websocket emits conversation snapshot on connect and conversation delta after input", async (t) => {
  class AppServerBridgeStub extends EventEmitter {
    async startTurn(_session, text) {
      return { turn: { items: [{ type: "agent_message", text: `reply:${text}` }] } };
    }
  }

  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-h1", thread_name: "历史会话" }]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-h1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-h1", cwd: rootDir, thread_name: "历史会话" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "用户：历史问题" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "历史回答" },
      timestamp: "2026-04-13T10:00:02.000Z"
    }
  ]);

  const sessionManager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });
  const session = sessionManager.create({ provider: "codex", cwd: rootDir, resumeSessionId: "thread-h1" });
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
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${session.id}`, {
    headers: {
      origin: baseUrl,
      cookie: auth.cookies
    }
  });
  t.after(async () => {
    await closeWebSocket(ws);
  });

  const incoming = [];
  ws.on("message", (raw) => {
    incoming.push(JSON.parse(String(raw)));
  });

  const initialA = JSON.parse(String(await ws.awaitMessage()));
  const initialB = JSON.parse(String(await ws.awaitMessage()));
  const initial = [initialA, initialB];
  assert.ok(initial.some((item) => item.type === "conversation.snapshot"));
  assert.ok(initial.some((item) => item.type === "snapshot"));

  const convSnapshot = initial.find((item) => item.type === "conversation.snapshot");
  assert.equal(convSnapshot.sessionId, session.id);
  assert.equal(convSnapshot.threadId, "thread-h1");
  assert.equal(convSnapshot.conversation.turns.length, 1);

  ws.send(JSON.stringify({ type: "input", data: "follow up" }));
  await waitForCondition(() => incoming.some((item) => item.type === "conversation.delta"), { timeoutMs: 1000 });
  const deltaPayload = incoming.find((item) => item.type === "conversation.delta");
  assert.ok(deltaPayload);
  assert.ok(deltaPayload.toVersion >= deltaPayload.fromVersion);
  assert.ok(Array.isArray(deltaPayload.deltas));
  assert.ok(deltaPayload.deltas.length > 0);
});
