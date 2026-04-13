import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { login, parseCookieValue, startTestServer } from "./helpers/backendTestUtils.js";

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
        messages: [{ role: "assistant", text: "历史消息", timestamp: new Date().toISOString() }]
      };
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

  nowMs += 1_000;
  const configResponse = await fetch(`${server.baseUrl}/api/config`, {
    headers: { cookie: auth.cookies }
  });
  assert.equal(configResponse.status, 200);

  const refreshedExpiry = server.runtime.authSessions.get(sessionId)?.expiresAt;
  assert.ok(refreshedExpiry > initialExpiry);
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
  assert.deepEqual(sessionManager.calls.history[0], { provider: "codex", resumeSessionId: "thread-1" });

  const resourceStyleResponse = await fetch(`${server.baseUrl}/api/history-sessions/codex/thread-1/messages`, {
    headers: { cookie: cookies }
  });
  assert.equal(resourceStyleResponse.status, 200);

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
