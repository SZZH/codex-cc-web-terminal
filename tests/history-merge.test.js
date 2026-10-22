import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryPayloadResolver } from "../src/routes/historyPayloads.js";
import { createThreadRuntimeController } from "../web/src/lib/thread-runtime.js";
import { buildDisplayedThreadSnapshot } from "../web/src/lib/thread-display-state.js";

const clone = (value) => structuredClone(value);
const userImage = (id, content) => ({ id, kind: "UserMessage", text: "", payload: { content } });
const assistant = (id, text) => ({ id, kind: "AgentMessage", text });
const snapshot = (items, status = "completed") => ({ threadId: "thread", turns: [{ id: "turn", status, items }], metadata: { name: "official title" } });

function serverBundle(base, live, { baseConversation, liveConversation } = {}) {
  const resolver = createHistoryPayloadResolver({
    getHistoricalMessages: () => ({ threadSnapshot: base, conversation: baseConversation, session: { id: "history:codex:thread" } }),
    getThreadSnapshotBundle: () => ({}),
    getThreadContinuationRuntime: () => ({ threadSnapshot: live, conversation: liveConversation, session: { id: "live" } })
  });
  return resolver.getThreadBundle("codex", "thread");
}

test("server pure-image history and live user items normalize image paths and retain official identity", () => {
  const official = userImage("official-user-uuid", [{ type: "input_image", image_url: "/tmp/qa/image.png" }]);
  const live = userImage("user-message:turn:1", [{ type: "localImage", path: "/tmp/qa/./image.png" }]);
  const result = serverBundle(snapshot([official]), snapshot([live]));
  assert.equal(result.threadSnapshot.turns[0].items.length, 1);
  assert.equal(result.threadSnapshot.turns[0].items[0].id, "official-user-uuid");
  assert.deepEqual(result.turns[0].user.content, official.payload.content);
});

test("server image equivalence treats local proxy and raw path as one image without merging different images", () => {
  const official = userImage("official", [{ type: "image", url: "/tmp/qa/image.png" }]);
  const same = userImage("live-user", [{ type: "input_image", image_url: "/api/local-file-image?path=%2Ftmp%2Fqa%2Fimage.png" }]);
  const different = userImage("other-user", [{ type: "input_image", image_url: "/tmp/qa/other.png" }]);
  const result = serverBundle(snapshot([official]), snapshot([same, different]));
  assert.equal(result.threadSnapshot.turns[0].items.length, 2);
  assert.equal(result.threadSnapshot.turns[0].items[0].id, "official");
});

test("completed official body and metadata replace stale live fragments instead of appending a second answer", () => {
  const official = snapshot([assistant("official-answer", "MULTILINE-OK")]);
  const live = snapshot([assistant("livemessage:turn", "prefixMULTILINE-OK")], "inProgress");
  live.metadata.name = "stale title";
  const result = serverBundle(official, live, {
    baseConversation: { threadId: "thread", turns: [{ id: "turn", assistant: { status: "completed", body: [{ id: "official-answer", kind: "markdown", text: "MULTILINE-OK" }] } }] },
    liveConversation: { threadId: "thread", turns: [{ id: "turn", assistant: { status: "running", body: [{ id: "livemessage:turn", kind: "markdown", text: "prefixMULTILINE-OK" }] } }] }
  });
  assert.deepEqual(result.threadSnapshot.turns[0].items.map((item) => item.text), ["MULTILINE-OK"]);
  assert.deepEqual(result.turns[0].assistant.body.map((item) => item.text), ["MULTILINE-OK"]);
  assert.equal(result.threadSnapshot.metadata.name, "official title");
});

test("matching synthetic runtime text is deduplicated while distinct official items remain separate", () => {
  const official = snapshot([assistant("official-1", "same"), assistant("official-2", "same")], "inProgress");
  const live = snapshot([assistant("livemessage:turn", "same")], "inProgress");
  const result = serverBundle(official, live);
  assert.equal(result.threadSnapshot.turns[0].items.length, 2);
  assert.deepEqual(result.threadSnapshot.turns[0].items.map((item) => item.id), ["official-1", "official-2"]);
});

function frontend() {
  const state = { liveView: { conversation: { threadId: "thread", turns: [] }, messages: [], backgroundAgents: [] },
    threadView: { threadId: "thread", persistedSnapshot: null, authoritativeSnapshot: null } };
  const runtime = createThreadRuntimeController({ state, setMessages: (messages) => { state.liveView.messages = messages; } });
  const displayed = () => buildDisplayedThreadSnapshot({ persistedSnapshot: state.threadView.persistedSnapshot,
    authoritativeSnapshot: state.threadView.authoritativeSnapshot, liveConversation: state.liveView.conversation,
    runtimeMessages: state.liveView.messages, threadId: "thread" });
  return { state, runtime, displayed };
}

test("official full snapshot clears old live text copies in conversation and the final display", () => {
  const h = frontend();
  const final = snapshot([assistant("official-answer", "MULTILINE-OK")]);
  h.runtime.setLiveThreadSnapshot(clone(final));
  h.runtime.setConversation({ threadId: "thread", turns: [{ id: "turn", assistant: { status: "completed", body: [
    { id: "historymsg_uuid", kind: "markdown", text: "MULTILINE-OK" },
    { id: "livemessage:turn", kind: "markdown", text: "MULTILINE-OK" }
  ] } }] }, { force: true });
  h.runtime.setThreadSnapshot(clone(final));
  assert.deepEqual(h.state.liveView.conversation.turns[0].assistant.body.map((part) => part.id), ["official-answer"]);
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.text), ["MULTILINE-OK"]);
});

test("official snapshot then a synthetic partial and final snapshot render a single markdown image", () => {
  const h = frontend();
  const text = "![QA image](/tmp/qa.png)";
  const initial = snapshot([assistant("official-answer", text)], "inProgress");
  h.runtime.setLiveThreadSnapshot(clone(initial));
  h.runtime.setLiveThreadSnapshot(snapshot([assistant("livemessage:turn", text)], "inProgress"), null, { partial: true });
  h.runtime.setConversation({ threadId: "thread", turns: [{ id: "turn", assistant: { status: "running", body: [
    { id: "historymsg_uuid", kind: "markdown", text }, { id: "livemessage:turn", kind: "markdown", text }
  ] } }] }, { force: true });
  h.runtime.setLiveThreadSnapshot(snapshot([assistant("official-answer", text)]));
  const visible = h.displayed().turns[0].items.filter((item) => item.kind === "AgentMessage");
  assert.deepEqual(visible.map((item) => item.text), [text]);
  assert.deepEqual(h.state.liveView.conversation.turns[0].assistant.body.map((item) => item.id), ["official-answer"]);
});

test("typed message copies reuse the existing official body item ID", () => {
  const h = frontend();
  const conversation = { threadId: "thread", turns: [{ id: "turn", assistant: { status: "running", body: [{ id: "official-answer", kind: "markdown", text: "answer" }] } }] };
  const result = h.runtime.appendMessageEventToConversation(conversation, { turnId: "turn", messageId: "livemessage:turn", text: "answer", phase: "final" });
  assert.equal(result.turns[0].assistant.body.length, 1);
  assert.equal(result.turns[0].assistant.body[0].id, "official-answer");
});

test("display maps separate official body item IDs without flattening identical messages", () => {
  const h = frontend();
  h.runtime.setConversation({ threadId: "thread", turns: [{ id: "turn", assistant: { status: "running", body: [
    { id: "official-one", kind: "markdown", text: "same" }, { id: "official-two", kind: "markdown", text: "same" }
  ] } }] }, { force: true });
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.id), ["official-one", "official-two"]);
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.text), ["same", "same"]);
});

test("display collapses synthetic body copies even before the first official full snapshot", () => {
  const h = frontend();
  const text = "![QA image](/tmp/qa.png)";
  h.runtime.setConversation({ threadId: "thread", turns: [{ id: "turn", assistant: { status: "running", body: [
    { id: "historymsg_uuid", kind: "markdown", text }, { id: "livemessage:turn", kind: "markdown", text }
  ] } }] }, { force: true });
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.text), [text]);
});

test("a shorter running full snapshot cannot roll back an active more complete live body", () => {
  const h = frontend();
  h.runtime.setConversation({ threadId: "thread", activeTurnId: "turn", turns: [{ id: "turn", assistant: { status: "running", body: [
    { id: "livemessage:turn", kind: "markdown", text: "first line\nsecond line" }
  ] } }] }, { force: true });
  h.runtime.setLiveThreadSnapshot(snapshot([assistant("official-answer", "first line")], "inProgress"));
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.text), ["first line\nsecond line"]);
  assert.equal(h.displayed().turns[0].items[0].id, "official-answer");
});

test("server preserves two official turns with identical user text twenty seconds apart", () => {
  const firstId = "019daf2c-f5a0-7033-a87c-b5df6ddef277";
  const nextId = "019daf2d-43c0-7033-b04b-5739fead9528";
  const first = { id: firstId, status: "completed", startedAt: "2026-10-15T11:00:00Z", items: [
    { id: "official-user-a", kind: "UserMessage", text: "继续" }, assistant("official-answer-a", "first reply")
  ] };
  const second = { id: nextId, status: "inProgress", startedAt: "2026-10-15T11:00:20Z", items: [
    { id: "official-user-b", kind: "UserMessage", text: "继续" }, assistant("official-answer-b", "second reply")
  ] };
  const result = serverBundle({ threadId: "thread", turns: [first] }, { threadId: "thread", turns: [second] });
  assert.deepEqual(result.threadSnapshot.turns.map((turn) => turn.id), [firstId, nextId]);
  assert.deepEqual(result.threadSnapshot.turns.flatMap((turn) => turn.items.filter((item) => item.kind === "AgentMessage").map((item) => item.text)), ["first reply", "second reply"]);
});

test("display preserves two official turns with the same user and assistant text", () => {
  const firstId = "019daf2c-f5a0-7033-a87c-b5df6ddef277";
  const nextId = "019daf2d-43c0-7033-b04b-5739fead9528";
  const visible = buildDisplayedThreadSnapshot({ threadId: "thread",
    authoritativeSnapshot: { threadId: "thread", turns: [{ id: firstId, status: "completed", startedAt: "2026-10-15T11:00:00Z", items: [
      { id: "user-a", kind: "UserMessage", text: "继续" }, assistant("answer-a", "same reply")
    ] }] },
    liveConversation: { threadId: "thread", turns: [{ id: nextId, user: { text: "继续" }, assistant: {
      status: "running", startedAt: "2026-10-15T11:00:05Z", body: [{ id: "answer-b", text: "same reply" }]
    } }] }
  });
  assert.deepEqual(visible.turns.map((turn) => turn.id), [firstId, nextId]);
});

test("completed history backfill clears stale active pointers and unlocks the tracked input", () => {
  const h = frontend();
  h.state.loading = true;
  h.state.liveView.activeInputStream = true;
  h.state.liveView.streamBuffer = "stale text";
  h.state.liveView.inputTurnId = "turn";
  h.state.liveView.liveOverlay = { turnId: "turn", text: "stale overlay" };
  h.state.threadView.authoritativeSnapshot = { ...snapshot([assistant("live", "partial")], "inProgress"), activeTurnId: "turn", status: "running" };
  h.runtime.setConversation({ threadId: "thread", activeTurnId: "turn", status: "running", turns: [{ id: "turn", assistant: {
    status: "running", body: [{ id: "live", text: "partial" }]
  } }] }, { force: true });
  h.runtime.setThreadSnapshot(snapshot([assistant("official", "complete reply")]));
  assert.equal(h.state.threadView.authoritativeSnapshot.activeTurnId, null);
  assert.equal(h.state.threadView.authoritativeSnapshot.status, "completed");
  assert.equal(h.state.liveView.conversation.activeTurnId, "");
  assert.equal(h.state.liveView.conversation.status, "completed");
  assert.equal(h.state.liveView.activeInputStream, false);
  assert.equal(h.state.liveView.streamBuffer, "");
  assert.equal(h.state.loading, false);
  assert.equal(h.state.liveView.liveOverlay, null);
  assert.deepEqual(h.displayed().turns[0].items.map((item) => item.text), ["complete reply"]);
});

test("backfilling an older completed turn preserves a different new running input and overlay", () => {
  const h = frontend();
  h.state.loading = true;
  h.state.liveView.activeInputStream = true;
  h.state.liveView.inputTurnId = "new-turn";
  h.state.liveView.liveOverlay = { turnId: "new-turn", text: "new partial" };
  h.state.threadView.authoritativeSnapshot = { threadId: "thread", activeTurnId: "new-turn", status: "running", turns: [
    { id: "turn", status: "inProgress", items: [assistant("old", "old partial")] },
    { id: "new-turn", status: "inProgress", items: [assistant("new", "new partial")] }
  ] };
  h.runtime.setConversation({ threadId: "thread", activeTurnId: "new-turn", status: "running", turns: [
    { id: "turn", assistant: { status: "running", body: [{ text: "old partial" }] } },
    { id: "new-turn", assistant: { status: "running", body: [{ text: "new partial" }] } }
  ] }, { force: true });
  h.runtime.setThreadSnapshot(snapshot([assistant("official", "old complete")]));
  assert.equal(h.state.threadView.authoritativeSnapshot.activeTurnId, "new-turn");
  assert.equal(h.state.liveView.conversation.activeTurnId, "new-turn");
  assert.equal(h.state.liveView.conversation.status, "running");
  assert.equal(h.state.liveView.activeInputStream, true);
  assert.equal(h.state.loading, true);
  assert.equal(h.state.liveView.liveOverlay.turnId, "new-turn");
});
