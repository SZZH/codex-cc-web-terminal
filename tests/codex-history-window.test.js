import test from "node:test";
import assert from "node:assert/strict";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexHistoryItems } from "../web/src/lib/codex-history-items.js";
import { createCodexHistoryWindow } from "../web/src/lib/codex-history-window.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

const item = (id) => ({ id, type: "agentMessage", text: id });
function fixture(respond) {
  const store = createCodexChatStore("thread");
  const calls = [], errors = [];
  let disposed = false;
  const call = async (path) => { calls.push(new URL(path, "http://fixture")); return respond(calls.at(-1)); };
  const history = createCodexHistoryItems({ store, call, base: "/thread", isDisposed: () => disposed, onItems() {} });
  const window = createCodexHistoryWindow({ store, call, base: "/thread", loadItems: history.loadItems,
    errors: { begin: () => ({}), succeed() {}, fail(_token, error) { errors.push(error.message); } }, isDisposed: () => disposed });
  return { store, ...history, ...window, calls, errors, dispose: () => { disposed = true; } };
}

test("the initial history view never displays old summary items while waiting for its latest page", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.store.upsertTurn({ id: "turn", status: "inProgress", items: [item("old-summary")] });
  const pending = f.loadItems("turn", { latest: true });
  assert.deepEqual(presentCodexChatSnapshot(f.store.state).turns[0].items, []);
  resolve({ items: [item("newest")], hasMore: true, nextCursor: "earlier" });
  await pending;
  assert.deepEqual(presentCodexChatSnapshot(f.store.state).turns[0].items.map((i) => i.id), ["newest"]);
  assert.equal(f.hasOlderHistory(), true);
});

test("a failed earlier page preserves its cursor and retry reads exactly that page", async () => {
  let failed = true;
  const f = fixture((url) => {
    assert.equal(url.searchParams.get("sortDirection"), "desc");
    assert.equal(url.searchParams.get("cursor"), "older-items");
    if (failed) throw new Error("offline");
    return { items: [item("earlier")], hasMore: false };
  });
  f.store.upsertTurn({ id: "turn", items: [] });
  f.store.applyLatestItemsPage("turn", { items: [item("last")], hasMore: true, nextCursor: "older-items" }, undefined, { reset: true });
  assert.equal(await f.loadOlder(), false);
  assert.equal(f.store.state.turns.turn.itemsEarlierCursor, "older-items");
  assert.deepEqual(f.store.state.turns.turn.itemsWindowIds, ["last"]);
  failed = false;
  assert.equal(await f.loadOlder(), true);
  assert.deepEqual(f.store.state.turns.turn.itemsWindowIds, ["earlier", "last"]);
  assert.equal(f.hasOlderHistory(), false);
  assert.equal(f.calls.length, 2);
});

test("a repeated earlier cursor is rejected before it can expand or consume the displayed window", async () => {
  const f = fixture(() => ({ items: [item("bad")], hasMore: true, nextCursor: "same" }));
  f.store.upsertTurn({ id: "turn", items: [] });
  f.store.applyLatestItemsPage("turn", { items: [item("last")], hasMore: true, nextCursor: "same" }, undefined, { reset: true });
  assert.equal(await f.loadOlder(), false);
  assert.deepEqual(f.store.state.turns.turn.itemsWindowIds, ["last"]);
  assert.equal(f.store.state.turns.turn.itemsEarlierCursor, "same");
});

test("settled old receipts cannot reinsert inputs outside the visible window but failure feedback remains", () => {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "turn", items: [{id: "old-user", type: "userMessage", clientId: "old-request", text: "old input"}] });
  store.state.turns.turn.itemsLatestRequested = true;
  store.applyLatestItemsPage("turn", { items: [item("last")], hasMore: true, nextCursor: "older" }, undefined, { reset: true });
  store.upsertRequest({ id: "old-request", state: "completed", turnId: "turn", userItemId: "old-user", input: { text: "old input" } });
  store.upsertRequest({ id: "failed", state: "failed", turnId: "turn", input: { text: "failed input" }, error: { message: "failure" } });
  const view = presentCodexChatSnapshot(store.state);
  assert.equal(view.turns[0].items.some((i) => i.text === "old input"), false);
  assert.equal(view.turns[0].items.some((i) => i.raw?.request?.error || i.request?.error?.message === "failure"), true);
});

test("a new steer remains visible after completion until its official input joins the window", () => {
  const values = new Map();
  const store = createCodexChatStore("thread", { storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } });
  store.upsertTurn({ id: "turn", status: "inProgress", items: [] });
  store.state.turns.turn.itemsLatestRequested = true;
  store.applyLatestItemsPage("turn", { items: [item("last")], hasMore: true, nextCursor: "older" }, undefined, { reset: true });
  store.queueRequest({ id: "new-steer", mode: "steer", state: "sending", turnId: "turn", steerAfterItemId: "last", input: { text: "new input" } });
  store.upsertRequest({ id: "new-steer", mode: "steer", state: "completed", turnId: "turn", userItemId: "official-new", localOnly: false });
  let view = presentCodexChatSnapshot(store.state);
  assert.equal(view.turns[0].items.filter((i) => i.text === "new input").length, 1);
  store.upsertItem("turn", { id: "official-new", type: "userMessage", clientId: "new-steer", text: "new input" });
  view = presentCodexChatSnapshot(store.state);
  assert.equal(view.turns[0].items.filter((i) => i.text === "new input").length, 1);
  assert.equal(view.turns[0].items.some((i) => i.id === "request:new-steer"), false);
});
