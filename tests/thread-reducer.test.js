import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSISTANT_LIVE_STATE,
  THREAD_ITEM_KIND,
  TURN_STATUS,
  applyCanonicalEvent,
  createCanonicalEvent,
  createCanonicalizerState,
  createRawRecord,
  canonicalizeRawRecord,
  getActiveTurnLiveOverlay,
  projectTurnSegments,
  reduceCanonicalEvents
} from "../src/threads/index.js";
import { segmentTurnItems } from "../web/src/lib/thread-view-model.js";

function event(input) {
  return createCanonicalEvent({
    threadId: "thread-1",
    eventTs: input.eventTs ?? "2026-04-21T00:00:00.000Z",
    ...input
  });
}

test("primary source replaces fallback live text and commits a single assistant message", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "user_message_recorded", payload: { text: "你好" } }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "先给一个 fallback", source: "fallback_final_answer" }
    }),
    event({
      seq: 4,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "最终主正文", source: "primary_output_text" }
    }),
    event({ seq: 5, turnId: "turn-1", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  assert.equal(turn.assistant.liveState, ASSISTANT_LIVE_STATE.COMMITTED);
  assert.equal(turn.assistant.committedMessages.length, 1);
  assert.equal(turn.assistant.committedMessages[0].text, "最终主正文");

  const agentItems = turn.items.filter((item) => item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE);
  assert.equal(agentItems.length, 1);
  assert.equal(agentItems[0].text, "最终主正文");
});

test("fallback source commits when primary source never arrives", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "只有 fallback", source: "fallback_final_answer" }
    }),
    event({ seq: 3, turnId: "turn-1", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  assert.equal(turn.assistant.committedMessages.length, 1);
  assert.equal(turn.assistant.committedMessages[0].text, "只有 fallback");
});

test("primary source accumulates streaming chunks and commits the full assistant reply", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "user_message_recorded", payload: { text: "回复：哈哈哈哈" } }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "哈", source: "primary_output_text" }
    }),
    event({
      seq: 4,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "哈", source: "primary_output_text" }
    }),
    event({
      seq: 5,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "哈哈", source: "primary_output_text" }
    }),
    event({ seq: 6, turnId: "turn-1", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  assert.equal(turn.assistant.committedMessages.length, 1);
  assert.equal(turn.assistant.committedMessages[0].text, "哈哈哈哈");
  const agentItems = turn.items.filter((item) => item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE);
  assert.equal(agentItems.length, 1);
  assert.equal(agentItems[0].text, "哈哈哈哈");
});

test("failed turn preserves visible live text and does not clear assistant output", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "已经可见的正文", source: "fallback_final_answer" }
    }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "turn_failed",
      payload: { error: { message: "boom" } }
    })
  ]);

  const turn = snapshot.turns[0];
  assert.equal(turn.status, TURN_STATUS.FAILED);
  assert.equal(turn.assistant.liveState, ASSISTANT_LIVE_STATE.FAILED);
  assert.equal(turn.assistant.liveText, "已经可见的正文");
});

test("late completion routes by turn id instead of current active turn", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started", eventTs: "2026-04-21T00:00:00.000Z" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "command_execution_started",
      payload: { callId: "cmd-1", name: "exec_command", args: { cmd: "pwd" } },
      eventTs: "2026-04-21T00:00:01.000Z"
    }),
    event({ seq: 3, turnId: "turn-2", eventType: "turn_started", eventTs: "2026-04-21T00:00:02.000Z" }),
    event({
      seq: 4,
      turnId: "turn-1",
      eventType: "command_execution_completed",
      payload: { callId: "cmd-1", name: "exec_command", output: "ok", status: "completed" },
      eventTs: "2026-04-21T00:00:03.000Z"
    })
  ]);

  const firstTurn = snapshot.turns.find((turn) => turn.id === "turn-1");
  const secondTurn = snapshot.turns.find((turn) => turn.id === "turn-2");
  assert.ok(firstTurn);
  assert.ok(secondTurn);
  assert.equal(firstTurn.items.filter((item) => item.kind === THREAD_ITEM_KIND.COMMAND_EXECUTION).length, 1);
  assert.equal(secondTurn.items.filter((item) => item.kind === THREAD_ITEM_KIND.COMMAND_EXECUTION).length, 0);
});

test("reasoning accumulates into a single adjacent reasoning item", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "reasoning_summary_recorded", payload: { summary: "step one" } }),
    event({ seq: 3, turnId: "turn-1", eventType: "reasoning_raw_recorded", payload: { content: "raw one" } }),
    event({ seq: 4, turnId: "turn-1", eventType: "reasoning_summary_recorded", payload: { summary: "step two" } })
  ]);

  const turn = snapshot.turns[0];
  const reasoningItems = turn.items.filter((item) => item.kind === THREAD_ITEM_KIND.REASONING);
  assert.equal(reasoningItems.length, 1);
  assert.deepEqual(reasoningItems[0].payload.summaries, ["step one", "step two"]);
  assert.deepEqual(reasoningItems[0].payload.contents, ["raw one"]);
});

test("projected segments preserve chronological order and split process blocks around primary content", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "reasoning_summary_recorded", payload: { summary: "thinking" } }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "正文", source: "primary_output_text" }
    }),
    event({
      seq: 4,
      turnId: "turn-1",
      eventType: "command_execution_started",
      payload: { callId: "cmd-1", name: "exec_command", args: { cmd: "ls" } }
    }),
    event({ seq: 5, turnId: "turn-1", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  const segments = projectTurnSegments(turn);
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["process", "primary", "process"]
  );
  assert.equal(segments[0].collapsible, true);
  assert.equal(segments[1].items[0].kind, THREAD_ITEM_KIND.AGENT_MESSAGE);
  assert.equal(segments[2].items[0].kind, THREAD_ITEM_KIND.COMMAND_EXECUTION);
});

test("active turn live overlay exposes the single visible assistant slot", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "实时可见正文", source: "fallback_final_answer" }
    })
  ]);

  const overlay = getActiveTurnLiveOverlay(snapshot);
  assert.deepEqual(overlay, {
    turnId: "turn-1",
    liveState: ASSISTANT_LIVE_STATE.LIVE_FALLBACK,
    text: "实时可见正文",
    source: "fallback",
    anchorItemId: "agent-message-live:turn-1:2"
  });
});

test("raw records canonicalize into canonical events for assistant content and command lifecycle", () => {
  const assistantMessageRecord = createRawRecord({
    id: "raw-1",
    threadId: "thread-1",
    turnId: "turn-1",
    recordType: "response_item",
    raw: {
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "主正文" }]
      }
    },
    seq: 1,
    recordTs: "2026-04-21T00:00:00.000Z"
  });
  const commandStartRecord = createRawRecord({
    id: "raw-2",
    threadId: "thread-1",
    turnId: "turn-1",
    recordType: "response_item",
    raw: {
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "cmd-1",
        arguments: { cmd: "pwd" }
      }
    },
    seq: 2,
    recordTs: "2026-04-21T00:00:01.000Z"
  });

  const assistantEvents = canonicalizeRawRecord(assistantMessageRecord);
  const commandEvents = canonicalizeRawRecord(commandStartRecord);

  assert.equal(assistantEvents[0].eventType, "agent_message_recorded");
  assert.equal(assistantEvents[0].payload.text, "主正文");
  assert.equal(commandEvents[0].eventType, "command_execution_started");
  assert.equal(commandEvents[0].payload.callId, "cmd-1");
});

test("assistant message payload can materialize image items alongside committed text", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: {
        text: "图已经生成好了",
        parts: [{ type: "image", url: "/api/local-file-image?path=%2Ftmp%2Fdemo.png", alt: "结果图" }],
        source: "primary_output_text"
      }
    }),
    event({ seq: 3, turnId: "turn-1", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  const imageItems = turn.items.filter((item) => item.kind === THREAD_ITEM_KIND.IMAGE_VIEW);
  const agentItems = turn.items.filter((item) => item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE);

  assert.equal(imageItems.length, 1);
  assert.equal(imageItems[0].payload.url, "/api/local-file-image?path=%2Ftmp%2Fdemo.png");
  assert.equal(imageItems[0].payload.alt, "结果图");
  assert.equal(agentItems.length, 1);
  assert.equal(agentItems[0].text, "图已经生成好了");
});

test("image view items are treated as primary content segments instead of process segments", () => {
  const segments = segmentTurnItems([
    {
      id: "img-1",
      kind: "ImageView",
      payload: { url: "/api/local-file-image?path=%2Ftmp%2Fdemo.png", alt: "结果图" }
    },
    {
      id: "msg-1",
      kind: "AgentMessage",
      text: "图已经生成好了"
    }
  ]);

  assert.deepEqual(segments.map((segment) => segment.kind), ["primary"]);
  assert.deepEqual(segments[0].items.map((item) => item.kind), ["imageview", "agentmessage"]);
});

test("raw assistant response content preserves image parts during canonicalization", () => {
  const assistantMessageRecord = createRawRecord({
    id: "raw-image-1",
    threadId: "thread-1",
    turnId: "turn-1",
    recordType: "response_item",
    raw: {
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "图已经生成好了" },
          { type: "output_image", image_url: "/api/local-file-image?path=%2Ftmp%2Fdemo.png", alt: "结果图" }
        ]
      }
    },
    seq: 1,
    recordTs: "2026-04-21T00:00:00.000Z"
  });

  const assistantEvents = canonicalizeRawRecord(assistantMessageRecord);

  assert.equal(assistantEvents[0].eventType, "agent_message_recorded");
  assert.equal(assistantEvents[0].payload.text, "图已经生成好了");
  assert.deepEqual(assistantEvents[0].payload.parts, [
    { type: "text", text: "图已经生成好了" },
    { type: "image", url: "/api/local-file-image?path=%2Ftmp%2Fdemo.png", alt: "结果图" }
  ]);
});

test("image_generation_end raw records produce image generation and image view events", () => {
  const state = createCanonicalizerState();
  canonicalizeRawRecord(
    createRawRecord({
      id: "raw-session-meta",
      threadId: "thread-1",
      seq: 1,
      recordTs: "2026-04-21T00:00:00.000Z",
      recordType: "session_meta",
      raw: {
        payload: {
          id: "session-imagegen-1"
        }
      }
    }),
    state
  );

  const events = canonicalizeRawRecord(
    createRawRecord({
      id: "raw-imagegen-1",
      threadId: "thread-1",
      turnId: "turn-1",
      seq: 2,
      recordTs: "2026-04-21T00:00:02.000Z",
      recordType: "event_msg",
      raw: {
        payload: {
          type: "image_generation_end",
          turn_id: "turn-1",
          call_id: "ig_demo_123",
          status: "completed",
          revised_prompt: "dreamy skyline"
        }
      }
    }),
    state
  );

  assert.deepEqual(
    events.map((item) => item.eventType),
    ["image_generation_completed", "image_view_recorded"]
  );
  assert.match(events[1].payload.url, /session-imagegen-1\/ig_demo_123\.png$/);
});

test("applyCanonicalEvent can incrementally build a snapshot with stable versions", () => {
  let snapshot = null;
  snapshot = applyCanonicalEvent(snapshot, event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }));
  snapshot = applyCanonicalEvent(snapshot, event({ seq: 2, turnId: "turn-1", eventType: "user_message_recorded", payload: { text: "hi" } }));
  snapshot = applyCanonicalEvent(snapshot, event({ seq: 3, turnId: "turn-1", eventType: "turn_completed" }));

  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.lastEventSeq, 3);
  assert.equal(snapshot.turns[0].status, TURN_STATUS.COMPLETED);
});
