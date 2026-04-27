import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { HistoricalSessionService } from "../src/sessions/history/HistoricalSessionService.js";
import { buildProviders } from "../src/sessions/providers/buildProviders.js";
import { createBaseConfig, createTempDir, login, parseCookieValue, startTestServer } from "./helpers/backendTestUtils.js";

function createSessionManagerStub() {
  const calls = {
    create: [],
    rename: [],
    close: [],
    resize: [],
    history: [],
    archive: [],
    restore: [],
    deleteHistory: []
  };

  const liveSession = {
    id: "session-1",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Session 1",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-1",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: ""
  };

  return {
    calls,
    providerCatalog() {
      return [{ id: "codex", label: "Codex" }];
    },
    stats() {
      return { sessions: 1, clients: 0, running: 1, exited: 0 };
    },
    listAll() {
      return [liveSession];
    },
    listProjectGroups() {
      return [
        {
          id: "project:/tmp/demo",
          name: "demo",
          projectRoot: "/tmp/demo",
          cwd: "/tmp/demo",
          collapsed: false,
          sessions: []
        }
      ];
    },
    listArchived() {
      return [{ ...liveSession, id: "history:codex:thread-1", kind: "archived", status: "archived" }];
    },
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    serialize(session) {
      return session;
    },
    create(body) {
      calls.create.push(body);
      return { ...liveSession, name: body.name || liveSession.name, cwd: body.cwd || liveSession.cwd };
    },
    rename(id, name) {
      calls.rename.push({ id, name });
      return { ...liveSession, id, name };
    },
    close(id) {
      calls.close.push(id);
      return true;
    },
    resize(id, cols, rows) {
      calls.resize.push({ id, cols, rows });
    },
    getHistoricalMessages(provider, resumeSessionId) {
      calls.history.push({ provider, resumeSessionId });
      return {
        session: { id: `history:${provider}:${resumeSessionId}` },
        messages: [{ role: "assistant", text: "历史消息", timestamp: new Date().toISOString() }],
        turns: [
          {
            id: "turn-1",
            user: { id: "user-1", text: "用户问题", ts: new Date().toISOString() },
            assistant: {
              body: [{ id: "body-1", kind: "markdown", text: "历史消息", payload: {}, ts: new Date().toISOString() }],
              process: [],
              status: "completed",
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString()
            }
          }
        ],
        backgroundAgents: []
      };
    },
    getThreadSnapshotBundle(provider, resumeSessionId) {
      return {
        session: { id: `history:${provider}:${resumeSessionId}` },
        threadSnapshot: {
          threadId: resumeSessionId,
          turns: [{ id: "turn-1", items: [] }]
        },
        liveOverlay: null,
        conversation: { threadId: resumeSessionId, turns: [] },
        conversationSnapshot: { threadId: resumeSessionId, turns: [] }
      };
    },
    getThreadContinuationRuntime(provider, resumeSessionId) {
      return null;
    },
    archiveHistoricalSession(provider, resumeSessionId) {
      calls.archive.push({ provider, resumeSessionId });
      return { id: `history:${provider}:${resumeSessionId}`, kind: "archived" };
    },
    restoreHistoricalSession(provider, resumeSessionId) {
      calls.restore.push({ provider, resumeSessionId });
      return { id: `history:${provider}:${resumeSessionId}`, kind: "history" };
    },
    deleteHistoricalSession(provider, resumeSessionId) {
      calls.deleteHistory.push({ provider, resumeSessionId });
      return true;
    }
  };
}

test("auth flow protects config and clears session on logout", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const unauthorized = await fetch(`${server.baseUrl}/api/config`);
  assert.equal(unauthorized.status, 401);

  const failedLogin = await login(server.baseUrl, "wrong-token");
  assert.equal(failedLogin.response.status, 401);

  const success = await login(server.baseUrl, server.config.accessToken);
  assert.equal(success.response.status, 200);
  assert.ok(parseCookieValue(success.cookies, server.config.authSessionCookieName));

  const configResponse = await fetch(`${server.baseUrl}/api/config`, {
    headers: { cookie: success.cookies }
  });
  assert.equal(configResponse.status, 200);
  const configPayload = await configResponse.json();
  assert.equal(configPayload.defaultProvider, "codex");

  const logoutResponse = await fetch(`${server.baseUrl}/api/logout`, {
    method: "POST",
    headers: { cookie: success.cookies }
  });
  assert.equal(logoutResponse.status, 200);
  const clearedCookie = logoutResponse.headers.get("set-cookie") || "";
  assert.match(clearedCookie, /Max-Age=0/);
});

test("authorized requests extend auth-session expiration", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  let nowMs = 1_000_000;
  server.runtime.nowMs = () => nowMs;

  const auth = await login(server.baseUrl, server.config.accessToken);
  assert.equal(auth.response.status, 200);
  const sessionId = parseCookieValue(auth.cookies, server.config.authSessionCookieName);
  assert.ok(sessionId);

  const initialExpiry = server.runtime.authSessions.get(sessionId)?.expiresAt;
  assert.ok(initialExpiry);

  nowMs += 61_000;
  const configResponse = await fetch(`${server.baseUrl}/api/config`, {
    headers: { cookie: auth.cookies }
  });
  assert.equal(configResponse.status, 200);

  const refreshedExpiry = server.runtime.authSessions.get(sessionId)?.expiresAt;
  assert.ok(refreshedExpiry > initialExpiry);
});

test("stale auth cookie is rejected after server restart instead of keeping protected routes in a loading state", async (t) => {
  const sessionManager = createSessionManagerStub();
  const firstServer = await startTestServer({ sessionManager });
  const auth = await login(firstServer.baseUrl, firstServer.config.accessToken);
  assert.equal(auth.response.status, 200);

  const cookieName = firstServer.config.authSessionCookieName;
  const staleSessionId = parseCookieValue(auth.cookies, cookieName);
  assert.ok(staleSessionId);

  await firstServer.close();

  const secondServer = await startTestServer({
    sessionManager,
    configOverrides: {
      authSessionCookieName: cookieName
    }
  });
  t.after(async () => {
    await secondServer.close();
  });

  const configResponse = await fetch(`${secondServer.baseUrl}/api/config`, {
    headers: { cookie: auth.cookies }
  });

  assert.equal(configResponse.status, 401);
  assert.equal(secondServer.runtime.authSessions.has(staleSessionId), false);
});

test("cross-origin login is rejected before token validation", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example.com"
    },
    body: JSON.stringify({ token: server.config.accessToken })
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Cross-origin request rejected" });
});

test("authorized local image proxy serves image files for history previews", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const auth = await login(server.baseUrl, server.config.accessToken);
  assert.equal(auth.response.status, 200);

  const imagePath = path.join(server.rootDir, "history-preview.png");
  fs.writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2X8AAAAASUVORK5CYII=", "base64")
  );

  const response = await fetch(
    `${server.baseUrl}/api/local-file-image?path=${encodeURIComponent(imagePath)}`,
    { headers: { cookie: auth.cookies } }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});

test("login rate limit blocks after max failures and resets after block window", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      authRateLimitMaxAttempts: 2,
      authRateLimitWindowMs: 60_000,
      authRateLimitBlockMs: 30_000
    }
  });
  t.after(async () => {
    await server.close();
  });

  let nowMs = 10_000;
  server.runtime.nowMs = () => nowMs;

  const failed1 = await login(server.baseUrl, "wrong-1");
  assert.equal(failed1.response.status, 401);
  const failed2 = await login(server.baseUrl, "wrong-2");
  assert.equal(failed2.response.status, 401);

  const blocked = await login(server.baseUrl, server.config.accessToken);
  assert.equal(blocked.response.status, 429);

  nowMs += 31_000;
  const success = await login(server.baseUrl, server.config.accessToken);
  assert.equal(success.response.status, 200);
});

test("session routes delegate CRUD operations and health stays public", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);

  const listResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    headers: { cookie: cookies }
  });
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.sessions.length, 1);
  assert.equal(listPayload.projectGroups.length, 1);

  const createResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ provider: "codex", cwd: "/tmp/demo", name: "Demo" })
  });
  assert.equal(createResponse.status, 201);
  assert.equal(sessionManager.calls.create.length, 1);

  const renameResponse = await fetch(`${server.baseUrl}/api/sessions/session-1`, {
    method: "PATCH",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "Renamed session" })
  });
  assert.equal(renameResponse.status, 200);
  assert.deepEqual(sessionManager.calls.rename[0], { id: "session-1", name: "Renamed session" });

  const deleteResponse = await fetch(`${server.baseUrl}/api/sessions/session-1`, {
    method: "DELETE",
    headers: { cookie: cookies }
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(sessionManager.calls.close, ["session-1"]);

  const healthResponse = await fetch(`${server.baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const healthPayload = await healthResponse.json();
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.sessions, 1);
});

test("session create reuses existing live session for same provider+resume id", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.findRunningLiveSessionByResume = (provider, resumeSessionId) => {
    if (provider === "codex" && resumeSessionId === "thread-1") {
      return sessionManager.get("session-1");
    }
    return null;
  };
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ provider: "codex", resumeSessionId: "thread-1" })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.session.id, "session-1");
  assert.equal(sessionManager.calls.create.length, 0);
});

test("session input-stream route returns typed sse events and applies input to the session manager", async (t) => {
  const writes = [];
  const liveSession = {
    id: "session-stream-1",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Session Stream",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-stream-1",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: "",
    clients: new Set()
  };

  const sessionManager = createSessionManagerStub();
  sessionManager.get = (id) => (id === liveSession.id ? liveSession : null);
  sessionManager.ensureLiveSessionForThread = (threadId) => {
    assert.equal(threadId, liveSession.resumeSessionId);
    return liveSession;
  };
  sessionManager.getConversationSnapshot = () => ({
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
  });
  sessionManager.attachClient = (id, client) => {
    if (id !== liveSession.id) {
      throw new Error("Session not found");
    }
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
    client.on("close", () => {
      liveSession.clients.delete(client);
    });
  };
  sessionManager.write = (id, data) => {
    writes.push({ id, data });
    for (const client of liveSession.clients) {
      client.send(JSON.stringify({ type: "message_part", part: { type: "text", text: "流式回复" }, phase: "streaming" }));
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
            turns: [
              {
                id: "turn-1",
                user: { id: "u1", text: "你好", ts: new Date().toISOString() },
                assistant: {
                  status: "completed",
                  body: [{ id: "b1", kind: "markdown", text: "流式回复", payload: {}, ts: new Date().toISOString() }],
                  process: [],
                  startedAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString()
                }
              }
            ]
          },
          threadSnapshot: {
            threadId: liveSession.resumeSessionId,
            turns: [{ id: "turn-1", items: [{ id: "u1", kind: "UserMessage", text: "你好" }, { id: "a1", kind: "AgentMessage", text: "流式回复" }] }]
          },
          liveOverlay: null
        })
      );
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}/api/sessions/${liveSession.id}/input-stream`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ type: "input", data: "你好\n" }),
    signal: controller.signal
  });

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  while (events.length < 3) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\n\n/);
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!dataLine) {
        continue;
      }
      events.push({
        event: eventLine ? eventLine.slice(6).trim() : "",
        payload: JSON.parse(dataLine)
      });
      if (events.length >= 3) {
        break;
      }
    }
  }
  controller.abort();

  assert.deepEqual(writes, [{ id: liveSession.id, data: "你好\n" }]);
  assert.ok(events.some((event) => event.event === "thread.snapshot"));
  assert.ok(events.some((event) => event.event === "thread.overlay"));
});

test("thread input-stream route can resume or create a live session from thread id", async (t) => {
  const writes = [];
  const liveSession = {
    id: "session-thread-stream-1",
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: "Thread Stream",
    cwd: process.cwd(),
    kind: "live",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    autoNamed: false,
    inputPreview: "",
    resumeSessionId: "thread-stream-1",
    model: "gpt-5",
    titleSource: "user_provided",
    sessionType: "main",
    parentThreadId: "",
    agentRole: "",
    agentNickname: "",
    clients: new Set(),
    currentTurnId: "turn-1"
  };

  const sessionManager = createSessionManagerStub();
  sessionManager.findRunningLiveSessionByResume = () => ({ id: liveSession.id });
  sessionManager.ensureLiveSessionForThread = () => liveSession;
  sessionManager.get = (id) => (id === liveSession.id ? liveSession : null);
  sessionManager.attachClient = (id, client) => {
    if (id !== liveSession.id) {
      throw new Error("Session not found");
    }
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
          status: "running",
          turns: []
        },
        threadSnapshot: {
          threadId: liveSession.resumeSessionId,
          turns: []
        },
        liveOverlay: null
      })
    );
    client.on("close", () => {
      liveSession.clients.delete(client);
    });
  };
  sessionManager.write = (id, data) => {
    writes.push({ id, data });
    for (const client of liveSession.clients) {
      client.send(JSON.stringify({ type: "message_part", part: { type: "text", text: "线程流式回复" }, phase: "streaming" }));
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
            turns: [
              {
                id: "turn-1",
                user: { id: "u1", text: "继续这个 thread", ts: new Date().toISOString() },
                assistant: {
                  status: "completed",
                  body: [{ id: "b1", kind: "markdown", text: "线程流式回复", payload: {}, ts: new Date().toISOString() }],
                  process: [],
                  startedAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString()
                }
              }
            ]
          },
          threadSnapshot: {
            threadId: liveSession.resumeSessionId,
            turns: [{ id: "turn-1", items: [{ id: "u1", kind: "UserMessage", text: "继续这个 thread" }, { id: "a1", kind: "AgentMessage", text: "线程流式回复" }] }]
          },
          liveOverlay: null
        })
      );
    }
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}/api/threads/codex/thread-stream-1/input-stream`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ type: "input", data: "继续这个 thread\n" }),
    signal: controller.signal
  });

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  while (events.length < 2) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\n\n/);
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!dataLine) {
        continue;
      }
      events.push({
        event: eventLine ? eventLine.slice(6).trim() : "",
        payload: JSON.parse(dataLine)
      });
      if (events.length >= 2) {
        break;
      }
    }
  }
  controller.abort();

  assert.deepEqual(writes, [{ id: liveSession.id, data: "继续这个 thread\n" }]);
  assert.ok(events.some((event) => event.event === "thread.snapshot"));
  assert.ok(events.some((event) => event.event === "thread.overlay"));
});

test("fs and history routes return manager-backed payloads", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);

  const dirPath = path.join(server.rootDir, "workspace");
  const nestedDir = path.join(dirPath, "nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "note.txt"), "hello");

  const fsResponse = await fetch(`${server.baseUrl}/api/fs?path=${encodeURIComponent(dirPath)}`, {
    headers: { cookie: cookies }
  });
  assert.equal(fsResponse.status, 200);
  const fsPayload = await fsResponse.json();
  assert.equal(fsPayload.path, dirPath);
  assert.equal(fsPayload.entries[0].type, "directory");

  const historyMessagesResponse = await fetch(
    `${server.baseUrl}/api/history-messages?provider=codex&resumeSessionId=thread-1`,
    { headers: { cookie: cookies } }
  );
  assert.equal(historyMessagesResponse.status, 200);
  const historyPayload = await historyMessagesResponse.json();
  assert.equal(historyPayload.messages.length, 1);
  assert.equal(historyPayload.threadSnapshot.threadId, "thread-1");
  assert.equal(historyPayload.continuation, null);
  assert.equal(historyPayload.thread.snapshot.threadId, "thread-1");
  assert.deepEqual(sessionManager.calls.history[0], { provider: "codex", resumeSessionId: "thread-1" });

  const resourceStyleResponse = await fetch(`${server.baseUrl}/api/history-sessions/codex/thread-1/messages`, {
    headers: { cookie: cookies }
  });
  assert.equal(resourceStyleResponse.status, 200);

  const threadRouteResponse = await fetch(`${server.baseUrl}/api/threads/codex/thread-1`, {
    headers: { cookie: cookies }
  });
  assert.equal(threadRouteResponse.status, 200);
  const threadRoutePayload = await threadRouteResponse.json();
  assert.equal(threadRoutePayload.threadSnapshot.threadId, "thread-1");
  assert.equal(threadRoutePayload.continuation, null);

  const threadConversationResponse = await fetch(`${server.baseUrl}/api/threads/codex/thread-1/conversation`, {
    headers: { cookie: cookies }
  });
  assert.equal(threadConversationResponse.status, 200);

  const invalidResourcePath = await fetch(`${server.baseUrl}/api/history-sessions/codex/messages`, {
    headers: { cookie: cookies }
  });
  assert.equal(invalidResourcePath.status, 404);

  const archiveResponse = await fetch(`${server.baseUrl}/api/history-sessions/archive`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ provider: "codex", resumeSessionId: "thread-1" })
  });
  assert.equal(archiveResponse.status, 200);

  const restoreResponse = await fetch(`${server.baseUrl}/api/history-sessions/restore`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ provider: "codex", resumeSessionId: "thread-1" })
  });
  assert.equal(restoreResponse.status, 200);

  const deleteHistoryResponse = await fetch(`${server.baseUrl}/api/history-sessions`, {
    method: "DELETE",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ provider: "codex", resumeSessionId: "thread-1" })
  });
  assert.equal(deleteHistoryResponse.status, 200);
  assert.deepEqual(sessionManager.calls.archive[0], { provider: "codex", resumeSessionId: "thread-1" });
  assert.deepEqual(sessionManager.calls.restore[0], { provider: "codex", resumeSessionId: "thread-1" });
  assert.deepEqual(sessionManager.calls.deleteHistory[0], { provider: "codex", resumeSessionId: "thread-1" });
});

test("history messages route returns manager-owned historical snapshot without reusing live session payload", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => {
    sessionManager.calls.history.push({ provider, resumeSessionId });
    return {
      session: {
        id: `history:${provider}:${resumeSessionId}`,
        kind: "history",
        resumeSessionId
      },
      messages: [{ role: "assistant", text: "历史答案", timestamp: new Date().toISOString() }],
      turns: [
        {
          id: "turn-history-only",
          user: { id: "user-history", text: "历史问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-history", kind: "markdown", text: "历史答案", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ],
      backgroundAgents: []
    };
  };

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const historyMessagesResponse = await fetch(
    `${server.baseUrl}/api/history-messages?provider=codex&resumeSessionId=thread-1`,
    { headers: { cookie: cookies } }
  );

  assert.equal(historyMessagesResponse.status, 200);
  const historyPayload = await historyMessagesResponse.json();
  assert.equal(historyPayload.session.id, "history:codex:thread-1");
  assert.equal(historyPayload.session.kind, "history");
  assert.equal(historyPayload.turns.length, 1);
  assert.equal(historyPayload.turns[0].user.text, "历史问题");
  assert.equal(historyPayload.turns[0].assistant.body[0].text, "历史答案");
  assert.equal(sessionManager.calls.create.length, 0);
});

test("single-thread model contract: history conversation route returns the persisted thread snapshot only, without live continuation turns", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => {
    sessionManager.calls.history.push({ provider, resumeSessionId });
    return {
      session: {
        id: `history:${provider}:${resumeSessionId}`,
        kind: "history",
        resumeSessionId
      },
      conversationSnapshot: {
        turns: [
          {
            id: "turn-history-only",
            user: { id: "user-history", text: "历史问题", ts: new Date().toISOString() },
            assistant: {
              body: [{ id: "body-history", kind: "markdown", text: "历史答案", payload: {}, ts: new Date().toISOString() }],
              process: [],
              status: "completed",
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString()
            }
          }
        ]
      },
      threadSnapshot: {
        threadId: resumeSessionId,
        turns: [
          {
            id: "turn-history-only",
            items: []
          }
        ]
      },
      liveOverlay: null
    };
  };
  sessionManager.getThreadSnapshotBundle = (provider, resumeSessionId) => ({
    session: {
      id: `history:${provider}:${resumeSessionId}`,
      kind: "history",
      resumeSessionId
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        {
          id: "turn-history-only",
          items: []
        }
      ]
    },
    liveOverlay: null,
    conversationSnapshot: {
      turns: [
        {
          id: "turn-history-only",
          user: { id: "user-history", text: "历史问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-history", kind: "markdown", text: "历史答案", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ]
    }
  });
  sessionManager.getThreadContinuationRuntime = () => ({
    session: { id: "session-live-1", kind: "live" },
    threadSnapshot: {
      threadId: "thread-1",
      turns: [
        { id: "turn-history-only", items: [] },
        { id: "turn-live-only", items: [] }
      ]
    },
    liveOverlay: { turnId: "turn-live-only", text: "继续对话的实时内容" }
  });

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/history-sessions/codex/thread-1/conversation`, {
    headers: { cookie: cookies }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.threadSnapshot.turns.length, 1);
  assert.equal(payload.continuation.threadSnapshot.turns.length, 2);
  assert.equal(payload.turns.length, 1);
});

test("single-thread model contract: continuation route returns only live continuation runtime and keeps it separate from historical conversation route", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => ({
    session: {
      id: `history:${provider}:${resumeSessionId}`,
      kind: "history",
      resumeSessionId
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [{ id: "turn-history-only", items: [{ id: "u1", kind: "UserMessage", text: "历史问题" }] }]
    },
    liveOverlay: null
  });
  sessionManager.getThreadContinuationRuntime = (provider, resumeSessionId) => ({
    session: {
      id: "session-live-1",
      kind: "live",
      resumeSessionId
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        { id: "turn-history-only", items: [{ id: "u1", kind: "UserMessage", text: "历史问题" }] },
        { id: "turn-live-only", items: [{ id: "u2", kind: "UserMessage", text: "继续追问" }] }
      ]
    },
    liveOverlay: {
      turnId: "turn-live-only",
      text: "继续对话的实时内容"
    }
  });

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);

  const historyResponse = await fetch(`${server.baseUrl}/api/history-sessions/codex/thread-1/conversation`, {
    headers: { cookie: cookies }
  });
  const historyPayload = await historyResponse.json();

  const continuationResponse = await fetch(`${server.baseUrl}/api/history-sessions/codex/thread-1/continuation`, {
    headers: { cookie: cookies }
  });
  const continuationPayload = await continuationResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.equal(continuationResponse.status, 200);
  assert.equal(historyPayload.threadSnapshot.turns.length, 1);
  assert.equal(historyPayload.turns.length, 0);
  assert.equal(continuationPayload.hasLiveContinuation, true);
  assert.equal(continuationPayload.continuation.threadSnapshot.turns.length, 2);
});

test("history messages route falls back to live continuation when historical session is missing", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => {
    sessionManager.calls.history.push({ provider, resumeSessionId });
    throw new Error(`Historical session not found: ${provider}/${resumeSessionId}`);
  };
  sessionManager.getThreadSnapshotBundle = () => ({
    session: null,
    threadSnapshot: null,
    liveOverlay: null,
    conversation: null,
    conversationSnapshot: null
  });
  sessionManager.getThreadContinuationRuntime = (provider, resumeSessionId) => ({
    session: {
      id: "session-live-only",
      kind: "live",
      provider,
      resumeSessionId
    },
    conversation: {
      sessionId: "session-live-only",
      threadId: resumeSessionId,
      version: 1,
      status: "running",
      turns: [
        {
          id: "turn-live-only",
          user: { id: "u-live", text: "只有 live 的问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-live", kind: "markdown", text: "只有 live 的回答", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ],
      backgroundAgents: []
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        {
          id: "turn-live-only",
          items: [
            { id: "u-live", kind: "UserMessage", text: "只有 live 的问题" },
            { id: "a-live", kind: "AgentMessage", text: "只有 live 的回答" }
          ]
        }
      ]
    },
    liveOverlay: null
  });

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/history-messages?provider=codex&resumeSessionId=thread-live-only`, {
    headers: { cookie: cookies }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.session.id, "session-live-only");
  assert.equal(payload.threadSnapshot.threadId, "thread-live-only");
  assert.equal(payload.turns.length, 1);
  assert.equal(payload.turns[0].assistant.body[0].text, "只有 live 的回答");
  assert.equal(payload.messages.length, 0);
});

test("history messages route prefers live continuation over stale persisted snapshot when both exist", async (t) => {
  const sessionManager = createSessionManagerStub();
  sessionManager.getThreadSnapshotBundle = (provider, resumeSessionId) => ({
    session: {
      id: `history:${provider}:${resumeSessionId}`,
      kind: "history",
      provider,
      resumeSessionId
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        {
          id: "turn-stale",
          items: [
            { id: "u-stale", kind: "UserMessage", text: "旧问题" },
            { id: "a-stale", kind: "AgentMessage", text: "旧回答" }
          ]
        }
      ]
    },
    conversation: {
      sessionId: `history:${provider}:${resumeSessionId}`,
      threadId: resumeSessionId,
      version: 10,
      status: "completed",
      turns: [
        {
          id: "turn-stale",
          user: { id: "u-stale", text: "旧问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-stale", kind: "markdown", text: "旧回答", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ],
      backgroundAgents: []
    },
    liveOverlay: null,
    conversationSnapshot: null
  });
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => ({
    session: {
      id: `history:${provider}:${resumeSessionId}`,
      kind: "history",
      provider,
      resumeSessionId
    },
    messages: [],
    turns: [],
    backgroundAgents: [],
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        {
          id: "turn-stale",
          items: [
            { id: "u-stale", kind: "UserMessage", text: "旧问题" },
            { id: "a-stale", kind: "AgentMessage", text: "旧回答" }
          ]
        }
      ]
    },
    liveOverlay: null,
    conversation: {
      sessionId: `history:${provider}:${resumeSessionId}`,
      threadId: resumeSessionId,
      version: 10,
      status: "completed",
      turns: [
        {
          id: "turn-stale",
          user: { id: "u-stale", text: "旧问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-stale", kind: "markdown", text: "旧回答", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ],
      backgroundAgents: []
    },
    conversationSnapshot: null
  });
  sessionManager.getThreadContinuationRuntime = (provider, resumeSessionId) => ({
    session: {
      id: "session-live-fresh",
      kind: "live",
      provider,
      resumeSessionId
    },
    conversation: {
      sessionId: "session-live-fresh",
      threadId: resumeSessionId,
      version: 11,
      status: "completed",
      turns: [
        {
          id: "turn-fresh",
          user: { id: "u-fresh", text: "新问题", ts: new Date().toISOString() },
          assistant: {
            body: [{ id: "body-fresh", kind: "markdown", text: "新回答", payload: {}, ts: new Date().toISOString() }],
            process: [],
            status: "completed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        }
      ],
      backgroundAgents: []
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        {
          id: "turn-fresh",
          items: [
            { id: "u-fresh", kind: "UserMessage", text: "新问题" },
            { id: "a-fresh", kind: "AgentMessage", text: "新回答" }
          ]
        }
      ]
    },
    liveOverlay: null
  });

  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/history-messages?provider=codex&resumeSessionId=thread-1`, {
    headers: { cookie: cookies }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.session.id, "session-live-fresh");
  assert.equal(payload.threadSnapshot.turns[0].id, "turn-fresh");
  assert.equal(payload.threadSnapshot.turns[0].items[1].text, "新回答");
  assert.equal(payload.conversation.turns[0].assistant.body[0].text, "新回答");
});

test("history messages interface strips IAB wrapper from authoritative turns and thread snapshot", async (t) => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const service = new HistoricalSessionService(config);
  const providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
  const provider = providers.get("codex");

  const dayDir = path.join(codexSessionsDir, "2026", "04", "24");
  fs.mkdirSync(dayDir, { recursive: true });
  const resumeSessionId = "019daee8-2852-7131-8d2e-9b7149cd6187";
  const sessionFile = path.join(dayDir, `rollout-2026-04-24T12-00-00-${resumeSessionId}.jsonl`);
  fs.writeFileSync(
    path.join(path.dirname(codexSessionsDir), "session_index.jsonl"),
    JSON.stringify({ id: resumeSessionId, thread_name: "IAB wrapper thread" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      timestamp: "2026-04-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: resumeSessionId,
        cwd: rootDir,
        thread_name: "IAB wrapper thread",
        originator: "codex_cli",
        source: "cli"
      }
    })}\n${JSON.stringify({
      timestamp: "2026-04-24T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message:
          "\n# In app browser (IAB):\n- The user has the in-app browser (IAB) open.\n- Current URL: http://127.0.0.1:3210/#/chat/history:codex:019daf2c-f5a0-7033-a87c-b5df6ddef277\n\n## My request for Codex:\n执行\n"
      }
    })}\n`,
    "utf8"
  );

  const sessionManager = createSessionManagerStub();
  sessionManager.getHistoricalMessages = (providerId, threadId) =>
    service.getHistoricalMessages(provider, threadId);
  sessionManager.getThreadSnapshotBundle = (providerId, threadId) => {
    const payload = service.getHistoricalMessages(provider, threadId);
    return {
      session: payload.session,
      threadSnapshot: payload.threadSnapshot,
      liveOverlay: payload.liveOverlay,
      conversation: payload.conversation,
      conversationSnapshot: payload.conversationSnapshot
    };
  };
  sessionManager.getThreadContinuationRuntime = () => null;

  const server = await startTestServer({
    sessionManager,
    configOverrides: { codexSessionsDir, dataDir: config.dataDir }
  });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/history-messages?provider=codex&resumeSessionId=${resumeSessionId}`, {
    headers: { cookie: cookies }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.turns[0].user.text, "执行");
  assert.equal(payload.threadSnapshot.turns[0].items[0].text, "执行");
});

test("workspace changes API lists diffs and reverts selected files", async (t) => {
  const rootDir = createTempDir();
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: rootDir, stdio: "ignore" });
  fs.writeFileSync(path.join(rootDir, "demo.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "demo.txt"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: rootDir, stdio: "ignore" });
  fs.writeFileSync(path.join(rootDir, "demo.txt"), "before\nafter\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "new.txt"), "new file\n", "utf8");

  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const params = new URLSearchParams({ cwd: rootDir });
  const listResponse = await fetch(`${server.baseUrl}/api/workspace-changes?${params.toString()}`, {
    headers: { cookie: cookies }
  });
  const listPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.deepEqual([...listPayload.files.map((file) => file.path)].sort(), ["demo.txt", "new.txt"]);
  assert.match(listPayload.files.find((file) => file.path === "demo.txt").diff, /\+after/);

  const revertResponse = await fetch(`${server.baseUrl}/api/workspace-changes/revert`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cwd: rootDir, paths: ["demo.txt"] })
  });
  const revertPayload = await revertResponse.json();

  assert.equal(revertResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(rootDir, "demo.txt"), "utf8"), "before\n");
  assert.ok(fs.existsSync(path.join(rootDir, "new.txt")));
  assert.deepEqual(revertPayload.reverted, ["demo.txt"]);
  assert.deepEqual(revertPayload.files.map((file) => file.path), ["new.txt"]);
});

test("invalid input payloads return 400 for json-backed routes", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);

  const invalidJsonResponse = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: "{invalid-json"
  });
  assert.equal(invalidJsonResponse.status, 400);

  const missingPathResponse = await fetch(`${server.baseUrl}/api/fs?path=${encodeURIComponent("/path/not-found")}`, {
    headers: { cookie: cookies }
  });
  assert.equal(missingPathResponse.status, 400);

  const invalidHistoryBody = await fetch(`${server.baseUrl}/api/history-sessions/archive`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: "{"
  });
  assert.equal(invalidHistoryBody.status, 400);
});

test("server returns 503 for non-health APIs while shutting down", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  server.runtime.shuttingDown = true;
  const blocked = await fetch(`${server.baseUrl}/api/config`);
  assert.equal(blocked.status, 503);

  const health = await fetch(`${server.baseUrl}/api/health`);
  assert.equal(health.status, 200);
});
