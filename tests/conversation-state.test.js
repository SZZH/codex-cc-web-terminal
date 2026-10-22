import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConversationDeltas,
  buildConversationStateFromThreadSnapshot,
  buildConversationStateFromHistory,
  createConversationState
} from "../src/sessions/conversation/state.js";
import {
  buildConversationDeltaPayload,
  buildConversationSnapshotPayload
} from "../src/sessions/conversation/protocol.js";
import {
  createTurnCompletedDelta,
  createTurnCreatedDelta
} from "../src/sessions/normalize/turnDeltas.js";

test("history payload builds conversation state for empty and non-empty history", () => {
  const empty = buildConversationStateFromHistory({ turns: [], backgroundAgents: [] }, { threadId: "thread-empty" });
  assert.equal(empty.threadId, "thread-empty");
  assert.equal(empty.status, "idle");
  assert.equal(empty.version, 0);
  assert.equal(empty.turns.length, 0);

  const nonEmpty = buildConversationStateFromHistory(
    {
      turns: [
        {
          id: "turn-1",
          user: { id: "u1", text: "hello", ts: "2026-04-14T00:00:00.000Z" },
          assistant: { body: [], process: [], status: "completed", startedAt: "2026-04-14T00:00:01.000Z", finishedAt: "2026-04-14T00:00:02.000Z" }
        }
      ],
      backgroundAgents: []
    },
    { threadId: "thread-full" }
  );
  assert.equal(nonEmpty.threadId, "thread-full");
  assert.equal(nonEmpty.status, "completed");
  assert.equal(nonEmpty.version, 1);
  assert.equal(nonEmpty.turns.length, 1);
});

test("conversation deltas increment version and preserve session identity", () => {
  let state = createConversationState({ sessionId: "session-1", threadId: "thread-1", version: 0 });
  const { state: next, applied } = applyConversationDeltas(state, [
    createTurnCreatedDelta("turn-1", "用户问题", "2026-04-14T00:00:00.000Z"),
    createTurnCompletedDelta("turn-1", "completed", "2026-04-14T00:00:01.000Z")
  ]);

  assert.equal(next.sessionId, "session-1");
  assert.equal(next.threadId, "thread-1");
  assert.equal(next.version, 2);
  assert.equal(next.status, "completed");
  assert.equal(next.turns.length, 1);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].fromVersion, 0);
  assert.equal(applied[1].toVersion, 2);
});

test("conversation snapshot payload carries normalized conversation and legacy fields", () => {
  const session = {
    id: "session-1",
    resumeSessionId: "thread-1",
    buffer: "buffer-text",
    conversationState: createConversationState({
      sessionId: "session-1",
      threadId: "thread-1",
      turns: [
        {
          id: "turn-1",
          user: { id: "u1", text: "Q", ts: "2026-04-14T00:00:00.000Z" },
          assistant: { body: [], process: [], status: "running", startedAt: "2026-04-14T00:00:01.000Z", finishedAt: "" }
        }
      ],
      version: 1
    })
  };
  const payload = buildConversationSnapshotPayload(session, { id: "session-1" });
  assert.equal(payload.type, "conversation.snapshot");
  assert.equal(payload.sessionId, "session-1");
  assert.equal(payload.threadId, "thread-1");
  assert.equal(payload.conversation.version, 1);
  assert.equal(payload.continuation.threadId, "thread-1");
  assert.equal(payload.continuation.sessionId, "session-1");
  assert.equal(payload.thread.snapshot, null);
  assert.equal(payload.thread.continuation.threadId, "thread-1");
  assert.equal(payload.turns.length, 1);
  assert.equal(payload.buffer, "buffer-text");
});

test("conversation delta payload emits versioned delta entries", () => {
  const session = {
    id: "session-1",
    resumeSessionId: "thread-1",
    conversationState: createConversationState({ sessionId: "session-1", threadId: "thread-1", version: 2, status: "running" })
  };
  const payload = buildConversationDeltaPayload(session, [
    {
      delta: { kind: "turn_created", turnId: "turn-1", timestamp: "2026-04-14T00:00:00.000Z" },
      fromVersion: 1,
      toVersion: 2,
      timestamp: "2026-04-14T00:00:00.000Z"
    }
  ]);
  assert.ok(payload);
  assert.equal(payload.type, "conversation.delta");
  assert.equal(payload.fromVersion, 1);
  assert.equal(payload.toVersion, 2);
  assert.equal(payload.continuation.threadId, "thread-1");
  assert.equal(payload.continuation.sessionId, "session-1");
  assert.equal(Object.hasOwn(payload, "thread"), false);
  assert.equal(Object.hasOwn(payload, "threadSnapshot"), false);
  assert.equal(payload.deltas.length, 1);
  assert.equal(payload.deltas[0].version, 2);
});

test("thread snapshot -> conversation preserves user image payload", () => {
  const conversation = buildConversationStateFromThreadSnapshot({
    threadId: "thread-images",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            id: "user-1",
            kind: "UserMessage",
            text: "看这张图",
            payload: {
              content: [
                { type: "input_text", text: "看这张图" },
                { type: "input_image", image_url: "data:image/png;base64,abc", alt: "截图" }
              ]
            }
          }
        ]
      }
    ]
  });

  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user.text, "看这张图");
  assert.equal(conversation.turns[0].user.content.length, 2);
  assert.equal(conversation.turns[0].user.content[1].type, "input_image");
  assert.equal(conversation.turns[0].user.content[1].image_url, "data:image/png;base64,abc");
});
