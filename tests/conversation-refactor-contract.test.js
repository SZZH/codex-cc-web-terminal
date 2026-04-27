import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConversationDeltaPayload,
  buildTimelineMessagesFromConversation,
  createConversationState
} from "../web/src/lib/conversation-timeline.js";

function applyPayload(state, payload) {
  return applyConversationDeltaPayload(state, payload).conversation;
}

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
