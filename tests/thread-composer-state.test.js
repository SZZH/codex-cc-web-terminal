import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { CodexThreadStateStore } from "../src/sessions/state/CodexThreadStateStore.js";
import { SessionManager } from "../src/sessionManager.js";
import { buildProviders } from "../src/sessions/providers/buildProviders.js";
import { buildSessionCreatePayloadFromThreadState, buildThreadComposerState } from "../src/routes/threadComposerState.js";
import { createBaseConfig, createTempDir, login, startTestServer, waitForMicrotasks } from "./helpers/backendTestUtils.js";

function createProviderDefaultsFixture(t, overrides = {}) {
  const root = createTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = createBaseConfig(root, {
    codexConfigPath: path.join(root, "config.toml"),
    codexGlobalStatePath: path.join(root, "desktop.json"),
    ccFullAccess: false,
    ...overrides
  });
  fs.writeFileSync(config.codexConfigPath, 'model = "gpt-r18-only"\nmodel_reasoning_effort = "ultra"\n');
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify({
    "electron-persisted-atom-state": { "agent-mode-by-host-id": { local: "full-access" } }
  }));
  const manager = Object.create(SessionManager.prototype);
  manager.config = config;
  manager.providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
  manager.sessions = new Map();
  return { config, manager, runtime: { config, sessionManager: manager } };
}

test("non-Codex cold composer defaults belong to the canonical provider", async (t) => {
  for (const ccModel of ["claude-owned-default", ""]) {
    for (const providerId of ["cc", "claude"]) {
      await t.test(`${providerId} with ${ccModel || "no configured model"}`, async (t) => {
        const { config, manager, runtime } = createProviderDefaultsFixture(t, { ccModel });
        const state = await buildThreadComposerState(runtime, {}, providerId, "cc-cold", { includeGit: false });
        assert.deepEqual(state, {
          provider: "cc", threadId: "cc-cold", model: ccModel,
          reasoningEffort: "medium", permissionMode: "default", cwd: config.defaultCwd, source: "defaults"
        });
        const payload = buildSessionCreatePayloadFromThreadState({ provider: providerId, resumeSessionId: "cc-cold" }, state);
        const { args } = manager.getProvider(providerId).buildSpawnSpec(payload);
        assert.deepEqual(args, ["--resume", "cc-cold", ...(ccModel ? ["--model", ccModel] : [])]);
      });
    }
  }
});

test("non-Codex live composer settings and explicit resume overrides stay provider-owned", async (t) => {
  const { config, manager, runtime } = createProviderDefaultsFixture(t);
  manager.providers.get("cc").models = [{ value: "cc-live", supportedReasoningEfforts: [] }];
  manager.sessions.set("live", {
    provider: "cc", resumeSessionId: "cc-live-thread", status: "running",
    model: "cc-live", reasoningEffort: "high", permissionMode: "auto-review", cwd: path.join(config.root, "live")
  });
  let state;
  for (const providerId of ["cc", "claude"]) {
    state = await buildThreadComposerState(runtime, {}, providerId, "cc-live-thread", { includeGit: false });
    assert.deepEqual(state, {
      provider: "cc", threadId: "cc-live-thread", model: "cc-live", reasoningEffort: "high",
      permissionMode: "auto-review", cwd: path.join(config.root, "live"), source: "live_session"
    });
  }
  const explicit = { provider: "claude", resumeSessionId: "cc-live-thread", model: "cc-explicit", reasoningEffort: "low", permissionMode: "default", cwd: path.join(config.root, "explicit") };
  const payload = buildSessionCreatePayloadFromThreadState(explicit, state);
  for (const key of ["model", "reasoningEffort", "permissionMode", "cwd"]) {
    assert.equal(payload[key], explicit[key]);
  }
  assert.deepEqual(manager.getProvider("claude").buildSpawnSpec(payload).args, ["--resume", "cc-live-thread", "--model", "cc-explicit"]);
});

test("non-Codex composer defaults support a catalog-only test runtime", async (t) => {
  const { config } = createProviderDefaultsFixture(t);
  const runtime = {
    config,
    sessionManager: { providerCatalog: () => [{ id: "cc", defaultModel: "cc-catalog-default" }] }
  };
  const state = await buildThreadComposerState(runtime, {}, "claude", "cc-catalog", { includeGit: false });
  assert.equal(state.provider, "cc");
  assert.equal(state.model, "cc-catalog-default");
  assert.equal(state.reasoningEffort, "medium");
  assert.equal(state.permissionMode, "default");
});

test("non-Codex composer state never reads Codex files, thread state, model catalog or git=0 Git", async (t) => {
  const { config, manager, runtime } = createProviderDefaultsFixture(t);
  const codexPaths = new Set([config.codexConfigPath, config.codexGlobalStatePath, config.codexStateDbPath, config.codexModelsCachePath]);
  for (const filePath of codexPaths) {
    fs.writeFileSync(filePath, "invalid Codex data");
  }
  const touched = [];
  const originalExists = fs.existsSync;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "existsSync", (filePath) => {
    if (codexPaths.has(String(filePath))) {
      touched.push(String(filePath));
      throw new Error("CC must not inspect Codex files");
    }
    return originalExists(filePath);
  });
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    if (codexPaths.has(String(filePath))) {
      touched.push(String(filePath));
      throw new Error("CC must not read Codex files");
    }
    return originalRead(filePath, ...args);
  });
  const threadRead = t.mock.method(CodexThreadStateStore.prototype, "getThreadComposerState", () => {
    throw new Error("CC must not read Codex thread state");
  });
  const catalogRead = t.mock.method(manager, "providerCatalog", () => {
    throw new Error("CC must not load the Codex model catalog");
  });
  const gitRead = t.mock.fn(() => { throw new Error("git=0 must not query Git"); });
  try {
    for (const providerId of ["cc", "claude"]) {
      const state = await buildThreadComposerState(runtime, { listGitBranches: gitRead }, providerId, "cc-isolated", { includeGit: false });
      assert.equal(state.model, config.ccModel);
      assert.equal(Object.hasOwn(state, "git"), false);
    }
    assert.deepEqual(touched, []);
    assert.equal(threadRead.mock.callCount(), 0);
    assert.equal(catalogRead.mock.callCount(), 0);
    assert.equal(gitRead.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
  }
});

test("Codex composer defaults still use desktop settings and Codex model capabilities", async (t) => {
  const { manager, runtime } = createProviderDefaultsFixture(t, { codexModel: "provider-default-is-not-desktop" });
  manager.providerCatalog = () => [{ id: "codex", models: [{ value: "gpt-r18-only", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }] }];
  const state = await buildThreadComposerState(runtime, {}, "codex", "codex-cold", { includeGit: false });
  assert.equal(state.model, "gpt-r18-only");
  assert.equal(state.reasoningEffort, "low");
  assert.equal(state.permissionMode, "full-access");
  assert.equal(state.source, "defaults");
});

function createSettingsFixture() {
  const root = createTempDir();
  const config = createBaseConfig(root, {
    codexStateDbPath: path.join(root, "threads.sqlite"),
    codexGlobalStatePath: path.join(root, "desktop.json"),
    codexConfigPath: path.join(root, "config.toml")
  });
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify({
    "electron-persisted-atom-state": { "agent-mode-by-host-id": { local: "default" } }
  }));
  execFileSync("sqlite3", [config.codexStateDbPath, `
    create table threads (
      id text primary key, cwd text, model text, reasoning_effort text,
      sandbox_policy text, approval_mode text, git_branch text,
      updated_at integer, updated_at_ms integer
    );
    insert into threads values ('thread-a', '${root}', 'model-a', 'high',
      '{"type":"workspace-write"}', 'on-request', '', 1, 1);
    insert into threads values ('thread-b', '${root}', 'model-b', 'low',
      '{"type":"read-only"}', 'never', '', 1, 1);
  `]);
  const models = [
    { value: "model-a", label: "Model A", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    { value: "model-b", label: "Model B", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
    { value: "model-none", label: "No Reasoning", supportedReasoningEfforts: [] }
  ];
  const store = new CodexThreadStateStore(config);
  return { config, store, models };
}

test("thread permissions round-trip independently of desktop defaults and other threads", () => {
  const { config, store } = createSettingsFixture();
  const globalBefore = fs.readFileSync(config.codexGlobalStatePath, "utf8");
  assert.equal(store.getThreadComposerState("thread-a").permissionMode, "auto-review");
  assert.equal(store.getThreadComposerState("thread-b").permissionMode, "default");
  for (const permissionMode of ["full-access", "default", "auto-review"]) {
    assert.equal(store.patchThreadComposerState("thread-a", { permissionMode }).permissionMode, permissionMode);
    assert.equal(new CodexThreadStateStore(config).getThreadComposerState("thread-a").permissionMode, permissionMode);
    assert.equal(store.getThreadComposerState("thread-b").permissionMode, "default");
    assert.equal(fs.readFileSync(config.codexGlobalStatePath, "utf8"), globalBefore);
  }
});

test("thread model changes normalize supported effort and reject unsupported patches before writing", () => {
  const { store, models } = createSettingsFixture();
  assert.equal(store.patchThreadComposerState("thread-a", { model: "model-b" }, { models }).reasoningEffort, "low");
  assert.throws(() => store.patchThreadComposerState("thread-a", { reasoningEffort: "high" }, { models }), /does not support/);
  assert.equal(store.getThreadComposerState("thread-a").reasoningEffort, "low");
  assert.equal(store.patchThreadComposerState("thread-a", { model: "model-none" }, { models }).reasoningEffort, "");
  assert.equal(store.patchThreadComposerState("thread-a", { permissionMode: "full-access" }, { models }).reasoningEffort, "");
});

class RecordingBridge extends EventEmitter {
  turns = [];
  async startTurn(session, prompt) {
    this.turns.push({ model: session.model, reasoningEffort: session.reasoningEffort, permissionMode: session.permissionMode, prompt });
    return { turn: { id: `server-turn-${this.turns.length}`, status: "inProgress", items: [] } };
  }
}

test("custom narrow grants cannot silently become a broader permission mode on resume", () => {
  const { config, store } = createSettingsFixture();
  const narrowPolicy = JSON.stringify({ type: "managed", network: "restricted", file_system: {
    type: "restricted", entries: [{ path: { type: "path", path: `${config.root}/allowed.txt` }, access: "write" }]
  } });
  execFileSync("sqlite3", [config.codexStateDbPath,
    `update threads set sandbox_policy='${narrowPolicy.replace(/'/g, "''")}' where id='thread-a'`]);
  const bridge = new RecordingBridge();
  const manager = new SessionManager(config, { appServerBridge: bridge });
  assert.throws(() => manager.create({ provider: "codex", resumeSessionId: "thread-a" }), /自定义权限策略/);
  assert.equal(bridge.turns.length, 0);
  store.patchThreadComposerState("thread-a", { permissionMode: "default" });
  assert.equal(manager.create({ provider: "codex", resumeSessionId: "thread-a" }).permissionMode, "default");
});

test("HTTP settings persist, reopen and drive the next turn even when input omits overrides", async (t) => {
  const { config, models } = createSettingsFixture();
  const bridge = new RecordingBridge();
  const manager = new SessionManager(config, { appServerBridge: bridge });
  manager.providerCatalog = () => [{ id: "codex", models }];
  const created = manager.create({ provider: "codex", resumeSessionId: "thread-a" });
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const headers = { cookie: cookies, "content-type": "application/json" };
  const url = `${server.baseUrl}/api/threads/codex/thread-a/composer-state`;
  const response = await fetch(url, {
    method: "PATCH", headers,
    body: JSON.stringify({ model: "model-b", permissionMode: "full-access" })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reasoningEffort, "low");
  const reopened = await (await fetch(url, { headers })).json();
  assert.deepEqual([reopened.model, reopened.reasoningEffort, reopened.permissionMode], ["model-b", "low", "full-access"]);
  const input = await fetch(`${server.baseUrl}/api/threads/codex/thread-a/input`, {
    method: "POST", headers, body: JSON.stringify({ data: "use saved settings" })
  });
  assert.equal(input.status, 202);
  await waitForMicrotasks();
  assert.deepEqual(bridge.turns, [{ model: "model-b", reasoningEffort: "low", permissionMode: "full-access", prompt: "use saved settings" }]);
  assert.equal(manager.get(created.id).runnerMode, "app_server");
  const rejected = await fetch(url, {
    method: "PATCH", headers, body: JSON.stringify({ reasoningEffort: "high" })
  });
  assert.equal(rejected.status, 400);
  assert.equal(manager.get(created.id).reasoningEffort, "low");
});

test("live threads can save settings before a SQLite row exists", async (t) => {
  const { config, models } = createSettingsFixture();
  const manager = new SessionManager(config, { appServerBridge: new RecordingBridge() });
  manager.providerCatalog = () => [{ id: "codex", models }];
  manager.create({ provider: "codex", resumeSessionId: "thread-live-only", model: "model-a", reasoningEffort: "high" });
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const headers = { cookie: cookies, "content-type": "application/json" };
  const url = `${server.baseUrl}/api/threads/codex/thread-live-only/composer-state`;
  const response = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ reasoningEffort: "low" }) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "live_session");
  assert.equal(payload.reasoningEffort, "low");
  const reopened = await (await fetch(url, { headers })).json();
  assert.equal(reopened.reasoningEffort, "low");
  const missing = await fetch(`${server.baseUrl}/api/threads/codex/missing/composer-state`, {
    method: "PATCH", headers, body: JSON.stringify({ model: "model-b" })
  });
  assert.equal(missing.status, 404);
});

test("git=0 settings GET/PATCH and resumed creation never query Git", async (t) => {
  const { config, models } = createSettingsFixture();
  const manager = new SessionManager(config, { appServerBridge: new RecordingBridge() });
  manager.providerCatalog = () => [{ id: "codex", models }];
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(async () => { await server.runtime.closeWorkspace(); await server.close(); manager.shutdown(); });
  let gitReads = 0;
  server.runtime.workspace.listGitBranches = async () => { gitReads += 1; throw new Error("slow Git must not be awaited by settings"); };
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const headers = { cookie: cookies, "content-type": "application/json" };
  const url = server.baseUrl + "/api/threads/codex/thread-a/composer-state";
  const first = await (await fetch(url + "?git=0", { headers })).json();
  assert.equal(first.model, "model-a");
  assert.equal(Object.hasOwn(first, "git"), false);
  const patch = await fetch(url + "?git=0", { method: "PATCH", headers, body: JSON.stringify({ permissionMode: "full-access" }) });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).permissionMode, "full-access");
  const created = await fetch(server.baseUrl + "/api/sessions", { method: "POST", headers, body: JSON.stringify({ provider: "codex", resumeSessionId: "thread-a" }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).session.permissionMode, "full-access");
  assert.equal(gitReads, 0);
  const compatible = await (await fetch(url, { headers })).json();
  assert.equal(gitReads, 1);
  assert.equal(compatible.git.available, false);
  assert.match(compatible.git.error, /slow Git/);
});
