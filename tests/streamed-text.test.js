import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { createLiveTurnAggregator } from "../src/projector/aggregator/liveTurnAggregator.js";
import { createCanonicalEventFromLegacy } from "../src/canonical/fromLegacyEvent.js";
import { SessionManager } from "../src/sessionManager.js";
import { projectorSnapshotToLegacyThread } from "../src/projector/legacyBridge.js";
import { createBaseConfig, createTempDir, waitForMicrotasks } from "./helpers/backendTestUtils.js";

function event(seq, kind, text, messageId = "message-a") {
  return { id: `event-${seq}`, seq, threadId: "thread-stream", turnId: "turn-stream", kind, payload: { text, messageId } };
}

test("delta append preserves repeated tokens, spaces and newlines without prefix heuristics", () => {
  const aggregator = createLiveTurnAggregator({ threadId: "thread-stream", turnId: "turn-stream" });
  const chunks = [" ", "same", "same", " ", "same", "\n", "\n", "  ", "tail", "\n"];
  for (const [index, text] of chunks.entries()) aggregator.applyEvent(event(index + 1, "message.delta", text));
  assert.equal(aggregator.getOverlay().message.text, chunks.join(""));
});

test("completed authoritative text replaces the draft even when final formatting differs", () => {
  const aggregator = createLiveTurnAggregator({ threadId: "thread-stream", turnId: "turn-stream" });
  const draft = "\u5de6\u4e0a\uff1a\u7ea2\u8272\u6b63\u65b9\u5f62\u3002\u53f3\u4e0a\uff1a\u84dd\u8272\u5706\u5f62\u3002\u5e95\u90e8\uff1a\u7eff\u8272\u957f\u65b9\u5f62\u3002";
  const final = "\u5de6\u4e0a\uff1a\u7ea2\u8272\u6b63\u65b9\u5f62\u3002\n\u53f3\u4e0a\uff1a\u84dd\u8272\u5706\u5f62\u3002\n\u5e95\u90e8\uff1a\u7eff\u8272\u957f\u65b9\u5f62\u3002";
  aggregator.applyEvent(event(1, "message.delta", draft));
  aggregator.applyEvent(event(2, "message.completed", final));
  aggregator.applyEvent(event(3, "message.completed", final));
  assert.equal(aggregator.getOverlay().message.text, final);
});

test("separate completed item IDs keep both messages while completion replay replaces only its own item", () => {
  const aggregator = createLiveTurnAggregator({ threadId: "thread-stream", turnId: "turn-stream" });
  aggregator.applyEvent(event(1, "message.delta", "first draft", "first"));
  aggregator.applyEvent(event(2, "message.completed", "first", "first"));
  aggregator.applyEvent(event(3, "message.delta", "second", "second"));
  aggregator.applyEvent(event(4, "message.completed", "second", "second"));
  aggregator.applyEvent(event(5, "message.completed", "first", "first"));
  assert.equal(aggregator.getOverlay().message.text, "first\n\nsecond");
});

test("legacy event mapping distinguishes streaming chunks from completed authoritative messages", () => {
  const make = (phase) => createCanonicalEventFromLegacy({
    id: `legacy-${phase}`, seq: 1, threadId: "thread-stream", turnId: "turn-stream", eventType: "agent_message_recorded",
    payload: { text: " \nhello\n", phase, messageId: "item-1" }
  });
  assert.equal(make("streaming").kind, "message.delta");
  for (const phase of ["final_answer", "final", "completed", undefined]) {
    const canonical = make(phase);
    assert.equal(canonical.kind, "message.completed");
    assert.equal(canonical.payload.text, " \nhello\n");
    assert.equal(canonical.payload.messageId, "item-1");
  }
});

function fixture(t) {
  const root = createTempDir();
  const bridge = new EventEmitter();
  bridge.startTurn = async (session) => {
    session.resumeSessionId = "thread-stream";
    return { turn: { id: "turn-stream", status: "inProgress", items: [] } };
  };
  const manager = new SessionManager(createBaseConfig(root), { appServerBridge: bridge });
  manager.scheduleConversationHistoryResync = () => {};
  const events = [];
  manager.broadcast = (session, payload) => events.push(payload);
  const session = manager.get(manager.create({ provider: "codex" }).id);
  const notify = (method, params) => bridge.emit("notification", { method, params: { threadId: "thread-stream", turnId: "turn-stream", ...params } });
  t.after(() => { manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { bridge, manager, session, notify, events };
}

test("real-shape app-server deltas preserve whitespace and final multiline output exactly once", async (t) => {
  const { manager, session, notify, events } = fixture(t);
  manager.write(session.id, "inspect image");
  await waitForMicrotasks();
  const chunks = ["\u5de6\u4e0a\uff1a", "\u7ea2\u8272\u6b63\u65b9\u5f62\u3002", "\n", "\u53f3\u4e0a\uff1a", "\u84dd\u8272\u5706\u5f62\u3002", "\n", "\u5e95\u90e8\uff1a", "\u7eff\u8272\u957f\u65b9\u5f62\u3002"];
  const text = chunks.join("");
  for (const delta of chunks) notify("item/agentMessage/delta", { itemId: "image-description", delta });
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, text);
  assert.equal(events.filter((payload) => payload.type === "message.delta" && payload.text === "\n").length, 2);
  const completeItem = () => notify("item/completed", { item: { id: "image-description", type: "agentMessage", phase: "final_answer", text } });
  completeItem();
  completeItem();
  notify("turn/completed", { turn: { id: "turn-stream", status: "completed", error: null } });
  assert.equal(session.threadSnapshot.turns[0].items.filter((item) => item.kind === "AgentMessage").length, 1);
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, text);
});

test("real-shape repeating single-token deltas append every occurrence", async (t) => {
  const { manager, session, notify } = fixture(t);
  manager.write(session.id, "repeat");
  await waitForMicrotasks();
  for (const delta of ["ha", "ha", " ", "ha"]) notify("item/agentMessage/delta", { itemId: "repeat", delta });
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, "haha ha");
});

test("authoritative app-server completion preserves leading and trailing whitespace", async (t) => {
  const { manager, session, notify } = fixture(t);
  manager.write(session.id, "preserve output");
  await waitForMicrotasks();
  const text = "  indented\n\n    nested\n".repeat(6);
  notify("item/completed", { item: { id: "whitespace", type: "agentMessage", phase: "final_answer", text } });
  notify("turn/completed", { turn: { id: "turn-stream", status: "completed", error: null } });
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, text);
});

test("reading conversation repeatedly during a live turn neither commits the draft nor duplicates its final reply", async (t) => {
  const { manager, session, notify } = fixture(t);
  manager.write(session.id, "return PROJECT-ID-OK");
  await waitForMicrotasks();
  const projection = session.threadProjection;
  for (const delta of ["PROJECT-", "ID-", "OK"]) {
    notify("item/agentMessage/delta", { itemId: "project-message", delta });
    manager.getConversationSnapshot(session.id);
    manager.getConversationSnapshot(session.id);
    assert.equal(session.threadProjection, projection);
  }
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, "PROJECT-ID-OK");
  notify("item/completed", { item: { id: "project-message", type: "agentMessage", phase: "final_answer", text: "PROJECT-ID-OK" } });
  manager.getConversationSnapshot(session.id);
  notify("turn/completed", { turn: { id: "turn-stream", status: "completed", error: null } });
  const result = manager.getConversationSnapshot(session.id);
  assert.equal(result.threadSnapshot.turns[0].items.filter((item) => item.kind === "AgentMessage").length, 1);
  assert.deepEqual(result.conversation.turns[0].assistant.body.map((part) => part.text), ["PROJECT-ID-OK"]);
});

test("legacy overlay replaces the same synthetic ID without collapsing distinct official messages", () => {
  const timestamp = "2026-10-15T00:00:00Z";
  const snapshot = { threadId: "thread", metadata: {}, turns: [{
    id: "turn", status: "running", startedAt: timestamp, items: [
      { id: "message:turn", kind: "AgentMessage", text: "draft", createdAt: timestamp },
      { id: "official-a", kind: "AgentMessage", text: "same text", createdAt: timestamp },
      { id: "official-b", kind: "AgentMessage", text: "same text", createdAt: timestamp }
    ]
  }] };
  const result = projectorSnapshotToLegacyThread(snapshot, {
    turnId: "turn", message: { text: "updated draft" }, tools: [], artifacts: []
  });
  assert.deepEqual(result.turns[0].items.map((item) => [item.id, item.text]), [
    ["message:turn", "updated draft"], ["official-a", "same text"], ["official-b", "same text"]
  ]);
});

test("history continuation polling preserves the active projector and final message", async (t) => {
  const { manager, session, notify } = fixture(t);
  manager.write(session.id, "return PROJECT-ID-OK");
  await waitForMicrotasks();
  const projection = session.threadProjection;
  for (const delta of ["PROJECT-", "ID-", "OK"]) {
    notify("item/agentMessage/delta", { itemId: "project-message", delta });
    manager.getLiveHistoryContinuation("codex", "thread-stream");
    manager.getConversationSnapshot(session.id);
    assert.equal(session.threadProjection, projection);
  }
  notify("item/completed", { item: { id: "project-message", type: "agentMessage", phase: "final_answer", text: "PROJECT-ID-OK" } });
  manager.getLiveHistoryContinuation("codex", "thread-stream");
  notify("turn/completed", { turn: { id: "turn-stream", status: "completed", error: null } });
  const continuation = manager.getLiveHistoryContinuation("codex", "thread-stream");
  assert.deepEqual(continuation.conversation.turns[0].assistant.body.map((part) => part.text), ["PROJECT-ID-OK"]);
  assert.equal(continuation.threadSnapshot.turns[0].items.filter((item) => item.kind === "AgentMessage").length, 1);
});
