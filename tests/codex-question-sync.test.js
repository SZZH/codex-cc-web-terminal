import test from "node:test";
import assert from "node:assert/strict";
import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexQuestionSync } from "../web/src/lib/codex-question-sync.js";
import { buildQuestionAnswer } from "../web/src/lib/codex-question-history.js";
import { pendingDesktopQuestions } from "../web/src/lib/codex-question-dock.js";

const question = (id = "call_hidden") => ({ id, type: "agentMessage", delivery: "async",
  questions: [{ title: "Choose a path", options: ["A", "B"] }] });
const tools = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: `tool-${i + offset}`, type: "commandExecution",
  status: "completed", command: "test", aggregatedOutput: "x".repeat(5000) }));
const reply = (id, questionId = "call_hidden", answer = "A", status = "accepted") => ({ id, type: "steeringUserMessage", status,
  input: [{ type: "text", text: buildQuestionAnswer(presentCodexItem(question(questionId)).presentation.question, 0, answer) }] });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(source, { beforeCall = () => {}, yieldPage = async () => {} } = {}) {
  const reader = new CodexHistoryReader();
  const store = createCodexChatStore("thread");
  const summary = reader.presentTurn({ id: "turn", status: "inProgress", items: source, itemsView: "full" }, "", false, "thread");
  const tail = source.slice(-30).map((item) => presentCodexItem(item));
  store.applyInitialHistory({ turnsPage: { threadId: "thread", turns: [summary], hasMore: false, olderCursor: null },
    itemsPage: { threadId: "thread", turnId: "turn", items: tail, latestItemId: tail.at(-1)?.id || null,
      hasMore: source.length > 30, nextCursor: source.length > 30 ? "older" : null } });
  const calls = [];
  let disposed = false;
  const sync = createCodexQuestionSync({ store, base: "/thread", isDisposed: () => disposed, yieldPage,
    call: async (path, options) => {
      const url = new URL(path, "http://test.invalid"); calls.push(url);
      await beforeCall(url, options);
      const detailId = url.pathname.match(/\/items\/([^/]+)$/)?.[1];
      if (detailId) return { item: presentCodexItem(source.find((item) => item.id === decodeURIComponent(detailId)), { detail: true }) };
      assert.equal(url.searchParams.get("limit"), "90");
      const cursor = url.searchParams.get("cursor"), after = url.searchParams.get("after");
      const start = cursor ? Number(cursor) : after ? source.findIndex((item) => item.id === after) + 1 : 0;
      const items = source.slice(start, start + 90).map((item) => presentCodexItem(item, { compact: true }));
      const hasMore = start + items.length < source.length;
      return { threadId: "thread", turnId: "turn", items, hasMore,
        nextCursor: hasMore ? String(start + items.length) : null, latestItemId: items.at(-1)?.id || after || null };
    } });
  return { store, sync, calls, summary, dispose() { disposed = true; sync.dispose(); } };
}

test("a question outside both summary and latest timeline is found without loading tool output into the store", async () => {
  const source = [{ id: "intro", type: "agentMessage", text: "Starting" }, question(),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `progress-${i}`, type: "agentMessage", text: "Working" })), ...tools(145)];
  const { store, sync, calls, summary } = fixture(source);
  assert.equal(summary.items.some((item) => item.id === "call_hidden"), false);
  assert.equal(pendingDesktopQuestions(store.state).length, 0);
  const timeline = [...store.state.turns.turn.itemsWindowIds];
  const loaded = Object.keys(store.state.turns.turn.items).length;
  await sync.refresh();
  assert.equal(pendingDesktopQuestions(store.state)[0].callId, "call_hidden");
  assert.equal(calls.length, 3);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, timeline);
  assert.equal(Object.keys(store.state.turns.turn.items).length, loaded);
  assert.deepEqual(Object.keys(store.state.turns.turn.questionItems), ["call_hidden"]);
});

test("an accepted desktop answer in the unrendered middle prevents a stale question from flashing", async () => {
  const gate = defer();
  const source = [question(), ...tools(95), reply("answer"), ...tools(70, 95)];
  const { store, sync, summary, calls } = fixture(source, { beforeCall: async (url) => {
    if (url.searchParams.get("cursor") === "90") await gate.promise;
  } });
  assert.ok(summary.items.some((item) => item.id === "call_hidden"));
  assert.equal(summary.items.some((item) => item.id === "answer"), false);
  const work = sync.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(store.state.turns.turn.questionSync.ready, false);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  gate.resolve(); await work;
  assert.equal(store.state.turns.turn.questionSync.ready, true);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  assert.equal(store.state.turns.turn.questionItems.answer.text.includes('"answer":"A"'), true);
});

test("after the first scan only appended items are read and rejected answers do not dismiss questions", async () => {
  const source = [question(), ...tools(100), reply("rejected", "call_hidden", "B", "rejected")];
  const { store, sync, calls } = fixture(source);
  await sync.refresh();
  assert.equal(pendingDesktopQuestions(store.state).length, 1);
  source.push(reply("accepted"));
  await sync.refresh();
  assert.equal(calls.at(-1).searchParams.get("after"), "rejected");
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  await sync.refresh();
  assert.equal(calls.at(-1).searchParams.get("after"), "accepted");
});

test("truncated answer envelopes hydrate their exact item, ordinary long output does not", async () => {
  const source = [question(), ...tools(20), reply("long-answer", "call_hidden", "A".repeat(9000)), ...tools(90, 20)];
  const { store, sync, calls } = fixture(source);
  await sync.refresh();
  assert.equal(calls.filter((url) => /\/items\//.test(url.pathname)).length, 1);
  assert.ok(calls.some((url) => url.pathname.endsWith("/items/long-answer")));
  assert.equal(store.state.turns.turn.questionItems["long-answer"].text.includes("A".repeat(9000)), true);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
});

test("failed scans retain their cursor and hide uncertain prompts until a successful retry", async () => {
  let failed = true;
  const { store, sync, calls } = fixture([question(), ...tools(120)], { beforeCall(url) {
    if (failed && url.searchParams.get("cursor") === "90") throw new Error("offline");
  } });
  await sync.refresh();
  assert.match(store.state.questionSyncError, /offline/);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  failed = false;
  await sync.refresh();
  assert.equal(calls.at(-1).searchParams.get("cursor"), "90");
  assert.equal(store.state.questionSyncError, "");
  assert.equal(pendingDesktopQuestions(store.state).length, 1);
});

test("completion, epoch change and disposal prevent a delayed scan from publishing old questions", async () => {
  for (const change of ["completion", "epoch", "dispose", "new-turn"]) {
    const gate = defer();
    const value = fixture([question(), ...tools(95)], { beforeCall: () => gate.promise });
    const work = value.sync.refresh();
    if (change === "completion") value.store.upsertTurn({ id: "turn", status: "completed" });
    if (change === "epoch") value.store.state.epoch = "new-epoch";
    if (change === "dispose") value.dispose();
    if (change === "new-turn") value.store.upsertTurn({ id: "next", status: "inProgress", items: [] });
    gate.resolve(); await work;
    assert.deepEqual(value.store.state.turns.turn.questionItems, {});
    assert.equal(value.store.state.turns.turn.questionSync.ready, false);
  }
});

test("derived question state cannot invalidate an earlier authoritative completion read", async () => {
  const { store, sync } = fixture([question()]);
  const read = store.beginRead();
  await sync.refresh();
  store.applyTurnsPage({ threadId: "thread", turns: [{ id: "turn", status: "completed", items: [] }], hasMore: false }, read);
  assert.equal(store.state.turns.turn.status, "completed");
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
});

test("an incomplete incremental pass cannot expose a question before its later answer is checked", async () => {
  const source = tools(3);
  let fail = false;
  const { store, sync } = fixture(source, { beforeCall(url) {
    if (fail && url.searchParams.has("cursor")) throw new Error("offline");
  } });
  await sync.refresh();
  source.push(question(), ...tools(95, 3), reply("answer")); fail = true;
  await sync.refresh();
  assert.equal(store.state.turns.turn.questionSync.ready, false);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  fail = false; await sync.refresh();
  assert.equal(store.state.turns.turn.questionSync.ready, true);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
});

test("queued desktop answers are revisited by identity after the tail has advanced", async () => {
  const queued = reply("queued-answer", "call_hidden", "A", "pending");
  const { store, sync, calls } = fixture([question(), queued, ...tools(95)]);
  await sync.refresh();
  assert.equal(pendingDesktopQuestions(store.state).length, 1);
  queued.status = "accepted";
  await sync.refresh();
  assert.ok(calls.some((url) => url.pathname.endsWith("/items/queued-answer")));
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
});

test("new summary questions wait for their incremental scan even when its first request fails", async () => {
  const source = [question("call_existing")];
  let fail = false;
  const { store, sync } = fixture(source, { beforeCall() { if (fail) throw new Error("offline"); } });
  await sync.refresh();
  source.push(question(), ...tools(95), reply("answer"));
  store.upsertTurn({ id: "turn", items: [presentCodexItem(question())] });
  fail = true; await sync.refresh();
  assert.deepEqual(pendingDesktopQuestions(store.state).map((entry) => entry.callId), ["call_existing"]);
  fail = false; await sync.refresh();
  assert.deepEqual(pendingDesktopQuestions(store.state).map((entry) => entry.callId), ["call_existing"]);
});
