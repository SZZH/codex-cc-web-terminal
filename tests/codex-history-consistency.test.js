import test from "node:test";
import assert from "node:assert/strict";
import { activeCodexTurnId, createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

const message = (id, type = "agentMessage") => ({ id, type, text: id, status: "completed" });
const visible = (store) => presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id);
function initial(store, tail, summaries) {
  store.applyInitialHistory({
    turnsPage: { threadId: "thread", turns: [{ id: "turn", status: "inProgress", items: summaries }], hasMore: false, olderCursor: null },
    itemsPage: { threadId: "thread", turnId: "turn", items: tail, latestItemId: tail.at(-1).id, nextCursor: "older", hasMore: true }
  });
}

test("initial latest content and later earlier pages keep the summary user before the final answer", () => {
  const store = createCodexChatStore("thread");
  const user = message("continue", "userMessage"), early = message("early-reply");
  const tail = Array.from({ length: 29 }, (_, i) => message(`recent-${i}`)).concat(message("final"));
  initial(store, tail, [user, tail.at(-1)]);
  assert.deepEqual(visible(store), tail.map((item) => item.id));
  store.applyTurnsPage({ turns: [{ id: "turn", status: "completed", items: [user, tail.at(-1)] }] });
  assert.deepEqual(visible(store), tail.map((item) => item.id), "a later sparse refresh does not change the window");
  store.applyEarlierItemsPage("turn", { items: [user, early], hasMore: false });
  assert.deepEqual(visible(store), [user.id, early.id, ...tail.map((item) => item.id)]);
  assert.equal(store.state.turns.turn.status, "completed");
  assert.equal(store.state.turns.turn.itemsLatestTail, "final");
});

test("the earlier page boundary takes precedence over a hidden summary item observed after the tail", () => {
  const store = createCodexChatStore("thread");
  const tail = [message("recent"), message("final")];
  initial(store, tail, []);
  store.applyTurnsPage({ turns: [{ id: "turn", items: [message("old-middle"), tail.at(-1)] }] });
  assert.deepEqual(visible(store), ["recent", "final"]);
  store.applyEarlierItemsPage("turn", { items: [message("old-middle"), message("old-next")], hasMore: false });
  assert.deepEqual(visible(store), ["old-middle", "old-next", "recent", "final"]);
});

test("sparse user summaries arrive before an existing tail without moving a known live followup", () => {
  const store = createCodexChatStore("thread");
  initial(store, [message("tail")], []);
  store.upsertItem("turn", message("followup", "userMessage"));
  store.applyTurnsPage({ turns: [{ id: "turn", items: [message("head", "userMessage"), message("tail")] }] });
  assert.deepEqual(store.state.turns.turn.itemOrder, ["head", "tail", "followup"]);
  assert.deepEqual(visible(store), ["tail", "followup"]);
});

test("poll metadata never inserts unloaded turns before or after initial history", () => {
  for (const metadataFirst of [true, false]) {
    const store = createCodexChatStore("thread");
    const generation = store.beginSocket();
    const send = (seq, type, payload) => store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq, type, payload }, generation);
    send(0, "sync.required", {});
    const read = store.beginRead();
    if (!metadataFirst) initial(store, [message("latest")], []);
    send(1, "turn.metadata", { turn: { id: "unloaded-old", status: "completed", items: [message("sparse")] } });
    if (metadataFirst) initial(store, [message("latest")], []);
    assert.deepEqual(store.state.turnOrder, ["turn"]);
    assert.equal(activeCodexTurnId(store.state), "turn");
    send(2, "turn.metadata", { turn: { id: "turn", status: "completed", completedAt: 200, items: [message("sparse")] } });
    store.upsertTurn({ id: "turn", status: "inProgress" }, read);
    assert.equal(store.state.turns.turn.status, "completed", "a pending HTTP read cannot restore the old status");
    assert.deepEqual(visible(store), ["latest"]);
    send(3, "turn.upsert", { turn: { id: "live-new", status: "inProgress" } });
    assert.deepEqual(store.state.turnOrder, ["turn", "live-new"], "native events still introduce new turns");
    assert.equal(activeCodexTurnId(store.state), "live-new");
  }
});

test("initial, refresh, forward, earlier and reconnect preserve one chronological history window", () => {
  for (const size of [31, 76, 143]) {
    const store = createCodexChatStore("thread");
    const items = Array.from({ length: size }, (_, i) => message(`item-${i}`, i % 17 === 0 ? "userMessage" : "agentMessage"));
    const tail = items.slice(-30);
    initial(store, tail, [items[0], items[3], items.at(-1)]);
    let expected = tail.map((item) => item.id);
    const check = () => assert.deepEqual(visible(store), expected, `size=${size}`);
    check();
    store.applyTurnsPage({ turns: [{ id: "turn", status: "inProgress", items: [items[0], items[3], items.at(-1)] }] });
    check();
    const live = [message("live-one"), message("live-two")];
    store.applyLatestItemsPage("turn", { items: live, latestItemId: live.at(-1).id, hasMore: false });
    expected.push(...live.map((item) => item.id)); check();
    let end = size - 30;
    while (end > 0) {
      const start = Math.max(0, end - 30);
      store.applyEarlierItemsPage("turn", { items: items.slice(start, end), hasMore: start > 0, nextCursor: start ? `before-${start}` : null });
      expected.unshift(...items.slice(start, end).map((item) => item.id)); check();
      store.applyTurnsPage({ turns: [{ id: "turn", items: [items[0], items[3], ...live] }] });
      check(); end = start;
    }
    const generation = store.beginSocket();
    store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: "reconnected", seq: 0, type: "sync.required" }, generation);
    store.applyLatestItemsPage("turn", { items: [...items, ...live].slice(-30), latestItemId: "live-two", hasMore: true, nextCursor: "older" },
      undefined, { reset: true });
    check();
    assert.equal(new Set(visible(store)).size, size + 2);
  }
});

test("a stale activity upsert cannot reopen the same completed lifecycle", () => {
  const store = createCodexChatStore("thread");
  const activity = { agentThreadId: "child", startedItemId: "start", event: "started", state: "completed",
    startedAt: 100, completedAt: 200, durationMs: 100 };
  store.upsertItem("turn", { id: "start", type: "subAgentActivity", presentation: { activity } });
  store.upsertItem("turn", { id: "start", type: "subAgentActivity", presentation: {
    activity: { ...activity, state: "running", completedAt: null, durationMs: null } } });
  const current = store.state.turns.turn.items.start.presentation.activity;
  assert.equal(current.state, "completed");
  assert.equal(current.completedAt, 200);
  assert.equal(current.durationMs, 100);
});

test("already visible live messages survive initial hydration, a lagging snapshot and catch-up in order", async () => {
  const { createCodexHistoryItems } = await import("../web/src/lib/codex-history-items.js");
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "turn", status: "inProgress" });
  store.upsertItem("turn", { ...message("live"), status: "inProgress", position: 1, text: "first" });
  let resolve;
  const history = createCodexHistoryItems({ store, base: "/history", isDisposed: () => false,
    onItems() {}, call: () => new Promise((done) => { resolve = done; }) });
  assert.deepEqual(visible(store), ["live"]);
  const pending = history.loadItems("turn", { latest: true });
  assert.deepEqual(visible(store), ["live"], "starting history must not clear live content");
  resolve({ items: [{ ...message("old"), position: 0 }], latestItemId: "old", hasMore: false });
  await pending;
  assert.deepEqual(visible(store), ["old", "live"], "a lagging disjoint snapshot precedes live content");
  store.upsertItem("turn", { ...message("live"), status: "inProgress", text: "first continued" });
  assert.deepEqual(visible(store), ["old", "live"]);
  store.applyLatestItemsPage("turn", { items: [message("old"), message("live")], hasMore: false }, store.beginRead(), { reset: true });
  assert.deepEqual(visible(store), ["old", "live"], "catch-up neither duplicates nor moves messages");
});

test("bounded running summaries preserve loaded content while advancing lifecycle status", () => {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "turn", status: "inProgress" });
  const text = "complete content ".repeat(1000);
  store.upsertItem("turn", { id: "answer", type: "agentMessage", status: "inProgress", text,
    presentation: { text }, detailsLoaded: true, hasDetails: false });
  for (const status of ["inProgress", "completed"]) {
    store.applyTurnsPage({ turns: [{ id: "turn", items: [{ id: "answer", type: "agentMessage", status,
      text: "complete", presentation: { text: "complete" }, hasDetails: true, truncated: true }] }] });
    const item = store.state.turns.turn.items.answer;
    assert.equal(item.text, text);
    assert.equal(item.presentation.text, text);
    assert.equal(item.status, status);
    assert.equal(item.detailsLoaded, true);
    assert.equal(item.hasDetails, true, "completion still requires final detail reconciliation");
  }
});


test("newer bounded content can advance a running detail snapshot and requests fresh detail", () => {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "turn", status: "inProgress" });
  store.upsertItem("turn", { id: "answer", type: "agentMessage", status: "inProgress",
    text: "first", presentation: { text: "first" }, detailsLoaded: true });
  store.applyTurnsPage({ turns: [{ id: "turn", items: [{ id: "answer", type: "agentMessage",
    text: "first continued", presentation: { text: "first continued" }, hasDetails: true }] }] });
  assert.equal(store.state.turns.turn.items.answer.text, "first continued");
  assert.equal(store.state.turns.turn.items.answer.detailsLoaded, false);
});


test("a newer disjoint history page remains after a live user message", () => {
  const store = createCodexChatStore("thread");
  store.upsertItem("turn", { ...message("user", "userMessage"), position: 0 });
  store.applyLatestItemsPage("turn", { items: [{ ...message("newer"), position: 40 }], hasMore: true },
    store.beginRead(), { reset: true });
  assert.deepEqual(visible(store), ["user", "newer"]);
});
