import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";

import { SessionManager } from "../src/sessionManager.js";
import { CodexSidebarService } from "../src/sessions/history/CodexSidebarService.js";
import { createConversationState } from "../src/sessions/conversation/state.js";
import { createEmptyConversationState, applyDelta } from "../src/sessions/normalize/turnState.js";
import { createTurnCreatedDelta, normalizeRecordToDeltas } from "../src/sessions/normalize/turnDeltas.js";
import { deriveThreadSnapshotFromConversationState } from "../src/threads/index.js";
import { summarizeRelevantStderr } from "../src/sessions/runners/codexRunner.js";
import { normalizeCodexComposerPatch } from "../src/sessions/shared/composerOptions.js";
import { createBaseConfig, createTempDir, waitForMicrotasks } from "./helpers/backendTestUtils.js";

class AppServerBridgeStub extends EventEmitter {
  constructor() {
    super();
    this.turns = [];
  }

  async startTurn(session, text) {
    this.turns.push({ sessionId: session.id, text });
    session.resumeSessionId ||= "thread-live-1";
    return {
      turn: {
        items: [{ type: "agent_message", text: `reply:${text}` }]
      }
    };
  }
}

function createManager(overrides = {}) {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir, overrides);
  const bridge = new AppServerBridgeStub();
  return {
    rootDir,
    config,
    bridge,
    manager: new SessionManager(config, { appServerBridge: bridge })
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
}

test("legacy turn delegates preserve the manager receiver and explicit completion targets", () => {
  const { manager } = createManager();
  const session = {
    id: "legacy-delegate",
    currentTurnId: "active-turn",
    activePendingTurnId: "active-turn",
    conversationState: createConversationState(),
    pendingLocalTurnIds: new Set(["active-turn"])
  };
  const records = [];
  const broadcasts = [];
  manager.applyThreadRawRecord = function (target, record, options) {
    assert.equal(this, manager);
    assert.equal(target, session);
    records.push({ record, options });
  };
  manager.broadcastDerivedConversationDelta = function (target, previous) {
    assert.equal(this, manager);
    assert.equal(target, session);
    assert.equal(previous.sessionId, "");
    broadcasts.push("delta");
  };
  manager.broadcastConversationSnapshot = function (target) {
    assert.equal(this, manager);
    assert.equal(target, session);
    broadcasts.push("snapshot");
  };
  const timestamp = "2026-10-17T10:00:00.000Z";
  const images = [{ path: "/tmp/legacy-delegate-image.png", name: "image.png" }];
  const queuedTurnId = manager.createConversationTurn(session, "queued input", timestamp, { activate: false, images });

  assert.equal(session.currentTurnId, "active-turn");
  assert.equal(session.activePendingTurnId, "active-turn");
  assert.ok(session.pendingLocalTurnIds.has(queuedTurnId));
  assert.equal(records[0].options.turnId, queuedTurnId);
  assert.equal(records[0].record.timestamp, timestamp);
  assert.deepEqual(records[0].record.payload.local_images, images);
  assert.deepEqual(broadcasts, ["delta"]);

  manager.hasConversationTurn = function (target, turnId) {
    assert.equal(this, manager);
    assert.equal(target, session);
    return turnId === queuedTurnId;
  };
  assert.equal(manager.finalizeConversationTurn(session, "completed", timestamp, { turnId: "" }), false);
  assert.equal(manager.finalizeConversationTurn(session, "completed", timestamp, { turnId: "missing-turn" }), false);
  assert.equal(records.length, 1);
  assert.equal(manager.finalizeConversationTurn(session, "completed", timestamp, { turnId: queuedTurnId }), true);
  assert.equal(records[1].options.turnId, queuedTurnId);
  assert.equal(records[1].record.payload.type, "task_complete");
  assert.equal(session.currentTurnId, "active-turn");
  assert.equal(session.activePendingTurnId, "active-turn");
  assert.ok(!session.pendingLocalTurnIds.has(queuedTurnId));
  assert.ok(session.pendingLocalTurnIds.has("active-turn"));
  assert.deepEqual(broadcasts, ["delta", "delta", "snapshot"]);
});

test("legacy history resync resolves manager methods when each scheduled callback runs", (t) => {
  const { manager } = createManager();
  const session = { id: "legacy-resync", provider: "codex", resumeSessionId: "official-thread", status: "running" };
  manager.sessions.set(session.id, session);
  const scheduled = [];
  t.mock.method(globalThis, "setTimeout", (callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return { unref() {} };
  });
  manager.scheduleConversationHistoryResync(session, { attempts: 2, delayMs: 5 });
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [5, 10]);

  const observed = [];
  manager.ensureThreadSnapshot = function (target) {
    assert.equal(this, manager);
    assert.equal(target, session);
    observed.push("ensure");
    return { threadId: "official-thread", version: 0, lastEventSeq: 0, turns: [] };
  };
  manager.historyService.getHistoricalMessages = () => ({
    threadSnapshot: { threadId: "official-thread", version: 1, lastEventSeq: 1, turns: [] }
  });
  manager.syncConversationStateFromThreadSnapshot = function (target) {
    assert.equal(this, manager);
    assert.equal(target, session);
    observed.push("sync");
  };
  manager.broadcastConversationSnapshot = function (target) {
    assert.equal(this, manager);
    assert.equal(target, session);
    assert.equal(target.threadSnapshot.threadId, "official-thread");
    observed.push("broadcast");
  };
  scheduled[0].callback();
  assert.deepEqual(observed, ["ensure", "sync", "broadcast"]);
  assert.ok(session.updatedAt);

  session.status = "exited";
  scheduled[1].callback();
  assert.deepEqual(observed, ["ensure", "sync", "broadcast"]);
});

test("providerCatalog exposes both provider definitions", () => {
  const { manager } = createManager();
  const providers = manager.providerCatalog();

  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["codex", "cc"]
  );
  assert.equal(providers[0].defaultModel, "gpt-5");
  assert.equal(providers[1].defaultModel, "sonnet");
});

test("providerCatalog reads codex model options from models cache when available", () => {
  const { manager, config, rootDir } = createManager();
  const cachePath = path.join(rootDir, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: true, priority: 0 },
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", supported_in_api: true, priority: 1 },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", supported_in_api: true, priority: 2 }
      ]
    }),
    "utf8"
  );
  manager.config.codexModelsCachePath = cachePath;

  const providers = manager.providerCatalog();
  const codexProvider = providers.find((provider) => provider.id === "codex");

  assert.deepEqual(codexProvider.models, [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" }
  ]);
});

test("providerCatalog preserves model reasoning capabilities, filtering and ordering", () => {
  const { manager, config } = createManager();
  fs.writeFileSync(config.codexModelsCachePath, JSON.stringify({ models: [
    { slug: "future", visibility: "list", priority: 2, supportedReasoningEfforts: ["high", "ultra", "ultra"], defaultReasoningEffort: "ultra" },
    { slug: "limited", display_name: "Limited", priority: 1, supported_reasoning_levels: [{ effort: "low", description: "Low" }], default_reasoning_level: "low" },
    { slug: "hidden", visibility: "hide", priority: 0 },
    { slug: "no-api", supported_in_api: false },
    { slug: "limited", priority: 0 },
    { slug: "no-reasoning", priority: 3, supportedReasoningEfforts: [] },
    { slug: "camel", priority: 4, supportedReasoningEfforts: [{ reasoningEffort: "ultra" }], defaultReasoningEffort: "ultra" }
  ] }));

  assert.deepEqual(manager.providerCatalog()[0].models, [
    { value: "limited", label: "Limited", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
    { value: "future", label: "future", supportedReasoningEfforts: ["high", "ultra"], defaultReasoningEffort: "ultra" },
    { value: "no-reasoning", label: "no-reasoning", supportedReasoningEfforts: [] },
    { value: "camel", label: "camel", supportedReasoningEfforts: ["ultra"], defaultReasoningEffort: "ultra" }
  ]);
});

test("Codex patches validate advertised efforts and normalize effort when changing models", () => {
  const models = [
    { value: "limited", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    { value: "future", supportedReasoningEfforts: ["ultra"], defaultReasoningEffort: "ultra" },
    { value: "no-reasoning", supportedReasoningEfforts: [] }
  ];
  const current = { model: "original", reasoningEffort: "xhigh", permissionMode: "full-access" };

  assert.deepEqual(normalizeCodexComposerPatch({}, current, models), {});
  assert.deepEqual(normalizeCodexComposerPatch({ model: "limited" }, current, models), { model: "limited", reasoningEffort: "high" });
  assert.deepEqual(normalizeCodexComposerPatch({ model: "limited" }, { ...current, model: "limited" }, models), { model: "limited", reasoningEffort: "high" });
  assert.deepEqual(normalizeCodexComposerPatch({ model: "limited" }, { ...current, reasoningEffort: "low" }, models), { model: "limited" });
  assert.deepEqual(normalizeCodexComposerPatch({ model: "future", reasoningEffort: "ultra" }, current, models), { model: "future", reasoningEffort: "ultra" });
  assert.deepEqual(normalizeCodexComposerPatch({ model: "no-reasoning" }, current, models), { model: "no-reasoning", reasoningEffort: "" });
  assert.throws(() => normalizeCodexComposerPatch({ model: "limited", reasoningEffort: "xhigh" }, current, models), /does not support reasoning effort/);
  assert.throws(() => normalizeCodexComposerPatch({ model: "no-reasoning", reasoningEffort: "low" }, current, models), /does not support reasoning effort/);
  assert.deepEqual(normalizeCodexComposerPatch({ reasoningEffort: "xhigh" }, current), { reasoningEffort: "xhigh" });
  assert.deepEqual(normalizeCodexComposerPatch({ reasoningEffort: "ultra" }, current), { reasoningEffort: "ultra" });
  assert.throws(() => normalizeCodexComposerPatch({ reasoningEffort: "unsupported-level" }, current), /does not support reasoning effort/);
});

test("Codex session creation and updates share model capability validation", () => {
  const { manager, config } = createManager();
  fs.writeFileSync(config.codexModelsCachePath, JSON.stringify({ models: [
    { slug: "limited", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" },
    { slug: "future", supportedReasoningEfforts: ["ultra"], defaultReasoningEffort: "ultra" },
    { slug: "no-reasoning", supportedReasoningEfforts: [] }
  ] }));
  const created = manager.create({ model: "limited" });
  const live = manager.get(created.id);
  assert.equal(created.reasoningEffort, "low");
  assert.throws(() => manager.create({ model: "limited", reasoningEffort: "xhigh" }), /does not support reasoning effort/);
  assert.throws(() => manager.updateSessionOptions(live, { model: "limited", reasoningEffort: "xhigh" }), /does not support reasoning effort/);
  assert.equal(live.reasoningEffort, "low");
  manager.updateSessionOptions(live, { model: "future" });
  assert.equal(live.reasoningEffort, "ultra");
  manager.updateSessionOptions(live, { model: "no-reasoning" });
  assert.equal(manager.serialize(live).reasoningEffort, "");
  assert.equal(manager.create({ model: "no-reasoning" }).reasoningEffort, "");
});

test("listProjectGroups preserves project order and includes old history alongside live sessions", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-04-29T12:00:00.000Z"));
  const { manager, rootDir } = createManager();
  const alphaRoot = path.join(rootDir, "workspace", "alpha");
  const betaRoot = path.join(rootDir, "workspace", "beta");
  fs.mkdirSync(path.join(alphaRoot, "app"), { recursive: true });
  fs.mkdirSync(betaRoot, { recursive: true });

  manager.codexSidebarService.listProjectGroups = () => [
    {
      id: `project:${alphaRoot}`,
      name: "alpha",
      projectRoot: alphaRoot,
      cwd: alphaRoot,
      collapsed: false,
      sessions: [
        {
          id: "history:codex:thread-alpha-old",
          threadId: "thread-alpha-old",
          provider: "codex",
          providerLabel: "Codex",
          cliLabel: "Codex CLI",
          name: "旧 alpha",
          cwd: alphaRoot,
          kind: "history",
          status: "saved",
          createdAt: "",
          updatedAt: "2026-04-20T10:00:00.000Z",
          exitCode: null,
          autoNamed: false,
          inputPreview: "",
          resumeSessionId: "thread-alpha-old",
          model: "",
          titleSource: "codex_state_db",
          sessionType: "main",
          parentThreadId: "",
          agentRole: "",
          agentNickname: ""
        }
      ]
    },
    {
      id: `project:${betaRoot}`,
      name: "beta",
      projectRoot: betaRoot,
      cwd: betaRoot,
      collapsed: false,
      sessions: [
        {
          id: "history:codex:thread-beta-old",
          threadId: "thread-beta-old",
          provider: "codex",
          providerLabel: "Codex",
          cliLabel: "Codex CLI",
          name: "旧 beta",
          cwd: betaRoot,
          kind: "history",
          status: "saved",
          createdAt: "",
          updatedAt: "2026-04-21T10:00:00.000Z",
          exitCode: null,
          autoNamed: false,
          inputPreview: "",
          resumeSessionId: "thread-beta-old",
          model: "",
          titleSource: "codex_state_db",
          sessionType: "main",
          parentThreadId: "",
          agentRole: "",
          agentNickname: ""
        }
      ]
    }
  ];

  const created = manager.create({ provider: "codex", cwd: path.join(alphaRoot, "app"), name: "alpha live" });
  const live = manager.get(created.id);
  live.updatedAt = "2026-04-27T12:00:00.000Z";

  const groups = manager.listProjectGroups();

  assert.deepEqual(groups.map((group) => group.name), ["alpha", "beta"]);
  assert.deepEqual(groups[0].sessions.map((session) => session.name), ["alpha live", "旧 alpha"]);
  assert.deepEqual(groups[1].sessions.map((session) => session.name), ["旧 beta"]);
});

test("listSidebarSnapshot reuses project groups and appends unmatched live sessions", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-04-29T12:00:00.000Z"));
  const { manager, rootDir } = createManager();
  const alphaRoot = path.join(rootDir, "workspace", "alpha");
  const gammaRoot = path.join(rootDir, "workspace", "gamma");
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.mkdirSync(gammaRoot, { recursive: true });

  manager.codexSidebarService.listProjectGroups = () => [
    {
      id: `project:${alphaRoot}`,
      name: "alpha",
      projectRoot: alphaRoot,
      cwd: alphaRoot,
      collapsed: false,
      sessions: [
        {
          id: "history:codex:thread-alpha",
          provider: "codex",
          providerLabel: "Codex",
          cliLabel: "Codex CLI",
          name: "alpha history",
          cwd: alphaRoot,
          kind: "history",
          status: "saved",
          createdAt: "",
          updatedAt: "2026-04-25T10:00:00.000Z",
          exitCode: null,
          autoNamed: false,
          inputPreview: "",
          resumeSessionId: "thread-alpha",
          model: "",
          titleSource: "codex_state_db",
          sessionType: "main",
          parentThreadId: "",
          agentRole: "",
          agentNickname: ""
        }
      ]
    }
  ];

  const groupedLive = manager.get(manager.create({ provider: "codex", cwd: alphaRoot, name: "alpha live" }).id);
  groupedLive.updatedAt = "2026-04-27T10:00:00.000Z";

  const unmatchedLive = manager.get(manager.create({ provider: "codex", cwd: gammaRoot, name: "gamma live" }).id);
  unmatchedLive.updatedAt = "2026-04-28T10:00:00.000Z";

  const snapshot = manager.listSidebarSnapshot();

  assert.equal(snapshot.projectGroups.length, 1);
  assert.deepEqual(snapshot.projectGroups[0].sessions.map((session) => session.name), ["alpha live", "alpha history"]);
  assert.equal(snapshot.sessions.some((session) => session.name === "gamma live"), true);
  assert.equal(snapshot.sessions[0].name, "gamma live");
});

test("listSidebarSnapshot excludes archived sessions while keeping old desktop history", () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-04-29T12:00:00.000Z");
  try {
    const { manager, rootDir } = createManager();
    const alphaRoot = path.join(rootDir, "workspace", "alpha");
    fs.mkdirSync(alphaRoot, { recursive: true });

    manager.codexSidebarService.listProjectGroups = () => [
      {
        id: `project:${alphaRoot}`,
        name: "alpha",
        projectRoot: alphaRoot,
        cwd: alphaRoot,
        collapsed: false,
        sessions: [
          {
            id: "history:codex:thread-recent",
            provider: "codex",
            providerLabel: "Codex",
            cliLabel: "Codex CLI",
            name: "recent history",
            cwd: alphaRoot,
            kind: "history",
            status: "saved",
            createdAt: "",
            updatedAt: "2026-04-25T10:00:00.000Z",
            exitCode: null,
            autoNamed: false,
            inputPreview: "",
            resumeSessionId: "thread-recent",
            model: "",
            titleSource: "codex_state_db",
            sessionType: "main",
            parentThreadId: "",
            agentRole: "",
            agentNickname: ""
          },
          {
            id: "history:codex:thread-old",
            provider: "codex",
            providerLabel: "Codex",
            cliLabel: "Codex CLI",
            name: "old history",
            cwd: alphaRoot,
            kind: "history",
            status: "saved",
            createdAt: "",
            updatedAt: "2026-04-01T10:00:00.000Z",
            exitCode: null,
            autoNamed: false,
            inputPreview: "",
            resumeSessionId: "thread-old",
            model: "",
            titleSource: "codex_state_db",
            sessionType: "main",
            parentThreadId: "",
            agentRole: "",
            agentNickname: ""
          }
        ]
      }
    ];

    const live = manager.get(manager.create({ provider: "codex", cwd: alphaRoot, name: "running live" }).id);
    live.updatedAt = "2026-04-01T10:00:00.000Z";
    live.status = "running";

    const archivedLive = manager.get(manager.create({ provider: "codex", cwd: alphaRoot, name: "archived live" }).id);
    archivedLive.updatedAt = "2026-04-25T10:00:00.000Z";
    archivedLive.status = "archived";

    const snapshot = manager.listSidebarSnapshot();

    assert.deepEqual(snapshot.projectGroups[0].sessions.map((session) => session.name), ["recent history", "old history", "running live"]);
    assert.equal(snapshot.sessions.some((session) => session.name === "old history"), true);
    assert.equal(snapshot.sessions.some((session) => session.name === "running live"), true);
    assert.equal(snapshot.sessions.some((session) => session.name === "archived live"), false);
  } finally {
    Date.now = realNow;
  }
});

test("create rejects unsupported providers", () => {
  const { manager } = createManager();
  assert.throws(() => manager.create({ provider: "unknown-provider" }), /Unsupported session provider/);
});

test("codex session stores composer runtime options without switching app-server for permission overrides", () => {
  const { manager } = createManager();
  const created = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5-mini",
    reasoningEffort: "high",
    permissionMode: "full-access"
  });
  const live = manager.get(created.id);

  assert.equal(created.model, "gpt-5-mini");
  assert.equal(created.reasoningEffort, "high");
  assert.equal(created.permissionMode, "full-access");
  assert.equal(live.runnerMode, "app_server");

  manager.updateSessionOptions(live, {
    model: "gpt-5",
    reasoningEffort: "low",
    permissionMode: "default"
  });

  assert.equal(live.model, "gpt-5");
  assert.equal(live.reasoningEffort, "low");
  assert.equal(live.permissionMode, "default");
  assert.equal(live.runnerMode, "app_server");
});

test("buildCodexJsonExecArgs maps permissionMode to headless sandbox flags", () => {
  const { manager } = createManager({ codexFullAccess: true });

  const defaultSession = manager.get(manager.create({ provider: "codex", cwd: process.cwd() }).id);
  const autoReviewSession = manager.get(
    manager.create({ provider: "codex", cwd: process.cwd(), permissionMode: "auto-review", reasoningEffort: "xhigh" }).id
  );
  const fullAccessSession = manager.get(
    manager.create({ provider: "codex", cwd: process.cwd(), permissionMode: "full-access" }).id
  );

  const defaultArgs = manager.buildCodexJsonExecArgs(defaultSession, "hello");
  const autoReviewArgs = manager.buildCodexJsonExecArgs(autoReviewSession, "hello");
  const fullAccessArgs = manager.buildCodexJsonExecArgs(fullAccessSession, "hello");

  assert.deepEqual(defaultArgs.slice(0, 2), ["--sandbox", "read-only"]);
  assert.ok(!defaultArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(defaultArgs.includes('approval_policy="never"'));
  assert.ok(defaultArgs.includes('approvals_reviewer="user"'));
  assert.ok(autoReviewArgs.includes("--approve-for-me"));
  assert.ok(!autoReviewArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(fullAccessArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(autoReviewArgs.includes('model_reasoning_effort="xhigh"'));
  assert.ok(fullAccessArgs.includes('approvals_reviewer="user"'));
  assert.ok(!autoReviewArgs.includes("--ask-for-approval"));
});

test("buildCodexJsonExecArgs injects selected permission flags for resumed sessions", () => {
  const { manager } = createManager({ codexFullAccess: true });
  const resumedSession = manager.get(
    manager.create({
      provider: "codex",
      cwd: process.cwd(),
      resumeSessionId: "thread-1",
      permissionMode: "auto-review"
    }).id
  );

  const resumedArgs = manager.buildCodexJsonExecArgs(resumedSession, "hello");

  assert.ok(resumedArgs.includes("resume"));
  assert.ok(resumedArgs.includes("--approve-for-me"));
  assert.ok(!resumedArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!resumedArgs.includes("--ask-for-approval"));
  assert.ok(resumedArgs.indexOf("--approve-for-me") < resumedArgs.indexOf("exec"));
  assert.ok(resumedArgs.indexOf("--json") < resumedArgs.indexOf("resume"));
});

test("resumed JSON execution places shared exec options before the resume subcommand", () => {
  const { manager } = createManager({ codexProfile: "work", codexExtraArgs: ["--color", "never"] });
  const args = manager.buildCodexJsonExecArgs({
    resumeSessionId: "thread-1",
    model: "gpt-5.4",
    reasoningEffort: "high",
    permissionMode: "auto-review"
  }, "hello");

  assert.deepEqual(args.slice(0, 2), ["--approve-for-me", "exec"]);
  for (const option of ["--model", "--profile", "--color", "--json", "--skip-git-repo-check"]) {
    assert.ok(args.indexOf(option) > args.indexOf("exec"));
    assert.ok(args.indexOf(option) < args.indexOf("resume"));
  }
  assert.deepEqual(args.slice(-4), ["resume", "--all", "thread-1", "hello"]);
  assert.ok(args.indexOf('model_reasoning_effort="high"') < args.indexOf("resume"));
});

test("JSON fallback includes reasoning only when the selected model has an effort", () => {
  const { manager } = createManager({ codexAppServerEnabled: false });
  const created = manager.create({ reasoningEffort: "high" });
  const live = manager.get(created.id);
  assert.equal(live.runnerMode, "json_exec");
  const args = manager.buildCodexJsonExecArgs(live, "hello");
  assert.ok(args.includes('model_reasoning_effort="high"'));
  const withoutReasoning = manager.buildCodexJsonExecArgs({ ...live, reasoningEffort: "" }, "hello");
  assert.ok(!withoutReasoning.some((arg) => String(arg).includes("model_reasoning_effort")));
  for (const extraArgs of [
    ["-c", 'model_reasoning_effort="high"'],
    ["--config", 'model_reasoning_effort="high"'],
    ['--config=model_reasoning_effort="high"'],
    ['-cmodel_reasoning_effort="high"']
  ]) {
    manager.config.codexExtraArgs = [...extraArgs, "--color", "never"];
    const withoutExtraReasoning = manager.buildCodexJsonExecArgs({ ...live, reasoningEffort: "" }, "hello");
    assert.ok(!withoutExtraReasoning.some((arg) => String(arg).includes("model_reasoning_effort")));
    assert.deepEqual(withoutExtraReasoning.slice(withoutExtraReasoning.indexOf("--color"), withoutExtraReasoning.indexOf("--color") + 2), ["--color", "never"]);
  }
});

test("JSON fallback leaves queued input untouched while another turn is active", () => {
  const { manager } = createManager({ codexAppServerEnabled: false });
  const created = manager.create();
  const live = manager.get(created.id);
  live.turnRunning = true;
  live.currentTurnId = "active-turn";
  manager.updateSessionOptions(live, { permissionMode: "full-access" });
  manager.write(live.id, "queued");

  assert.equal(live.runnerMode, "json_exec");
  assert.equal(live.runningProcess, null);
  assert.equal(live.currentTurnId, "active-turn");
  assert.deepEqual(live.queuedInputs, ["queued"]);
});

test("JSON fallback selected model and effort override extra argument defaults", () => {
  const { manager } = createManager({ codexExtraArgs: ["--model", "old-model", "-c", 'model_reasoning_effort="low"', "--color", "never"] });
  const args = manager.buildCodexJsonExecArgs({ model: "selected-model", reasoningEffort: "xhigh", permissionMode: "default", resumeSessionId: "thread-1" }, "hello");

  assert.deepEqual(args.filter((argument) => argument === "--model"), ["--model"]);
  assert.equal(args[args.indexOf("--model") + 1], "selected-model");
  assert.ok(!args.includes("old-model"));
  assert.ok(!args.includes('model_reasoning_effort="low"'));
  assert.deepEqual(args.filter((arg) => String(arg).includes("model_reasoning_effort")), ['model_reasoning_effort="xhigh"']);
  assert.ok(args.indexOf('model_reasoning_effort="xhigh"') < args.indexOf("resume"));
});

test("JSON fallback refuses permission overrides in extra arguments before queueing input", () => {
  const { manager } = createManager({ codexAppServerEnabled: false });
  const live = manager.get(manager.create().id);
  for (const extraArgs of [
    ["--sandbox", "danger-full-access"], ["--sandbox=danger-full-access"], ["-sdanger-full-access"],
    ["--ask-for-approval", "never"], ["-a", "never"], ["--approve-for-me"], ["--full-auto"],
    ["--dangerously-bypass-approvals-and-sandbox"], ["--yolo"], ["-c", 'sandbox_mode="danger-full-access"'],
    ["--config", 'approval_policy="never"'], ["--config=approvals_reviewer=\"user\""], ["-capprovals_reviewer=\"user\""]
  ]) {
    manager.config.codexExtraArgs = extraArgs;
    assert.throws(() => manager.write(live.id, "hello"), /conflicts with the selected access permissions/);
    assert.deepEqual(live.queuedInputs, []);
    assert.equal(live.turnRunning, false);
    assert.equal(live.currentTurnId, "");
  }
});

test("updating permission during an active app-server turn keeps queued input on the same runner", async () => {
  const { manager, bridge } = createManager();
  let finishFirstTurn;
  const configurations = [];
  bridge.startTurn = (session, text) => {
    configurations.push({ text, model: session.model, effort: session.reasoningEffort, permission: session.permissionMode });
    if (configurations.length === 1) {
      return new Promise((resolve) => { finishFirstTurn = resolve; });
    }
    return Promise.resolve({ turn: { items: [{ type: "agent_message", text: "second reply" }] } });
  };
  const session = manager.create({ model: "gpt-5", reasoningEffort: "low", permissionMode: "default" });
  const live = manager.get(session.id);
  manager.write(session.id, "first");
  const activeControl = live.runnerTurnControl;
  manager.updateSessionOptions(live, { model: "gpt-5-mini", reasoningEffort: "xhigh", permissionMode: "full-access" });
  manager.write(session.id, "second");

  assert.equal(live.runnerMode, "app_server");
  assert.equal(live.runningProcess, null);
  assert.equal(live.runnerTurnControl, activeControl);
  assert.deepEqual(live.queuedInputs, ["second"]);
  assert.equal(configurations.length, 1);
  finishFirstTurn({ turn: { items: [{ type: "agent_message", text: "first reply" }] } });
  await waitForMicrotasks();
  assert.deepEqual(configurations, [
    { text: "first", model: "gpt-5", effort: "low", permission: "default" },
    { text: "second", model: "gpt-5-mini", effort: "xhigh", permission: "full-access" }
  ]);
  assert.equal(live.turnRunning, false);
});

test("summarizeRelevantStderr drops plugin startup warning noise", () => {
  const stderr = [
    "2026-04-28T10:05:12.798623Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters",
    "2026-04-28T10:05:12.798700Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported"
  ].join("\n");

  assert.equal(summarizeRelevantStderr(stderr), "");
});

test("summarizeRelevantStderr keeps real fatal stderr lines", () => {
  const stderr = [
    "2026-04-28T10:05:12.798623Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters",
    "fatal: unexpected EOF while parsing"
  ].join("\n");

  assert.equal(summarizeRelevantStderr(stderr), "fatal: unexpected EOF while parsing");
});

test("json_exec warning-only stderr should not be surfaced as hard failure detail", () => {
  const stderr = [
    "2026-04-28T10:05:12.798623Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters",
    "2026-04-28T10:05:12.798700Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported"
  ].join("\n");

  const concise = summarizeRelevantStderr(stderr);
  const text = concise ? `Codex 执行失败（exit=1）：${concise}` : "Codex 执行未完成（exit=1），请重试。";
  assert.equal(text, "Codex 执行未完成（exit=1），请重试。");
});

test("codex resumed session inherits model, reasoning effort, permission and cwd from thread state when omitted", () => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const workspaceRoot = path.join(rootDir, "workspace", "project-a");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      `
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
        insert into threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
          cli_version, first_user_message, memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
        ) values (
          'thread-resume-config', '', 1714200000, 1714200000, 'vscode', 'openai', '${workspaceRoot}',
          'Resume Config Thread', '{"type":"workspace-write"}', 'on-request', 0, 0, 0, 'main',
          '', '', 'enabled', 'gpt-5.4', 'xhigh', 1714200000000, 1714200000000
        );
      `
    ],
    { stdio: "ignore" }
  );

  const config = createBaseConfig(rootDir, {
    codexStateDbPath: stateDbPath
  });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const created = manager.create({
    provider: "codex",
    resumeSessionId: "thread-resume-config"
  });
  const live = manager.get(created.id);

  assert.equal(created.cwd, workspaceRoot);
  assert.equal(created.model, "gpt-5.4");
  assert.equal(created.reasoningEffort, "xhigh");
  assert.equal(created.permissionMode, "auto-review");
  assert.equal(live.cwd, workspaceRoot);
  assert.equal(live.model, "gpt-5.4");
  assert.equal(live.reasoningEffort, "xhigh");
  assert.equal(live.permissionMode, "auto-review");
  assert.equal(live.runnerMode, "app_server");
});

test("codex resumed sqlite state keeps workspace-write permissions even when approvals are never", () => {
  const rootDir = createTempDir();
  const stateDbPath = path.join(rootDir, ".codex", "state.sqlite");
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  execFileSync("sqlite3", [stateDbPath, "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer);"]);
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, model, reasoning_effort)
       values ('thread-workspace-never', '/tmp/rollout.jsonl', 1, 1, 'vscode', 'openai', '${path.join(rootDir, "workspace", "project-a").replace(/'/g, "''")}', 'workspace never', '{"type":"workspace-write"}', 'never', 'gpt-5.4', 'low');`
    ],
    { stdio: "ignore" }
  );

  const config = createBaseConfig(rootDir, {
    codexStateDbPath: stateDbPath
  });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const created = manager.create({
    provider: "codex",
    resumeSessionId: "thread-workspace-never"
  });
  const live = manager.get(created.id);

  assert.equal(live.permissionMode, "auto-review");
  assert.equal(live.runnerMode, "app_server");
});

test("codex resumed session prefers app_server when permission mode stays default", () => {
  const rootDir = createTempDir();
  const stateDbPath = path.join(rootDir, ".codex", "state.sqlite");
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  execFileSync("sqlite3", [stateDbPath, "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, has_user_event integer not null default 0, archived integer not null default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, cli_version text not null default '', first_user_message text not null default '', agent_nickname text, agent_role text, memory_mode text not null default 'enabled', model text, reasoning_effort text, agent_path text, created_at_ms integer, updated_at_ms integer);"]);
  execFileSync(
    "sqlite3",
    [
      stateDbPath,
      `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, model, reasoning_effort)
       values ('thread-resume-default', '/tmp/rollout.jsonl', 1, 1, 'vscode', 'openai', '${path.join(rootDir, "workspace", "project-a").replace(/'/g, "''")}', 'resume default', '{"type":"read-only","network_access":true}', 'never', 'gpt-5.4', 'low');`
    ],
    { stdio: "ignore" }
  );

  const config = createBaseConfig(rootDir, {
    codexStateDbPath: stateDbPath
  });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const created = manager.create({
    provider: "codex",
    resumeSessionId: "thread-resume-default"
  });
  const live = manager.get(created.id);

  assert.equal(live.permissionMode, "default");
  assert.equal(live.runnerMode, "app_server");
});

test("codex live session auto-renames and streams app-server replies", async () => {
  const { manager, bridge } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd() });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  manager.write(session.id, "整理一个回归测试计划");
  await waitForMicrotasks();

  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].text, "整理一个回归测试计划");
  assert.equal(live.name, "整理一个回归测试计划");
  assert.equal(live.titleSource, "first_user_input");
  assert.match(live.buffer, /reply:整理一个回归测试计划/);
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        (payload.deltas || []).some((delta) => delta.kind === "body_appended" && /reply:整理一个回归测试计划/.test(delta.block?.text || ""))
    )
  );
  assert.equal(live.turnRunning, false);
  assert.equal(live.conversationState.turns[0].assistant.status, "completed");
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        (payload.deltas || []).some(
          (delta) =>
            delta.kind === "conversation_replaced" &&
            delta.conversation?.turns?.some((turn) => turn.assistant?.status === "completed")
        )
    )
  );
});

test("app-server synchronous completed result finalizes the turn without waiting for completion notification", async () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd() });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  manager.write(session.id, "同步完成路径");
  await waitForMicrotasks();

  assert.equal(live.turnRunning, false);
  assert.equal(live.currentTurnId, "");
  assert.equal(live.conversationState.turns.length, 1);
  assert.equal(live.conversationState.turns[0].assistant.status, "completed");
  assert.match(live.conversationState.turns[0].assistant.body[0].text, /reply:同步完成路径/);
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "turn.completed" &&
        payload.status === "completed"
    )
  );
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        (payload.deltas || []).some(
          (delta) =>
            delta.kind === "conversation_replaced" &&
            delta.conversation?.turns?.some((turn) => turn.assistant?.status === "completed")
        )
    )
  );
});

test("codex live session emits a fallback message when app-server returns no visible output", async () => {
  class SilentAppServerBridgeStub extends EventEmitter {
    async startTurn(session, text) {
      session.resumeSessionId ||= "thread-live-empty";
      return {
        turn: {
          items: []
        },
        echoedPrompt: text
      };
    }
  }

  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const manager = new SessionManager(config, { appServerBridge: new SilentAppServerBridgeStub() });
  const session = manager.create({ provider: "codex", cwd: process.cwd() });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  manager.write(session.id, "测试空响应");
  await waitForMicrotasks();

  manager.handleAppServerNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-live-empty",
      turn: {
        id: "turn-empty-1",
        status: "completed",
        error: null
      }
    }
  });

  assert.equal(live.conversationState.turns.length, 1);
  assert.equal(live.conversationState.turns[0].assistant.process.length, 1);
  assert.match(live.conversationState.turns[0].assistant.process[0].summary, /未返回可展示文本/);
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "message_part" &&
        payload.role === "system" &&
        String(payload.part?.text || "").includes("未返回可展示文本")
    )
  );
});

test("app-server failed turn surfaces the real error instead of no-reply fallback", async () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-live-failed" });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  live.currentTurnId = manager.createConversationTurn(live, "触发失败", "2026-04-14T00:00:00.000Z");
  live.turnRunning = true;
  manager.handleAppServerNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-live-failed",
      turn: {
        id: "turn-failed-1",
        status: "failed",
        error: {
          message: "unexpected status 502 Bad Gateway",
          additionalDetails: "Upstream service temporarily unavailable"
        }
      }
    }
  });

  const failedTurn = live.conversationState.turns[0];
  assert.equal(failedTurn.id, "turn-failed-1");
  assert.equal(failedTurn.assistant.status, "failed");
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "message_part" &&
        payload.role === "system" &&
        String(payload.part?.text || "").includes("502 Bad Gateway")
    )
  );
});

test("startTurn in-progress shell does not emit no-reply fallback before notifications finish", async () => {
  class InProgressAppServerBridgeStub extends EventEmitter {
    async startTurn(session) {
      session.resumeSessionId ||= "thread-live-in-progress";
      return {
        turn: {
          id: "turn-in-progress-1",
          items: [],
          status: "inProgress",
          error: null
        }
      };
    }
  }

  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const manager = new SessionManager(config, { appServerBridge: new InProgressAppServerBridgeStub() });
  const session = manager.create({ provider: "codex", cwd: process.cwd() });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  manager.write(session.id, "测试进行中壳子");
  await waitForMicrotasks();

  assert.ok(
    !sentPayloads.some(
      (payload) =>
        payload.type === "message_part" &&
        payload.role === "system" &&
        String(payload.part?.text || "").includes("未返回可展示文本")
    )
  );
});

test("app-server hook notifications emit typed process lifecycle events", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-hook-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试 hook 事件", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "hook/started",
    params: {
      threadId: "thread-hook-events",
      turnId: live.currentTurnId,
      run: {
        id: "hook-1",
        eventName: "userPromptSubmit",
        status: "running"
      }
    }
  });

  manager.handleAppServerNotification({
    method: "hook/completed",
    params: {
      threadId: "thread-hook-events",
      turnId: live.currentTurnId,
      run: {
        id: "hook-1",
        eventName: "userPromptSubmit",
        status: "completed"
      }
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "process.started" && payload.processType === "hook"));
  assert.ok(sentPayloads.some((payload) => payload.type === "process.completed" && payload.processType === "hook"));
});

test("app-server item/completed for non-message items emits typed process completion", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-item-completed-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试 item completed 事件", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-item-completed-events",
      turnId: live.currentTurnId,
      item: {
        type: "functionCallOutput",
        id: "tool-output-1",
        text: "tool output ready"
      }
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "process.completed" && payload.processType === "functioncalloutput"));
});

test("app-server command execution delta notifications emit typed process deltas", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-command-delta-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试命令过程增量", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-command-delta-events",
      turnId: live.currentTurnId,
      itemId: "cmd-1",
      processId: "123",
      delta: "npm run check"
    }
  });

  manager.handleAppServerNotification({
    method: "item/commandExecution/terminalInteraction",
    params: {
      threadId: "thread-command-delta-events",
      turnId: live.currentTurnId,
      itemId: "cmd-1",
      processId: "123",
      stdin: "y"
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "process.delta" && payload.summary === "npm run check"));
  assert.ok(sentPayloads.some((payload) => payload.type === "process.delta" && payload.summary === "y"));
});

test("app-server message delta notifications emit typed message events directly", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-message-delta-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试文本增量", "2026-04-14T00:00:00.000Z");
  const payloadCountBeforeDelta = sentPayloads.length;

  manager.handleAppServerNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-message-delta-events",
      turnId: live.currentTurnId,
      delta: "第一段增量"
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "message.delta" && payload.text === "第一段增量"));
  const streamingDeltaPayload = sentPayloads.find(
    (payload) =>
      payload.type === "conversation.delta" &&
      payload.deltas?.some((delta) => delta.kind === "body_appended" && delta.block?.text === "第一段增量")
  );
  assert.ok(streamingDeltaPayload);
  assert.equal(Object.prototype.hasOwnProperty.call(streamingDeltaPayload, "conversation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(streamingDeltaPayload, "threadSnapshot"), false);
  assert.equal(sentPayloads.slice(payloadCountBeforeDelta).some((payload) => payload.type === "conversation.snapshot"), false);
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        payload.deltas?.some(
          (delta) =>
            delta.kind === "body_appended" &&
            delta.turnId === live.currentTurnId &&
            delta.block?.mergeMode === "stream_append" &&
            delta.block?.text === "第一段增量"
        )
    )
  );
});

test("app-server message delta without a server turn id streams into the active pending turn", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-missing-turn-id-events" });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  live.currentTurnId = manager.createConversationTurn(live, "测试缺 turnId", "2026-04-29T00:00:00.000Z");
  live.turnRunning = true;

  manager.handleAppServerNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-missing-turn-id-events",
      delta: "不能写到 current turn"
    }
  });

  assert.equal(live.conversationState.turns[0].assistant.body[0].text, "不能写到 current turn");
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        payload.deltas?.some(
          (delta) =>
            delta.kind === "body_appended" &&
            delta.turnId === live.currentTurnId &&
            delta.block?.text === "不能写到 current turn"
        )
    )
  );
});

test("app-server turn completion with unaliased server turn id does not finalize the current local turn", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-unaliased-completion" });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const localTurnId = manager.createConversationTurn(live, "本地 pending turn", "2026-04-29T00:00:00.000Z");
  live.currentTurnId = localTurnId;
  live.activePendingTurnId = "";
  live.turnRunning = true;

  manager.handleAppServerNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-unaliased-completion",
      turn: {
        id: "server-turn-not-yet-known",
        status: "completed",
        error: null
      }
    }
  });

  assert.equal(live.currentTurnId, localTurnId);
  assert.equal(live.turnRunning, true);
  assert.equal(live.conversationState.turns.length, 1);
  assert.equal(live.conversationState.turns[0].id, localTurnId);
  assert.equal(live.conversationState.turns[0].assistant.status, "running");
  assert.equal(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        payload.deltas?.some((delta) => delta.kind === "turn_completed" && delta.turnId === localTurnId)
    ),
    false
  );
  assert.ok(sentPayloads.some((payload) => payload.type === "turn.completed" && payload.turnId === "server-turn-not-yet-known"));
});

test("app-server real turn id aliases the active pending local turn before conversation deltas are applied", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-alias-events" });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const localTurnId = manager.createConversationTurn(live, "测试真实 turnId", "2026-04-29T00:00:00.000Z");
  live.turnRunning = true;
  live.currentTurnId = localTurnId;

  manager.handleAppServerNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-alias-events",
      turnId: "server-turn-alias-1",
      delta: "真实 turn 增量"
    }
  });

  assert.equal(live.currentTurnId, "server-turn-alias-1");
  assert.deepEqual(live.conversationState.turns.map((turn) => turn.id), ["server-turn-alias-1"]);
  assert.equal(live.conversationState.turns[0].user.text, "测试真实 turnId");
  assert.ok(
    sentPayloads.some(
      (payload) =>
        payload.type === "conversation.delta" &&
        payload.deltas?.some(
          (delta) =>
            delta.kind === "body_appended" &&
            delta.turnId === "server-turn-alias-1" &&
            delta.clientTurnId === localTurnId &&
            delta.aliasSource === "active-pending-turn" &&
            delta.block?.text === "真实 turn 增量"
        )
    )
  );
});

test("queued codex turns do not rebind currentTurnId before the running turn finishes", async () => {
  class InProgressAppServerBridgeStub extends EventEmitter {
    async startTurn(session) {
      session.resumeSessionId ||= "thread-queue-bind-events";
      return {
        turn: {
          id: "turn-queue-running",
          items: [],
          status: "inProgress",
          error: null
        }
      };
    }
  }

  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const manager = new SessionManager(config, { appServerBridge: new InProgressAppServerBridgeStub() });
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-queue-bind-events" });
  const live = manager.get(session.id);

  manager.write(session.id, "回复：TRACE-03");
  await waitForMicrotasks();
  const firstTurnId = live.currentTurnId;

  // Simulate a second user input arriving while the first turn is still running.
  manager.write(session.id, "回复：TRACE-04");
  const secondTurnId = live.queuedTurnIds[0];

  assert.notEqual(firstTurnId, secondTurnId);
  assert.equal(live.currentTurnId, firstTurnId);
});

test("app-server thread lifecycle notifications emit typed thread and turn events", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-lifecycle-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试线程状态", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "turn/started",
    params: {
      threadId: "thread-lifecycle-events",
      turnId: live.currentTurnId
    }
  });
  manager.handleAppServerNotification({
    method: "thread/status/changed",
    params: {
      threadId: "thread-lifecycle-events",
      status: "running"
    }
  });
  manager.handleAppServerNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-lifecycle-events",
      usage: { inputTokens: 12, outputTokens: 34 }
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "turn.started" && payload.turnId === live.currentTurnId));
  assert.ok(sentPayloads.some((payload) => payload.type === "thread.status.updated" && payload.status === "running"));
  assert.ok(sentPayloads.some((payload) => payload.type === "thread.metrics.updated" && payload.metrics?.outputTokens === 34));
});

test("app-server reasoning notifications emit typed reasoning lifecycle events", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-reasoning-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试 reasoning", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "item/started",
    params: {
      threadId: "thread-reasoning-events",
      turnId: live.currentTurnId,
      item: {
        id: "reasoning-1",
        type: "reasoning"
      }
    }
  });
  manager.handleAppServerNotification({
    method: "item/reasoning/delta",
    params: {
      threadId: "thread-reasoning-events",
      turnId: live.currentTurnId,
      itemId: "reasoning-1",
      delta: "先检查链路"
    }
  });
  manager.handleAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-reasoning-events",
      turnId: live.currentTurnId,
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "先检查链路"
      }
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "reasoning.started" && payload.processId === "reasoning-1"));
  assert.ok(sentPayloads.some((payload) => payload.type === "reasoning.delta" && payload.summary === "先检查链路"));
  assert.ok(sentPayloads.some((payload) => payload.type === "reasoning.completed" && payload.processId === "reasoning-1"));
});

test("app-server commentary agentMessage delta is routed to typed reasoning events", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-commentary-events" });
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  const live = manager.get(session.id);
  live.currentTurnId = manager.createConversationTurn(live, "测试 commentary", "2026-04-14T00:00:00.000Z");

  manager.handleAppServerNotification({
    method: "item/started",
    params: {
      threadId: "thread-commentary-events",
      turnId: live.currentTurnId,
      item: {
        id: "msg-commentary-1",
        type: "agentMessage",
        phase: "commentary"
      }
    }
  });

  manager.handleAppServerNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-commentary-events",
      turnId: live.currentTurnId,
      itemId: "msg-commentary-1",
      delta: "先分析一下"
    }
  });

  assert.ok(sentPayloads.some((payload) => payload.type === "reasoning.started" && payload.processId === "msg-commentary-1"));
  assert.ok(sentPayloads.some((payload) => payload.type === "reasoning.delta" && payload.summary === "先分析一下"));
  assert.equal(sentPayloads.filter((payload) => payload.type === "message.delta").length, 0);
});

test("app-server item/completed ignores userMessage echoes", () => {
  const { manager } = createManager();
  const session = manager.create({ provider: "codex", cwd: process.cwd(), resumeSessionId: "thread-live-user-item" });
  const live = manager.get(session.id);
  const sentPayloads = [];

  manager.attachClient(session.id, {
    send(payload) {
      sentPayloads.push(JSON.parse(payload));
    },
    on() {}
  });

  live.currentTurnId = manager.createConversationTurn(live, "原始用户消息", "2026-04-14T00:00:00.000Z");
  manager.handleAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-live-user-item",
      item: {
        type: "userMessage",
        id: "user-item-1",
        content: [{ type: "text", text: "原始用户消息" }]
      }
    }
  });

  assert.equal(live.conversationState.turns[0].assistant.process.length, 0);
  assert.equal(
    sentPayloads.filter((payload) => payload.type === "message_part" && payload.role === "assistant").length,
    0
  );
});

test("rename persists custom names for resumable sessions", () => {
  const { manager, config } = createManager();
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-rename-1"
  });

  manager.rename(session.id, "新的会话标题");

  const payload = JSON.parse(fs.readFileSync(path.join(config.dataDir, "session-names.json"), "utf8"));
  assert.equal(payload["codex:thread-rename-1"], "新的会话标题");

  const metaPayload = JSON.parse(fs.readFileSync(path.join(config.dataDir, "session-name-meta.json"), "utf8"));
  assert.equal(metaPayload["codex:thread-rename-1"].source, "manual");
});

test("auto-generated first-user-input titles do not persist as custom names", () => {
  const { manager, config } = createManager();
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-auto-title-1"
  });
  const live = manager.get(session.id);

  live.name = "回复：你好";
  live.titleSource = "first_user_input";
  live.autoNamed = false;

  assert.equal(manager.persistSessionName(live), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "session-names.json")), false);
});

test("resumed Codex sessions retain their authoritative desktop title after the first continuation input", () => {
  const { manager, config } = createManager();
  manager.codexSidebarService.getDesktopSnapshot = () => ({ sessions: [
    { resumeSessionId: "thread-resume-title", name: "Desktop title" }
  ] });
  const session = manager.create({ provider: "codex", resumeSessionId: "thread-resume-title" });
  const live = manager.get(session.id);
  assert.equal(session.name, "Desktop title");
  assert.equal(session.titleSource, "codex_state_db");
  assert.equal(session.autoNamed, false);
  manager.maybeAutoRename(live, "a completely different continuation prompt\n");
  assert.equal(manager.serialize(live).name, "Desktop title");
  assert.equal(fs.existsSync(path.join(config.dataDir, "session-names.json")), false);
  manager.shutdown();
});

test("a resumed Codex session without desktop metadata does not auto-name from a later prompt", () => {
  const { manager } = createManager();
  manager.codexSidebarService.getDesktopSnapshot = () => null;
  const session = manager.create({ provider: "codex", resumeSessionId: "thread-missing-title" });
  const live = manager.get(session.id);
  manager.maybeAutoRename(live, "do not replace an existing thread title\n");
  assert.equal(manager.serialize(live).name, "");
  assert.equal(live.autoNamed, false);
  assert.equal(live.titleSource, "codex_state_db");
  manager.shutdown();
});

test("an explicit resumed title remains explicit and new Codex sessions still auto-name", () => {
  const { manager } = createManager();
  manager.codexSidebarService.getDesktopSnapshot = () => ({ sessions: [
    { resumeSessionId: "thread-explicit", name: "Desktop title" }
  ] });
  const resumed = manager.create({ provider: "codex", resumeSessionId: "thread-explicit", name: "Explicit title" });
  assert.equal(resumed.name, "Explicit title");
  assert.equal(resumed.titleSource, "user_provided");
  assert.equal(resumed.autoNamed, false);
  const fresh = manager.create({ provider: "codex" });
  const live = manager.get(fresh.id);
  assert.equal(live.autoNamed, true);
  manager.maybeAutoRename(live, "brand new first prompt\n");
  assert.equal(manager.serialize(live).name, "brand new first prompt");
  manager.shutdown();
});

test("findRunningLiveSessionByResume returns the latest running live session", async () => {
  const { manager } = createManager();
  const first = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resume-1"
  });
  manager.get(first.id).status = "exited";
  const second = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resume-1"
  });
  await waitForMicrotasks();

  const reusable = manager.findRunningLiveSessionByResume("codex", "thread-resume-1");
  assert.ok(reusable);
  assert.equal(reusable.id, second.id);
});

test("historical sessions can be listed, archived, restored and deleted", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const codexArchivedSessionsDir = path.join(rootDir, ".codex", "archived_sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir, codexArchivedSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(rootDir, ".codex", "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-h1", thread_name: "Indexed Codex Thread" }]);

  const historyFile = path.join(codexArchivedSessionsDir, "project-a", "thread-h1.jsonl");
  writeJsonl(historyFile, [
    {
      type: "session_meta",
      payload: {
        id: "thread-h1",
        cwd: rootDir,
        thread_name: "Fallback Title"
      },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "用户：帮我整理发布脚本"
      },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "final_answer",
        message: "当然，先把入口拆清楚。"
      },
      timestamp: "2026-04-13T10:00:02.000Z"
    }
  ]);

  const historySessions = manager.listHistoricalSessions();
  assert.equal(historySessions.length, 1);
  assert.equal(historySessions[0].name, "Indexed Codex Thread");
  assert.equal(historySessions[0].resumeSessionId, "thread-h1");

  const historicalMessages = manager.getHistoricalMessages("codex", "thread-h1");
  assert.equal(historicalMessages.messages.length, 2);
  assert.equal(historicalMessages.turns.length, 1);
  assert.equal(historicalMessages.backgroundAgents.length, 0);
  assert.equal(historicalMessages.conversation.turns.length, 1);
  assert.equal(historicalMessages.threadSnapshot.turns.length, 1);
  assert.equal(historicalMessages.conversation.turns[0].id, historicalMessages.threadSnapshot.turns[0].id);

  const archived = manager.archiveHistoricalSession("codex", "thread-h1");
  assert.equal(archived.kind, "archived");
  const restored = manager.restoreHistoricalSession("codex", "thread-h1");
  assert.equal(restored.kind, "history");

  assert.equal(manager.deleteHistoricalSession("codex", "thread-h1"), true);
  assert.equal(fs.existsSync(historyFile), false);
});

test("codex historical list reflects sessions without filtering subagent or non-indexed items", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const codexArchivedSessionsDir = path.join(rootDir, ".codex", "archived_sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir, codexArchivedSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-main-1", thread_name: "主线程标题" },
    { id: "thread-subagent-1", thread_name: "子线程标题" }
  ]);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-main-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-main-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "主线程问题" },
      timestamp: "2026-04-24T10:00:01.000Z"
    }
  ]);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-subagent-1.jsonl"), [
    {
      type: "session_meta",
      payload: {
        id: "thread-subagent-1",
        cwd: rootDir,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "thread-main-1",
              agent_nickname: "Worker",
              agent_role: "worker"
            }
          }
        }
      },
      timestamp: "2026-04-24T10:00:02.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "子线程问题" },
      timestamp: "2026-04-24T10:00:03.000Z"
    }
  ]);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-live-only.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-live-only", cwd: rootDir },
      timestamp: "2026-04-24T10:00:04.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "live 目录里的线程不该出现在历史列表" },
      timestamp: "2026-04-24T10:00:05.000Z"
    }
  ]);

  const sessions = manager.listHistoricalSessions();

  assert.deepEqual(
    [...sessions.map((session) => session.resumeSessionId)].sort(),
    ["thread-live-only", "thread-main-1", "thread-subagent-1"]
  );
  assert.equal(sessions.find((session) => session.resumeSessionId === "thread-main-1")?.name, "主线程标题");
  assert.equal(sessions.find((session) => session.resumeSessionId === "thread-subagent-1")?.name, "子线程标题");
  assert.equal(sessions.find((session) => session.resumeSessionId === "thread-live-only")?.name, "");
});

test("codex historical list includes both sessions and archived sources when present", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const codexArchivedSessionsDir = path.join(rootDir, ".codex", "archived_sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir, codexArchivedSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-old-1", thread_name: "旧线程", updated_at: "2026-04-24T10:00:00.000Z" },
    { id: "thread-new-1", thread_name: "新线程", updated_at: "2026-04-24T11:00:00.000Z" }
  ]);

  writeJsonl(path.join(codexArchivedSessionsDir, "2026", "04", "24", "thread-old-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-old-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "旧线程问题" },
      timestamp: "2026-04-24T10:00:01.000Z"
    }
  ]);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-new-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-new-1", cwd: rootDir },
      timestamp: "2026-04-24T11:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "新线程问题" },
      timestamp: "2026-04-24T11:00:01.000Z"
    }
  ]);

  const sessions = manager.listHistoricalSessions();

  assert.deepEqual(sessions.map((session) => session.resumeSessionId), ["thread-new-1", "thread-old-1"]);
  assert.equal(sessions[0].name, "新线程");
  assert.equal(sessions[1].name, "旧线程");
});

test("codex historical cache refreshes when a nested session file is added", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-before-1", thread_name: "缓存前线程" },
    { id: "thread-after-1", thread_name: "缓存后线程" }
  ]);
  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-before-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-before-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    }
  ]);

  assert.equal(manager.listHistoricalSessions().length, 1);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "27", "thread-after-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-after-1", cwd: rootDir },
      timestamp: "2026-04-27T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "新建线程问题" },
      timestamp: "2026-04-27T10:00:01.000Z"
    }
  ]);

  const sessions = manager.listHistoricalSessions();
  assert.deepEqual(
    [...sessions.map((session) => session.resumeSessionId)].sort(),
    ["thread-after-1", "thread-before-1"]
  );
  assert.equal(manager.getHistoricalMessages("codex", "thread-after-1").messages.length, 1);
});

test("codex historical list keeps stale sessions instead of applying a recency cutoff", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-fresh-1", thread_name: "近期线程", updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
    { id: "thread-stale-1", thread_name: "过期线程", updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() }
  ]);

  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-fresh-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-fresh-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    }
  ]);
  writeJsonl(path.join(codexSessionsDir, "2026", "04", "24", "thread-stale-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-stale-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    }
  ]);

  const sessions = manager.listHistoricalSessions();
  assert.deepEqual(sessions.map((session) => session.resumeSessionId), ["thread-fresh-1", "thread-stale-1"]);
});

test("legacy low-signal custom names do not override real historical titles", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const codexArchivedSessionsDir = path.join(rootDir, ".codex", "archived_sessions");
  const dataDir = path.join(rootDir, "data");
  const config = createBaseConfig(rootDir, { codexSessionsDir, codexArchivedSessionsDir, dataDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  fs.writeFileSync(
    path.join(dataDir, "session-names.json"),
    JSON.stringify(
      {
        "codex:thread-legacy-name-1": "回复：你好"
      },
      null,
      2
    ),
    "utf8"
  );

  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-legacy-name-1", thread_name: "发现一个标题错位问题，帮我确认真实历史。", updated_at: "2026-04-13T10:00:01.000Z" }
  ]);

  const historyFile = path.join(codexArchivedSessionsDir, "project-a", "thread-legacy-name-1.jsonl");
  writeJsonl(historyFile, [
    {
      type: "session_meta",
      payload: {
        id: "thread-legacy-name-1",
        cwd: rootDir
      },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "发现一个标题错位问题，帮我确认真实历史。"
      },
      timestamp: "2026-04-13T10:00:01.000Z"
    }
  ]);

  const reloadedManager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });
  const historySessions = reloadedManager.listHistoricalSessions();

  assert.equal(historySessions.length, 1);
  assert.equal(historySessions[0].name, "发现一个标题错位问题，帮我确认真实历史。");
  assert.equal(historySessions[0].titleSource, "codex_session_index");
});

test("codex list view prefers canonical thread titles over local custom names", () => {
  const rootDir = createTempDir();
  const codexArchivedSessionsDir = path.join(rootDir, ".codex", "archived_sessions");
  const dataDir = path.join(rootDir, "data");
  const config = createBaseConfig(rootDir, { codexArchivedSessionsDir, dataDir });

  fs.writeFileSync(
    path.join(dataDir, "session-names.json"),
    JSON.stringify(
      {
        "codex:thread-canonical-1": "我自己改过的标题"
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, "session-name-meta.json"),
    JSON.stringify(
      {
        "codex:thread-canonical-1": { source: "manual", updatedAt: "2026-04-24T10:00:00.000Z" }
      },
      null,
      2
    ),
    "utf8"
  );
  writeJsonl(path.join(rootDir, ".codex", "session_index.jsonl"), [
    { id: "thread-canonical-1", thread_name: "Codex 真标题", updated_at: "2026-04-24T10:00:00.000Z" }
  ]);
  writeJsonl(path.join(codexArchivedSessionsDir, "2026", "04", "24", "thread-canonical-1.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-canonical-1", cwd: rootDir },
      timestamp: "2026-04-24T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "随便一条问题" },
      timestamp: "2026-04-24T10:00:01.000Z"
    }
  ]);

  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });
  const sessions = manager.listHistoricalSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "Codex 真标题");
  assert.equal(sessions[0].titleSource, "codex_session_index");
});

test("conversation history seeding does not leak turns between empty and non-empty sessions", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [
    { id: "thread-full", thread_name: "Full Thread" },
    { id: "thread-empty", thread_name: "Empty Thread" }
  ]);

  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-full.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-full", cwd: rootDir, thread_name: "Full Thread" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "用户：hello" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "assistant:world" },
      timestamp: "2026-04-13T10:00:02.000Z"
    }
  ]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-empty.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-empty", cwd: rootDir, thread_name: "Empty Thread" },
      timestamp: "2026-04-13T11:00:00.000Z"
    }
  ]);

  const fullSession = manager.create({ provider: "codex", cwd: rootDir, resumeSessionId: "thread-full" });
  const emptySession = manager.create({ provider: "codex", cwd: rootDir, resumeSessionId: "thread-empty" });

  const fullState = manager.get(fullSession.id).conversationState;
  const emptyState = manager.get(emptySession.id).conversationState;

  assert.ok(fullState.turns.length > 0);
  assert.ok(fullState.version > 0);
  assert.equal(fullState.threadId, "thread-full");
  assert.equal(emptyState.turns.length, 0);
  assert.equal(emptyState.version, 0);
  assert.equal(emptyState.threadId, "thread-empty");
});

test("listAll keeps both live and persisted entries for the same resumable thread", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-shadow", thread_name: "Historical Shadow" }]);
  writeJsonl(path.join(codexSessionsDir, "project-b", "thread-shadow.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-shadow", cwd: rootDir, thread_name: "Historical Shadow" },
      timestamp: "2026-04-13T11:00:00.000Z"
    }
  ]);

  manager.create({ provider: "codex", cwd: rootDir, resumeSessionId: "thread-shadow", name: "Live Shadow" });
  const all = manager.listAll().filter((item) => String(item.resumeSessionId || "") === "thread-shadow");
  assert.equal(all.length, 2);
  assert.deepEqual(
    [...all.map((item) => item.kind)].sort(),
    ["history", "live"]
  );
});

test("codex sidebar keeps all non-archived threads and empty saved projects", () => {
  const rootDir = createTempDir();
  const codexDir = path.join(rootDir, ".codex");
  const globalStatePath = path.join(codexDir, ".codex-global-state.json");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  fs.mkdirSync(codexDir, { recursive: true });

  fs.writeFileSync(
    globalStatePath,
    JSON.stringify(
      {
        "project-order": [
          "/workspace/project-a",
          "/workspace/project-b",
          "/workspace/project-c",
          "/workspace/project-d"
        ],
        "electron-saved-workspace-roots": [
          "/workspace/project-a",
          "/workspace/project-b",
          "/workspace/project-c",
          "/workspace/project-d"
        ],
        "electron-persisted-atom-state": {
          "sidebar-collapsed-groups": {
            "/workspace/project-b": true
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const oldSec = nowSec - 9 * 24 * 60 * 60;
  const recentSec = nowSec - 2 * 60 * 60;

  const sqliteInit = `
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
    insert into threads values
    ('thread-front-1','','${recentSec}','${recentSec}','vscode','openai','/workspace/project-a','回复在吗','danger','full',0,1,0,null,null,null,null,'','','','','enabled',null,null,null,null,null),
    ('thread-front-sub','','${recentSec}','${recentSec}','{"subagent":{"thread_spawn":{"parent_thread_id":"thread-front-1"}}}','openai','/workspace/project-a','子线程','danger','full',0,1,0,null,null,null,null,'','','','','enabled',null,null,null,null,null),
    ('thread-sub2-1','','${recentSec}','${recentSec}','vscode','openai','/workspace/project-d','改为透传','danger','full',0,1,0,null,null,null,null,'','','','','enabled',null,null,null,null,null),
    ('thread-auto-old','','${oldSec}','${oldSec}','vscode','openai','/workspace/project-b','旧 project-b 线程','danger','full',0,1,0,null,null,null,null,'','','','','enabled',null,null,null,null,null),
    ('thread-ai-old','','${oldSec}','${oldSec}','vscode','openai','/workspace/project-c','旧 ai 线程','danger','full',0,1,0,null,null,null,null,'','','','','enabled',null,null,null,null,null);
  `;

  execFileSync("sqlite3", [stateDbPath, sqliteInit], { stdio: "ignore" });

  const service = new CodexSidebarService({
    home: rootDir,
    codexGlobalStatePath: globalStatePath,
    codexStateDbPath: stateDbPath
  });
  const groups = service.listProjectGroups();

  assert.deepEqual(groups.map((group) => group.name), [
    "project-a",
    "project-b",
    "project-c",
    "project-d"
  ]);
  assert.equal(groups[0].sessions.length, 1);
  assert.deepEqual(
    groups[0].sessions.map((session) => session.name),
    ["回复在吗"]
  );
  assert.deepEqual(groups[1].sessions.map((session) => session.name), ["旧 project-b 线程"]);
  assert.equal(groups[1].collapsed, true);
  assert.deepEqual(groups[2].sessions.map((session) => session.name), ["旧 ai 线程"]);
  assert.equal(groups[3].sessions.length, 1);
  assert.equal(groups[3].sessions[0].name, "改为透传");
});

test("codex sidebar includes desktop CLI and exec sources across branches while excluding child threads", () => {
  const rootDir = createTempDir();
  const workspaceRoot = path.join(rootDir, "workspace", "codex-cc-web-terminal");
  const codexDir = path.join(rootDir, ".codex");
  const globalStatePath = path.join(codexDir, ".codex-global-state.json");
  const stateDbPath = path.join(codexDir, "state_5.sqlite");
  const nowSeconds = Math.floor(Date.now() / 1000);
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/conversation-sync-fix"], { cwd: workspaceRoot, stdio: "ignore" });

  fs.writeFileSync(
    globalStatePath,
    JSON.stringify(
      {
        "project-order": [workspaceRoot],
        "electron-saved-workspace-roots": [workspaceRoot]
      },
      null,
      2
    ),
    "utf8"
  );

  const sqliteInit = `
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
    insert into threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_branch,
      cli_version, first_user_message, agent_nickname, agent_role, memory_mode
    ) values
    ('thread-current-1','',${nowSeconds - 200},${nowSeconds - 200},'vscode','openai','${workspaceRoot}','branch session A','danger','full',0,0,0,'feature/conversation-sync-fix','','','','','enabled'),
    ('thread-current-2','',${nowSeconds - 100},${nowSeconds - 100},'vscode','openai','${workspaceRoot}','branch session B','danger','full',0,0,0,'feature/conversation-sync-fix','','','','','enabled'),
    ('thread-main','',${nowSeconds - 300},${nowSeconds - 300},'vscode','openai','${workspaceRoot}','main old session','danger','full',0,0,0,'main','','','','','enabled'),
    ('thread-subagent','',${nowSeconds - 50},${nowSeconds - 50},'subagent','openai','${workspaceRoot}','subagent session','danger','full',0,0,0,'feature/conversation-sync-fix','','','','worker','enabled'),
    ('thread-exec','',${nowSeconds - 25},${nowSeconds - 25},'exec','openai','${workspaceRoot}','exec session','danger','full',0,0,0,'feature/conversation-sync-fix','','','','','enabled');
  `;
  execFileSync("sqlite3", [stateDbPath, sqliteInit], { stdio: "ignore" });

  const service = new CodexSidebarService({
    home: rootDir,
    codexGlobalStatePath: globalStatePath,
    codexStateDbPath: stateDbPath
  });
  const groups = service.listProjectGroups();

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].sessions.map((session) => session.name),
    ["exec session", "branch session B", "branch session A", "main old session"]
  );
});

test("historical payload does not get overridden by a poorer live conversation with a higher version", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-history-better", thread_name: "History Better" }]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-history-better.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-history-better", cwd: rootDir, thread_name: "History Better" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "用户：最后一轮" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "思考过程" },
      timestamp: "2026-04-13T10:00:02.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "最终回答" },
      timestamp: "2026-04-13T10:00:03.000Z"
    }
  ]);

  const liveSession = manager.create({ provider: "codex", cwd: rootDir, resumeSessionId: "thread-history-better" });
  manager.get(liveSession.id).conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-history-better",
    version: 99,
    turns: [
      {
        id: "stale-turn",
        user: { id: "u1", text: "用户：最后一轮", ts: "2026-04-13T10:00:01.000Z" },
        assistant: {
          body: [{ id: "b1", kind: "markdown", text: "最终回答", payload: { phase: "completed" }, ts: "2026-04-13T10:00:03.000Z" }],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:00:01.000Z",
          finishedAt: "2026-04-13T10:00:03.000Z"
        }
      }
    ]
  });

  const payload = manager.getHistoricalMessages("codex", "thread-history-better");
  const lastTurn = payload.turns.at(-1);
  assert.equal(lastTurn.assistant.process.length, 1);
  assert.equal(lastTurn.assistant.body.length, 1);
  assert.match(lastTurn.assistant.process[0].summary, /思考过程/);
});

test("historical payload ignores live-only turns from an attached resumable live session", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-history-isolated", thread_name: "History Isolated" }]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-history-isolated.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-history-isolated", cwd: rootDir, thread_name: "History Isolated" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "用户：历史问题" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "历史答案" },
      timestamp: "2026-04-13T10:00:02.000Z"
    }
  ]);

  const liveSession = manager.create({
    provider: "codex",
    cwd: rootDir,
    resumeSessionId: "thread-history-isolated"
  });
  manager.get(liveSession.id).conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-history-isolated",
    version: 10,
    turns: [
      {
        id: "history-turn",
        user: { id: "user-history", text: "用户：历史问题", ts: "2026-04-13T10:00:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-history",
              kind: "markdown",
              text: "历史答案",
              payload: {},
              ts: "2026-04-13T10:00:02.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:00:01.000Z",
          finishedAt: "2026-04-13T10:00:02.000Z"
        }
      },
      {
        id: "live-only-turn",
        user: { id: "user-live", text: "你好", ts: "2026-04-13T10:01:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-live",
              kind: "markdown",
              text: "你好，直接说需求。",
              payload: {},
              ts: "2026-04-13T10:01:02.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:01:01.000Z",
          finishedAt: "2026-04-13T10:01:02.000Z"
        }
      }
    ]
  });

  const payload = manager.getHistoricalMessages("codex", "thread-history-isolated");
  assert.equal(payload.turns.length, 1);
  assert.match(payload.turns[0].user.text, /历史问题/);
  assert.equal(payload.turns[0].assistant.body.length, 1);
  assert.equal(payload.turns[0].assistant.body[0].text, "历史答案");
  assert.equal(
    payload.turns.some((turn) => String(turn.user?.text || "").includes("你好")),
    false
  );
});

test("live history continuation returns resumable live-only turns without mutating pure historical payload", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-single-source", thread_name: "Single Source Thread" }]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-single-source.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-single-source", cwd: rootDir, thread_name: "Single Source Thread" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "历史里的问题" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "历史里的答案" },
      timestamp: "2026-04-13T10:00:02.000Z"
    }
  ]);

  const liveSession = manager.create({
    provider: "codex",
    cwd: rootDir,
    resumeSessionId: "thread-single-source"
  });
  manager.get(liveSession.id).conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-single-source",
    version: 11,
    turns: [
      {
        id: "history-turn",
        user: { id: "user-history", text: "历史里的问题", ts: "2026-04-13T10:00:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-history",
              kind: "markdown",
              text: "历史里的答案",
              payload: {},
              ts: "2026-04-13T10:00:02.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:00:01.000Z",
          finishedAt: "2026-04-13T10:00:02.000Z"
        }
      },
      {
        id: "live-turn",
        user: { id: "user-live", text: "继续追问", ts: "2026-04-13T10:01:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-live",
              kind: "markdown",
              text: "这是继续对话的新答案",
              payload: {},
              ts: "2026-04-13T10:01:02.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:01:01.000Z",
          finishedAt: "2026-04-13T10:01:02.000Z"
        }
      }
    ]
  });

  manager.get(liveSession.id).threadSnapshot = deriveThreadSnapshotFromConversationState(
    manager.get(liveSession.id).conversationState,
    {
      threadId: "thread-single-source",
      metadata: { name: "Single Source Thread", cwd: rootDir, source: "codex" }
    }
  );

  const historicalPayload = manager.getHistoricalMessages("codex", "thread-single-source");
  const continuation = manager.getThreadContinuationRuntime("codex", "thread-single-source");

  assert.equal(historicalPayload.turns.length, 1);
  assert.equal(historicalPayload.turns[0].assistant.body[0].text, "历史里的答案");
  assert.ok(continuation);
  assert.equal(continuation.threadSnapshot.turns.length, 2);
  assert.equal(
    continuation.threadSnapshot.turns.some((turn) =>
      Array.isArray(turn?.items) && turn.items.some((item) => String(item?.text || "").includes("这是继续对话的新答案"))
    ),
    true
  );
});

test("legacy historical thread stays stable while same-thread continuation appends only the new live turn", () => {
  const rootDir = createTempDir();
  const codexSessionsDir = path.join(rootDir, ".codex", "sessions");
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-legacy-continuation", thread_name: "Legacy Continuation Thread" }]);
  writeJsonl(path.join(codexSessionsDir, "project-a", "thread-legacy-continuation.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "thread-legacy-continuation", cwd: rootDir, thread_name: "Legacy Continuation Thread" },
      timestamp: "2026-04-13T10:00:00.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "历史里的问题" },
      timestamp: "2026-04-13T10:00:01.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "先分析一下" },
      timestamp: "2026-04-13T10:00:02.000Z"
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "历史里的答案" },
      timestamp: "2026-04-13T10:00:03.000Z"
    }
  ]);

  const liveSession = manager.create({
    provider: "codex",
    cwd: rootDir,
    resumeSessionId: "thread-legacy-continuation"
  });
  manager.get(liveSession.id).conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-legacy-continuation",
    version: 7,
    turns: [
      {
        id: "legacy-history-turn",
        user: { id: "user-history", text: "历史里的问题", ts: "2026-04-13T10:00:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-history",
              kind: "markdown",
              text: "历史里的答案",
              payload: {},
              ts: "2026-04-13T10:00:03.000Z"
            }
          ],
          process: [
            {
              id: "proc-history",
              type: "reasoning",
              title: "分析",
              summary: "先分析一下",
              content: "",
              payload: {},
              phase: "completed",
              ts: "2026-04-13T10:00:02.000Z"
            }
          ],
          status: "completed",
          startedAt: "2026-04-13T10:00:01.000Z",
          finishedAt: "2026-04-13T10:00:03.000Z"
        }
      },
      {
        id: "live-turn-2",
        user: { id: "user-live", text: "继续追问", ts: "2026-04-13T10:01:01.000Z" },
        assistant: {
          body: [
            {
              id: "body-live",
              kind: "markdown",
              text: "这是继续对话的新答案",
              payload: {},
              ts: "2026-04-13T10:01:02.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-13T10:01:01.000Z",
          finishedAt: "2026-04-13T10:01:02.000Z"
        }
      }
    ]
  });

  manager.get(liveSession.id).threadSnapshot = deriveThreadSnapshotFromConversationState(
    manager.get(liveSession.id).conversationState,
    {
      threadId: "thread-legacy-continuation",
      metadata: { name: "Legacy Continuation Thread", cwd: rootDir, source: "codex" }
    }
  );

  const historicalPayload = manager.getHistoricalMessages("codex", "thread-legacy-continuation");
  const continuation = manager.getThreadContinuationRuntime("codex", "thread-legacy-continuation");

  assert.equal(
    historicalPayload.turns.some((turn) => String(turn.user?.text || "").includes("继续追问")),
    false
  );
  assert.ok(continuation);
  assert.equal(
    continuation.threadSnapshot.turns.some((turn) =>
      Array.isArray(turn?.items) && turn.items.some((item) => String(item?.text || "").includes("继续追问"))
    ),
    true
  );
});

test("historical mutation APIs throw clear errors for missing sessions", () => {
  const { manager } = createManager();
  assert.throws(
    () => manager.archiveHistoricalSession("codex", "missing-session"),
    /Historical session not found/
  );
  assert.throws(
    () => manager.restoreHistoricalSession("codex", "missing-session"),
    /Archived session not found/
  );
  assert.throws(
    () => manager.deleteHistoricalSession("codex", "missing-session"),
    /Historical session not found/
  );
});

test("live continuation lookup does not require a persisted historical session", () => {
  const { manager } = createManager();
  const liveSession = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-live-only"
  });
  manager.get(liveSession.id).conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-live-only",
    version: 1,
    turns: [
      {
        id: "live-turn-only",
        user: { id: "user-live-only", text: "只有 live 的问题", ts: "2026-04-22T00:00:00.000Z" },
        assistant: {
          body: [
            {
              id: "body-live-only",
              kind: "markdown",
              text: "只有 live 的回答",
              payload: {},
              ts: "2026-04-22T00:00:01.000Z"
            }
          ],
          process: [],
          status: "completed",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:01.000Z"
        }
      }
    ]
  });
  manager.get(liveSession.id).threadSnapshot = deriveThreadSnapshotFromConversationState(
    manager.get(liveSession.id).conversationState,
    {
      threadId: "thread-live-only",
      metadata: { name: "Live Only Thread", cwd: process.cwd(), source: "codex" }
    }
  );

  const bundle = manager.getThreadSnapshotBundle("codex", "thread-live-only");
  const continuation = manager.getThreadContinuationRuntime("codex", "thread-live-only");

  assert.equal(bundle.threadSnapshot, null);
  assert.ok(continuation);
  assert.equal(continuation.threadSnapshot.threadId, "thread-live-only");
  assert.equal(
    continuation.threadSnapshot.turns.some((turn) =>
      Array.isArray(turn?.items) && turn.items.some((item) => String(item?.text || "").includes("只有 live 的回答"))
    ),
    true
  );
});

test("history resync broadcasts when resumed-thread snapshot content advances without version bump", async () => {
  const { manager } = createManager();
  const liveSessionMeta = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resync-1"
  });
  const liveSession = manager.get(liveSessionMeta.id);
  liveSession.threadSnapshot = {
    threadId: "thread-resync-1",
    version: 5,
    lastEventSeq: 10,
    turns: [
      {
        id: "turn-resync-1",
        status: "running",
        items: [{ id: "item-1", kind: "AgentMessage", text: "旧内容" }]
      }
    ]
  };

  manager.historyService.getHistoricalMessages = () => ({
    threadSnapshot: {
      threadId: "thread-resync-1",
      version: 5,
      lastEventSeq: 10,
      turns: [
        {
          id: "turn-resync-1",
          status: "running",
          items: [{ id: "item-1", kind: "AgentMessage", text: "旧内容\n新内容" }]
        }
      ]
    },
    liveOverlay: null
  });

  const snapshots = [];
  manager.broadcastConversationSnapshot = (session) => {
    snapshots.push(session.threadSnapshot);
  };

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    handler();
    return { unref() {} };
  };
  try {
    manager.scheduleConversationHistoryResync(liveSession, { attempts: 1, delayMs: 1 });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.equal(snapshots.length, 1);
  assert.match(String(snapshots[0]?.turns?.[0]?.items?.[0]?.text || ""), /新内容/);
});

test("history resync does not roll back a newer live snapshot with an older historical snapshot", async () => {
  const { manager } = createManager();
  const liveSessionMeta = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resync-stale-1"
  });
  const liveSession = manager.get(liveSessionMeta.id);
  liveSession.threadSnapshot = {
    threadId: "thread-resync-stale-1",
    version: 9,
    lastEventSeq: 20,
    updatedAt: "2026-04-29T05:54:53.977Z",
    turns: [
      {
        id: "turn-latest-1",
        status: "completed",
        items: [
          { id: "user-1", kind: "UserMessage", text: "回复：5555" },
          { id: "agent-1", kind: "AgentMessage", text: "5555" }
        ]
      }
    ]
  };

  manager.historyService.getHistoricalMessages = () => ({
    threadSnapshot: {
      threadId: "thread-resync-stale-1",
      version: 8,
      lastEventSeq: 19,
      updatedAt: "2026-04-29T05:53:31.274Z",
      turns: []
    },
    liveOverlay: null
  });

  const snapshots = [];
  manager.broadcastConversationSnapshot = (session) => {
    snapshots.push(session.threadSnapshot);
  };

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    handler();
    return { unref() {} };
  };
  try {
    manager.scheduleConversationHistoryResync(liveSession, { attempts: 1, delayMs: 1 });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.equal(snapshots.length, 0);
  assert.equal(liveSession.threadSnapshot.version, 9);
  assert.equal(liveSession.threadSnapshot.turns.length, 1);
  assert.equal(liveSession.threadSnapshot.turns[0].items[1].text, "5555");
});

test("history resync does not drop the current live turn when historical snapshot has not caught up yet", async () => {
  const { manager } = createManager();
  const liveSessionMeta = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resync-active-1"
  });
  const liveSession = manager.get(liveSessionMeta.id);
  liveSession.currentTurnId = "turn-active-1";
  liveSession.conversationState = createConversationState({
    sessionId: liveSession.id,
    threadId: "thread-resync-active-1",
    version: 12,
    status: "running",
    activeTurnId: "turn-active-1",
    turns: [
      {
        id: "turn-active-1",
        user: { id: "u1", text: "看一下这个接口怎么改", ts: "2026-04-29T06:00:48.136Z" },
        assistant: {
          status: "running",
          body: [{ id: "body-1", kind: "markdown", text: "先按接口说明改这一处。", payload: {}, ts: "2026-04-29T06:01:00.685Z" }],
          process: []
        }
      }
    ]
  });
  liveSession.threadSnapshot = deriveThreadSnapshotFromConversationState(liveSession.conversationState, {
    threadId: "thread-resync-active-1",
    metadata: { name: "Active Thread", cwd: process.cwd(), source: "codex" }
  });
  liveSession.threadSnapshot.updatedAt = "2026-04-29T06:01:00.687Z";
  liveSession.threadSnapshot.activeTurnId = "turn-active-1";

  manager.historyService.getHistoricalMessages = () => ({
    threadSnapshot: {
      threadId: "thread-resync-active-1",
      version: 13,
      lastEventSeq: Number(liveSession.threadSnapshot.lastEventSeq || 0) + 1,
      updatedAt: "2026-04-29T06:01:11.464Z",
      activeTurnId: "",
      turns: []
    },
    liveOverlay: null
  });

  const snapshots = [];
  manager.broadcastConversationSnapshot = (session) => {
    snapshots.push(session.threadSnapshot);
  };

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    handler();
    return { unref() {} };
  };
  try {
    manager.scheduleConversationHistoryResync(liveSession, { attempts: 1, delayMs: 1 });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.equal(snapshots.length, 0);
  assert.equal(liveSession.threadSnapshot.activeTurnId, "turn-active-1");
  assert.equal(liveSession.threadSnapshot.turns.length, 1);
  assert.equal(liveSession.threadSnapshot.turns[0].items[0].text, "看一下这个接口怎么改");
});

test("history resync does not replace a protected live turn with an empty historical shell of the same thread", async () => {
  const { manager } = createManager();
  const liveSessionMeta = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    resumeSessionId: "thread-resync-protected-shell-1"
  });
  const liveSession = manager.get(liveSessionMeta.id);
  liveSession.currentTurnId = "turn-protected-shell-1";
  liveSession.threadSnapshot = {
    threadId: "thread-resync-protected-shell-1",
    version: 12,
    lastEventSeq: 24,
    updatedAt: "2026-04-29T06:00:48.136Z",
    activeTurnId: "turn-protected-shell-1",
    turns: [
      {
        id: "turn-protected-shell-1",
        status: "inProgress",
        items: [
          { id: "user-1", kind: "UserMessage", text: "看一下这个接口怎么改" },
          { id: "agent-1", kind: "AgentMessage", text: "先按接口说明改这一处。" }
        ]
      }
    ]
  };

  manager.historyService.getHistoricalMessages = () => ({
    threadSnapshot: {
      threadId: "thread-resync-protected-shell-1",
      version: 13,
      lastEventSeq: 25,
      updatedAt: "2026-04-29T06:01:00.687Z",
      activeTurnId: "",
      turns: []
    },
    liveOverlay: null
  });

  const snapshots = [];
  manager.broadcastConversationSnapshot = (session) => {
    snapshots.push(session.threadSnapshot);
  };

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    handler();
    return { unref() {} };
  };
  try {
    manager.scheduleConversationHistoryResync(liveSession, { attempts: 1, delayMs: 1 });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.equal(snapshots.length, 0);
  assert.equal(liveSession.threadSnapshot.turns.length, 1);
  assert.equal(liveSession.threadSnapshot.turns[0].items[1].text, "先按接口说明改这一处。");
});

test("buildProviderCommand reflects provider-specific CLI arguments", async () => {
  const { manager, rootDir } = createManager();
  try {
    const codexCommand = manager.buildProviderCommand({
      provider: "codex",
      resumeSessionId: "thread-42",
      model: "gpt-5-mini",
      autoNamed: false,
      name: "demo"
    });
    assert.match(codexCommand, /codex/);
    assert.match(codexCommand, /resume/);
    assert.match(codexCommand, /--model/);

    const ccCommand = manager.buildProviderCommand({
      provider: "cc",
      resumeSessionId: "",
      model: "sonnet",
      autoNamed: false,
      name: "Claude Demo"
    });
    assert.match(ccCommand, /claude/);
    assert.doesNotMatch(ccCommand, /--name|Claude Demo/);
    assert.match(ccCommand, /'--model' 'sonnet'/);

    const autoNamedCc = manager.buildProviderCommand({
      provider: "cc",
      resumeSessionId: "",
      model: "sonnet",
      autoNamed: true,
      name: "ignored"
    });
    assert.doesNotMatch(autoNamedCc, /--name/);
  } finally {
    manager.shutdown();
    await manager.codexSidebarService.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("streaming markdown message parts merge into a single body block", () => {
  let state = createEmptyConversationState();
  state = applyDelta(state, createTurnCreatedDelta("turn-1", "用户问题", "2026-04-14T00:00:00.000Z"));

  const streamingA = normalizeRecordToDeltas(
    {
      type: "message_part",
      part: { type: "text", text: "第一段", format: "markdown" },
      phase: "streaming",
      timestamp: "2026-04-14T00:00:01.000Z"
    },
    { turnId: "turn-1" }
  );
  const streamingB = normalizeRecordToDeltas(
    {
      type: "message_part",
      part: { type: "text", text: "第二段", format: "markdown" },
      phase: "streaming",
      timestamp: "2026-04-14T00:00:02.000Z"
    },
    { turnId: "turn-1" }
  );
  const finalChunk = normalizeRecordToDeltas(
    {
      type: "message_part",
      part: { type: "text", text: "第一段第二段", format: "markdown" },
      phase: "final",
      timestamp: "2026-04-14T00:00:03.000Z"
    },
    { turnId: "turn-1" }
  );

  for (const delta of [...streamingA, ...streamingB, ...finalChunk]) {
    state = applyDelta(state, delta);
  }

  assert.equal(state.turns[0].assistant.body.length, 1);
  assert.equal(state.turns[0].assistant.body[0].text, "第一段第二段");
});

test("adjacent completed markdown records in history merge into a single body block", () => {
  let state = createEmptyConversationState();
  state = applyDelta(state, createTurnCreatedDelta("turn-2", "用户问题", "2026-04-14T00:00:00.000Z"));

  const first = normalizeRecordToDeltas(
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第一句" }]
      },
      timestamp: "2026-04-14T00:00:01.000Z"
    },
    { turnId: "turn-2" }
  );
  const second = normalizeRecordToDeltas(
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第二句" }]
      },
      timestamp: "2026-04-14T00:00:02.000Z"
    },
    { turnId: "turn-2" }
  );

  for (const delta of [...first, ...second]) {
    state = applyDelta(state, delta);
  }

  assert.equal(state.turns[0].assistant.body.length, 1);
  assert.equal(state.turns[0].assistant.body[0].text, "第一句\n第二句");
});
