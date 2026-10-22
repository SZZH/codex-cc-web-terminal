import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import { PassThrough } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { HistoricalSessionService } from "../src/sessions/history/HistoricalSessionService.js";
import { installRequestBodyRuntime } from "../src/runtime/http/body.js";
import { buildProviders } from "../src/sessions/providers/buildProviders.js";
import { createBaseConfig, createTempDir, login, parseCookieValue, startTestServer } from "./helpers/backendTestUtils.js";

function createCodexThreadsTableSql() {
  return `
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      source text not null,
      model_provider text not null,
      cwd text not null,
      title text not null,
      sandbox_policy text not null,
      approval_mode text not null,
      tokens_used integer not null default 0,
      has_user_event integer not null default 0,
      archived integer not null default 0,
      archived_at integer,
      git_sha text,
      git_branch text,
      git_origin_url text,
      cli_version text not null default '',
      first_user_message text not null default '',
      agent_nickname text,
      agent_role text,
      memory_mode text not null default 'enabled',
      model text,
      reasoning_effort text,
      agent_path text,
      created_at_ms integer,
      updated_at_ms integer
    );
  `;
}

function createSessionManagerStub() {
  const calls = {
    create: [],
    updateSessionOptions: [],
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
    reasoningEffort: "medium",
    permissionMode: "default",
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
    listSidebarSnapshot() {
      return {
        sessions: [liveSession],
        projectGroups: this.listProjectGroups()
      };
    },
    listArchived() {
      return [{ ...liveSession, id: "history:codex:thread-1", kind: "archived", status: "archived" }];
    },
    get(id) {
      return id === liveSession.id ? liveSession : null;
    },
    findRunningLiveSessionByResume(provider, resumeSessionId) {
      return provider === liveSession.provider && resumeSessionId === liveSession.resumeSessionId ? liveSession : null;
    },
    serialize(session) {
      return session;
    },
    create(body) {
      calls.create.push(body);
      return {
        ...liveSession,
        id: body.id || liveSession.id,
        name: body.name || liveSession.name,
        cwd: body.cwd || liveSession.cwd,
        resumeSessionId: body.resumeSessionId || liveSession.resumeSessionId,
        model: body.model || liveSession.model,
        reasoningEffort: body.reasoningEffort || liveSession.reasoningEffort,
        permissionMode: body.permissionMode || liveSession.permissionMode
      };
    },
    updateSessionOptions(session, body) {
      calls.updateSessionOptions.push({
        id: session?.id || "",
        ...body
      });
      Object.assign(session, body);
      return session;
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

test("auth sessions repair legacy file permissions and persist new sessions privately", async (t) => {
  const dataDir = path.join(createTempDir(), "data");
  fs.mkdirSync(dataDir);
  const sessionsPath = path.join(dataDir, "auth-sessions.json");
  fs.writeFileSync(sessionsPath, JSON.stringify({ legacy: {
    id: "legacy", createdAt: Date.now(), expiresAt: Date.now() + 60_000, ip: "", userAgent: ""
  } }), { mode: 0o644 });
  fs.chmodSync(sessionsPath, 0o644);

  const server = await startTestServer({ sessionManager: createSessionManagerStub(), configOverrides: { dataDir } });
  t.after(() => server.close());
  assert.equal(server.runtime.authSessions.has("legacy"), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(sessionsPath).mode & 0o777, 0o600);
  }

  const auth = await login(server.baseUrl, server.config.accessToken);
  assert.equal(auth.response.status, 200);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(sessionsPath, "utf8"))).length, 2);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(sessionsPath).mode & 0o777, 0o600);
  }

  const freshServer = await startTestServer({ sessionManager: createSessionManagerStub() });
  t.after(() => freshServer.close());
  const freshSessionsPath = path.join(freshServer.config.dataDir, "auth-sessions.json");
  assert.equal(fs.existsSync(freshSessionsPath), false);
  assert.equal((await login(freshServer.baseUrl, freshServer.config.accessToken)).response.status, 200);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(freshSessionsPath).mode & 0o777, 0o600);
  }
});

test("failed auth-session write preserves the last complete file for reload", async (t) => {
  const server = await startTestServer({ sessionManager: createSessionManagerStub() });
  t.after(() => server.close());
  const auth = await login(server.baseUrl, server.config.accessToken);
  const persistedId = parseCookieValue(auth.cookies, server.config.authSessionCookieName);
  const sessionsPath = path.join(server.config.dataDir, "auth-sessions.json");
  const savedPayload = fs.readFileSync(sessionsPath, "utf8");
  server.runtime.authSessions.set("pending", {
    id: "pending", createdAt: Date.now(), expiresAt: Date.now() + 60_000, ip: "", userAgent: ""
  });

  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === "number") {
      writeFileSync(target, '{"partial":', "utf8");
      throw new Error("injected auth-session write failure");
    }
    return writeFileSync(target, ...args);
  };
  try {
    assert.throws(() => server.runtime.saveAuthSessions(), /injected auth-session write failure/);
  } finally {
    fs.writeFileSync = writeFileSync;
  }

  assert.equal(fs.readFileSync(sessionsPath, "utf8"), savedPayload);
  assert.equal(fs.readdirSync(server.config.dataDir).some((name) => name.endsWith(".tmp")), false);
  server.runtime.authSessions.clear();
  server.runtime.loadAuthSessions();
  assert.equal(server.runtime.authSessions.has(persistedId), true);
  assert.equal(server.runtime.authSessions.has("pending"), false);
});

test("request body readers stop retaining data after exceeding byte limits", async () => {
  const runtime = {};
  installRequestBodyRuntime(runtime);
  const textStream = new PassThrough();
  const textBody = runtime.readBody(textStream);
  textStream.write(Buffer.from("é".repeat(1_000_001)));
  await assert.rejects(textBody, /Request body too large/);
  assert.equal(textStream.listenerCount("data"), 0);
  assert.equal(textStream.listenerCount("end"), 0);
  assert.equal(textStream.listenerCount("error"), 1);
  assert.doesNotThrow(() => textStream.emit("error", new Error("late stream error")));
  const textClosed = new Promise((resolve) => textStream.once("close", resolve));
  textStream.end();
  await textClosed;
  assert.equal(textStream.listenerCount("error"), 0);

  const bufferStream = new PassThrough();
  const bufferBody = runtime.readBodyBuffer(bufferStream, 3);
  bufferStream.write(Buffer.from("éé"));
  await assert.rejects(bufferBody, /Request body too large/);
  assert.equal(bufferStream.listenerCount("data"), 0);
  bufferStream.end();

  const validStream = new PassThrough();
  const validBody = runtime.readBody(validStream);
  validStream.end("正常内容");
  assert.equal(await validBody, "正常内容");
});

test("config rejects the example access token while keeping a random default", () => {
  const configUrl = new URL("../src/config.js", import.meta.url).href;
  const script = `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(config.accessToken);`;
  const cwd = createTempDir();
  const environment = { ...process.env };
  delete environment.ACCESS_TOKEN;
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, env, encoding: "utf8"
  });

  const placeholder = run({ ...environment, ACCESS_TOKEN: "change-me" });
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /ACCESS_TOKEN must not be the example value change-me/);

  const first = run(environment);
  const second = run(environment);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first.stdout, second.stdout);
});

test("config route exposes codex desktop defaults from local config files", async (t) => {
  const sessionManager = createSessionManagerStub();
  const rootDir = createTempDir();
  const codexConfigPath = path.join(rootDir, ".codex", "config.toml");
  const codexGlobalStatePath = path.join(rootDir, ".codex", ".codex-global-state.json");
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  fs.writeFileSync(
    codexConfigPath,
    'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "low"\n',
    "utf8"
  );
  fs.writeFileSync(
    codexGlobalStatePath,
    JSON.stringify({ "electron-persisted-atom-state": { "agent-mode": "full-access" } }),
    "utf8"
  );
  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      home: rootDir,
      codexConfigPath,
      codexGlobalStatePath
    }
  });
  t.after(async () => {
    await server.close();
  });

  const auth = await login(server.baseUrl, server.config.accessToken);
  const configResponse = await fetch(`${server.baseUrl}/api/config`, {
    headers: { cookie: auth.cookies }
  });
  assert.equal(configResponse.status, 200);
  const payload = await configResponse.json();
  assert.deepEqual(payload.codexDefaults, {
    model: "gpt-5.5",
    reasoningEffort: "low",
    permissionMode: "full-access"
  });
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

  const gifPath = path.join(server.rootDir, "history-preview.gif");
  fs.writeFileSync(gifPath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  const gifUrl = `${server.baseUrl}/api/local-file-image?path=${encodeURIComponent(gifPath)}`;
  const gifResponse = await fetch(gifUrl, { headers: { cookie: auth.cookies } });
  assert.equal(gifResponse.status, 200);
  assert.equal(gifResponse.headers.get("content-type"), "image/gif");
  assert.deepEqual(Buffer.from(await gifResponse.arrayBuffer()), fs.readFileSync(gifPath));
  assert.equal((await fetch(gifUrl)).status, 401);

  const svgPath = path.join(server.rootDir, "history-preview.svg");
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>throw new Error("unsafe")</script></svg>');
  const svgResponse = await fetch(`${server.baseUrl}/api/local-file-image?path=${encodeURIComponent(svgPath)}`,
    { headers: { cookie: auth.cookies } });
  assert.equal(svgResponse.status, 200);
  assert.equal(svgResponse.headers.get("content-security-policy"), "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(svgResponse.headers.get("x-content-type-options"), "nosniff");
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

test("health route stays public even when client access policy would reject other routes", async (t) => {
  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      trustedCidrs: ["100.64.0.0/10"]
    }
  });
  t.after(async () => {
    await server.close();
  });

  const healthResponse = await fetch(`${server.baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);

  const protectedResponse = await fetch(`${server.baseUrl}/api/sessions`);
  assert.equal(protectedResponse.status, 403);
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

test("session create forwards composer runtime options to the session manager", async (t) => {
  const sessionManager = createSessionManagerStub();
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
    body: JSON.stringify({
      provider: "codex",
      cwd: "/tmp/composer-demo",
      model: "gpt-5-mini",
      reasoningEffort: "high",
      permissionMode: "full-access"
    })
  });

  assert.equal(response.status, 201);
  assert.equal(sessionManager.calls.create.length, 1);
  assert.deepEqual(sessionManager.calls.create[0], {
    provider: "codex",
    cwd: "/tmp/composer-demo",
    model: "gpt-5-mini",
    reasoningEffort: "high",
    permissionMode: "full-access"
  });
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
  sessionManager.ensureLiveSessionForThread = (threadId, options = {}) => {
    assert.equal(threadId, liveSession.resumeSessionId);
    assert.equal(options.model, "gpt-5-mini");
    assert.equal(options.reasoningEffort, "high");
    assert.equal(options.permissionMode, "full-access");
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
      client.send(JSON.stringify({ type: "message_part", turnId: "turn-1", part: { type: "text", text: "流式回复" }, phase: "streaming" }));
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
      client.send(JSON.stringify({ type: "turn.completed", turnId: "turn-1", status: "completed" }));
    }
    return "turn-1";
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
    body: JSON.stringify({
      type: "input",
      data: "你好\n",
      model: "gpt-5-mini",
      reasoningEffort: "high",
      permissionMode: "full-access"
    }),
    signal: controller.signal
  });

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  while (!events.some((event) => event.event === "turn.completed")) {
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
      if (events.some((event) => event.event === "turn.completed")) {
        break;
      }
    }
  }
  controller.abort();

  assert.deepEqual(writes, [{ id: liveSession.id, data: "你好\n" }]);
  assert.deepEqual(sessionManager.calls.updateSessionOptions, [
    {
      id: liveSession.id,
      model: "gpt-5-mini",
      reasoningEffort: "high",
      permissionMode: "full-access"
    }
  ]);
  assert.equal(events.some((event) => event.event === "thread.snapshot"), false);
  assert.equal(events.find((event) => event.event === "message.delta")?.payload.text, "流式回复");
  assert.equal(events.find((event) => event.event === "turn.completed")?.payload.turnId, "turn-1");
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
  sessionManager.ensureLiveSessionForThread = (threadId, options = {}) => {
    assert.equal(threadId, liveSession.resumeSessionId);
    assert.equal(options.providerId, "codex");
    assert.equal(options.cwd, "/tmp/thread-workspace");
    assert.equal(options.model, "gpt-5-mini");
    assert.equal(options.reasoningEffort, "low");
    assert.equal(options.permissionMode, "auto-review");
    return liveSession;
  };
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
      client.send(JSON.stringify({ type: "message_part", turnId: "turn-1", part: { type: "text", text: "线程流式回复" }, phase: "streaming" }));
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
      client.send(JSON.stringify({ type: "turn.completed", turnId: "turn-1", status: "completed" }));
    }
    return "turn-1";
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
    body: JSON.stringify({
      type: "input",
      data: "继续这个 thread\n",
      cwd: "/tmp/thread-workspace",
      model: "gpt-5-mini",
      reasoningEffort: "low",
      permissionMode: "auto-review"
    }),
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
  assert.deepEqual(sessionManager.calls.updateSessionOptions, [
    {
      id: liveSession.id,
      model: "gpt-5-mini",
      reasoningEffort: "low",
      permissionMode: "auto-review"
    }
  ]);
  assert.equal(events.some((event) => event.event === "thread.snapshot"), false);
  assert.equal(events.find((event) => event.event === "message.delta")?.payload.text, "线程流式回复");
  assert.equal(events.find((event) => event.event === "turn.completed")?.payload.turnId, "turn-1");
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

test("thread composer-state route returns thread-specific composer state and git state", async (t) => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const sessionManager = createSessionManagerStub();
  fs.mkdirSync(codexDir, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      [
        createCodexThreadsTableSql(),
        `insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-1', '', 1714200000, 1714200000, 'vscode', 'openai', '${process.cwd()}',
          'Thread One', '{"type":"danger-full-access"}', 'never', 0, 0, 0, 'feature/test-thread',
          '', '', 'enabled', 'gpt-5.4', 'xhigh', 1714200000000, 1714200000000
        );`
      ].join("\n")
    ],
    { stdio: "ignore" }
  );

  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      codexStateDbPath: stateDbPath,
      codexConfigPath: path.join(createTempDir(), "missing-config.toml"),
      codexGlobalStatePath: path.join(createTempDir(), "missing-global-state.json")
    }
  });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(
    `${server.baseUrl}/api/threads/codex/${encodeURIComponent("thread-1")}/composer-state`,
    { headers: { cookie: cookies } }
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.threadId, "thread-1");
  assert.equal(payload.provider, "codex");
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.reasoningEffort, "xhigh");
  assert.equal(payload.permissionMode, "full-access");
  assert.equal(typeof payload.git.isGitRepo, "boolean");
});

test("CC composer-state and resumed creation use canonical provider defaults, live settings and explicit overrides", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir, {
    ccModel: "claude-http-default",
    ccFullAccess: false,
    codexConfigPath: path.join(rootDir, "codex-config.toml"),
    codexGlobalStatePath: path.join(rootDir, "codex-global-state.json")
  });
  fs.writeFileSync(config.codexConfigPath, 'model = "gpt-http-only"\nmodel_reasoning_effort = "ultra"\n');
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify({
    "electron-persisted-atom-state": { "agent-mode-by-host-id": { local: "full-access" } }
  }));
  const sessionManager = createSessionManagerStub();
  const providers = buildProviders(config);
  const spawnSpecs = [];
  let liveSession = null;
  sessionManager.getProvider = (id) => providers.find((provider) => provider.id === id || provider.aliases.includes(id));
  sessionManager.findLiveSessionByThreadId = (threadId, { providerId }) => (
    liveSession?.resumeSessionId === threadId && liveSession.provider === providerId ? liveSession : null
  );
  sessionManager.create = (body) => {
    sessionManager.calls.create.push(body);
    const provider = sessionManager.getProvider(body.provider);
    spawnSpecs.push(provider.buildSpawnSpec(body));
    return { ...body, id: `cc-http-${spawnSpecs.length}`, provider: provider.id, status: "running" };
  };
  const server = await startTestServer({ sessionManager, configOverrides: config });
  t.after(async () => {
    await server.runtime.closeWorkspace();
    await server.close();
    fs.rmSync(server.rootDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  let gitReads = 0;
  server.runtime.workspace.listGitBranches = async () => { gitReads += 1; throw new Error("git=0 must not query Git"); };
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const headers = { cookie: cookies, "content-type": "application/json" };
  for (const provider of ["cc", "claude"]) {
    const response = await fetch(`${server.baseUrl}/api/threads/${provider}/cc-http-thread/composer-state?git=0`, { headers });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state, {
      provider: "cc", threadId: "cc-http-thread", model: config.ccModel, reasoningEffort: "medium",
      permissionMode: "default", cwd: config.defaultCwd, source: "defaults"
    });
    const resumed = await fetch(`${server.baseUrl}/api/sessions`, {
      method: "POST", headers, body: JSON.stringify({ provider, resumeSessionId: "cc-http-thread" })
    });
    assert.equal(resumed.status, 201);
    assert.equal((await resumed.json()).session.model, config.ccModel);
    assert.deepEqual(spawnSpecs.at(-1).args, ["--resume", "cc-http-thread", "--model", config.ccModel]);
    assert.equal(sessionManager.calls.create.at(-1).permissionMode, "default");
  }

  liveSession = {
    provider: "cc", resumeSessionId: "cc-http-live", model: "cc-http-live-model", reasoningEffort: "high",
    permissionMode: "auto-review", cwd: path.join(rootDir, "live")
  };
  const liveResponse = await fetch(`${server.baseUrl}/api/threads/claude/cc-http-live/composer-state?git=0`, { headers });
  assert.equal(liveResponse.status, 200);
  const liveState = await liveResponse.json();
  assert.equal(liveState.source, "live_session");
  assert.equal(liveState.model, liveSession.model);
  assert.equal(liveState.reasoningEffort, liveSession.reasoningEffort);
  assert.equal(liveState.permissionMode, liveSession.permissionMode);
  assert.equal(liveState.cwd, liveSession.cwd);
  const liveResume = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify({ provider: "claude", resumeSessionId: "cc-http-live" })
  });
  assert.equal(liveResume.status, 201);
  await liveResume.json();
  assert.equal(sessionManager.calls.create.at(-1).model, liveSession.model);
  assert.equal(sessionManager.calls.create.at(-1).permissionMode, liveSession.permissionMode);

  const explicit = {
    provider: "claude", resumeSessionId: "cc-http-live", model: "cc-http-explicit", reasoningEffort: "low",
    permissionMode: "default", cwd: path.join(rootDir, "explicit")
  };
  const overridden = await fetch(`${server.baseUrl}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify(explicit)
  });
  assert.equal(overridden.status, 201);
  await overridden.json();
  for (const key of ["model", "reasoningEffort", "permissionMode", "cwd"]) {
    assert.equal(sessionManager.calls.create.at(-1)[key], explicit[key]);
  }
  assert.deepEqual(spawnSpecs.at(-1).args, ["--resume", "cc-http-live", "--model", explicit.model]);
  assert.equal(gitReads, 0);
});

test("thread composer-state patch updates sqlite-backed thread state and live session", async (t) => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const sessionManager = createSessionManagerStub();
  fs.mkdirSync(codexDir, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      [
        createCodexThreadsTableSql(),
        `insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-1', '', 1714200000, 1714200000, 'vscode', 'openai', '${process.cwd()}',
          'Thread One', '{"type":"danger-full-access"}', 'never', 0, 0, 0, 'feature/old-branch',
          '', '', 'enabled', 'gpt-5.5', 'low', 1714200000000, 1714200000000
        );`
      ].join("\n")
    ],
    { stdio: "ignore" }
  );
  sessionManager.findLiveSessionByThreadId = () => sessionManager.get("session-1");

  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      codexStateDbPath: stateDbPath
    }
  });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(
    `${server.baseUrl}/api/threads/codex/${encodeURIComponent("thread-1")}/composer-state`,
    {
      method: "PATCH",
      headers: {
        cookie: cookies,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        reasoningEffort: "medium",
        permissionMode: "auto-review",
        gitBranch: "feature/new-branch"
      })
    }
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.reasoningEffort, "medium");
  assert.equal(payload.permissionMode, "auto-review");

  const row = execFileSync(
    "sqlite3",
    [
      stateDbPath,
      "select model, reasoning_effort, sandbox_policy, approval_mode, git_branch from threads where id='thread-1';"
    ],
    { encoding: "utf8" }
  ).trim();
  assert.equal(
    row,
    `gpt-5.4|medium|{"type":"workspace-write"}|on-request|feature/new-branch`
  );
  assert.equal(sessionManager.get("session-1").model, "gpt-5.4");
  assert.equal(sessionManager.get("session-1").reasoningEffort, "medium");
  assert.equal(sessionManager.get("session-1").permissionMode, "auto-review");
  assert.deepEqual(sessionManager.calls.updateSessionOptions, [
    {
      id: "session-1",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      permissionMode: "auto-review"
    }
  ]);
});

test("thread composer-state patch writes default permission to the Codex thread state", async (t) => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const sessionManager = createSessionManagerStub();
  fs.mkdirSync(codexDir, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      [
        createCodexThreadsTableSql(),
        `insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-1', '', 1714200000, 1714200000, 'vscode', 'openai', '${process.cwd()}',
          'Thread One', '{"type":"danger-full-access"}', 'never', 0, 0, 0, 'feature/old-branch',
          '', '', 'enabled', 'gpt-5.5', 'low', 1714200000000, 1714200000000
        );`
      ].join("\n")
    ],
    { stdio: "ignore" }
  );
  sessionManager.findLiveSessionByThreadId = () => sessionManager.get("session-1");

  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      codexStateDbPath: stateDbPath
    }
  });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(
    `${server.baseUrl}/api/threads/codex/${encodeURIComponent("thread-1")}/composer-state`,
    {
      method: "PATCH",
      headers: {
        cookie: cookies,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        permissionMode: "default"
      })
    }
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.permissionMode, "default");
  assert.equal(sessionManager.get("session-1").permissionMode, "default");

  const row = execFileSync(
    "sqlite3",
    [
      stateDbPath,
      "select sandbox_policy, approval_mode from threads where id='thread-1';"
    ],
    { encoding: "utf8" }
  ).trim();
  assert.equal(row, `{"type":"read-only","network_access":true}|never`);
});

test("thread composer-state patch does not call app-server resume for state sync", { timeout: 10_000 }, async (t) => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const workspaceDir = path.join(rootDir, "workspace");
  const sessionManager = createSessionManagerStub();
  let runtimeSyncCalled = false;
  sessionManager.appServerBridge = {
    updateThreadComposerState() {
      runtimeSyncCalled = true;
      throw new Error("app-server resume should not be used for composer-state persistence");
    }
  };
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      [
        createCodexThreadsTableSql(),
        `insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-1', '', 1714200000, 1714200000, 'vscode', 'openai', '${workspaceDir}',
          'Thread One', '{"type":"read-only"}', 'default', 0, 0, 0, 'feature/old-branch',
          '', '', 'enabled', 'gpt-5.5', 'high', 1714200000000, 1714200000000
        );`
      ].join("\n")
    ],
    { stdio: "ignore" }
  );

  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      codexStateDbPath: stateDbPath
    }
  });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(
    `${server.baseUrl}/api/threads/codex/${encodeURIComponent("thread-1")}/composer-state`,
    {
      method: "PATCH",
      headers: {
        cookie: cookies,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        reasoningEffort: "low",
        permissionMode: "full-access"
      })
    }
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.reasoningEffort, "low");
  assert.equal(payload.permissionMode, "full-access");
  assert.equal(runtimeSyncCalled, false);
});

test("session create resumes Codex thread with sqlite-backed permission state when options are omitted", async (t) => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const workspaceRoot = path.join(rootDir, "workspace", "resume-thread");
  const sessionManager = createSessionManagerStub();
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      [
        createCodexThreadsTableSql(),
        `insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-resume-config', '', 1714200000, 1714200000, 'vscode', 'openai', '${workspaceRoot}',
          'Resume Config Thread', '{"type":"danger-full-access"}', 'never', 0, 0, 0, 'feature/resume-thread',
          '', '', 'enabled', 'gpt-5.4', 'low', 1714200000000, 1714200000000
        );`
      ].join("\n")
    ],
    { stdio: "ignore" }
  );

  const server = await startTestServer({
    sessionManager,
    configOverrides: {
      codexStateDbPath: stateDbPath
    }
  });
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
    body: JSON.stringify({
      provider: "codex",
      resumeSessionId: "thread-resume-config"
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.session.resumeSessionId, "thread-resume-config");
  assert.equal(payload.session.cwd, workspaceRoot);
  assert.equal(payload.session.model, "gpt-5.4");
  assert.equal(payload.session.reasoningEffort, "low");
  assert.equal(payload.session.permissionMode, "full-access");
});

test("single-thread model contract: history conversation route returns the authoritative merged thread view when live continuation exists", async (t) => {
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
  assert.equal(payload.session.id, "session-live-1");
  assert.equal(payload.threadSnapshot.turns.length, 2);
  assert.equal(payload.continuation.threadSnapshot.turns.length, 2);
  assert.equal(payload.turns.length, 2);
});

test("single-thread model contract: continuation route still exposes raw live continuation separately from the merged history conversation route", async (t) => {
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
  assert.equal(historyPayload.threadSnapshot.turns.length, 2);
  assert.equal(historyPayload.turns.length, 0);
  assert.equal(continuationPayload.hasLiveContinuation, true);
  assert.equal(continuationPayload.continuation.threadSnapshot.turns.length, 2);
});

test("single-thread model contract: thread bundle route returns the authoritative merged thread snapshot", async (t) => {
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
    conversation: {
      threadId: resumeSessionId,
      turns: [{ id: "turn-history-only" }],
      backgroundAgents: []
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
    conversation: {
      threadId: resumeSessionId,
      turns: [{ id: "turn-live-only" }],
      backgroundAgents: []
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
  const response = await fetch(`${server.baseUrl}/api/threads/codex/thread-1`, {
    headers: { cookie: cookies }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.session.id, "session-live-1");
  assert.equal(payload.threadSnapshot.turns.length, 2);
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

test("history messages route merges live continuation without dropping historical turns", async (t) => {
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
  assert.deepEqual(
    payload.threadSnapshot.turns.map((turn) => turn.id),
    ["turn-stale", "turn-fresh"]
  );
  assert.deepEqual(
    payload.conversation.turns.map((turn) => turn.id),
    ["turn-stale", "turn-fresh"]
  );
  assert.equal(payload.threadSnapshot.turns[0].items[1].text, "旧回答");
  assert.equal(payload.threadSnapshot.turns[1].items[1].text, "新回答");
  assert.equal(payload.conversation.turns[0].assistant.body[0].text, "旧回答");
  assert.equal(payload.conversation.turns[1].assistant.body[0].text, "新回答");
});

test("history messages route keeps historical middle turns when live continuation is partial", async (t) => {
  const sessionManager = createSessionManagerStub();
  const makeConversationTurn = (id, userText, assistantText) => ({
    id,
    user: { id: `u-${id}`, text: userText, ts: new Date().toISOString() },
    assistant: {
      body: [{ id: `body-${id}`, kind: "markdown", text: assistantText, payload: {}, ts: new Date().toISOString() }],
      process: [],
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }
  });
  const makeThreadTurn = (id, userText, assistantText) => ({
    id,
    items: [
      { id: `u-${id}`, kind: "UserMessage", text: userText },
      { id: `a-${id}`, kind: "AgentMessage", text: assistantText }
    ],
    status: "completed"
  });

  sessionManager.getThreadSnapshotBundle = () => ({});
  sessionManager.getHistoricalMessages = (provider, resumeSessionId) => ({
    session: { id: `history:${provider}:${resumeSessionId}`, kind: "history", provider, resumeSessionId },
    messages: [],
    turns: [],
    backgroundAgents: [],
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        makeThreadTurn("turn-before", "前一问", "前一答"),
        makeThreadTurn("turn-middle", "中间问", "中间答"),
        makeThreadTurn("turn-after", "后一问", "后一答")
      ]
    },
    conversation: {
      sessionId: `history:${provider}:${resumeSessionId}`,
      threadId: resumeSessionId,
      version: 3,
      status: "completed",
      turns: [
        makeConversationTurn("turn-before", "前一问", "前一答"),
        makeConversationTurn("turn-middle", "中间问", "中间答"),
        makeConversationTurn("turn-after", "后一问", "后一答")
      ],
      backgroundAgents: []
    },
    conversationSnapshot: null
  });
  sessionManager.getThreadContinuationRuntime = (provider, resumeSessionId) => ({
    session: { id: "session-live-partial", kind: "live", provider, resumeSessionId },
    conversation: {
      sessionId: "session-live-partial",
      threadId: resumeSessionId,
      version: 4,
      status: "completed",
      turns: [
        makeConversationTurn("turn-before", "前一问", "前一答"),
        makeConversationTurn("turn-after", "后一问", "后一答")
      ],
      backgroundAgents: []
    },
    threadSnapshot: {
      threadId: resumeSessionId,
      turns: [
        makeThreadTurn("turn-before", "前一问", "前一答"),
        makeThreadTurn("turn-after", "后一问", "后一答")
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
  assert.deepEqual(
    payload.conversation.turns.map((turn) => turn.id),
    ["turn-before", "turn-middle", "turn-after"]
  );
  assert.deepEqual(
    payload.threadSnapshot.turns.map((turn) => turn.id),
    ["turn-before", "turn-middle", "turn-after"]
  );
  assert.equal(payload.conversation.turns[1].user.text, "中间问");
  assert.equal(payload.conversation.turns[1].assistant.body[0].text, "中间答");
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

test("workspace git API lists branches, creates a branch, and checks out a clean workspace", async (t) => {
  const rootDir = createTempDir();
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: rootDir, stdio: "ignore" });
  fs.writeFileSync(path.join(rootDir, "demo.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "demo.txt"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: rootDir, stdio: "ignore" });
  const initialBranch = execFileSync("git", ["branch", "--show-current"], { cwd: rootDir, encoding: "utf8" }).trim();

  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const params = new URLSearchParams({ cwd: rootDir });
  const listResponse = await fetch(`${server.baseUrl}/api/workspace-git?${params.toString()}`, {
    headers: { cookie: cookies }
  });
  const listPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.isGitRepo, true);
  assert.equal(listPayload.currentBranch, initialBranch);
  assert.deepEqual(listPayload.branches.map((branch) => branch.name), [initialBranch]);

  const createResponse = await fetch(`${server.baseUrl}/api/workspace-git/branches`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ cwd: rootDir, branch: "feature/composer-api", checkout: false })
  });
  const createPayload = await createResponse.json();

  assert.equal(createResponse.status, 200);
  assert.equal(createPayload.currentBranch, initialBranch);
  assert.deepEqual(createPayload.branches.map((branch) => branch.name), [initialBranch, "feature/composer-api"]);

  const checkoutResponse = await fetch(`${server.baseUrl}/api/workspace-git/checkout`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ cwd: rootDir, branch: "feature/composer-api" })
  });
  const checkoutPayload = await checkoutResponse.json();

  assert.equal(checkoutResponse.status, 200);
  assert.equal(checkoutPayload.currentBranch, "feature/composer-api");
  assert.equal(checkoutPayload.branches[0].name, "feature/composer-api");
  assert.equal(checkoutPayload.branches[0].current, true);
});

test("workspace git checkout API rejects dirty workspaces with 409", async (t) => {
  const rootDir = createTempDir();
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: rootDir, stdio: "ignore" });
  fs.writeFileSync(path.join(rootDir, "demo.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "demo.txt"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: rootDir, stdio: "ignore" });
  const initialBranch = execFileSync("git", ["branch", "--show-current"], { cwd: rootDir, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-b", "feature/dirty-target"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["checkout", initialBranch], { cwd: rootDir, stdio: "ignore" });
  fs.writeFileSync(path.join(rootDir, "demo.txt"), "before\nafter\n", "utf8");

  const sessionManager = createSessionManagerStub();
  const server = await startTestServer({ sessionManager });
  t.after(async () => {
    await server.close();
  });

  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const response = await fetch(`${server.baseUrl}/api/workspace-git/checkout`, {
    method: "POST",
    headers: {
      cookie: cookies,
      "content-type": "application/json"
    },
    body: JSON.stringify({ cwd: rootDir, branch: "feature/dirty-target" })
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload, {
    error: "Workspace has uncommitted changes",
    code: "DIRTY_WORKTREE",
    executionState: "not-applied",
    dirty: true
  });
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: rootDir, encoding: "utf8" }).trim(), initialBranch);
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

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("error", reject);
  });
}

test("sidebar transfer negotiates br and gzip and revalidates current JSON with stable weak ETags", async (t) => {
  const sessionManager = createSessionManagerStub();
  const expected = { sessions: [{ id: "a", name: "侧栏会话", details: "repeatable payload ".repeat(200), activityState: "unknown", lastActivityAt: null }],
    projectGroups: [{ id: "project", sessions: [{ id: "a", activityState: "unknown", lastActivityAt: null }] }] };
  let reads = 0;
  sessionManager.listSidebarSnapshot = () => { reads += 1; return expected; };
  const server = await startTestServer({ sessionManager });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const endpoint = `${server.baseUrl}/api/sessions`;
  const first = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "gzip" });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-encoding"], "gzip");
  assert.match(first.headers["content-type"], /^application\/json/);
  assert.equal(first.headers["cache-control"], "private, no-cache");
  assert.equal(first.headers.vary, "Accept-Encoding");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  assert.equal(first.headers["x-frame-options"], "DENY");
  assert.equal(first.headers["referrer-policy"], "same-origin");
  assert.deepEqual(JSON.parse(gunzipSync(first.body).toString()), expected);
  assert.ok(first.body.length < JSON.stringify(expected).length);
  assert.match(first.headers.etag, /^W\/".+"$/);

  const repeated = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "gzip" });
  assert.equal(repeated.headers.etag, first.headers.etag);
  assert.deepEqual(repeated.body, first.body);
  const cached = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "gzip", "If-None-Match": `"unrelated", ${first.headers.etag.replace(/^W\//, "")}` });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
  assert.equal(cached.headers.vary, "Accept-Encoding");
  assert.equal(cached.headers["content-encoding"], undefined);

  const identity = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "identity" });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(identity.body.toString()), expected);
  assert.equal(identity.headers.etag, first.headers.etag);
  assert.deepEqual(identity.body, gunzipSync(first.body));
  const brotli = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "br" });
  assert.equal(brotli.status, 200);
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(brotli.headers.etag, first.headers.etag);
  assert.deepEqual(brotliDecompressSync(brotli.body), identity.body);
  const crossEncoding = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "br", "If-None-Match": first.headers.etag });
  assert.equal(crossEncoding.status, 304);
  assert.equal(crossEncoding.body.length, 0);
  assert.equal(crossEncoding.headers["content-encoding"], undefined);
  assert.equal(crossEncoding.headers.etag, first.headers.etag);
  expected.sessions[0].name = "桌面已修改标题";
  const changed = await rawGet(endpoint, { cookie: cookies, "Accept-Encoding": "br", "If-None-Match": first.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.deepEqual(JSON.parse(brotliDecompressSync(changed.body).toString()), expected);
  assert.equal(reads, 7);
});

test("sidebar encoding negotiation honors quality, casing, wildcards, explicit rejection and no header", async (t) => {
  const server = await startTestServer({ sessionManager: createSessionManagerStub() });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const cases = [
    [undefined, undefined], ["identity", undefined], ["gzip;q=0", undefined],
    ["br", "br"], ["br, gzip;q=0.5", "br"], ["gzip;q=0.5, br", "br"],
    ["br;q=0.3, gzip;q=0.8", "gzip"], ["br;q=0.8, gzip;q=0.3", "br"],
    ["br, gzip", "br"], ["gzip, br", "br"], ["gzip, deflate, br", "br"], ["gzip;q=0.7, br;q=0.7", "br"],
    ["identity;q=1, br;q=0.8, gzip;q=0.5", undefined],
    ["gzip;q=0, *;q=1", "br"], ["br;q=0, *;q=1", "gzip"],
    ["br;q=0, gzip;q=0, identity;q=1, *;q=1", undefined],
    ["gzip;q=0.0, br", "br"], ["*;q=1", "br"], ["GZip;Q=1", "gzip"], ["BR;q=1", "br"],
    ["BR;Q=0, GZip;Q=0, identity", undefined], ["BR;Q=0, *;Q=1", "gzip"],
    ["GZip;Q=0, *;Q=1", "br"]
  ];
  const baseline = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies });
  for (const [accept, encoding] of cases) {
    const headers = { cookie: cookies, ...(accept === undefined ? {} : { "Accept-Encoding": accept }) };
    const response = await rawGet(`${server.baseUrl}/api/sessions`, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], encoding, `Accept-Encoding: ${accept}`);
    const decoded = encoding === "br" ? brotliDecompressSync(response.body)
      : encoding === "gzip" ? gunzipSync(response.body) : response.body;
    assert.deepEqual(decoded, baseline.body);
    assert.equal(response.headers.etag, baseline.headers.etag);
  }
});

test("sidebar returns a safe 406 JSON error when every supported encoding is rejected", async (t) => {
  const server = await startTestServer({ sessionManager: createSessionManagerStub() });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const valid = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies });
  for (const accept of ["*;q=0", "br;q=0, gzip;q=0, identity;q=0", "br;q=0, gzip;q=0, identity;q=0, *;q=1"]) {
    for (const etag of [undefined, valid.headers.etag]) {
      const response = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies, "Accept-Encoding": accept,
        ...(etag ? { "If-None-Match": etag } : {}) });
      assert.equal(response.status, 406, `Accept-Encoding: ${accept}; If-None-Match: ${etag}`);
      assert.deepEqual(JSON.parse(response.body), { error: "No acceptable content encoding" });
      assert.equal(response.headers["content-encoding"], undefined);
      assert.equal(response.headers.etag, undefined);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["x-frame-options"], "DENY");
      assert.equal(response.headers["referrer-policy"], "same-origin");
    }
  }
});

test("sidebar ETag never bypasses authorization or changes cache policy on other routes", async (t) => {
  const sessionManager = createSessionManagerStub();
  let reads = 0;
  const list = sessionManager.listSidebarSnapshot.bind(sessionManager);
  sessionManager.listSidebarSnapshot = () => { reads += 1; return list(); };
  const server = await startTestServer({ sessionManager });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const valid = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies });
  for (const encoding of ["br", "gzip", "*;q=0"]) {
    const unauthorized = await rawGet(`${server.baseUrl}/api/sessions`, { "If-None-Match": valid.headers.etag, "Accept-Encoding": encoding });
    assert.equal(unauthorized.status, 401);
    assert.equal(JSON.parse(unauthorized.body.toString()).error, "Unauthorized");
    assert.equal(unauthorized.headers.etag, undefined);
    assert.equal(unauthorized.headers["content-encoding"], undefined);
    assert.equal(unauthorized.headers["cache-control"], "no-store");
  }
  assert.equal(reads, 1);
  const config = await rawGet(`${server.baseUrl}/api/config`, { cookie: cookies, "Accept-Encoding": "gzip", "If-None-Match": valid.headers.etag });
  assert.equal(config.status, 200);
  assert.equal(config.headers["content-encoding"], undefined);
  assert.equal(config.headers["cache-control"], "no-store");
});

test("sidebar includes V2 turn activity in all lists and changes ETag without changing recorded recency", async (t) => {
  const sessionManager = createSessionManagerStub();
  const entry = { id: "history:codex:activity-thread", threadId: "activity-thread", provider: "codex", status: "saved",
    updatedAt: "2026-10-16T06:00:00.000Z" };
  sessionManager.listSidebarSnapshot = () => ({ sessions: [entry], projectGroups: [{ id: "project", sessions: [entry] }] });
  const server = await startTestServer({ sessionManager });
  t.after(() => server.close());
  let state = "running";
  server.runtime.codexThreads = { getThreadActivity: (id) => {
    assert.equal(id, "activity-thread"); return { activityState: state, lastActivityAt: "2026-10-16T06:00:01.000Z" };
  } };
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const first = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies });
  const running = JSON.parse(first.body.toString());
  assert.equal(running.sessions[0].activityState, "running");
  assert.equal(running.projectGroups[0].sessions[0].activityState, "running");
  const cached = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies, "If-None-Match": first.headers.etag });
  assert.equal(cached.status, 304);
  state = "idle";
  const next = await rawGet(`${server.baseUrl}/api/sessions`, { cookie: cookies, "If-None-Match": first.headers.etag });
  assert.equal(next.status, 200);
  const idle = JSON.parse(next.body.toString());
  assert.equal(idle.sessions[0].activityState, "idle");
  assert.equal(idle.sessions[0].lastActivityAt, running.sessions[0].lastActivityAt);
  assert.equal(entry.activityState, undefined);
});
