import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createSseStreamWriter } from "../src/transport/index.js";
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

test("input-stream contract: thread-scoped SSE keeps resume threadId on streamed snapshots instead of leaking sessionId", async (t) => {
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
  const snapshotFrame = frames.find((frame) => frame.event === "thread.snapshot");
  assert.ok(snapshotFrame);
  assert.equal(snapshotFrame.payload.threadId, liveSession.resumeSessionId);
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

test("input-stream contract: route tracks the turn id returned by write() so fast terminal snapshots can close the stream", async (t) => {
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
  const text = await Promise.race([
    response.text(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for input-stream to close")), 1000))
  ]);
  const frames = parseSseFrames(text);
  assert.ok(frames.some((frame) => frame.event === "thread.snapshot" && frame.payload?.version === 2));
});

test("input-stream contract: typed completed thread.snapshot closes the SSE stream for the tracked turn after a short terminal drain window", async () => {
  const liveSession = {
    id: "session-close-typed-1",
    provider: "codex",
    resumeSessionId: "thread-close-typed-1",
    currentTurnId: "turn-close-typed-1",
    clients: new Set(),
    threadSnapshot: {
      threadId: "thread-close-typed-1",
      activeTurnId: null,
      turns: []
    }
  };

  const sessionManager = {
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    attachClient(_sessionId, client) {
      liveSession.threadSnapshot = {
        threadId: "thread-close-typed-1",
        activeTurnId: "",
        turns: [{ id: "turn-close-typed-1", status: "completed", items: [] }]
      };
      liveSession.conversationState = {
        threadId: "thread-close-typed-1",
        activeTurnId: "",
        turns: [{ id: "turn-close-typed-1", assistant: { status: "completed", body: [] } }]
      };
      client.send(
        JSON.stringify({
          type: "thread.snapshot",
          threadId: "thread-close-typed-1",
          sessionId: "session-close-typed-1",
          turnId: "turn-close-typed-1",
          status: "completed",
          version: 99,
          partial: true,
          snapshot: {
            threadId: "thread-close-typed-1",
            activeTurnId: "",
            turns: [{ id: "turn-close-typed-1", status: "completed", items: [] }]
          },
          conversation: {
            sessionId: "session-close-typed-1",
            threadId: "thread-close-typed-1",
            status: "completed",
            activeTurnId: "",
            turns: [{ id: "turn-close-typed-1", assistant: { status: "completed", body: [] } }]
          }
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

  const { openSessionSseStream } = await import("../src/transport/sse/sessionStream.js");
  const stream = openSessionSseStream({
    req,
    res,
    sessionManager,
    sessionId: liveSession.id,
    keepaliveMs: 15_000,
    terminalCloseDelayMs: 10
  });
  stream.setTrackedTurnId("turn-close-typed-1");

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed, true);
  assert.ok(chunks.join("").includes("event: thread.snapshot") || closed);
});

test("input-stream contract: terminal tracked snapshots keep the stream open long enough for trailing same-turn events", async () => {
  const liveSession = {
    id: "session-terminal-drain-1",
    provider: "codex",
    resumeSessionId: "thread-terminal-drain-1",
    currentTurnId: "turn-terminal-drain-1",
    clients: new Set(),
    threadSnapshot: {
      threadId: "thread-terminal-drain-1",
      activeTurnId: "turn-terminal-drain-1",
      turns: [{ id: "turn-terminal-drain-1", status: "running", items: [] }]
    },
    conversationState: {
      threadId: "thread-terminal-drain-1",
      activeTurnId: "turn-terminal-drain-1",
      turns: [{ id: "turn-terminal-drain-1", assistant: { status: "running", body: [] } }]
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
      liveSession.threadSnapshot = {
        threadId: "thread-terminal-drain-1",
        activeTurnId: "",
        turns: [{ id: "turn-terminal-drain-1", status: "completed", items: [] }]
      };
      liveSession.conversationState = {
        threadId: "thread-terminal-drain-1",
        activeTurnId: "",
        turns: [{ id: "turn-terminal-drain-1", assistant: { status: "completed", body: [] } }]
      };
      liveSession.clients.add(client);
      client.send(
        JSON.stringify({
          type: "thread.snapshot",
          threadId: "thread-terminal-drain-1",
          sessionId: "session-terminal-drain-1",
          turnId: "turn-terminal-drain-1",
          status: "completed",
          version: 41,
          partial: true,
          snapshot: {
            threadId: "thread-terminal-drain-1",
            activeTurnId: "",
            turns: [{ id: "turn-terminal-drain-1", status: "completed", items: [] }]
          },
          conversation: {
            sessionId: "session-terminal-drain-1",
            threadId: "thread-terminal-drain-1",
            status: "completed",
            activeTurnId: "",
            turns: [{ id: "turn-terminal-drain-1", assistant: { status: "completed", body: [] } }]
          }
        })
      );

      setTimeout(() => {
        client.send(
          JSON.stringify({
            type: "process.completed",
            sessionId: "session-terminal-drain-1",
            threadId: "thread-terminal-drain-1",
            turnId: "turn-terminal-drain-1",
            processId: "proc-tail-1",
            processType: "command_execution",
            summary: "tail event",
            ts: "2026-04-29T14:00:01.000Z"
          })
        );
      }, 5);
    }
  };

  const { openSessionSseStream } = await import("../src/transport/sse/sessionStream.js");
  const stream = openSessionSseStream({
    req,
    res,
    sessionManager,
    sessionId: liveSession.id,
    keepaliveMs: 15_000,
    terminalCloseDelayMs: 20
  });
  stream.setTrackedTurnId("turn-terminal-drain-1");

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(closed, true);
  const text = chunks.join("");
  assert.match(text, /event: process\.completed/);
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

test("typed SSE contract: transport ignores legacy snapshot event names instead of remapping them into duplicate thread snapshots", () => {
  const sessionStreamSource = fs.readFileSync(new URL("../src/transport/sse/sessionStream.js", import.meta.url), "utf8");

  assert.match(
    sessionStreamSource,
    /if \(type === "conversation\.snapshot" \|\| type === "conversation\.delta"\) \{/
  );
  assert.doesNotMatch(sessionStreamSource, /type === "snapshot"/);
  assert.doesNotMatch(sessionStreamSource, /type === "conversation_snapshot"/);
});

test("input-stream main-path guard: App closes the legacy websocket before switching to thread-level SSE", () => {
  const appSource = fs.readFileSync(new URL("../web/src/App.vue", import.meta.url), "utf8");
  const threadRuntimeSource = fs.readFileSync(new URL("../web/src/lib/thread-runtime.js", import.meta.url), "utf8");
  const liveRuntimeSource = fs.readFileSync(new URL("../web/src/lib/live-session-runtime.js", import.meta.url), "utf8");
  const sessionManagerSource = fs.readFileSync(new URL("../src/sessionManager.js", import.meta.url), "utf8");

  assert.match(
    appSource,
    /try \{\s*state\.loading = true;\s*setStatus\("正在发送…"\);\s*stopHistorySyncLoop\(\);\s*closeSocket\(\{ silent: true \}\);/
  );
  assert.match(
    appSource,
    /state\.liveView\.activeInputStream = true;[\s\S]*if \(targetThreadId\) \{[\s\S]*requestThreadInputStream\(/
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
