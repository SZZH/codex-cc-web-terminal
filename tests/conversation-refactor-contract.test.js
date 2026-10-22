import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { createBaseConfig, createTempDir, waitForCondition } from "./helpers/backendTestUtils.js";

import {
  applyConversationDeltaPayload,
  buildTimelineMessagesFromConversation,
  createConversationState
} from "../web/src/lib/conversation-timeline.js";

function applyPayload(state, payload) {
  return applyConversationDeltaPayload(state, payload).conversation;
}

test("Codex V2 reads official history and completes streamed requests without legacy manager projection methods", async (t) => {
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir);
  const calls = [];
  const bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: rootDir, status: { type: "idle" } } };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: "official-turn", status: "inProgress", items: [] } };
    assert.fail(`Unexpected official method: ${method}`);
  };
  const sessionManager = new Proxy({ codexModelCatalog: () => [] }, {
    get(target, property, receiver) {
      assert.equal(property, "codexModelCatalog", `V2 accessed manager.${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  const service = new CodexThreadService({ config, bridge, sessionManager, pollMs: 60_000 });
  t.after(() => {
    service.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const page = await service.reader.listTurns("official-thread");
  assert.deepEqual(page.turns, []);
  assert.deepEqual(calls.map(({ method }) => method), ["thread/read", "thread/turns/list"]);
  assert.equal(calls[0].params.includeTurns, false);

  const events = [];
  service.subscribe("official-thread", (event) => events.push(event));
  service.submit("official-thread", { clientRequestId: "v2-boundary-request", input: { text: "continue", attachments: [] }, options: {} });
  await waitForCondition(() => service.requests.get("official-thread", "v2-boundary-request")?.state === "accepted");
  const turnParams = { threadId: "official-thread", turnId: "official-turn" };
  bridge.emit("notification", { method: "item/agentMessage/delta", params: { ...turnParams, itemId: "official-item", delta: "reply" } });
  bridge.emit("notification", { method: "item/completed", params: { ...turnParams, item: { id: "official-item", type: "agentMessage", text: "reply" } } });
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "official-thread", turn: { id: "official-turn", status: "completed", items: [] } } });

  assert.equal(service.requests.get("official-thread", "v2-boundary-request").state, "completed");
  assert.equal(calls.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(calls.find(({ method }) => method === "turn/start").params.clientUserMessageId, "v2-boundary-request");
  assert.deepEqual(events.filter(({ type }) => type === "item.delta").map(({ payload }) => payload), [
    { turnId: "official-turn", itemId: "official-item", field: "text", text: "reply" }
  ]);
  assert.equal(events.find(({ type }) => type === "item.upsert").payload.item.text, "reply");
  assert.ok(events.every(({ schemaVersion }) => schemaVersion === 2));
});

test("realtime assistant body stays visible while streaming updates converge into a single committed block", () => {
  let state = createConversationState({
    sessionId: "session-live",
    threadId: "thread-live",
    version: 0
  });

  state = applyPayload(state, {
    deltas: [
      {
        kind: "turn_created",
        turnId: "turn-1",
        timestamp: "2026-04-21T09:00:00.000Z",
        user: {
          id: "user-1",
          text: "先给我一个方案",
          ts: "2026-04-21T09:00:00.000Z"
        }
      },
      {
        kind: "body_appended",
        turnId: "turn-1",
        block: {
          id: "body-1",
          kind: "markdown",
          text: "先看一下",
          payload: { phase: "streaming" },
          ts: "2026-04-21T09:00:01.000Z",
          mergeMode: "stream_append"
        }
      },
      {
        kind: "body_appended",
        turnId: "turn-1",
        block: {
          id: "body-1",
          kind: "markdown",
          text: "先看一下当前链路",
          payload: { phase: "streaming" },
          ts: "2026-04-21T09:00:02.000Z",
          mergeMode: "stream_append"
        }
      },
      {
        kind: "body_appended",
        turnId: "turn-1",
        block: {
          id: "body-1",
          kind: "markdown",
          text: "先看一下当前链路，再补一个正式方案。",
          payload: { phase: "completed" },
          ts: "2026-04-21T09:00:03.000Z",
          mergeMode: "stream_replace"
        }
      },
      {
        kind: "turn_completed",
        turnId: "turn-1",
        status: "completed",
        timestamp: "2026-04-21T09:00:04.000Z"
      }
    ]
  });

  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].assistant.body.length, 1);
  assert.equal(state.turns[0].assistant.body[0].text, "先看一下当前链路，再补一个正式方案。");
  assert.equal(state.turns[0].assistant.status, "completed");
});

test("late-arriving process item stays attached to its original turn after a new turn becomes active", () => {
  let state = createConversationState({
    sessionId: "session-late",
    threadId: "thread-late"
  });

  state = applyPayload(state, {
    deltas: [
      {
        kind: "turn_created",
        turnId: "turn-1",
        timestamp: "2026-04-21T09:00:00.000Z",
        user: {
          id: "user-1",
          text: "先检查实时链路",
          ts: "2026-04-21T09:00:00.000Z"
        }
      },
      {
        kind: "turn_completed",
        turnId: "turn-1",
        status: "completed",
        timestamp: "2026-04-21T09:00:01.000Z"
      },
      {
        kind: "turn_created",
        turnId: "turn-2",
        timestamp: "2026-04-21T09:00:02.000Z",
        user: {
          id: "user-2",
          text: "再看历史恢复",
          ts: "2026-04-21T09:00:02.000Z"
        }
      },
      {
        kind: "process_appended",
        turnId: "turn-1",
        event: {
          id: "proc-late-1",
          type: "tool_result",
          title: "exec_command",
          summary: "历史对账完成",
          content: "late item still belongs to turn-1",
          payload: {},
          phase: "completed",
          ts: "2026-04-21T09:00:03.000Z"
        }
      }
    ]
  });

  assert.equal(state.turns.length, 2);
  assert.equal(state.turns[0].id, "turn-1");
  assert.equal(state.turns[0].assistant.process.length, 1);
  assert.equal(state.turns[0].assistant.process[0].summary, "历史对账完成");
  assert.equal(state.turns[1].id, "turn-2");
  assert.equal(state.turns[1].assistant.process.length, 0);
  assert.equal(state.activeTurnId, "turn-2");
});

test("history conversation output does not duplicate committed assistant text when ephemeral draft matches final content", () => {
  const conversation = createConversationState({
    sessionId: "session-dedup",
    threadId: "thread-dedup",
    turns: [
      {
        id: "turn-1",
        user: { id: "user-1", text: "总结一下", ts: "2026-04-21T09:00:00.000Z" },
        assistant: {
          status: "completed",
          startedAt: "2026-04-21T09:00:01.000Z",
          finishedAt: "2026-04-21T09:00:02.000Z",
          process: [],
          body: [
            {
              id: "body-1",
              kind: "markdown",
              text: "这是最终总结。",
              payload: {},
              ts: "2026-04-21T09:00:02.000Z"
            }
          ]
        }
      }
    ]
  });

  const messages = buildTimelineMessagesFromConversation(conversation, [
    {
      role: "assistant",
      text: "这是最终总结。",
      timestamp: "2026-04-21T09:00:02.100Z",
      source: "draft",
      streaming: true,
      partType: "markdown",
      payload: {}
    }
  ]);

  const assistantMessages = messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].text, "这是最终总结。");
});

test("version-gap payload resyncs to authoritative conversation snapshot instead of mixing partial local state", () => {
  const current = createConversationState({
    sessionId: "session-gap",
    threadId: "thread-gap",
    version: 4,
    turns: [
      {
        id: "turn-stale",
        user: { id: "user-stale", text: "旧内容", ts: "2026-04-21T09:00:00.000Z" },
        assistant: {
          status: "running",
          startedAt: "2026-04-21T09:00:01.000Z",
          finishedAt: "",
          process: [],
          body: []
        }
      }
    ]
  });

  const { conversation, resynced } = applyConversationDeltaPayload(current, {
    fromVersion: 2,
    conversation: {
      sessionId: "session-gap",
      threadId: "thread-gap",
      version: 6,
      status: "completed",
      turns: [
        {
          id: "turn-fresh",
          user: { id: "user-fresh", text: "新内容", ts: "2026-04-21T09:01:00.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-21T09:01:01.000Z",
            finishedAt: "2026-04-21T09:01:02.000Z",
            process: [],
            body: [
              {
                id: "body-fresh",
                kind: "markdown",
                text: "同步后的正式答案",
                payload: {},
                ts: "2026-04-21T09:01:02.000Z"
              }
            ]
          }
        }
      ]
    }
  });

  assert.equal(resynced, true);
  assert.equal(conversation.version, 6);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].id, "turn-fresh");
  assert.equal(conversation.turns[0].assistant.body[0].text, "同步后的正式答案");
});

test("version-gap payload still applies the current streaming delta after resync", () => {
  const current = createConversationState({
    sessionId: "session-gap-delta",
    threadId: "thread-gap-delta",
    version: 1,
    turns: []
  });

  const { conversation, resynced } = applyConversationDeltaPayload(current, {
    sessionId: "session-gap-delta",
    threadId: "thread-gap-delta",
    fromVersion: 3,
    conversation: {
      sessionId: "session-gap-delta",
      threadId: "thread-gap-delta",
      version: 3,
      status: "running",
      turns: [
        {
          id: "turn-gap-delta",
          user: { id: "user-gap-delta", text: "继续", ts: "2026-04-29T00:00:00.000Z" },
          assistant: {
            status: "running",
            startedAt: "2026-04-29T00:00:01.000Z",
            finishedAt: "",
            process: [],
            body: []
          }
        }
      ]
    },
    deltas: [
      {
        kind: "body_appended",
        turnId: "turn-gap-delta",
        timestamp: "2026-04-29T00:00:02.000Z",
        block: {
          id: "body-gap-delta",
          kind: "markdown",
          text: "实时增量",
          mergeMode: "stream_append",
          payload: {}
        }
      }
    ]
  });

  assert.equal(resynced, true);
  assert.equal(conversation.version, 4);
  assert.equal(conversation.turns[0].assistant.body[0].text, "实时增量");
});

test("version-gap payload does not replay deltas already represented in the authoritative conversation", () => {
  const current = createConversationState({
    sessionId: "session-gap-replay",
    threadId: "thread-gap-replay",
    version: 1,
    turns: []
  });

  const { conversation, resynced } = applyConversationDeltaPayload(current, {
    sessionId: "session-gap-replay",
    threadId: "thread-gap-replay",
    fromVersion: 3,
    conversation: {
      sessionId: "session-gap-replay",
      threadId: "thread-gap-replay",
      version: 4,
      status: "running",
      turns: [
        {
          id: "turn-gap-replay",
          user: { id: "user-gap-replay", text: "继续", ts: "2026-04-29T00:00:00.000Z" },
          assistant: {
            status: "running",
            startedAt: "2026-04-29T00:00:01.000Z",
            finishedAt: "",
            process: [],
            body: [
              {
                id: "body-gap-replay",
                kind: "markdown",
                text: "实时增量",
                payload: {},
                ts: "2026-04-29T00:00:02.000Z"
              }
            ]
          }
        }
      ]
    },
    deltas: [
      {
        kind: "body_appended",
        turnId: "turn-gap-replay",
        timestamp: "2026-04-29T00:00:02.000Z",
        block: {
          id: "body-gap-replay",
          kind: "markdown",
          text: "实时增量",
          mergeMode: "stream_append",
          payload: {}
        }
      }
    ]
  });

  assert.equal(resynced, true);
  assert.equal(conversation.version, 4);
  assert.equal(conversation.turns[0].assistant.body.length, 1);
  assert.equal(conversation.turns[0].assistant.body[0].text, "实时增量");
});

test("server turn id aliases the local optimistic turn before streaming body deltas land", () => {
  let state = createConversationState({
    sessionId: "session-alias",
    threadId: "thread-alias",
    version: 0
  });

  state = applyPayload(state, {
    deltas: [
      {
        kind: "turn_created",
        turnId: "client-turn-1",
        timestamp: "2026-04-29T00:00:00.000Z",
        user: {
          id: "user-alias-1",
          text: "测试 alias",
          ts: "2026-04-29T00:00:00.000Z"
        }
      },
      {
        kind: "turn_status_changed",
        turnId: "server-turn-1",
        clientTurnId: "client-turn-1",
        aliasSource: "active-pending-turn",
        status: "running",
        timestamp: "2026-04-29T00:00:01.000Z"
      },
      {
        kind: "body_appended",
        turnId: "server-turn-1",
        block: {
          id: "body-server-1",
          kind: "markdown",
          text: "真实增量",
          payload: { phase: "streaming" },
          ts: "2026-04-29T00:00:02.000Z",
          mergeMode: "stream_append"
        }
      }
    ]
  });

  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].id, "server-turn-1");
  assert.equal(state.turns[0].user.text, "测试 alias");
  assert.equal(state.turns[0].assistant.body[0].text, "真实增量");
  assert.equal(state.activeTurnId, "server-turn-1");
});

test("streaming body delta can establish the server turn alias without a prior status delta", () => {
  let state = createConversationState({
    sessionId: "session-alias-body",
    threadId: "thread-alias-body",
    version: 0
  });

  state = applyPayload(state, {
    deltas: [
      {
        kind: "turn_created",
        turnId: "client-turn-body",
        timestamp: "2026-04-29T00:00:00.000Z",
        user: {
          id: "user-alias-body",
          text: "测试首段 alias",
          ts: "2026-04-29T00:00:00.000Z"
        }
      },
      {
        kind: "body_appended",
        turnId: "server-turn-body",
        clientTurnId: "client-turn-body",
        aliasSource: "active-pending-turn",
        block: {
          id: "body-server-first",
          kind: "markdown",
          text: "首段真实增量",
          payload: { phase: "streaming" },
          ts: "2026-04-29T00:00:01.000Z",
          mergeMode: "stream_append"
        }
      }
    ]
  });

  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].id, "server-turn-body");
  assert.equal(state.turns[0].user.text, "测试首段 alias");
  assert.equal(state.turns[0].assistant.body[0].text, "首段真实增量");
  assert.equal(state.activeTurnId, "server-turn-body");
});

test("unresolved body delta without turn id is buffered out of the visible conversation instead of guessing active turn", () => {
  let state = createConversationState({
    sessionId: "session-unresolved",
    threadId: "thread-unresolved",
    activeTurnId: "turn-active",
    turns: [
      {
        id: "turn-active",
        user: { id: "user-active", text: "已有 turn", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", startedAt: "", finishedAt: "", process: [], body: [] }
      }
    ]
  });

  state = applyPayload(state, {
    deltas: [
      {
        kind: "body_appended",
        block: {
          id: "body-unresolved",
          kind: "markdown",
          text: "不能猜写到 active turn",
          payload: { phase: "streaming" },
          ts: "2026-04-29T00:00:01.000Z",
          mergeMode: "stream_append"
        }
      }
    ]
  });

  assert.equal(state.turns[0].assistant.body.length, 0);
});

test("conversation_replaced delta swaps live conversation to the authoritative snapshot immediately", () => {
  const current = createConversationState({
    sessionId: "session-replaced",
    threadId: "thread-replaced",
    version: 1,
    status: "running",
    activeTurnId: "turn-live",
    turns: [
      {
        id: "turn-live",
        user: { id: "user-live", text: "先发出去", ts: "2026-04-21T09:00:00.000Z" },
        assistant: {
          status: "running",
          startedAt: "2026-04-21T09:00:01.000Z",
          finishedAt: "",
          process: [],
          body: []
        }
      }
    ]
  });

  const authoritativeConversation = {
    sessionId: "session-replaced",
    threadId: "thread-replaced",
    version: 2,
    status: "completed",
    updatedAt: "2026-04-21T09:00:03.000Z",
    activeTurnId: "",
    turns: [
      {
        id: "turn-live",
        user: { id: "user-live", text: "先发出去", ts: "2026-04-21T09:00:00.000Z" },
        assistant: {
          status: "completed",
          startedAt: "2026-04-21T09:00:01.000Z",
          finishedAt: "2026-04-21T09:00:03.000Z",
          process: [],
          body: [
            {
              id: "body-live",
              kind: "markdown",
              text: "正式回复已经写入 authoritative conversation。",
              payload: {},
              ts: "2026-04-21T09:00:03.000Z"
            }
          ]
        }
      }
    ],
    backgroundAgents: []
  };

  const { conversation, resynced } = applyConversationDeltaPayload(current, {
    sessionId: "session-replaced",
    threadId: "thread-replaced",
    fromVersion: 1,
    toVersion: 2,
    timestamp: "2026-04-21T09:00:03.000Z",
    conversation: authoritativeConversation,
    deltas: [
      {
        kind: "conversation_replaced",
        sessionId: "session-replaced",
        threadId: "thread-replaced",
        version: 2,
        timestamp: "2026-04-21T09:00:03.000Z",
        conversation: authoritativeConversation
      }
    ]
  });

  assert.equal(resynced, false);
  assert.equal(conversation.version, 2);
  assert.equal(conversation.status, "completed");
  assert.equal(conversation.activeTurnId, "");
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].assistant.status, "completed");
  assert.equal(conversation.turns[0].assistant.body.length, 1);
  assert.equal(conversation.turns[0].assistant.body[0].text, "正式回复已经写入 authoritative conversation。");
});
