import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createSseStreamWriter } from "../src/transport/index.js";
import { openSessionSseStream } from "../src/transport/sse/sessionStream.js";
import { requestSessionInputStream } from "../web/src/lib/api.js";
import { login, startTestServer } from "./helpers/backendTestUtils.js";
import { normalizeSessionInputEvents, applySessionInputEvents } from "../src/transport/index.js";
import { mergeAuthoritativeThreadSnapshotPatch } from "../web/src/lib/thread-display-state.js";

function parseSseFrames(raw) {
  return String(raw || "")
    .split(/\n\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const frame = { event: "", id: "", data: "" };
      for (const line of lines) {
        if (line.startsWith("event:")) {
          frame.event = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("id:")) {
          frame.id = line.slice("id:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          frame.data += `${line.slice("data:".length).trimStart()}\n`;
        }
      }
      return {
        event: frame.event,
        id: frame.id,
        payload: JSON.parse(frame.data.trimEnd() || "{}")
      };
    });
}

test("input-stream contract: thread-scoped SSE streams only tracked-turn deltas instead of history snapshots", async (t) => {
  const writes = [];
  const liveSession = {
    id: "session-42",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Thread scoped session",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-transport-42",
    currentTurnId: "turn-transport-42",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: "",
    clients: new Set()
  };

  const sessionManager = {
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    ensureLiveSessionForThread(threadId) {
      assert.equal(threadId, liveSession.resumeSessionId);
      return liveSession;
    },
    attachClient(_sessionId, client) {
      liveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "conversation.snapshot",
          sessionId: liveSession.id,
          threadId: liveSession.resumeSessionId,
          conversation: {
            sessionId: liveSession.id,
            threadId: liveSession.resumeSessionId,
            version: 7,
            status: "running",
            turns: [{ id: liveSession.currentTurnId, status: "running" }]
          },
          threadSnapshot: {
            threadId: liveSession.resumeSessionId,
            turns: [{ id: liveSession.currentTurnId, status: "running", items: [] }]
          },
          liveOverlay: {
            threadId: liveSession.resumeSessionId,
            turnId: liveSession.currentTurnId,
            text: "streaming"
          }
        })
      );
      client.on?.("close", () => {
        liveSession.clients.delete(client);
      });
    },
    write(id, data) {
      writes.push({ id, data });
      for (const client of liveSession.clients) {
        client.send(
          JSON.stringify({
            type: "conversation.delta",
            sessionId: liveSession.id,
            threadId: liveSession.resumeSessionId,
            fromVersion: 7,
            toVersion: 8,
            deltas: [
              {
                kind: "body_appended",
                turnId: liveSession.currentTurnId,
                block: {
                  id: "body-thread-transport-42",
                  kind: "markdown",
                  text: "streaming",
                  mergeMode: "stream_append"
                }
              }
            ]
          })
        );
      }
      return liveSession.currentTurnId;
    },
    resize() {},
    listAll() {
      return [liveSession];
    },
    listArchived() {
      return [];
    },
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: liveSession.clients.size, running: 1, exited: 0 };
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/sessions/${liveSession.id}/input-stream`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({
      events: [
        { type: "resize", cols: 120, rows: 40 },
        { type: "input", data: "继续这个 thread\n" }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE frame")), 1000))
    ]);
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});

  const frames = parseSseFrames(buffer);
  assert.equal(frames.some((frame) => frame.event === "conversation.snapshot"), false);
  const deltaFrame = frames.find((frame) => frame.event === "conversation.delta");
  assert.ok(deltaFrame);
  assert.equal(deltaFrame.payload.threadId, liveSession.resumeSessionId);
  assert.equal(deltaFrame.payload.deltas.length, 1);
  assert.equal(deltaFrame.payload.deltas[0].block.text, "streaming");
  assert.deepEqual(writes, [{ id: liveSession.id, data: "继续这个 thread\n" }]);
});

test("input-stream contract: session-scoped route delegates to thread-backed live resolution when resume thread exists", async (t) => {
  const attachCalls = [];
  const compatibilitySession = {
    id: "session-compat-1",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Compat session",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-compat-1",
    currentTurnId: "",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: "",
    clients: new Set()
  };
  const resolvedLiveSession = {
    ...compatibilitySession,
    id: "session-live-resolved-1",
    clients: new Set()
  };

  const sessionManager = {
    get(id) {
      if (id === compatibilitySession.id) {
        return compatibilitySession;
      }
      if (id === resolvedLiveSession.id) {
        return resolvedLiveSession;
      }
      return null;
    },
    ensureLiveSessionForThread(threadId, options = {}) {
      assert.equal(threadId, compatibilitySession.resumeSessionId);
      assert.equal(options.providerId, "codex");
      return resolvedLiveSession;
    },
    attachClient(id, client) {
      attachCalls.push(id);
      resolvedLiveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "conversation.snapshot",
          sessionId: resolvedLiveSession.id,
          threadId: resolvedLiveSession.resumeSessionId,
          conversation: {
            sessionId: resolvedLiveSession.id,
            threadId: resolvedLiveSession.resumeSessionId,
            version: 1,
            status: "running",
            turns: []
          },
          threadSnapshot: {
            threadId: resolvedLiveSession.resumeSessionId,
            turns: []
          },
          liveOverlay: null
        })
      );
      client.on?.("close", () => {
        resolvedLiveSession.clients.delete(client);
      });
    },
    write(id, data) {
      assert.equal(id, resolvedLiveSession.id);
      assert.equal(data, "代理到 thread\n");
      return "";
    },
    resize() {},
    listAll() {
      return [compatibilitySession];
    },
    listArchived() {
      return [];
    },
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: resolvedLiveSession.clients.size, running: 1, exited: 0 };
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/sessions/${compatibilitySession.id}/input-stream`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ type: "input", data: "代理到 thread\n" })
  });

  assert.equal(response.status, 200);
  await response.body?.cancel?.().catch(() => {});
  assert.deepEqual(attachCalls, [resolvedLiveSession.id]);
});

test("input route contract: session input writes once and returns json without opening SSE", async (t) => {
  const writes = [];
  const compatibilitySession = {
    id: "session-json-input-1",
    provider: "codex",
    name: "Json input",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resumeSessionId: "thread-json-input-1",
    currentTurnId: "",
    clients: new Set()
  };
  const resolvedLiveSession = {
    ...compatibilitySession,
    id: "session-json-live-1",
    currentTurnId: "turn-json-live-1"
  };

  const sessionManager = {
    get(id) {
      if (id === compatibilitySession.id) {
        return compatibilitySession;
      }
      if (id === resolvedLiveSession.id) {
        return resolvedLiveSession;
      }
      return null;
    },
    ensureLiveSessionForThread(threadId) {
      assert.equal(threadId, compatibilitySession.resumeSessionId);
      return resolvedLiveSession;
    },
    write(id, data) {
      writes.push({ id, data });
      return "turn-json-written-1";
    },
    resize() {},
    listAll() {
      return [compatibilitySession];
    },
    listArchived() {
      return [];
    },
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: 0, running: 1, exited: 0 };
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/sessions/${compatibilitySession.id}/input`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ type: "input", data: "通过普通输入接口发送\n" })
  });

  assert.equal(response.status, 202);
  assert.match(String(response.headers.get("content-type") || ""), /application\/json/);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.session.id, resolvedLiveSession.id);
  assert.equal(payload.turnId, "turn-json-written-1");
  assert.deepEqual(writes, [{ id: resolvedLiveSession.id, data: "通过普通输入接口发送\n" }]);
});

test("input-stream contract: route filters conversation snapshots and closes on tracked terminal events", async (t) => {
  const liveSession = {
    id: "session-close-1",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Close tracking session",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-close-1",
    currentTurnId: "",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: "",
    clients: new Set()
  };

  const sessionManager = {
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    ensureLiveSessionForThread(threadId) {
      assert.equal(threadId, liveSession.resumeSessionId);
      return liveSession;
    },
    attachClient(_sessionId, client) {
      liveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "conversation.snapshot",
          sessionId: liveSession.id,
          threadId: liveSession.resumeSessionId,
          conversation: {
            sessionId: liveSession.id,
            threadId: liveSession.resumeSessionId,
            version: 1,
            status: "idle",
            turns: []
          },
          threadSnapshot: {
            threadId: liveSession.resumeSessionId,
            turns: []
          },
          liveOverlay: null
        })
      );
      client.on?.("close", () => {
        liveSession.clients.delete(client);
      });
    },
    write(id, data) {
      assert.equal(id, liveSession.id);
      assert.equal(data, "close me\n");
      const returnedTurnId = "turn-returned-by-write";
      liveSession.threadSnapshot = {
        threadId: liveSession.resumeSessionId,
        turns: [{ id: returnedTurnId, status: "completed", items: [] }]
      };
      for (const client of liveSession.clients) {
        client.send(
          JSON.stringify({
            type: "conversation.snapshot",
            sessionId: liveSession.id,
            threadId: liveSession.resumeSessionId,
            conversation: {
              sessionId: liveSession.id,
              threadId: liveSession.resumeSessionId,
              version: 2,
              status: "completed",
              turns: [{ id: returnedTurnId, status: "completed" }]
            },
            threadSnapshot: {
              threadId: liveSession.resumeSessionId,
              turns: [{ id: returnedTurnId, status: "completed", items: [] }]
            },
            liveOverlay: null
          })
        );
        client.send(
          JSON.stringify({
            type: "turn.completed",
            sessionId: liveSession.id,
            threadId: liveSession.resumeSessionId,
            turnId: returnedTurnId,
            status: "completed",
            ts: "2026-04-29T14:00:00.000Z"
          })
        );
      }
      return returnedTurnId;
    },
    resize() {},
    listAll() {
      return [liveSession];
    },
    listArchived() {
      return [];
    },
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: liveSession.clients.size, running: 1, exited: 0 };
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/sessions/${liveSession.id}/input-stream`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ type: "input", data: "close me\n" })
  });

  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("event: turn.completed")) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for terminal turn event")), 1000))
    ]);
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  const frames = parseSseFrames(buffer);
  assert.equal(frames.some((frame) => frame.event === "conversation.snapshot"), false);
  assert.ok(frames.some((frame) => frame.event === "turn.completed"));
});

test("input-stream contract: openSessionSseStream emits conversation.delta directly and closes after tracked turn completion", async () => {
  const liveSession = {
    id: "session-conversation-delta-1",
    provider: "codex",
    resumeSessionId: "thread-conversation-delta-1",
    currentTurnId: "turn-conversation-delta-1",
    clients: new Set(),
    threadSnapshot: {
      threadId: "thread-conversation-delta-1",
      activeTurnId: "turn-conversation-delta-1",
      turns: [{ id: "turn-conversation-delta-1", status: "inProgress", items: [] }]
    },
    conversationState: {
      sessionId: "session-conversation-delta-1",
      threadId: "thread-conversation-delta-1",
      version: 1,
      activeTurnId: "turn-conversation-delta-1",
      turns: [{ id: "turn-conversation-delta-1", assistant: { status: "running", body: [] } }]
    }
  };

  const sessionManager = {
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    attachClient(_sessionId, client) {
      liveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "conversation.delta",
          sessionId: "session-conversation-delta-1",
          threadId: "thread-conversation-delta-1",
          fromVersion: 1,
          toVersion: 2,
          conversation: {
            sessionId: "session-conversation-delta-1",
            threadId: "thread-conversation-delta-1",
            version: 2,
            status: "running",
            activeTurnId: "turn-conversation-delta-1",
            turns: [{ id: "turn-conversation-delta-1", assistant: { status: "running", body: [] } }]
          },
          deltas: [
            {
              kind: "body_appended",
              turnId: "turn-conversation-delta-1",
              block: {
                id: "body-conversation-delta-1",
                kind: "markdown",
                text: "direct delta",
                mergeMode: "stream_append"
              }
            },
            {
              kind: "turn_completed",
              turnId: "turn-conversation-delta-1",
              status: "completed",
              timestamp: "2026-04-29T14:00:00.000Z"
            }
          ]
        })
      );
    }
  };

  const reqListeners = new Map();
  const resListeners = new Map();
  const chunks = [];
  let closed = false;

  const req = {
    on(name, handler) {
      reqListeners.set(name, handler);
    }
  };
  const res = {
    setHeader() {},
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      closed = true;
    },
    on(name, handler) {
      resListeners.set(name, handler);
    }
  };

  const stream = openSessionSseStream({
    req,
    res,
    sessionManager,
    sessionId: liveSession.id,
    keepaliveMs: 5,
    terminalCloseDelayMs: 10
  });
  stream.setTrackedTurnId("turn-conversation-delta-1");

  await new Promise((resolve) => setTimeout(resolve, 25));
  const text = chunks.join("");
  const frames = parseSseFrames(text);
  const deltaFrame = frames.find((frame) => frame.event === "conversation.delta");
  assert.ok(deltaFrame);
  assert.equal(deltaFrame.payload.type, "conversation.delta");
  assert.equal(deltaFrame.payload.deltas.length, 2);
  assert.equal(deltaFrame.payload.deltas[0].kind, "body_appended");
  assert.equal(deltaFrame.payload.deltas[1].kind, "turn_completed");
  assert.equal(closed, true);
  stream.close();
});

test("input-stream contract: typed terminal turn events close after tail events for the tracked turn", async () => {
  const liveSession = {
    id: "session-terminal-open-1",
    provider: "codex",
    resumeSessionId: "thread-terminal-open-1",
    currentTurnId: "turn-terminal-open-1",
    clients: new Set(),
    threadSnapshot: {
      threadId: "thread-terminal-open-1",
      activeTurnId: "turn-terminal-open-1",
      turns: [{ id: "turn-terminal-open-1", status: "running", items: [] }]
    },
    conversationState: {
      threadId: "thread-terminal-open-1",
      activeTurnId: "turn-terminal-open-1",
      turns: [{ id: "turn-terminal-open-1", assistant: { status: "running", body: [] } }]
    }
  };

  const reqListeners = new Map();
  const resListeners = new Map();
  const chunks = [];
  let closed = false;

  const req = {
    on(name, handler) {
      reqListeners.set(name, handler);
    }
  };
  const res = {
    setHeader() {},
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      closed = true;
    },
    on(name, handler) {
      resListeners.set(name, handler);
    }
  };

  const sessionManager = {
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    attachClient(_sessionId, client) {
      liveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "turn.completed",
          threadId: "thread-terminal-open-1",
          sessionId: "session-terminal-open-1",
          turnId: "turn-terminal-open-1",
          status: "completed",
          ts: "2026-04-29T14:00:00.000Z"
        })
      );

      setTimeout(() => {
        client.send(
          JSON.stringify({
            type: "process.completed",
            sessionId: "session-terminal-open-1",
            threadId: "thread-terminal-open-1",
            turnId: "turn-terminal-open-1",
            processId: "proc-tail-1",
            processType: "command_execution",
            summary: "tail event",
            ts: "2026-04-29T14:00:01.000Z"
          })
        );
      }, 5);
    }
  };

  const stream = openSessionSseStream({
    req,
    res,
    sessionManager,
    sessionId: liveSession.id,
    keepaliveMs: 5,
    terminalCloseDelayMs: 20
  });
  stream.setTrackedTurnId("turn-terminal-open-1");

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(closed, true);
  const text = chunks.join("");
  assert.match(text, /event: turn\.completed/);
  assert.match(text, /event: process\.completed/);
  stream.close();
});

test("typed SSE writer contract: event type becomes event name and version-like fields become SSE id", () => {
  const writes = [];
  const writer = createSseStreamWriter({
    write(chunk) {
      writes.push(String(chunk));
    },
    flushHeaders() {},
    end() {}
  });

  writer.open();
  writer.sendTypedEvent({
    type: "thread.snapshot",
    threadId: "thread-transport-42",
    version: 9,
    snapshot: { threadId: "thread-transport-42" }
  });
  writer.sendTypedEvent({
    type: "message.delta",
    ts: "2026-04-23T12:00:00.000Z",
    text: "hello"
  });

  const frames = parseSseFrames(writes.join(""));
  assert.deepEqual(
    frames.map((frame) => ({ event: frame.event, id: frame.id })),
    [
      { event: "thread.snapshot", id: "9" },
      { event: "message.delta", id: "2026-04-23T12:00:00.000Z" }
    ]
  );
  assert.equal(frames[0].payload.type, "thread.snapshot");
  assert.equal(frames[0].payload.threadId, "thread-transport-42");
  assert.equal(frames[1].payload.text, "hello");
});

test("typed SSE writer contract: started/delta/completed lifecycle events preserve event names and ids", () => {
  const writes = [];
  const writer = createSseStreamWriter({
    write(chunk) {
      writes.push(String(chunk));
    },
    flushHeaders() {},
    end() {}
  });

  writer.open();
  writer.sendTypedEvent({
    type: "process.started",
    processId: "proc-writer-1",
    processType: "command_execution",
    summary: "npm run check",
    ts: "2026-04-29T00:00:01.000Z"
  });
  writer.sendTypedEvent({
    type: "process.delta",
    processId: "proc-writer-1",
    processType: "command_execution",
    summary: "src/sessionManager.js",
    ts: "2026-04-29T00:00:02.000Z"
  });
  writer.sendTypedEvent({
    type: "process.completed",
    processId: "proc-writer-1",
    processType: "command_execution",
    summary: "done",
    ts: "2026-04-29T00:00:03.000Z"
  });
  writer.sendTypedEvent({
    type: "turn.completed",
    turnId: "turn-writer-1",
    ts: "2026-04-29T00:00:04.000Z"
  });

  const frames = parseSseFrames(writes.join(""));
  assert.deepEqual(
    frames.map((frame) => ({ event: frame.event, id: frame.id })),
    [
      { event: "process.started", id: "2026-04-29T00:00:01.000Z" },
      { event: "process.delta", id: "2026-04-29T00:00:02.000Z" },
      { event: "process.completed", id: "2026-04-29T00:00:03.000Z" },
      { event: "turn.completed", id: "turn-writer-1" }
    ]
  );
});

test("typed SSE client contract: requestSessionInputStream parses typed event blocks without falling back to websocket semantics", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const streamBody = [
    'id: 3\nevent: message_part\ndata: {"type":"message_part","seq":3,"threadId":"thread-transport-42","part":{"type":"text","text":"hi"}}\n\n',
    'id: 4\nevent: conversation.snapshot\ndata: {"type":"conversation.snapshot","version":4,"threadId":"thread-transport-42","conversation":{"threadId":"thread-transport-42","turns":[]}}\n\n'
  ].join("");

  globalThis.fetch = async () =>
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(streamBody));
      controller.close();
    } }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8"
      }
    });

  const payloads = [];
  await requestSessionInputStream("session-42", { type: "input", data: "hi\n" }, {
    onPayload(payload, eventName) {
      payloads.push({ payload, eventName });
    }
  });

  assert.deepEqual(
    payloads.map((entry) => ({ eventName: entry.eventName, type: entry.payload.type, threadId: entry.payload.threadId })),
    [
      { eventName: "message_part", type: "message_part", threadId: "thread-transport-42" },
      { eventName: "conversation.snapshot", type: "conversation.snapshot", threadId: "thread-transport-42" }
    ]
  );
});

test("typed SSE contract: transport event names stay on the typed surface instead of leaking legacy websocket names", () => {
  const writes = [];
  const writer = createSseStreamWriter({
    write(chunk) {
      writes.push(String(chunk));
    },
    flushHeaders() {},
    end() {}
  });

  writer.open();
  writer.sendTypedEvent({
    type: "thread.snapshot",
    threadId: "thread-surface-1",
    version: 12,
    snapshot: { threadId: "thread-surface-1", turns: [] }
  });
  writer.sendTypedEvent({
    type: "session.updated",
    session: { id: "session-surface-1", updatedAt: "2026-04-23T12:00:00.000Z" }
  });

  const events = parseSseFrames(writes.join("")).map((frame) => frame.event);
  assert.deepEqual(events, ["thread.snapshot", "session.updated"]);
  assert.ok(!events.some((event) => /^conversation(\.|_)/.test(event) || event === "message_part"));
});

test("typed SSE contract: thread.snapshot payload is a partial turn patch instead of replaying the whole thread history", () => {
  const payload = {
    type: "thread.snapshot",
    partial: true,
    threadId: "thread-surface-2",
    turnId: "turn-live-2",
    version: 42,
    snapshot: {
      threadId: "thread-surface-2",
      turns: [{ id: "turn-live-2", items: [] }]
    },
    conversation: {
      sessionId: "session-surface-2",
      threadId: "thread-surface-2",
      version: 42,
      turns: [{ id: "turn-live-2" }],
      activeTurnId: "turn-live-2"
    }
  };

  const normalized = (() => {
    const writes = [];
    const localWriter = createSseStreamWriter({
      write(chunk) {
        writes.push(String(chunk));
      },
      flushHeaders() {},
      end() {}
    });
    localWriter.open();
    localWriter.sendTypedEvent(payload);
    return parseSseFrames(writes.join(""))[0]?.payload;
  })();

  assert.equal(normalized.partial, true);
  assert.deepEqual(normalized.snapshot.turns.map((turn) => turn.id), ["turn-live-2"]);
  assert.deepEqual(normalized.conversation.turns.map((turn) => turn.id), ["turn-live-2"]);
  assert.equal(normalized.snapshot.threadId, "thread-surface-2");
  assert.ok(Array.isArray(normalized.snapshot.turns));
  assert.ok(!("runtime" in normalized.snapshot));
  assert.ok(!("metrics" in normalized.snapshot));
  assert.ok(!("conversation" in normalized.snapshot));
  assert.ok(!("continuation" in normalized));
});

test("typed SSE contract: completed turn snapshots do not keep the completed turn as activeTurnId", () => {
  const payload = {
    type: "thread.snapshot",
    partial: true,
    threadId: "thread-surface-3",
    sessionId: "session-surface-3",
    status: "completed",
    turnId: "turn-completed-3",
    version: 43,
    timestamp: "2026-04-23T12:00:00.000Z",
    snapshot: {
      threadId: "thread-surface-3",
      version: 43,
      updatedAt: "2026-04-23T12:00:00.000Z",
      activeTurnId: "",
      turns: [{ id: "turn-completed-3", status: "completed", items: [] }]
    },
    conversation: {
      sessionId: "session-surface-3",
      threadId: "thread-surface-3",
      version: 43,
      status: "completed",
      activeTurnId: "",
      turns: [{ id: "turn-completed-3", assistant: { status: "completed", body: [{ text: "done" }] } }]
    }
  };

  const normalized = (() => {
    const writes = [];
    const localWriter = createSseStreamWriter({
      write(chunk) {
        writes.push(String(chunk));
      },
      flushHeaders() {},
      end() {}
    });
    localWriter.open();
    localWriter.sendTypedEvent(payload);
    return parseSseFrames(writes.join(""))[0]?.payload;
  })();

  assert.equal(normalized.status, "completed");
  assert.equal(normalized.snapshot.activeTurnId, "");
  assert.equal(normalized.conversation.activeTurnId, "");
});

test("typed SSE contract: partial thread snapshot merges into existing history instead of replacing it", () => {
  const merged = mergeAuthoritativeThreadSnapshotPatch({
    persistedSnapshot: {
      threadId: "thread-merge-1",
      metadata: { name: "History Thread" },
      turns: [
        { id: "turn-history-1", status: "completed", items: [{ kind: "UserMessage", text: "老消息" }] }
      ],
      version: 10,
      updatedAt: "2026-04-23T12:00:00.000Z"
    },
    authoritativeSnapshot: null,
    incomingSnapshot: {
      threadId: "thread-merge-1",
      metadata: { name: "History Thread" },
      turns: [
        { id: "turn-live-1", status: "inProgress", items: [{ kind: "UserMessage", text: "新消息" }] }
      ],
      version: 11,
      updatedAt: "2026-04-23T12:00:01.000Z"
    }
  });

  assert.deepEqual(
    merged.turns.map((turn) => turn.id),
    ["turn-history-1", "turn-live-1"]
  );
});

test("typed SSE contract: input-stream transport filters snapshots and keeps tracked conversation deltas typed", () => {
  const sessionStreamSource = fs.readFileSync(new URL("../src/transport/sse/sessionStream.js", import.meta.url), "utf8");

  assert.match(
    sessionStreamSource,
    /if \(type === "conversation\.snapshot"\) \{[\s\S]*return \[\];[\s\S]*if \(type === "conversation\.delta"\) \{[\s\S]*filterConversationDeltaForTrackedTurns/
  );
  assert.doesNotMatch(sessionStreamSource, /buildThreadTransportSnapshot\(session, payload/);
  assert.doesNotMatch(sessionStreamSource, /type === "snapshot"/);
  assert.doesNotMatch(sessionStreamSource, /type === "conversation_snapshot"/);
});

test("input main-path guard: App submits through json input and leaves rendering to history polling", () => {
  const appSource = fs.readFileSync(new URL("../web/src/App.vue", import.meta.url), "utf8");
  const threadRuntimeSource = fs.readFileSync(new URL("../web/src/lib/thread-runtime.js", import.meta.url), "utf8");
  const liveRuntimeSource = fs.readFileSync(new URL("../web/src/lib/live-session-runtime.js", import.meta.url), "utf8");
  const sessionManagerSource = fs.readFileSync(new URL("../src/sessionManager.js", import.meta.url), "utf8");
  const submitStart = appSource.indexOf("async function submitInput()");
  const submitEnd = appSource.indexOf("async function interruptActiveSession()");
  const submitSource = submitStart >= 0 && submitEnd > submitStart ? appSource.slice(submitStart, submitEnd) : "";

  assert.match(
    submitSource,
    /try \{\s*state\.loading = true;\s*setStatus\("正在发送…"\);\s*closeSocket\(\{ silent: true \}\);/
  );
  assert.match(
    submitSource,
    /if \(targetThreadId\) \{[\s\S]*requestThreadInput\([\s\S]*\} else \{[\s\S]*requestSessionInput\(/
  );
  assert.doesNotMatch(submitSource, /requestThreadInputStream\(/);
  assert.doesNotMatch(submitSource, /requestSessionInputStream\(/);
  assert.doesNotMatch(submitSource, /activeInputStream\s*=/);
  assert.doesNotMatch(submitSource, /stopHistorySyncLoop\(\)/);
  assert.doesNotMatch(appSource, /requestThreadInputStream/);
  assert.doesNotMatch(appSource, /requestSessionInputStream/);
  assert.doesNotMatch(appSource, /waitForHistoricalReply/);
  assert.doesNotMatch(appSource, /Promise\.race\(\[streamPromise,\s*historyFallbackPromise\]\)/);
  assert.match(
    submitSource,
    /finally \{[\s\S]*state\.loading = false;[\s\S]*await syncActiveThreadSession\(\{ silent: true \}\)\.catch\(\(\) => \{\}\);[\s\S]*startHistorySyncLoop\(\);[\s\S]*\}/
  );
  assert.match(
    appSource,
    /const canSend = computed\(\(\) => \{[\s\S]*state\.statusText === "等待 Codex 回复…"[\s\S]*return false;[\s\S]*canSendComposerMessage/
  );
  assert.match(
    appSource,
    /function isDisplayedThreadRunning\(snapshot = null\)[\s\S]*const canSend = computed[\s\S]*isDisplayedThreadRunning\(displayedThreadSnapshot\.value\)[\s\S]*const canInterrupt = computed[\s\S]*isDisplayedThreadRunning\(displayedThreadSnapshot\.value\)/
  );
  assert.match(
    fs.readFileSync(new URL("../web/src/lib/session-runtime.js", import.meta.url), "utf8"),
    /forceSync: isAwaitingInputStatus\(state\.statusText\)/
  );
  assert.match(
    appSource,
    /async function interruptActiveSession\(\) \{[\s\S]*?closeSocket\(\{ silent: true \}\);[\s\S]*?type:\s*"interrupt"/
  );
  assert.match(
    threadRuntimeSource,
    /incomingVersion > currentVersion[\s\S]*contentComparison < 0[\s\S]*incoming\.activeTurnId[\s\S]*current\.activeTurnId[\s\S]*return false;/
  );
  assert.match(
    liveRuntimeSource,
    /if \(payload\.type === "thread\.snapshot"\) \{[\s\S]*?stopHistorySyncLoop\?\.\(\);[\s\S]*?hasConversationSnapshot = true;[\s\S]*?hasConversationDelta = true;/
  );
  assert.match(
    liveRuntimeSource,
    /if \(payload\.type === "thread\.overlay"\) \{[\s\S]*?stopHistorySyncLoop\?\.\(\);[\s\S]*?(?:setLiveOverlay\(payload\)|threadRuntime\.setLiveOverlay\(payload\))[\s\S]*?hasConversationSnapshot = true;[\s\S]*?hasConversationDelta = true;/
  );
  assert.match(
    liveRuntimeSource,
    /if \(isTerminalTurnStatus\(payload\?\.status\) \|\| isTerminalTurnStatus\(authoritativeAssistantStatus\)\) \{\s*settleAuthoritativeInputState\(\);/
  );
  assert.match(
    threadRuntimeSource,
    /const existingText = collectAssistantText\(existingAssistant\);[\s\S]*const incomingText = collectAssistantText\(incomingAssistant\);[\s\S]*const keepExistingBody = existingText\.length > incomingText\.length;/
  );
  assert.match(
    sessionManagerSource,
    /const preferAppServer = Boolean\([\s\S]*this\.config\.codexAppServerEnabled[\s\S]*this\.appServerBridge[\s\S]*!sessionRequiresJsonExec/
  );
});

test("input-stream control contract: interrupt events stay explicit and map to ESC only inside the transport adapter", () => {
  const events = normalizeSessionInputEvents({ type: "interrupt", reason: "user_interrupt" });
  assert.deepEqual(events, [{ type: "interrupt", reason: "user_interrupt" }]);

  const writes = [];
  applySessionInputEvents(
    {
      resize() {},
      write(_sessionId, data) {
        writes.push(data);
        return "";
      }
    },
    "session-ctrl-1",
    events
  );

  assert.deepEqual(writes, ["\u001b"]);
});
