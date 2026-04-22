import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { SessionManager } from "../src/sessionManager.js";
import { createConversationState } from "../src/sessions/conversation/state.js";
import { createEmptyConversationState, applyDelta } from "../src/sessions/normalize/turnState.js";
import { createTurnCreatedDelta, normalizeRecordToDeltas } from "../src/sessions/normalize/turnDeltas.js";
import { deriveThreadSnapshotFromConversationState } from "../src/threads/index.js";
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
  assert.equal(failedTurn.assistant.process.length, 1);
  assert.match(failedTurn.assistant.process[0].summary, /502 Bad Gateway/);
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
