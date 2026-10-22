import test from "node:test";
import assert from "node:assert/strict";
import { activeCodexTurnId, createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexHistoryItems } from "../web/src/lib/codex-history-items.js";
import { codexRequestError, presentCodexChatSnapshot, presentCodexQueue } from "../web/src/lib/codex-chat-presentation.js";

test("the latest finished turn supersedes stale running history and receipts without hiding a newly accepted turn", () => {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "older", status: "inProgress" });
  store.upsertRequest({ id: "older-answer", state: "running", executionRoute: "desktopQuestion", turnId: "older" });
  store.upsertTurn({ id: "latest", status: "completed" });
  assert.equal(activeCodexTurnId(store.state), "");
  store.upsertRequest({ id: "next-request", state: "accepted", turnId: "not-yet-loaded" });
  assert.equal(activeCodexTurnId(store.state), "not-yet-loaded", "the accepted response can precede the turn event");
  store.upsertTurn({ id: "not-yet-loaded", status: "inProgress" });
  assert.equal(activeCodexTurnId(store.state), "not-yet-loaded");
  store.upsertTurn({ id: "not-yet-loaded", status: "completed" });
  assert.equal(activeCodexTurnId(store.state), "", "neither old running history nor stale receipts revive a completed task");
});

test("desktop removal survives reload without a queue row or false interrupted turn, then accepts execution evidence", () => {
  const storage = memoryStorage();
  let store = createCodexChatStore("thread", { storage });
  store.upsertRequest({ id: "desktop-request", state: "queued", mode: "queue", executionRoute: "desktopQueue",
    input: { text: "pending" }, updatedAt: "2026-10-20T00:00:00Z" });
  store.upsertRequest({ id: "desktop-request", state: "removed", updatedAt: "2026-10-20T00:00:02Z" });
  store.persist();
  store = createCodexChatStore("thread", { storage });
  store.upsertRequest({ id: "desktop-request", state: "queued", updatedAt: "2026-10-20T00:00:01Z" });
  assert.equal(presentCodexQueue(store.state).length, 0);
  assert.equal(presentCodexChatSnapshot(store.state).turns.length, 0);
  assert.equal(store.state.requests["desktop-request"].state, "removed");
  store.upsertRequest({ id: "desktop-request", state: "accepted", turnId: "actual-turn", userItemId: "actual-user", updatedAt: "2026-10-20T00:00:03Z" });
  assert.equal(store.state.requests["desktop-request"].state, "accepted");
  assert.equal(presentCodexChatSnapshot(store.state).turns.length, 1);
});

test("persisted writer conflicts describe the supported original runtime without suggesting an unavailable handoff", () => {
  const receipt = { state: "rejected", error: { code: "thread_in_use", message: "请交接后重试。" } };
  assert.match(codexRequestError(receipt), /尚未发出/);
  assert.match(codexRequestError(receipt), /在网页重新发送/);
  assert.equal(receipt.error.message, "请交接后重试。");
  assert.equal(codexRequestError({ error: { code: "other", message: "原始错误" } }), "原始错误");
});

test("desktop queued message stays outside the timeline until its official client message appears", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  store.upsertRequest({ id: "desktop-request", state: "queued", mode: "queue", executionRoute: "desktopQueue",
    input: { text: "continue", attachments: [] } });
  assert.deepEqual(presentCodexQueue(store.state).map((request) => request.id), ["desktop-request"]);
  assert.equal(presentCodexChatSnapshot(store.state).turns.length, 0);
  store.upsertTurn({ id: "desktop-turn", status: "inProgress", items: [
    { id: "desktop-user", type: "userMessage", clientId: "desktop-request", text: "continue" }
  ] });
  assert.equal(presentCodexQueue(store.state).length, 0);
  const snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns.map((turn) => turn.id), ["desktop-turn"]);
  assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ["desktop-user"]);
  assert.equal(snapshot.turns[0].items[0].request.state, "running");
  assert.equal(store.state.requests["desktop-request"].state, "queued");
  store.upsertTurn({ id: "desktop-turn", status: "completed" });
  assert.equal(presentCodexChatSnapshot(store.state).turns[0].items[0].request.state, "completed");
  assert.equal(store.state.requests["desktop-request"].state, "queued");
});

test("official user item arriving before its queued receipt remains one message through turn completion", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  store.upsertTurn({ id: "desktop-turn", status: "inProgress", items: [
    { id: "desktop-user", type: "userMessage", clientId: "late-receipt", text: "continue" }
  ] });
  store.upsertRequest({ id: "late-receipt", state: "queued", mode: "queue", executionRoute: "desktopQueue",
    input: { text: "continue", attachments: [] } });

  let snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns.map((turn) => turn.id), ["desktop-turn"]);
  assert.deepEqual(snapshot.turns.flatMap((turn) => turn.items.map((item) => item.id)), ["desktop-user"]);
  assert.equal(snapshot.turns[0].items[0].request.state, "running");
  assert.equal(presentCodexQueue(store.state).length, 0);

  store.upsertTurn({ id: "desktop-turn", status: "completed" });
  snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns.flatMap((turn) => turn.items.map((item) => item.id)), ["desktop-user"]);
  assert.equal(snapshot.turns[0].items[0].request.state, "completed");
  assert.equal(store.state.requests["late-receipt"].state, "queued");
});
import { buildThreadViewModel } from "../web/src/lib/thread-view-model.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}

test("server confirmation supersedes a locally timed request without comparing client and server clocks", () => {
  for (const localTime of ["2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"]) {
    const storage = memoryStorage();
    const store = createCodexChatStore("thread", { storage });
    const local = { id: "clock", threadId: "thread", state: "sending", localOnly: true,
      input: { text: "once" }, createdAt: localTime, updatedAt: localTime };
    store.queueRequest(local);
    store.upsertRequest({ id: "clock", state: "accepted", turnId: "turn", updatedAt: "2027-01-01T00:00:00Z" });
    assert.equal(store.state.requests.clock.state, "accepted");
    store.upsertRequest({ ...local, state: "unknown", error: { message: "late network failure" } });
    assert.equal(store.state.requests.clock.state, "accepted");
    assert.equal(createCodexChatStore("thread", { storage }).state.requests.clock.state, "accepted");
  }
});

test("restoring an older sending record retains its local origin until server confirmation", () => {
  const storage = memoryStorage();
  storage.setItem("codex-chat-v2:thread", JSON.stringify({ threadId: "thread", draft: { text: "new draft", attachments: [] },
    requests: [{ id: "clock", threadId: "thread", state: "sending", updatedAt: "2028-01-01T00:00:00Z" }] }));
  const store = createCodexChatStore("thread", { storage });
  assert.equal(store.state.requests.clock.state, "unknown");
  store.upsertRequest({ id: "clock", state: "running", turnId: "turn", updatedAt: "2027-01-01T00:00:00Z" });
  assert.equal(store.state.requests.clock.state, "running");
  assert.equal(store.state.draft.text, "new draft");
});

test("a restored local unknown or rejection yields to server acknowledgement with an earlier clock", () => {
  for (const state of ["unknown", "rejected"]) {
    const storage = memoryStorage();
    storage.setItem("codex-chat-v2:thread", JSON.stringify({ threadId: "thread", draft: { text: "new draft", attachments: [] },
      requests: [{ id: "clock", threadId: "thread", state, localOnly: true, updatedAt: "2028-01-01T00:00:00Z" }] }));
    const store = createCodexChatStore("thread", { storage });
    store.upsertRequest({ id: "clock", state: "accepted", updatedAt: "2027-01-01T00:00:00Z" });
    assert.equal(store.state.requests.clock.state, "accepted");
    assert.equal(createCodexChatStore("thread", { storage }).state.requests.clock.state, "accepted");
    assert.equal(store.state.draft.text, "new draft");
  }
});

test("server receipts can correct local rejection while server terminal and timestamp protection remains", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  store.upsertRequest({ id: "local", state: "rejected", localOnly: true, updatedAt: "2028-01-01T00:00:00Z" });
  store.upsertRequest({ id: "local", state: "accepted", updatedAt: "2027-01-01T00:00:00Z" });
  assert.equal(store.state.requests.local.state, "accepted");
  store.upsertRequest({ id: "server", state: "running", updatedAt: "2027-01-01T00:00:02Z" });
  store.upsertRequest({ id: "server", state: "accepted", updatedAt: "2027-01-01T00:00:01Z" });
  assert.equal(store.state.requests.server.state, "running");
  store.upsertRequest({ id: "server", state: "completed", updatedAt: "2027-01-01T00:00:03Z" });
  store.upsertRequest({ id: "server", state: "running", updatedAt: "2027-01-01T00:00:04Z" });
  assert.equal(store.state.requests.server.state, "completed");
});

test("receipt list readiness must be checked again after restoring the same thread", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.state.requestListReady = true;
  store.state.requestListError = "previous transient error";
  store.setDraft({ text: "retained" });
  const restored = createCodexChatStore("thread", { storage });
  assert.equal(restored.state.draft.text, "retained");
  assert.equal(restored.state.requestListReady, false);
  assert.equal(restored.state.requestListError, "");
});

test("a successfully persisted local submission stays marked through server updates without restoring that transient mark", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.queueRequest({ id: "local-steer", state: "sending", mode: "steer", input: { text: "continue" } });
  assert.deepEqual(store.state.submittedRequestIds, ["local-steer"]);
  store.upsertRequest({ id: "local-steer", state: "completed", mode: "steer", turnId: "turn" });
  assert.deepEqual(store.state.submittedRequestIds, ["local-steer"]);
  const persisted = JSON.parse(storage.getItem(store.storageKey));
  assert.equal(Object.hasOwn(persisted, "submittedRequestIds"), false);
  const restored = createCodexChatStore("thread", { storage });
  assert.deepEqual(restored.state.submittedRequestIds, []);
  assert.equal(restored.state.requests["local-steer"].state, "completed");
});

test("a local submission that fails persistence never receives a submitted marker", () => {
  const store = createCodexChatStore("thread", { storage: { getItem: () => null, setItem() { throw new Error("disk unavailable"); } } });
  assert.throws(() => store.queueRequest({ id: "failed-local", state: "sending", input: { text: "keep me" } }), /disk unavailable/);
  assert.deepEqual(store.state.submittedRequestIds, []);
  assert.equal(store.state.requests["failed-local"], undefined);
});

test("queue placement survives delayed server receipts, persistence, refresh and a late cancellation after execution", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.queueRequest({ id: "followup", state: "sending", mode: "queue", initialPlacement: "composer",
    input: { text: "next", attachments: [{ id: "photo" }] }, updatedAt: "2028-01-01T00:00:00Z" });
  const pendingRead = store.beginRead();
  store.upsertRequest({ id: "followup", state: "received", localOnly: false, updatedAt: "2027-01-01T00:00:00Z" });
  store.upsertRequest({ id: "followup", state: "accepted", turnId: "stale-turn" }, pendingRead);
  assert.equal(store.state.requests.followup.state, "received", "a stale read cannot consume the newer queue state");
  store.upsertRequest({ id: "followup", state: "dispatching", updatedAt: "2027-01-01T00:00:01Z" });
  store.setDraft({ text: "new draft" });
  let restored = createCodexChatStore("thread", { storage });
  assert.equal(restored.state.requests.followup.initialPlacement, "composer");
  assert.deepEqual(presentCodexQueue(restored.state).map((request) => request.id), ["followup"]);
  assert.equal(presentCodexQueue(restored.state)[0].images[0].url, "/api/attachments/images/photo");
  assert.equal(restored.state.draft.text, "new draft");
  restored.upsertRequest({ id: "followup", state: "running", turnId: "real-turn", updatedAt: "2027-01-01T00:00:02Z" });
  restored.upsertRequest({ id: "followup", state: "cancelled", updatedAt: "2027-01-01T00:00:03Z" });
  restored = createCodexChatStore("thread", { storage });
  assert.equal(restored.state.requests.followup.executionConfirmed, true);
  assert.equal(presentCodexQueue(restored.state).length, 0);
  assert.equal(presentCodexChatSnapshot(restored.state).turns[0].items[0].text, "next", "proven execution is retained");
});

test("restoring saved optimistic queue input remains a checkable composer message without replay", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.queueRequest({ id: "pending", mode: "queue", state: "sending", initialPlacement: "composer", input: { text: "pending" } });
  const restored = createCodexChatStore("thread", { storage });
  assert.equal(restored.state.requests.pending.state, "unknown");
  assert.equal(presentCodexQueue(restored.state)[0].request.state, "unknown");
  assert.equal(presentCodexChatSnapshot(restored.state).turns.length, 0);
  restored.upsertRequest({ id: "pending", state: "queued", localOnly: false });
  restored.upsertRequest({ id: "pending", state: "cancelled" });
  const cancelled = createCodexChatStore("thread", { storage });
  assert.equal(cancelled.state.requests.pending.state, "cancelled");
  assert.equal(presentCodexQueue(cancelled.state).length, 0);
  assert.equal(presentCodexChatSnapshot(cancelled.state).turns.length, 0);
});
const item = (id, text, status = "inProgress") => ({ id, type: "agentMessage", text, status, presentation: { text } });
function fixture() {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  const generation = store.beginSocket();
  const event = (seq, type, payload, epoch = "one", socket = generation) => store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch, seq, type, payload }, socket);
  event(0, "sync.required", {});
  return { store, event, generation };
}

test("waiting messages retain queue order and images through restoration and dispatch until acceptance", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.upsertRequest({ id: "queue-1", mode: "queue", state: "received", input: { text: "next message", attachments: [] } });
  store.upsertRequest({ id: "queue-2", mode: "queue", state: "received", input: { text: "", attachments: [{ id: "image-123" }] } });
  const restored = createCodexChatStore("thread", { storage });
  assert.deepEqual(presentCodexQueue(restored.state).map((request) => request.id), ["queue-1", "queue-2"]);
  assert.equal(presentCodexQueue(restored.state)[1].images[0].url, "/api/attachments/images/image-123");
  assert.equal(presentCodexChatSnapshot(restored.state).turns.length, 0);
  restored.upsertRequest({ ...restored.state.requests["queue-1"], state: "dispatching" });
  assert.deepEqual(presentCodexQueue(restored.state).map((request) => request.id), ["queue-1", "queue-2"]);
  assert.equal(presentCodexChatSnapshot(restored.state).turns.length, 0);
  restored.upsertRequest({ id: "queue-1", state: "accepted", turnId: "new-turn" });
  assert.deepEqual(presentCodexQueue(restored.state).map((request) => request.id), ["queue-2"]);
  assert.equal(presentCodexChatSnapshot(restored.state).turns[0].items[0].text, "next message");
});

test("official acknowledgement, steer and rejected messages never remain in the waiting queue", () => {
  const { store } = fixture();
  store.upsertRequest({ id: "started", mode: "queue", state: "received", input: { text: "started" } });
  store.upsertRequest({ id: "steer", mode: "steer", state: "received", expectedTurnId: "turn", input: { text: "followup" } });
  store.upsertRequest({ id: "rejected", mode: "queue", state: "rejected", input: { text: "retained" } });
  store.applyTurnsPage({ turns: [{ id: "turn", status: "inProgress", items: [
    { id: "official-user", type: "userMessage", clientId: "started", content: [{ type: "text", text: "started" }] }
  ] }] });
  assert.equal(presentCodexQueue(store.state).length, 0);
  const messages = presentCodexChatSnapshot(store.state).turns.flatMap((turn) => turn.items);
  assert.deepEqual(messages.map((entry) => entry.text), ["started", "followup", "retained"]);
});

test("late pages cannot roll back streamed items or completed turns, and do not delete other pages", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "old", status: "completed", items: [item("old-message", "old", "completed")] }], olderCursor: "cursor", hasMore: true });
  event(1, "item.upsert", { turnId: "latest", item: item("answer", "first") });
  const pendingPage = store.beginRead();
  event(2, "item.delta", { turnId: "latest", itemId: "answer", field: "text", text: " second" });
  event(3, "turn.upsert", { turn: { id: "latest", status: "completed" } });
  store.applyTurnsPage({ turns: [{ id: "latest", status: "inProgress", items: [item("answer", "first")] }], hasMore: false }, pendingPage);
  assert.equal(store.state.turns.latest.items.answer.text, "first second");
  assert.equal(store.state.turns.latest.status, "completed");
  assert.deepEqual(store.state.turnOrder, ["old", "latest"]);
  assert.equal(store.state.hasMore, true);
  assert.equal(store.state.olderCursor, "cursor");
});

test("draft edits preserve read revisions without advancing the history presentation version", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "live", status: "inProgress", items: [item("answer", "initial")] });
  const pending = store.beginRead();
  const version = presentCodexChatSnapshot(store.state).version;
  store.setDraft({ text: "unrelated draft" });
  assert.equal(store.beginRead().revision, pending.revision + 1);
  assert.equal(presentCodexChatSnapshot(store.state).version, version);
  event(1, "item.delta", { turnId: "live", itemId: "answer", field: "text", text: " streamed" });
  store.applyTurnsPage({ turns: [{ id: "live", status: "inProgress", items: [item("answer", "late")] }] }, pending);
  assert.equal(store.state.turns.live.items.answer.text, "initial streamed");
  assert.ok(presentCodexChatSnapshot(store.state).version > version);
});

test("correcting an unconfirmed interrupted history can restore running but never reopens a confirmed interruption", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "external", status: "interrupted", completedAt: null, items: [] }] });
  store.applyTurnsPage({ turns: [{ id: "external", status: "inProgress", completedAt: null, statusSource: "rollout", statusConfirmed: true, items: [] }] });
  assert.equal(store.state.turns.external.status, "inProgress");
  store.applyTurnsPage({ turns: [{ id: "external", status: "unknown", statusSource: "rollout", statusConfirmed: false, items: [] }] });
  assert.equal(presentCodexChatSnapshot(store.state).turns[0].status, "unknown");
  event(1, "turn.upsert", { turn: { id: "external", status: "interrupted" } });
  for (let index = 0; index < 2; index += 1) store.applyTurnsPage({ turns: [{ id: "external", status: "unknown", statusSource: "unconfirmed-history", statusConfirmed: false, items: [] }] });
  assert.equal(store.state.turns.external.status, "interrupted");
  assert.equal(store.state.turns.external.statusConfirmed, true);
});

test("initial and disjoint ascending turn pages retain order around concurrent live turns", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "old", items: [] }, { id: "new", items: [] }] });
  assert.deepEqual(store.state.turnOrder, ["old", "new"]);
  const read = store.beginRead();
  event(1, "turn.upsert", { turn: { id: "live", status: "inProgress" } });
  store.applyTurnsPage({ turns: [{ id: "later-a", items: [] }, { id: "later-b", items: [] }] }, read);
  assert.deepEqual(store.state.turnOrder, ["old", "new", "later-a", "later-b", "live"]);
  store.applyTurnsPage({ turns: [{ id: "earliest-a", items: [] }, { id: "earliest-b", items: [] }, { id: "old", items: [] }] }, store.beginRead(), { older: true });
  assert.deepEqual(store.state.turnOrder, ["earliest-a", "earliest-b", "old", "new", "later-a", "later-b", "live"]);
  store.applyTurnsPage({ turns: [{ id: "first-a", items: [] }, { id: "first-b", items: [] }] }, store.beginRead(), { older: true });
  assert.deepEqual(store.state.turnOrder.slice(0, 4), ["first-a", "first-b", "earliest-a", "earliest-b"]);
});

test("ordered sparse summaries and overlapping item pages insert tools before final replies", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [
    { ...item("user", "question", "completed"), position: 0 },
    { ...item("file", "diff", "completed"), position: 5 },
    { ...item("final", "answer", "completed"), position: 6 }
  ] }] });
  event(1, "item.upsert", { turnId: "turn", item: item("live", "stream") });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "file", "final", "live"]);
  store.applyItemsPage("turn", { items: [
    { ...item("user", "question", "completed"), position: 0 }, item("tool-1", "1"), item("tool-2", "2")
  ], nextCursor: "p2", hasMore: true });
  store.applyItemsPage("turn", { items: [item("tool-2", "2"), item("tool-3", "3"), item("tool-4", "4"),
    { ...item("file", "diff", "completed"), position: 5 }], nextCursor: "p3", hasMore: true });
  store.applyItemsPage("turn", { items: [{ ...item("final", "answer", "completed"), position: 6 }], hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "tool-1", "tool-2", "tool-3", "tool-4", "file", "final", "live"]);
});

test("a sparse summary never moves the final answer ahead of the earlier reply and steer user", () => {
  for (const status of ["inProgress", "completed"]) {
    const { store, event } = fixture();
    const ordered = [
      { id: "original-user", type: "userMessage", position: 0, presentation: { text: "same" } },
      { ...item("first-answer", "same", status), position: 1 },
      { id: "steer-user", type: "userMessage", clientId: "steer-request", position: 2, presentation: { text: "same" } },
      { id: "reasoning", type: "reasoning", position: 3 },
      { ...item("final-answer", "same", status), position: 4 }
    ];
    event(1, "turn.upsert", { turn: { id: "turn", status, items: ordered } });
    store.applyTurnsPage({ turns: [{ id: "turn", status, itemsView: "summary", items: [ordered[0], { ...ordered[4], position: 1 }] }] });
    assert.deepEqual(store.state.turns.turn.itemOrder, ordered.map((value) => value.id));
    store.applyItemsPage("turn", { items: ordered.map((value) => value.id === "final-answer" ? { ...value, position: 1 } : value), hasMore: false });
    assert.deepEqual(store.state.turns.turn.itemOrder, ordered.map((value) => value.id));
    assert.deepEqual(store.state.turns.turn.historyItemOrder, ordered.map((value) => value.id));
  }
});

test("a new summary reply preserves live steer chronology without marking the single WS user as history", () => {
  const { store, event } = fixture();
  const original = { id: "original", type: "userMessage", presentation: { text: "question" } };
  store.applyItemsPage("turn", { items: [original, item("first", "reply")], hasMore: false });
  event(1, "item.upsert", { turnId: "turn", item: { id: "steer", type: "userMessage", clientId: "r", presentation: { text: "followup" } } });
  event(2, "item.upsert", { turnId: "turn", item: item("answer", "streaming") });
  store.applyTurnsPage({ turns: [{ id: "turn", itemsView: "summary", items: [original, { ...item("answer", "streaming"), position: 1 }] }] });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["original", "first", "steer", "answer"]);
  assert.equal(store.state.turns.turn.historyItemOrder.includes("steer"), false);
});

test("official item pages repair existing IDs received out of order without reverting newer WS text", () => {
  const { store, event } = fixture();
  const original = { id: "original", type: "userMessage" };
  const followup = { id: "steer", type: "userMessage", clientId: "r" };
  event(1, "item.upsert", { turnId: "turn", item: original });
  event(2, "item.upsert", { turnId: "turn", item: item("answer", "partial") });
  event(3, "item.upsert", { turnId: "turn", item: item("first", "first") });
  event(4, "item.upsert", { turnId: "turn", item: followup });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [original, item("answer", "partial")] }] });
  const read = store.beginRead();
  event(5, "item.upsert", { turnId: "turn", item: item("answer", "complete latest", "completed") });
  store.applyItemsPage("turn", { items: [original, item("first", "first"), followup, item("answer", "old partial")], hasMore: false }, read);
  assert.deepEqual(store.state.turns.turn.itemOrder, ["original", "first", "steer", "answer"]);
  assert.equal(store.state.turns.turn.items.answer.text, "complete latest");
  store.applyTurnsPage({ turns: [{ id: "turn", items: [original, item("answer", "summary", "completed")] }] }, read);
  assert.deepEqual(store.state.turns.turn.itemOrder, ["original", "first", "steer", "answer"]);
});

test("a late item page cannot undo newer page order or roll back the incremental tail", () => {
  const { store } = fixture();
  store.applyItemsPage("turn", { items: [item("first", "1"), item("second", "2")], nextCursor: "page-2", hasMore: true });
  const oldRead = store.beginRead();
  store.applyItemsPage("turn", { items: [item("steer", "3"), item("final", "4")], latestItemId: "final", nextCursor: null, hasMore: false });
  store.applyItemsPage("turn", { items: [item("first", "1"), item("second", "2"), item("final", "4")], latestItemId: "second", nextCursor: "old-page", hasMore: true }, oldRead);
  assert.deepEqual(store.state.turns.turn.itemOrder, ["first", "second", "steer", "final"]);
  assert.equal(store.state.turns.turn.itemsPageTail, "final");
  assert.equal(store.state.turns.turn.nextCursor, null);
  assert.equal(store.state.turns.turn.hasMore, false);
});

test("a latest window keeps the ascending prefix cursor and completion state independent", () => {
  const { store } = fixture();
  store.applyItemsPage("turn", { items: [item("head", "first")], latestItemId: "head", nextCursor: "prefix-next", hasMore: true });
  store.applyLatestItemsPage("turn", { items: [item("recent", "recent"), item("tail", "last")], latestItemId: "tail", nextCursor: "desc-older", hasMore: true }, store.beginRead(), { reset: true });
  const turn = store.state.turns.turn;
  assert.deepEqual(turn.itemOrder, ["head", "recent", "tail"]);
  assert.equal(turn.itemsPageLoaded, true);
  assert.equal(turn.itemsPageTail, "head");
  assert.equal(turn.nextCursor, "prefix-next");
  assert.equal(turn.itemsNextCursor, "prefix-next");
  assert.equal(turn.hasMore, true);
  assert.equal(turn.hasMoreItems, true);
  assert.equal(turn.itemsLatestLoaded, true);
  assert.equal(turn.itemsLatestTail, "tail");
  assert.equal(turn.itemsLatestHasEarlier, true);
  assert.equal(turn.itemsLatestNextCursor, null);
  assert.equal(turn.itemsLatestHasMore, false);
  assert.equal(turn.itemsHydratedStatus, undefined);
});

test("latest pages preserve sparse primary messages and never deduplicate identical text by content", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", itemsView: "summary", items: [
    { id: "user", type: "userMessage", presentation: { text: "same" } },
    item("first-answer", "same"),
    { id: "steer", type: "userMessage", presentation: { text: "same" } },
    item("final", "same")
  ] }] });
  store.applyLatestItemsPage("turn", { items: [item("reasoning", "same"), item("final", "same")], hasMore: true }, store.beginRead(), { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "first-answer", "steer", "reasoning", "final"]);
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((entry) => entry.id), ["reasoning", "final"]);
  assert.deepEqual(store.state.turns.turn.confirmedItemIds, ["reasoning", "final"]);
  assert.equal(store.state.turns.turn.itemsPageLoaded, undefined);
  store.applyEarlierItemsPage("turn", { items: [
    { id: "user", type: "userMessage", presentation: { text: "same" } }, item("first-answer", "same"),
    { id: "steer", type: "userMessage", presentation: { text: "same" } }
  ], hasMore: false });
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((entry) => entry.id),
    ["user", "first-answer", "steer", "reasoning", "final"]);
});

test("a disjoint latest window follows the known summary and precedes newer websocket output", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [
    { id: "user", type: "userMessage" }, item("old-answer", "old")
  ] }] });
  const read = store.beginRead();
  event(1, "item.upsert", { turnId: "turn", item: item("live", "newest") });
  store.applyLatestItemsPage("turn", { items: [item("recent", "recent"), item("tail", "tail")], latestItemId: "tail", hasMore: true }, read, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "old-answer", "recent", "tail", "live"]);
  assert.deepEqual(store.state.turns.turn.historyItemOrder, ["user", "old-answer", "recent", "tail"]);
});

test("a late descending snapshot precedes a newer disjoint summary reply", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [{ id: "user", type: "userMessage" }] }] });
  const read = store.beginRead();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [{ id: "user", type: "userMessage" }, item("new-final", "new") ] }] });
  store.applyLatestItemsPage("turn", { items: [item("old-tail", "old")], hasMore: true }, read, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "old-tail", "new-final"]);
});

test("disjoint latest slices use known absolute positions before a newer known history item", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [
    { ...item("head", "head"), position: 0 }, { ...item("newer", "newer"), position: 100 }
  ] }] });
  store.applyLatestItemsPage("turn", { items: [
    { ...item("middle", "middle"), position: 50 }, { ...item("tail", "tail"), position: 70 }
  ], hasMore: true }, store.beginRead(), { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["head", "middle", "tail", "newer"]);
});

test("latest reads retain a live steer before its following reply and protect newer WS text", () => {
  const { store, event } = fixture();
  store.applyItemsPage("turn", { items: [{ id: "user", type: "userMessage" }, item("answer", "earlier")], hasMore: false });
  event(1, "item.upsert", { turnId: "turn", item: { id: "steer", type: "userMessage", clientId: "steer-request" } });
  const read = store.beginRead();
  event(2, "item.upsert", { turnId: "turn", item: item("final", "fresh websocket", "completed") });
  store.applyLatestItemsPage("turn", { items: [item("final", "stale HTTP")], hasMore: true }, read, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "answer", "steer", "final"]);
  assert.equal(store.state.turns.turn.items.final.text, "fresh websocket");
  assert.equal(store.state.turns.turn.confirmedItemIds.includes("steer"), false);
});

test("ascending prefix pages catch up through a loaded latest window without moving or duplicating items", () => {
  const { store } = fixture();
  const ordered = Array.from({ length: 8 }, (_, index) => ({ ...item(`item-${index}`, "same"), position: index }));
  store.applyTurnsPage({ turns: [{ id: "turn", items: [ordered[0], ordered[7]] }] });
  store.applyLatestItemsPage("turn", { items: ordered.slice(5), latestItemId: "item-7", hasMore: true }, store.beginRead(), { reset: true });
  store.applyItemsPage("turn", { items: ordered.slice(0, 3), nextCursor: "p2", hasMore: true });
  store.applyItemsPage("turn", { items: ordered.slice(3, 6), nextCursor: "p3", hasMore: true });
  store.applyItemsPage("turn", { items: ordered.slice(6), latestItemId: "item-7", hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemOrder, ordered.map((entry) => entry.id));
  assert.deepEqual(store.state.turns.turn.itemOrder.map((id) => store.state.turns.turn.items[id].position), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(store.state.turns.turn.confirmedItemIds.length, 8);
  assert.equal(store.state.turns.turn.itemsLatestTail, "item-7");
  assert.equal(store.state.turns.turn.hasMore, false);
});

test("concurrent prefix progress does not make a pending latest window precede older prefix items", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("head", "head")] }] });
  const latestRead = store.beginRead();
  store.applyItemsPage("turn", { items: [item("head", "head"), item("middle", "middle")], nextCursor: "prefix-more", hasMore: true });
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], hasMore: true }, latestRead, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["head", "middle", "tail"]);
  assert.equal(store.state.turns.turn.nextCursor, "prefix-more");
});

test("a completed ascending prefix advances an existing latest anchor without copying prefix cursors or status", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("old-tail", "old")], hasMore: true }, store.beginRead(), { reset: true });
  store.upsertTurn({ id: "turn", itemsLatestHydratedStatus: "inProgress" });
  store.applyLatestItemsPage("turn", { items: [item("next", "next")], nextCursor: "latest-more", hasMore: true });
  store.applyItemsPage("turn", { items: [item("head", "head")], latestItemId: "head", nextCursor: "prefix-more", hasMore: true });
  assert.equal(store.state.turns.turn.itemsLatestTail, "next");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, "latest-more");
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, true);
  store.applyItemsPage("turn", { items: [item("new-tail", "new")], hasMore: false });
  const turn = store.state.turns.turn;
  assert.equal(turn.itemsPageTail, "new-tail");
  assert.equal(turn.itemsLatestTail, "new-tail");
  assert.equal(turn.itemsLatestNextCursor, null);
  assert.equal(turn.itemsLatestHasMore, false);
  assert.equal(turn.itemsLatestHasEarlier, false);
  assert.equal(turn.itemsLatestHydratedStatus, "inProgress");
  assert.equal(turn.itemsHydratedStatus, undefined);
  store.applyItemsPage("turn", { items: [], hasMore: false });
  assert.equal(turn.itemsLatestTail, "new-tail");
});

test("a completed prefix protects the promoted latest anchor from an older latest response", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("old", "old")], hasMore: true }, store.beginRead(), { reset: true });
  const staleLatestRead = store.beginRead();
  store.applyItemsPage("turn", { items: [item("old", "old"), item("prefix-tail", "new")], latestItemId: "prefix-tail", hasMore: false });
  store.applyLatestItemsPage("turn", { items: [item("old", "old")], latestItemId: "old", nextCursor: "stale-more", hasMore: true }, staleLatestRead);
  assert.equal(store.state.turns.turn.itemsLatestTail, "prefix-tail");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, null);
  assert.equal(store.state.turns.turn.itemsLatestHasMore, false);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, false);
});

test("an old completed prefix cannot roll a newer latest anchor or pending incremental cursor back", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("old", "old")], hasMore: true }, store.beginRead(), { reset: true });
  const stalePrefixRead = store.beginRead();
  store.applyLatestItemsPage("turn", { items: [item("latest", "latest")], latestItemId: "latest", nextCursor: "latest-next", hasMore: true });
  store.applyItemsPage("turn", { items: [item("prefix-tail", "old prefix")], latestItemId: "prefix-tail", hasMore: false }, stalePrefixRead);
  assert.equal(store.state.turns.turn.itemsPageTail, "prefix-tail");
  assert.equal(store.state.turns.turn.itemsLatestTail, "latest");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, "latest-next");
  assert.equal(store.state.turns.turn.itemsLatestHasMore, true);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, true);
});

test("latest polling resumes after the completed grown prefix instead of downloading its middle again", async () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  const source = Array.from({ length: 70 }, (_, index) => item(`item-${index}`, `body ${index}`));
  const queries = [];
  const history = createCodexHistoryItems({ store, base: "/api/v2/codex/threads/thread", isDisposed: () => false, onItems() {},
    async call(path) {
      const query = new URL(path, "http://fixture.test").searchParams;
      queries.push(query);
      if (query.get("sortDirection") === "desc") return { items: source.slice(-30), latestItemId: source.at(-1).id, hasMore: source.length > 30, nextCursor: "older-desc" };
      const start = query.get("cursor") ? Number(query.get("cursor"))
        : query.get("after") ? source.findIndex((entry) => entry.id === query.get("after")) + 1 : 0;
      const items = source.slice(start, start + 30), hasMore = start + items.length < source.length;
      return { items, hasMore, nextCursor: hasMore ? String(start + items.length) : null,
        latestItemId: items.at(-1)?.id || query.get("after") };
    } });
  await history.loadItems("turn", { latest: true });
  assert.equal(store.state.turns.turn.itemsLatestTail, "item-69");
  source.push(...Array.from({ length: 930 }, (_, offset) => item(`item-${offset + 70}`, `body ${offset + 70}`)));
  do { await history.loadItems("turn"); } while (store.state.turns.turn.hasMore);
  assert.equal(store.state.turns.turn.itemsPageTail, "item-999");
  assert.equal(store.state.turns.turn.itemsLatestTail, "item-999");
  const prefixRequests = queries.length;
  await history.loadItems("turn", { latest: true });
  assert.equal(queries.length, prefixRequests + 1);
  assert.equal(queries.at(-1).get("after"), "item-999");
  assert.equal(queries.at(-1).has("cursor"), false);
  assert.equal(store.state.turns.turn.itemsLatestTail, "item-999");
  assert.deepEqual(store.state.turns.turn.itemOrder, source.map((entry) => entry.id));
});

test("latest incremental pages preserve their own tail, cursor and earlier-history flag", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], hasMore: true, nextCursor: "older" }, store.beginRead(), { reset: true });
  store.applyLatestItemsPage("turn", { items: [item("new", "new")], latestItemId: "new", hasMore: true, nextCursor: "newer-next" });
  assert.equal(store.state.turns.turn.itemsLatestTail, "new");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, "newer-next");
  assert.equal(store.state.turns.turn.itemsLatestHasMore, true);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, true);
  store.applyLatestItemsPage("turn", { items: [], latestItemId: "new", hasMore: false });
  assert.equal(store.state.turns.turn.itemsLatestTail, "new");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, null);
  assert.equal(store.state.turns.turn.itemsLatestHasMore, false);
  assert.deepEqual(store.state.turns.turn.itemOrder, ["tail", "new"]);
});

test("a late initial latest snapshot cannot roll back a newer latest page or its cursor", () => {
  const { store } = fixture();
  const oldRead = store.beginRead();
  store.applyLatestItemsPage("turn", { items: [item("new-head", "new head"), item("new-tail", "new tail")], latestItemId: "new-tail", hasMore: true }, store.beginRead(), { reset: true });
  store.applyLatestItemsPage("turn", { items: [item("latest", "latest")], latestItemId: "latest", nextCursor: "newest-cursor", hasMore: true });
  store.applyLatestItemsPage("turn", { items: [item("old-head", "old head"), item("old-tail", "old tail")], latestItemId: "old-tail", nextCursor: "old-desc-cursor", hasMore: false }, oldRead, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["old-head", "old-tail", "new-head", "new-tail", "latest"]);
  assert.equal(store.state.turns.turn.itemsLatestTail, "latest");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, "newest-cursor");
  assert.equal(store.state.turns.turn.itemsLatestHasMore, true);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, true);
});

test("latest pages reject mismatched identities and reads from a replaced socket epoch", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", items: [item("known", "known")] });
  const read = store.beginRead();
  store.applyLatestItemsPage("turn", { threadId: "other", items: [item("wrong-thread", "wrong")] }, read, { reset: true });
  store.applyLatestItemsPage("turn", { turnId: "other", items: [item("wrong-turn", "wrong")] }, read, { reset: true });
  event(1, "sync.required", {});
  const generation = store.beginSocket();
  store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: "replacement", seq: 0, type: "sync.required", payload: {} }, generation);
  store.applyLatestItemsPage("turn", { items: [item("old-epoch", "old")], hasMore: true }, read, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["known"]);
  assert.equal(store.state.turns.turn.itemsLatestLoaded, undefined);
});

test("the first latest window excludes old and concurrent summary items but retains truly new websocket items", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [{ id: "old-user", type: "userMessage" }, item("summary-old", "old")] }] });
  const read = store.beginRead();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("concurrent-summary", "summary")] }] });
  event(1, "item.upsert", { turnId: "turn", item: item("ws-new", "new websocket") });
  store.applyLatestItemsPage("turn", { items: [item("recent", "recent"), item("tail", "tail")], latestItemId: "tail", nextCursor: "older-1", hasMore: true }, read, { reset: true });
  const turn = store.state.turns.turn;
  assert.deepEqual(turn.itemsWindowIds, ["recent", "tail", "ws-new"]);
  assert.equal(turn.itemsEarlierCursor, "older-1");
  assert.equal(turn.itemsEarlierHasMore, true);
  assert.equal(turn.itemsLatestNextCursor, null);
  assert.ok(turn.items["old-user"]);
  assert.ok(turn.items["concurrent-summary"]);
});

test("earlier pages prepend one chronological window page without moving any forward or prefix cursor", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("recent", "recent"), item("tail", "tail")], latestItemId: "tail", nextCursor: "earlier-1", hasMore: true }, store.beginRead(), { reset: true });
  store.applyLatestItemsPage("turn", { items: [item("new", "new")], latestItemId: "new", nextCursor: "forward-next", hasMore: true });
  store.applyEarlierItemsPage("turn", { items: [item("old-a", "old a"), item("old-b", "old b")], latestItemId: "old-b", nextCursor: "earlier-2", hasMore: true });
  const turn = store.state.turns.turn;
  assert.deepEqual(turn.itemsWindowIds, ["old-a", "old-b", "recent", "tail", "new"]);
  assert.equal(turn.itemsEarlierCursor, "earlier-2");
  assert.equal(turn.itemsEarlierHasMore, true);
  assert.equal(turn.itemsLatestHasEarlier, true);
  assert.equal(turn.itemsLatestTail, "new");
  assert.equal(turn.itemsLatestNextCursor, "forward-next");
  assert.equal(turn.itemsLatestHasMore, true);
  assert.equal(turn.itemsPageLoaded, undefined);
  assert.equal(turn.itemsPageTail, undefined);
  assert.equal(turn.nextCursor, undefined);
});

test("earlier overlapping pages correct official order and retain same-text message identities", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("head", "same"), item("final", "same")] }] });
  store.applyLatestItemsPage("turn", { items: [item("b", "same"), item("final", "same")], nextCursor: "older", hasMore: true }, store.beginRead(), { reset: true });
  store.applyEarlierItemsPage("turn", { items: [item("head", "same"), item("a", "same"), item("b", "same")], nextCursor: null, hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["head", "a", "b", "final"]);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["head", "a", "b", "final"]);
  assert.equal(store.state.turns.turn.itemsEarlierHasMore, false);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, false);
  assert.equal(store.state.turns.turn.itemsLatestTail, "final");
});

test("an earlier page can finish after the newest append without rolling the latest tail or dropping live output", () => {
  const { store, event } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], hasMore: true, nextCursor: "older" }, store.beginRead(), { reset: true });
  const earlierRead = store.beginRead();
  store.applyLatestItemsPage("turn", { items: [item("new", "new")], latestItemId: "new", hasMore: false });
  event(1, "item.upsert", { turnId: "turn", item: item("ws", "streaming") });
  store.applyEarlierItemsPage("turn", { items: [item("old", "old")], nextCursor: "even-older", hasMore: true }, earlierRead);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["old", "tail", "new", "ws"]);
  assert.equal(store.state.turns.turn.itemsLatestTail, "new");
  assert.equal(store.state.turns.turn.itemsLatestNextCursor, null);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, "even-older");
});

test("a stale earlier page cannot roll a newer earlier cursor or its visible window back", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], nextCursor: "older", hasMore: true }, store.beginRead(), { reset: true });
  const staleRead = store.beginRead();
  store.applyEarlierItemsPage("turn", { items: [item("old", "old")], hasMore: false });
  store.applyEarlierItemsPage("turn", { items: [item("stale", "stale")], nextCursor: "stale-next", hasMore: true }, staleRead);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["old", "tail"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, null);
  assert.equal(store.state.turns.turn.itemsEarlierHasMore, false);
  assert.equal(store.state.turns.turn.itemsLatestHasEarlier, false);
});

test("a pending descending reset cannot undo earlier pagination that already advanced", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], nextCursor: "older-1", hasMore: true }, store.beginRead(), { reset: true });
  const resetRead = store.beginRead();
  store.applyEarlierItemsPage("turn", { items: [item("old", "old")], nextCursor: "older-2", hasMore: true });
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], nextCursor: "older-1", hasMore: true }, resetRead, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["old", "tail"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, "older-2");
});

test("later summary reads stay outside the window while new websocket items become visible immediately", () => {
  const { store, event } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], hasMore: false }, store.beginRead(), { reset: true });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("summary-only", "old summary"), item("tail", "tail")] }] });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["tail"]);
  event(1, "item.upsert", { turnId: "turn", item: item("ws-new", "new") });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["tail", "ws-new"]);
  store.applyLatestItemsPage("turn", { items: [item("ws-new", "new"), item("after", "after")], hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["tail", "ws-new", "after"]);
  assert.equal(store.state.turns.turn.itemsWindowIds.includes("summary-only"), false);
});

test("a websocket upsert exposes a new item first observed through a summary after the window loaded", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  store.applyLatestItemsPage("turn", { items: [item("150", "tail")], hasMore: false }, store.beginRead(), { reset: true });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("151", "summary", "inProgress")] }] });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["150"]);
  event(1, "item.upsert", { turnId: "turn", item: item("151", "live", "inProgress") });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["150", "151"]);
  assert.equal(store.state.turns.turn.items["151"].text, "live");
});

test("a websocket delta exposes a new item whose first content arrived as a summary", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  store.applyLatestItemsPage("turn", { items: [item("150", "tail")], hasMore: false }, store.beginRead(), { reset: true });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("151", "first", "inProgress")] }] });
  event(1, "item.delta", { turnId: "turn", itemId: "151", field: "text", text: " continued" });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["150", "151"]);
  assert.equal(store.state.turns.turn.items["151"].text, "first continued");
});

test("a websocket update to an old hidden summary head does not reopen that historical content", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("old-head", "old", "inProgress")] }] });
  store.applyLatestItemsPage("turn", { items: [item("150", "tail")], hasMore: true, nextCursor: "older" }, store.beginRead(), { reset: true });
  event(1, "item.upsert", { turnId: "turn", item: item("old-head", "old updated", "inProgress") });
  event(2, "item.delta", { turnId: "turn", itemId: "old-head", field: "text", text: " plus" });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["150"]);
  assert.equal(store.state.turns.turn.items["old-head"].text, "old updated plus");
});

test("an initial descending read keeps summary-first items that receive websocket content during the read", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("old-head", "old", "inProgress")] }] });
  const read = store.beginRead();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("151", "summary", "inProgress")] }] });
  event(1, "item.upsert", { turnId: "turn", item: item("old-head", "old updated", "inProgress") });
  event(2, "item.delta", { turnId: "turn", itemId: "151", field: "text", text: " live" });
  store.applyLatestItemsPage("turn", { items: [item("150", "tail")], hasMore: true, nextCursor: "older" }, read, { reset: true });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["150", "151"]);
  assert.equal(store.state.turns.turn.items["151"].text, "summary live");
});

test("explicit prefix pages join an existing window and completion clears earlier pagination", () => {
  const { store } = fixture();
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], nextCursor: "older", hasMore: true }, store.beginRead(), { reset: true });
  store.applyItemsPage("turn", { items: [item("head", "head")], nextCursor: "prefix-next", hasMore: true });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["head", "tail"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, "older");
  store.applyItemsPage("turn", { items: [item("middle", "middle"), item("tail", "tail")], hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["head", "middle", "tail"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, null);
  assert.equal(store.state.turns.turn.itemsEarlierHasMore, false);
});

test("earlier pages reject invalid identities, uninitialized windows and replaced epochs", () => {
  const { store, event } = fixture();
  store.upsertTurn({ id: "turn", items: [item("summary", "summary")] });
  store.applyEarlierItemsPage("turn", { items: [item("premature", "premature")], hasMore: false });
  assert.equal(store.state.turns.turn.items.premature, undefined);
  store.applyLatestItemsPage("turn", { items: [item("tail", "tail")], hasMore: true, nextCursor: "older" }, store.beginRead(), { reset: true });
  const read = store.beginRead();
  store.applyEarlierItemsPage("turn", { threadId: "other", items: [item("wrong-thread", "wrong")] }, read);
  store.applyEarlierItemsPage("turn", { turnId: "other", items: [item("wrong-turn", "wrong")] }, read);
  event(1, "sync.required", {});
  const generation = store.beginSocket();
  store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: "replaced", seq: 0, type: "sync.required", payload: {} }, generation);
  store.applyEarlierItemsPage("turn", { items: [item("old-epoch", "old")], hasMore: false }, read);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["tail"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, "older");
  assert.equal(store.state.turns.turn.items["wrong-thread"], undefined);
  assert.equal(store.state.turns.turn.items["old-epoch"], undefined);
});

test("official completion fills a streamed item; later deltas and bounded summaries cannot erase detail", () => {
  const { store, event } = fixture();
  event(1, "item.upsert", { turnId: "turn", item: item("answer", "part") });
  event(2, "item.upsert", { turnId: "turn", item: item("answer", "full", "completed") });
  event(3, "item.delta", { turnId: "turn", itemId: "answer", field: "text", text: "stale" });
  store.upsertItem("turn", { ...item("answer", "full with official details", "completed"), detailsLoaded: true }, store.beginRead());
  store.applyTurnsPage({ turns: [{ id: "turn", items: [{ ...item("answer", "summary", "completed"), hasDetails: true }] }] });
  assert.equal(store.state.turns.turn.items.answer.text, "full with official details");
});

test("reconciling an active item detail does not freeze subsequent live deltas", () => {
  const { store, event } = fixture();
  event(1, "item.upsert", { turnId: "turn", item: { ...item("answer", "start"), hasDetails: true } });
  store.upsertItem("turn", { ...item("answer", "start"), hasDetails: true, detailsLoaded: true }, store.beginRead());
  event(2, "item.delta", { turnId: "turn", itemId: "answer", field: "text", text: " continues" });
  assert.equal(store.state.turns.turn.items.answer.text, "start continues");
});

test("turn.upsert without items preserves known items and old item pages preserve official order before live items", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("first", "1")], hasMoreItems: true }] });
  event(1, "item.upsert", { turnId: "turn", item: item("live", "3") });
  event(2, "turn.upsert", { turn: { id: "turn", status: "inProgress" } });
  store.applyItemsPage("turn", { items: [item("first", "1"), item("middle", "2")], nextCursor: null, hasMore: false });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["first", "middle", "live"]);
  assert.equal(store.state.turns.turn.hasMoreItems, false);
});

test("the first handshake preserves in-flight history without replacing later socket fields", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  const read = store.beginRead();
  const generation = store.beginSocket();
  const event = (seq, type, payload) => store.applyEvent({ schemaVersion: 2, threadId: "thread",
    epoch: "one", seq, type, payload }, generation);
  assert.equal(event(0, "sync.required", {}).sync, true);
  event(1, "thread.updated", { thread: { id: "thread", name: "live title" } });
  event(2, "turn.upsert", { turn: { id: "latest", status: "inProgress", startedAt: 200,
    items: [item("answer", "live answer")] } });
  store.upsertThread({ id: "thread", name: "old title" }, read);
  store.applyTurnsPage({ threadId: "thread", turns: [
    { id: "older", status: "completed", items: [item("old-answer", "older text", "completed")] },
    { id: "latest", status: "completed", startedAt: 100, items: [item("answer", "old answer", "completed")] }
  ], olderCursor: "older-cursor", hasMore: true }, read);
  assert.deepEqual(store.state.turnOrder, ["older", "latest"]);
  assert.equal(store.state.thread.name, "live title");
  assert.equal(store.state.turns.latest.status, "inProgress");
  assert.equal(store.state.turns.latest.startedAt, 200);
  assert.equal(store.state.turns.latest.items.answer.text, "live answer");
  assert.equal(store.state.turns.older.items["old-answer"].text, "older text");
  assert.equal(store.state.initialized, true);
  assert.equal(store.state.olderCursor, "older-cursor");
  assert.equal(store.state.hasMore, true);
});

test("late metadata can add capabilities without replacing newer thread status or name", () => {
  const store = createCodexChatStore("thread");
  const read = store.beginRead();
  store.upsertThread({ id: "thread", name: "live name", status: { type: "idle" } });
  store.upsertThread({ id: "thread", name: "old name", status: { type: "active" },
    capabilities: { desktopQuestionAnswers: true } }, read);
  assert.equal(store.state.thread.name, "live name");
  assert.deepEqual(store.state.thread.status, { type: "idle" });
  assert.deepEqual(store.state.thread.capabilities, { desktopQuestionAnswers: true });
  store.upsertThread({ id: "thread", name: "renamed" });
  assert.deepEqual(store.state.thread.capabilities, { desktopQuestionAnswers: true });
});

test("capabilities have their own stale-read guard and cannot be re-enabled by older metadata", () => {
  const store = createCodexChatStore("thread");
  const older = store.beginRead();
  store.upsertThread({ id: "thread", capabilities: { desktopQuestionAnswers: false } });
  store.upsertThread({ id: "thread", capabilities: { desktopQuestionAnswers: true } }, older);
  assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, false);
  const current = store.beginRead();
  store.upsertThread({ id: "thread", status: { type: "idle" } });
  store.upsertThread({ id: "thread", capabilities: { desktopQuestionAnswers: true } }, current);
  assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, true);
});

test("capabilities from a previous subscription epoch cannot enable question answering", () => {
  const store = createCodexChatStore("thread");
  const generation = store.beginSocket();
  const event = (epoch) => store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch,
    seq: 0, type: "sync.required", payload: {} }, generation);
  event("first");
  const old = store.beginRead();
  event("replacement");
  store.upsertThread({ id: "thread", name: "current", capabilities: { desktopQuestionAnswers: false } });
  store.upsertThread({ id: "thread", name: "stale", capabilities: { desktopQuestionAnswers: true } }, old);
  assert.equal(store.state.thread.name, "current");
  assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, false);
});

test("a later known epoch still rejects a read begun before the first handshake", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  const read = store.beginRead();
  const generation = store.beginSocket();
  const event = (epoch) => store.applyEvent({ schemaVersion: 2, threadId: "thread",
    epoch, seq: 0, type: "sync.required", payload: {} }, generation);
  event("one");
  event("two");
  store.upsertThread({ id: "thread", name: "obsolete" }, read);
  store.applyTurnsPage({ turns: [{ id: "obsolete", items: [item("answer", "obsolete")] }],
    olderCursor: "obsolete-cursor", hasMore: true }, read);
  assert.equal(store.state.thread, null);
  assert.deepEqual(store.state.turnOrder, []);
  assert.equal(store.state.initialized, false);
  assert.equal(store.state.olderCursor, null);
  assert.equal(store.state.hasMore, false);
});

test("epoch changes require the current subscription handshake and invalidate in-flight history", () => {
  const { store, event, generation } = fixture();
  event(1, "item.upsert", { turnId: "turn", item: item("answer", "old") });
  const read = store.beginRead();
  const current = store.beginSocket();
  assert.equal(event(2, "item.upsert", { turnId: "turn", item: item("answer", "rogue") }, "two", current).ignored, true);
  event(0, "sync.required", {}, "two", current);
  event(1, "item.upsert", { turnId: "turn", item: item("answer", "new") }, "two", current);
  event(9, "sync.required", {}, "one", generation);
  store.applyTurnsPage({ turns: [{ id: "turn", items: [item("answer", "stale read")] }] }, read);
  assert.equal(store.state.epoch, "two");
  assert.equal(store.state.turns.turn.items.answer.text, "new");
  assert.equal(event(1, "item.delta", { turnId: "turn", itemId: "answer", field: "text", text: " duplicate" }, "two", current).ignored, true);
  assert.equal(event(4, "thread.updated", { thread: { id: "thread", name: "updated" } }, "two", current).sync, true);
});

test("local drafts and request IDs survive refresh without mixing threads or serializing File data", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("a", { storage });
  store.setDraft({ text: "draft", attachments: [
    { id: "uploaded", uploadedId: "server-image", kind: "image", name: "image.png", url: "/uploads/a.png", file: { secretBytes: true } },
    { id: "pending", kind: "image", name: "pending.png", file: { secretBytes: true } }
  ] });
  store.upsertRequest({ id: "request", threadId: "a", state: "sending", input: { text: "sent" } });
  const reloaded = createCodexChatStore("a", { storage });
  assert.equal(reloaded.state.draft.text, "draft");
  assert.equal(reloaded.state.draft.attachments[0].uploadedId, "server-image");
  assert.equal(reloaded.state.draft.attachments[1].status, "failed");
  assert.equal(reloaded.state.draft.attachments[1].file, undefined);
  assert.match(reloaded.state.draft.attachments[1].error, /重新选择图片/);
  assert.equal(reloaded.state.requests.request.state, "unknown");
  assert.equal(JSON.stringify(reloaded.state).includes("secretBytes"), false);
  assert.equal(createCodexChatStore("b", { storage }).state.draft.text, "");
});

test("a newly reported server unknown receipt restores the send lock after manual dismissal", () => {
  const store = createCodexChatStore("thread", { storage: memoryStorage() });
  store.upsertRequest({ id: "request", state: "unknown", confirmationDismissed: true, updatedAt: "2026-01-01T00:00:00.000Z" });
  store.upsertRequest({ id: "request", state: "unknown", updatedAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(store.state.requests.request.confirmationDismissed, false);
});

test("persistence failure keeps the draft and does not leave a fake queued request", () => {
  const store = createCodexChatStore("thread", { storage: { getItem() {}, setItem() { throw new Error("quota"); } } });
  store.setDraft({ text: "keep me" });
  assert.throws(() => store.queueRequest({ id: "request", state: "sending" }), /保存失败/);
  assert.equal(store.state.draft.text, "keep me");
  assert.equal(store.state.requests.request, undefined);
});

test("queue persistence atomically exchanges a draft for one pending receipt", () => {
  const values = new Map();
  let writes = 0;
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => { writes += 1; values.set(key, value); } };
  const store = createCodexChatStore("thread", { storage });
  store.setDraft({ text: "ready" });
  const before = writes;
  store.queueRequest({ id: "request", threadId: "thread", state: "sending", input: { text: "ready" } });
  assert.equal(writes - before, 1);
  const saved = JSON.parse(values.get(store.storageKey));
  assert.equal(saved.draft.text, "");
  assert.equal(saved.requests[0].input.text, "ready");
});

test("a question reply atomically saves its receipt while preserving an unrelated text and image draft", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  const attachment = { id: "local", kind: "image", uploadedId: "uploaded", status: "uploaded", url: "/image", name: "draft.png" };
  store.setDraft({ text: "not the answer", attachments: [attachment] });
  const draft = store.state.draft;
  store.queueRequest({ id: "answer", threadId: "thread", state: "sending", input: { text: "structured answer", attachments: [] } }, { preserveDraft: true });
  assert.equal(store.state.draft, draft);
  assert.equal(store.state.draft.attachments[0], attachment);
  const saved = JSON.parse(storage.getItem(store.storageKey));
  assert.equal(saved.draft.text, "not the answer");
  assert.equal(saved.draft.attachments[0].uploadedId, "uploaded");
  assert.deepEqual(saved.requests[0].input, { text: "structured answer", attachments: [] });
  assert.deepEqual(store.state.submittedRequestIds, ["answer"]);
});

test("question reply persistence failure preserves its draft and never leaves a sendable receipt", () => {
  const storage = memoryStorage();
  const store = createCodexChatStore("thread", { storage });
  store.setDraft({ text: "keep the draft", attachments: [{ id: "draft-image", kind: "image", uploadedId: "photo" }] });
  const draft = store.state.draft;
  storage.setItem = () => { throw new Error("quota"); };
  assert.throws(() => store.queueRequest({ id: "answer", state: "sending", input: { text: "answer", attachments: [] } },
    { preserveDraft: true }), /保存失败/);
  assert.equal(store.state.draft, draft);
  assert.deepEqual(store.state.requestOrder, []);
  assert.deepEqual(store.state.submittedRequestIds, []);
});

test("a detached receipt update preserves the latest draft, attachments and unrelated receipts", () => {
  const storage = memoryStorage();
  const old = createCodexChatStore("thread", { storage });
  old.queueRequest({ id: "original", state: "sending", input: { text: "sent once" } });
  const current = createCodexChatStore("thread", { storage });
  const attachment = { id: "new-image", uploadedId: "uploaded-new", kind: "image", name: "new.png", url: "/api/attachments/images/uploaded-new" };
  current.setDraft({ text: "new draft", attachments: [attachment] });
  current.upsertRequest({ id: "new-request", state: "queued", input: { text: "new request" } });
  const savedDraft = JSON.parse(storage.getItem(old.storageKey)).draft;
  old.upsertRequest({ id: "original", state: "accepted" }, undefined, { preserveDraft: true });
  let saved = JSON.parse(storage.getItem(old.storageKey));
  assert.deepEqual(saved.draft, savedDraft);
  assert.deepEqual(saved.requests.map((request) => request.id), ["original", "new-request"]);
  assert.equal(saved.requests[0].state, "accepted");
  assert.equal(saved.requests[0].input.text, "sent once");
  current.setDraft({ text: "new draft edited again" });
  saved = JSON.parse(storage.getItem(old.storageKey));
  assert.equal(saved.requests[0].state, "accepted");
  assert.equal(saved.draft.text, "new draft edited again");
  assert.equal(saved.draft.attachments[0].uploadedId, "uploaded-new");
});

test("single receipt persistence retains newer terminal and timestamped results", () => {
  for (const [previous, late] of [
    [{ state: "completed" }, { state: "accepted" }],
    [{ state: "failed", updatedAt: "2026-10-18T00:00:02Z" }, { state: "rejected", updatedAt: "2026-10-18T00:00:01Z" }]
  ]) {
    const storage = memoryStorage();
    const old = createCodexChatStore("thread", { storage });
    old.queueRequest({ id: "original", state: "sending", input: { text: "original" } });
    const current = createCodexChatStore("thread", { storage });
    current.upsertRequest({ id: "original", ...previous });
    current.setDraft({ text: "latest" });
    old.upsertRequest({ id: "original", ...late }, undefined, { preserveDraft: true });
    const restored = createCodexChatStore("thread", { storage });
    assert.equal(restored.state.draft.text, "latest");
    assert.equal(restored.state.requests.original.state, previous.state);
    assert.equal(restored.state.requests.original.updatedAt, previous.updatedAt);
  }
});

test("single receipt persistence keeps all pending requests and the latest forty terminal receipts", () => {
  const storage = memoryStorage();
  const old = createCodexChatStore("thread", { storage });
  old.queueRequest({ id: "original", state: "sending" });
  const current = createCodexChatStore("thread", { storage });
  current.upsertRequest({ id: "pending", state: "queued" });
  for (let index = 0; index < 45; index += 1) current.upsertRequest({ id: `done-${index}`, state: "completed" });
  old.upsertRequest({ id: "original", state: "rejected" }, undefined, { preserveDraft: true });
  const saved = JSON.parse(storage.getItem(old.storageKey));
  assert.equal(saved.requests.length, 41);
  assert.equal(saved.requests[0].id, "pending");
  assert.equal(saved.requests.some((request) => request.id === "done-5"), true);
  assert.equal(saved.requests.some((request) => request.id === "original"), false);
  assert.equal(saved.requests.at(-1).id, "done-44");
});

test("damaged saved records are not replaced by a late receipt or a required new send", () => {
  for (const damaged of ["{bad json", JSON.stringify({ threadId: "other", draft: {}, requests: [] }),
    JSON.stringify({ threadId: "thread", draft: { text: "retained", attachments: "invalid" }, requests: [] }),
    JSON.stringify({ threadId: "thread", draft: { text: "retained", attachments: [] }, requests: "invalid" })]) {
    const storage = memoryStorage();
    const old = createCodexChatStore("thread", { storage });
    old.queueRequest({ id: "original", state: "sending", input: { text: "sent" } });
    storage.setItem(old.storageKey, damaged);
    old.upsertRequest({ id: "original", state: "accepted" }, undefined, { preserveDraft: true });
    assert.equal(storage.getItem(old.storageKey), damaged);
    assert.equal(old.state.requests.original.state, "accepted");
    assert.match(old.state.persistenceError, /保存失败/);
    old.setDraft({ text: "recoverable draft" });
    assert.throws(() => old.queueRequest({ id: "must-not-send", state: "sending" }), /保存失败/);
    assert.equal(old.state.draft.text, "recoverable draft");
    assert.equal(old.state.requests["must-not-send"], undefined);
    assert.equal(storage.getItem(old.storageKey), damaged);
  }
});

test("an unwritable late receipt remains recoverable without destroying the saved draft", () => {
  const values = new Map();
  let blocked = false;
  const storage = { getItem: (key) => values.get(key), setItem(key, value) {
    if (blocked) throw new Error("quota");
    values.set(key, value);
  } };
  const old = createCodexChatStore("thread", { storage });
  old.queueRequest({ id: "original", state: "sending", input: { text: "retained send" } });
  const current = createCodexChatStore("thread", { storage });
  current.setDraft({ text: "retained new draft" });
  const saved = storage.getItem(old.storageKey);
  blocked = true;
  old.upsertRequest({ id: "original", state: "accepted" }, undefined, { preserveDraft: true });
  assert.equal(storage.getItem(old.storageKey), saved);
  assert.equal(old.state.requests.original.input.text, "retained send");
  assert.equal(old.state.requests.original.state, "accepted");
  assert.match(old.state.persistenceError, /quota/);
  assert.equal(old.persist({ receiptId: "original", preserveDraft: true }), false);
  blocked = false;
  assert.equal(old.persist({ receiptId: "original", preserveDraft: true }), true);
  const restored = createCodexChatStore("thread", { storage });
  assert.equal(restored.state.draft.text, "retained new draft");
  assert.equal(restored.state.requests.original.state, "accepted");
});

test("old completed receipts outside loaded history do not become fake newest messages", () => {
  const { store } = fixture();
  store.upsertRequest({ id: "old-request", state: "completed", turnId: "not-loaded", userItemId: "old-user", input: { text: "old" } });
  store.applyTurnsPage({ turns: [{ id: "new-turn", items: [item("new-answer", "new")] }] });
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["new-turn"]);
});

test("server-only failed image receipts derive authenticated previews without local upload metadata", () => {
  const { store } = fixture();
  store.upsertRequest({ id: "image-request", state: "failed", input: { text: "", attachments: [{ id: "image id" }] }, error: { message: "rejected" } });
  const view = buildThreadViewModel(presentCodexChatSnapshot(store.state));
  const user = view.turns[0].segments[0].items[0];
  assert.equal(user.imageItems[0].url, "/api/attachments/images/image%20id");
  assert.equal(user.raw.request.error.message, "rejected");
});

test("typed presentation retains two identical user messages and replaces pending only by official identity", () => {
  const { store } = fixture();
  store.upsertRequest({ id: "r1", state: "running", input: { text: "same" }, turnId: "t1" });
  store.upsertRequest({ id: "r2", state: "failed", input: { text: "same" }, error: { message: "failed" } });
  store.applyTurnsPage({ turns: [{ id: "t1", items: [{ id: "user1", type: "userMessage", clientId: "r1", presentation: { text: "same" } }] }] });
  const snapshot = presentCodexChatSnapshot(store.state);
  assert.equal(snapshot.turns.flatMap((turn) => turn.items).filter((entry) => entry.text === "same").length, 2);
  assert.equal(snapshot.turns.at(-1).items[0].request.error.message, "failed");
  assert.equal(snapshot.turns.at(-1).status, "failed");
  assert.equal(store.state.turns.t1.items.user1.type, "userMessage");
});

test("steer appends a second user message to the active turn then adopts its official position without losing output", () => {
  const { store, event } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", status: "inProgress", items: [
    { id: "original", type: "userMessage", position: 0, presentation: { text: "same" } },
    { ...item("answer", "existing answer"), position: 1 },
    { id: "file", type: "fileChange", position: 2, presentation: { fileChanges: [{ path: "src/a.js", diff: "+kept", additions: 1, deletions: 0 }] } }
  ] }] });
  store.upsertRequest({ id: "steer", mode: "steer", expectedTurnId: "turn", state: "accepted", input: { text: "same" } });
  let snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.id), ["original", "answer", "file", "request:steer"]);
  event(1, "item.upsert", { turnId: "turn", item: { id: "followup", type: "userMessage", clientId: "steer", position: 3, presentation: { text: "same" } } });
  snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.id), ["original", "answer", "file", "followup"]);
  assert.equal(snapshot.turns[0].items.filter((entry) => entry.kind === "UserMessage").length, 2);
  assert.equal(snapshot.turns[0].items[1].text, "existing answer");
  assert.equal(buildThreadViewModel(snapshot).turns[0].fileChanges[0].diff, "+kept");
});

test("renderer gets only presentation text, normalized images and full file changes", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "turn", status: "completed", items: [
    { id: "user", type: "userMessage", content: [{ type: "input_text", text: "private host wrapper" }], presentation: { text: "", images: [{ url: "/tmp/a.png" }, { url: "file:///tmp/a.png" }] } },
    { id: "files", type: "fileChange", status: "completed", presentation: { text: "changed", fileChanges: [{ path: "src/a.js", status: "update", additions: 1, deletions: 1, diff: "-old\n+new" }] } }
  ] }] });
  const view = buildThreadViewModel(presentCodexChatSnapshot(store.state));
  const user = view.turns[0].segments[0].items[0];
  assert.equal(user.body, "");
  assert.equal(user.imageItems.length, 1);
  assert.match(user.imageItems[0].url, /^\/api\/local-file-image/);
  assert.equal(view.turns[0].fileChanges[0].diff, "-old\n+new");
});

test("empty reasoning disappears from cards and counts while real reasoning and steer anchors remain", () => {
  const { store } = fixture();
  store.upsertTurn({ id: "turn", status: "completed", items: [
    { id: "reply", type: "agentMessage", presentation: { text: "before" } },
    { id: "empty", type: "reasoning", summary: [], content: [], encryptedContent: "opaque", presentation: { text: "" } },
    { id: "next", type: "agentMessage", presentation: { text: "after" } },
    { id: "real", type: "reasoning", summary: ["Visible reasoning summary"], content: [] }
  ] });
  store.upsertRequest({ id: "guide", mode: "steer", state: "accepted", turnId: "turn", steerAfterItemId: "empty", steerQueuedAt: 1, input: { text: "guide" } });
  const snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ["reply", "request:guide", "next", "real"]);
  const view = buildThreadViewModel(snapshot);
  const process = view.turns[0].segments.filter((segment) => segment.kind === "process");
  assert.equal(process.reduce((sum, segment) => sum + segment.processSummary.total, 0), 1);
  assert.equal(process[0].items[0].body, "Visible reasoning summary");
  assert.ok(store.state.turns.turn.items.empty);
});

test("a rejected message keeps its chronological position when later replies arrive", () => {
  const { store } = fixture();
  store.applyTurnsPage({ turns: [{ id: "before", startedAt: 1700000000, items: [] }] });
  store.upsertRequest({ id: "failed", state: "rejected", createdAt: "2023-11-14T22:13:25.000Z", input: { text: "retained" } });
  store.applyTurnsPage({ turns: [{ id: "after", startedAt: 1700000010, items: [] }] });
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["before", "request:failed", "after"]);
  assert.deepEqual(store.state.turnOrder, ["before", "after"]);
});
