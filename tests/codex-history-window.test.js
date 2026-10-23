import test from "node:test";
import assert from "node:assert/strict";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexHistoryItems } from "../web/src/lib/codex-history-items.js";
import { createCodexHistoryWindow } from "../web/src/lib/codex-history-window.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

const item = (id) => ({ id, type: "agentMessage", text: id });
const flush = () => new Promise((resolve) => setImmediate(resolve));
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

test("older batches load three turns with at most two item reads and preserve chronological order", async () => {
  const waiting = new Map();
  const f = fixture((url) => {
    if (url.pathname.endsWith('/turns')) {
      assert.equal(url.searchParams.get('limit'), '3');
      return { turns: ['old', 'middle', 'recent'].map((id) => ({ id, items: [] })), hasMore: false };
    }
    const id = url.pathname.split('/').at(-2);
    return new Promise((resolve) => waiting.set(id, resolve));
  });
  f.store.state.hasMore = true;
  const read = f.loadOlder();
  assert.equal(f.loadOlder(), read);
  await flush();
  assert.deepEqual([...waiting.keys()], ['recent', 'middle']);
  waiting.get('recent')({ items: [item('r')], hasMore: false });
  await flush();
  assert.equal(waiting.has('old'), false);
  waiting.get('middle')({ items: [item('m')], hasMore: false });
  await flush();
  waiting.get('old')({ items: [item('o')], hasMore: false });
  assert.equal(await read, true);
  assert.deepEqual(f.store.state.turnOrder, ['old', 'middle', 'recent']);
  assert.equal(f.hasOlderHistory(), false);
});

test("a failed middle turn and its remaining item pages stay reachable after a partial batch", async () => {
  let retry = false;
  const f = fixture((url) => {
    if (url.pathname.endsWith('/turns')) return { turns: ['old', 'middle', 'recent'].map((id) => ({ id, items: [] })), hasMore: false };
    const id = url.pathname.split('/').at(-2);
    if (id === 'middle' && !retry) throw new Error('middle unavailable');
    if (url.searchParams.get('cursor') === 'middle-prefix') return { items: [item('m0')], hasMore: false };
    return { items: [item(id)], hasMore: id === 'middle', nextCursor: id === 'middle' ? 'middle-prefix' : null };
  });
  f.store.state.hasMore = true;
  assert.equal(await f.loadOlder(), false);
  assert.equal(f.hasOlderHistory(), true);
  retry = true;
  assert.equal(await f.loadOlder(), true);
  assert.equal(f.hasOlderHistory(), true, 'middle prefix must remain reachable even when the oldest turn is complete');
  assert.equal(await f.loadOlder(), true);
  assert.equal(f.hasOlderHistory(), false);
  assert.deepEqual(f.store.state.turns.middle.itemsWindowIds, ['m0', 'middle']);
  assert.equal(f.calls.filter((url) => url.pathname.endsWith('/turns')).length, 1);
  assert.equal(f.calls.filter((url) => url.pathname.includes('/recent/items')).length, 1, 'successful siblings are not fetched again');
});

test("disposing during an older batch prevents its queued turn read and late publication", async () => {
  const pending = [];
  const f = fixture((url) => url.pathname.endsWith('/turns')
    ? { turns: ['old', 'middle', 'recent'].map((id) => ({ id, items: [] })), hasMore: false }
    : new Promise((resolve) => pending.push(resolve)));
  f.store.state.hasMore = true;
  const read = f.loadOlder(); await flush();
  f.dispose();
  pending.forEach((resolve) => resolve({ items: [item('late')], hasMore: false }));
  assert.equal(await read, false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.state.turns.recent.items.late, undefined);
});

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

test("only latest history pages select the initial window until it has loaded", () => {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "live", items: [item("live-item")] });
  assert.equal(store.state.initialHistoryTurnId, "");
  store.applyTurnsPage({ turns: [{ id: "first", items: [] }] });
  assert.equal(store.state.initialHistoryTurnId, "first");
  store.applyTurnsPage({ turns: [{ id: "older", items: [] }] }, undefined, { older: true });
  assert.equal(store.state.initialHistoryTurnId, "first");
  store.applyTurnsPage({ turns: [{ id: "newer", items: [] }] });
  assert.equal(store.state.initialHistoryTurnId, "newer", "a retry may discover a newer initial window");
  store.applyLatestItemsPage("newer", { items: [item("latest")], hasMore: false }, undefined, { reset: true });
  store.applyTurnsPage({ turns: [{ id: "next", items: [] }] });
  assert.equal(store.state.initialHistoryTurnId, "newer", "later refreshes must not hide an established timeline");
});

test("an empty initial history stays ready when a later turn arrives", () => {
  const store = createCodexChatStore("thread");
  store.applyTurnsPage({ turns: [], hasMore: false });
  assert.equal(store.state.initialized, true);
  assert.equal(store.state.initialHistoryTurnId, "");
  store.applyTurnsPage({ turns: [{ id: "later", items: [item("new")] }] });
  assert.equal(store.state.initialHistoryTurnId, "");
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
