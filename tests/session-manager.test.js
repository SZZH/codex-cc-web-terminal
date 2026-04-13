import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { SessionManager } from "../src/sessionManager.js";
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

test("create rejects unsupported providers", () => {
  const { manager } = createManager();
  assert.throws(() => manager.create({ provider: "unknown-provider" }), /Unsupported session provider/);
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
  assert.ok(sentPayloads.some((payload) => payload.type === "message_part"));
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
  const config = createBaseConfig(rootDir, { codexSessionsDir });
  const manager = new SessionManager(config, { appServerBridge: new AppServerBridgeStub() });

  const sessionIndexPath = path.join(path.dirname(codexSessionsDir), "session_index.jsonl");
  writeJsonl(sessionIndexPath, [{ id: "thread-h1", thread_name: "Indexed Codex Thread" }]);

  const historyFile = path.join(codexSessionsDir, "project-a", "thread-h1.jsonl");
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

  const archived = manager.archiveHistoricalSession("codex", "thread-h1");
  assert.equal(archived.kind, "archived");
  const restored = manager.restoreHistoricalSession("codex", "thread-h1");
  assert.equal(restored.kind, "history");

  assert.equal(manager.deleteHistoricalSession("codex", "thread-h1"), true);
  assert.equal(fs.existsSync(historyFile), false);
});

test("listAll deduplicates historical sessions shadowed by live resumable sessions", () => {
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
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "live");
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

test("buildProviderCommand reflects provider-specific CLI arguments", () => {
  const { manager } = createManager();

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
  assert.match(ccCommand, /--name/);
  assert.match(ccCommand, /Claude Demo/);

  const autoNamedCc = manager.buildProviderCommand({
    provider: "cc",
    resumeSessionId: "",
    model: "sonnet",
    autoNamed: true,
    name: "ignored"
  });
  assert.doesNotMatch(autoNamedCc, /--name/);
});
