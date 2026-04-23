import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createCanonicalEvent } from "../src/canonical/createCanonicalEvent.js";
import { CANONICAL_EVENT_KINDS } from "../src/canonical/eventKinds.js";
import { createThreadProjector } from "../src/projector/threadProjector.js";
import { canonicalizeRawRecord, createCanonicalizerState } from "../src/threads/canonicalEvents.js";
import { SSE_TRANSPORT_EVENTS, serializeSseFrame } from "../src/transport/sse/eventSerializer.js";
import { buildDisplayedThreadSnapshot } from "../web/src/lib/thread-display-state.js";

const examplesDir = path.join(process.cwd(), "docs", "refactoring", "examples", "events");

function readExample(name) {
  return JSON.parse(fs.readFileSync(path.join(examplesDir, name), "utf8"));
}

test("canonical/projector contract: sample single-interface stream stays in overlay until turn completion and then materializes exactly once", () => {
  const events = [
    readExample("turn.started.json"),
    readExample("tool.started.json"),
    readExample("tool.completed.json"),
    readExample("artifact.created.json"),
    readExample("message.delta.json"),
    readExample("message.completed.json")
  ];
  const turnCompleted = readExample("turn.completed.json");

  const projector = createThreadProjector({ threadId: events[0].threadId });
  const liveState = projector.applyEvents(events);

  assert.equal(liveState.snapshot.metadata.providerSet.includes("codex"), true);
  assert.equal(liveState.snapshot.turns.length, 1);
  assert.equal(liveState.snapshot.turns[0].status, "running");
  assert.deepEqual(liveState.snapshot.turns[0].items, []);
  assert.equal(liveState.overlay?.turnId, "turn-refactor-001");
  assert.equal(
    liveState.overlay?.message?.text,
    "我先给你整理一组最小但完整的契约样本，覆盖事件、snapshot 和 live overlay，方便开发与 QA 直接对照。"
  );
  assert.equal(liveState.overlay?.tools.length, 1);
  assert.equal(liveState.overlay?.artifacts.length, 1);

  const frame = serializeSseFrame({
    id: events[4].id,
    event: SSE_TRANSPORT_EVENTS.CANONICAL_EVENT,
    data: events[4]
  });
  assert.match(frame, /^id: evt-thread-refactor-001-0005\nevent: canonical\.event\n/m);
  assert.match(frame, /"kind":"message\.delta"/);
  assert.match(frame, /"provider":"codex"/);

  const completedState = projector.applyEvent(turnCompleted);
  const completedTurn = completedState.snapshot.turns[0];

  assert.equal(completedState.overlay, null);
  assert.equal(completedTurn.status, "completed");
  assert.deepEqual(
    completedTurn.items.map((item) => item.kind),
    ["AgentMessage", "ToolCall", "Artifact"]
  );
  assert.equal(
    completedTurn.items.find((item) => item.kind === "AgentMessage")?.text,
    "我先给你整理一组最小但完整的契约样本，覆盖事件、snapshot 和 live overlay，方便开发与 QA 直接对照。"
  );
});

test("frontend contract: current-page authoritative snapshot and new-tab persisted snapshot render the same completed thread", () => {
  const persistedSnapshot = readExample("thread.snapshot.json").payload.snapshot;

  const currentPageSnapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: persistedSnapshot,
    threadId: persistedSnapshot.threadId,
    liveSessionMeta: { resumeSessionId: persistedSnapshot.threadId },
    threadMeta: { resumeSessionId: persistedSnapshot.threadId }
  });
  const newTabSnapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot,
    threadId: persistedSnapshot.threadId,
    threadMeta: { resumeSessionId: persistedSnapshot.threadId }
  });

  assert.deepEqual(currentPageSnapshot, newTabSnapshot);
  assert.equal(newTabSnapshot.turns.length, 1);
  assert.equal(newTabSnapshot.turns[0].status, "completed");
  assert.equal(
    newTabSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage")?.text,
    "我先给你整理一组最小但完整的契约样本，覆盖事件、snapshot 和 live overlay，方便开发与 QA 直接对照。"
  );
});

test("canonical/projector contract: fragmented assistant deltas accumulate instead of regressing to the last chunk", () => {
  const projector = createThreadProjector({ threadId: "thread-fragment-1" });

  projector.applyEvents([
    {
      id: "evt-fragment-1",
      seq: 1,
      provider: "codex",
      providerThreadId: "thread-fragment-1",
      threadId: "thread-fragment-1",
      turnId: "turn-fragment-1",
      ts: "2026-04-23T08:52:55.719Z",
      kind: "turn.started",
      payload: {}
    },
    {
      id: "evt-fragment-2",
      seq: 2,
      provider: "codex",
      providerThreadId: "thread-fragment-1",
      threadId: "thread-fragment-1",
      turnId: "turn-fragment-1",
      ts: "2026-04-23T08:53:07.147Z",
      kind: "message.delta",
      payload: { text: "111", phase: "streaming", source: "primary_output_text" }
    },
    {
      id: "evt-fragment-3",
      seq: 3,
      provider: "codex",
      providerThreadId: "thread-fragment-1",
      threadId: "thread-fragment-1",
      turnId: "turn-fragment-1",
      ts: "2026-04-23T08:53:07.179Z",
      kind: "message.delta",
      payload: { text: "42", phase: "streaming", source: "primary_output_text" }
    },
    {
      id: "evt-fragment-4",
      seq: 4,
      provider: "codex",
      providerThreadId: "thread-fragment-1",
      threadId: "thread-fragment-1",
      turnId: "turn-fragment-1",
      ts: "2026-04-23T08:53:07.601Z",
      kind: "message.completed",
      payload: { text: "11142", phase: "final", source: "primary_output_text" }
    }
  ]);

  const completedState = projector.applyEvent({
    id: "evt-fragment-5",
    seq: 5,
    provider: "codex",
    providerThreadId: "thread-fragment-1",
    threadId: "thread-fragment-1",
    turnId: "turn-fragment-1",
    ts: "2026-04-23T08:53:08.137Z",
    kind: "turn.completed",
    payload: {}
  });

  assert.equal(completedState.overlay, null);
  assert.equal(
    completedState.snapshot.turns[0].items.find((item) => item.kind === "AgentMessage")?.text,
    "11142"
  );
});

test("canonical/projector contract: item.completed agentMessage with top-level text materializes into snapshot", () => {
  const state = createCanonicalizerState();
  state.activeTurnId = "turn-materialize-1";

  const events = canonicalizeRawRecord(
    {
      id: "raw-materialize-1",
      threadId: "thread-materialize-1",
      turnId: "turn-materialize-1",
      seq: 1,
      recordTs: "2026-04-23T09:34:42.557Z",
      recordType: "item.completed",
      raw: {
        item: {
          type: "agentMessage",
          id: "msg-materialize-1",
          text: "123456789",
          phase: "final_answer"
        }
      }
    },
    state
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "agent_message_recorded");
  assert.equal(events[0].payload.text, "123456789");

  const projector = createThreadProjector({ threadId: "thread-materialize-1" });
  projector.applyEvents([
    createCanonicalEvent({
      id: "evt-materialize-start",
      seq: 1,
      provider: "codex",
      providerThreadId: "thread-materialize-1",
      threadId: "thread-materialize-1",
      turnId: "turn-materialize-1",
      ts: "2026-04-23T09:34:34.503Z",
      kind: CANONICAL_EVENT_KINDS.TURN_STARTED,
      payload: {}
    }),
    createCanonicalEvent({
      id: "evt-materialize-user",
      seq: 2,
      provider: "codex",
      providerThreadId: "thread-materialize-1",
      threadId: "thread-materialize-1",
      turnId: "turn-materialize-1",
      ts: "2026-04-23T09:34:34.503Z",
      kind: CANONICAL_EVENT_KINDS.USER_MESSAGE,
      payload: { text: "回复：123456789", content: [] }
    }),
    createCanonicalEvent({
      id: "evt-materialize-message",
      seq: 3,
      provider: "codex",
      providerThreadId: "thread-materialize-1",
      threadId: "thread-materialize-1",
      turnId: "turn-materialize-1",
      ts: "2026-04-23T09:34:42.557Z",
      kind: CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED,
      payload: { text: "123456789", phase: "final_answer", source: "primary_output_text" }
    }),
    createCanonicalEvent({
      id: "evt-materialize-complete",
      seq: 4,
      provider: "codex",
      providerThreadId: "thread-materialize-1",
      threadId: "thread-materialize-1",
      turnId: "turn-materialize-1",
      ts: "2026-04-23T09:34:43.589Z",
      kind: CANONICAL_EVENT_KINDS.TURN_COMPLETED,
      payload: {}
    })
  ]);

  const materialized = projector.getSnapshot().turns[0].items.find((item) => item.kind === "AgentMessage");
  assert.equal(materialized?.text, "123456789");
});
