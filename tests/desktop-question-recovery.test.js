import test from "node:test";
import assert from "node:assert/strict";
import { DesktopQuestionRecovery } from "../src/sessions/codex/desktopQuestionRecovery.js";

const request = (id = "reply-one", expectedTurnId = "original") => ({ id, expectedTurnId, state: "unknown", executionRoute: "desktopQuestion", turnId: null });
const item = (clientId = "reply-one", id = "official-answer") => ({ id, type: "userMessage", clientId });
const turns = (ids, olderCursor = null) => ({ turns: ids.map((id) => ({ id, items: [] })), olderCursor, hasMore: Boolean(olderCursor) });
const items = (entries = [], nextCursor = null) => ({ items: entries, nextCursor, hasMore: Boolean(nextCursor) });

function fixture(t, { listTurns = async () => turns(["original", "successor"]), listItems = async () => items(), reconcileItems, isClosed } = {}) {
  const calls = [], reconciled = [];
  const recovery = new DesktopQuestionRecovery({
    reader: {
      listTurns: (...args) => { calls.push({ method: "turns", threadId: args[0], options: args[1] }); return listTurns(...args); },
      listItems: (...args) => { calls.push({ method: "items", threadId: args[0], turnId: args[1], options: args[2] }); return listItems(...args); },
    },
    reconcileItems: (...args) => { reconciled.push(args); return reconcileItems?.(...args); }, isClosed,
  });
  t.after(() => recovery.shutdown());
  const tick = async (requests = [request()], threadId = "thread") => {
    const before = calls.length;
    await recovery.recover(threadId, requests);
    const recent = calls.slice(before);
    assert.ok(recent.filter((call) => call.method === "turns").length <= 1, "at most one turn page per tick");
    assert.ok(recent.filter((call) => call.method === "items").length <= 1, "at most one item page per tick");
    return recent;
  };
  return { recovery, calls, reconciled, tick };
}

test("an uncertain answer is recovered from successor items even when its turn summary omits it", async (t) => {
  const candidate = request();
  const f = fixture(t, { listItems: async (_, turnId) => turnId === "successor" ? items([item()]) : items(),
    reconcileItems: (_, turnId, found) => { candidate.turnId = turnId; candidate.state = "running"; candidate.userItemId = found[0].id; } });
  await f.tick([candidate]);
  assert.equal(candidate.turnId, "successor");
  assert.equal(candidate.userItemId, "official-answer");
  assert.deepEqual(f.reconciled, [["thread", "successor", [item()]]]);
  assert.equal(f.calls[1].options.sortDirection, "desc");
  const calls = f.calls.length;
  await f.tick([candidate]);
  assert.equal(f.calls.length, calls, "no remaining unknown request means no further reads");
});

test("turn and item cursors continue across ticks and stop at the earliest requested boundary inclusively", async (t) => {
  const f = fixture(t, {
    listTurns: async (_, { cursor }) => cursor ? turns(["too-old", "original", "middle"]) : turns(["recent", "newest"], "older-turn-page"),
    listItems: async (_, turnId, { cursor }) => turnId === "newest" && !cursor ? items([], "older-items")
      : turnId === "original" ? items([item("reply-two")]) : items(),
  });
  const candidates = [request("reply-one", "recent"), request("reply-two", "original")];
  for (let index = 0; index < 5; index++) await f.tick(candidates);
  assert.deepEqual(f.calls.filter((call) => call.method === "items").map(({ turnId, options }) => [turnId, options.cursor || null]), [
    ["newest", null], ["newest", "older-items"], ["recent", null], ["middle", null], ["original", null],
  ]);
  assert.deepEqual(f.calls.filter((call) => call.method === "turns").map(({ options }) => options.cursor || null), [null, "older-turn-page"]);
  assert.deepEqual(f.reconciled, [["thread", "original", [item("reply-two")]]]);
  await f.tick(candidates);
  assert.equal(f.calls.at(-1).turnId, "newest", "the next pass starts at the latest turn, not before the boundary");
});

test("late native items are discovered after a complete empty pass", async (t) => {
  let materialized = false;
  const f = fixture(t, { listItems: async (_, turnId) => items(materialized && turnId === "successor" ? [item()] : []) });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.reconciled, []);
  materialized = true;
  await f.tick();
  assert.deepEqual(f.reconciled, [["thread", "successor", [item()]]]);
});

test("an initially empty turn history is retried instead of marked permanently exhausted", async (t) => {
  let visible = false;
  const f = fixture(t, { listTurns: async () => turns(visible ? ["original", "successor"] : []), listItems: async () => items([item()]) });
  await f.tick();
  assert.equal(f.calls.length, 1);
  visible = true;
  await f.tick();
  assert.deepEqual(f.reconciled, [["thread", "successor", [item()]]]);
});

test("failed older-turn and item reads retain the exact unread cursor", async (t) => {
  let failedTurns = false, failedItems = false;
  const f = fixture(t, {
    listTurns: async (_, { cursor }) => {
      if (!cursor) return turns(["successor"], "older-turns");
      if (!failedTurns) { failedTurns = true; throw new Error("offline"); }
      return turns(["original"]);
    },
    listItems: async (_, turnId, { cursor }) => {
      if (turnId === "successor") return items();
      if (!cursor) return items([], "older-items");
      if (!failedItems) { failedItems = true; throw new Error("offline"); }
      return items([item()]);
    },
  });
  for (let index = 0; index < 5; index++) await f.tick();
  assert.deepEqual(f.calls.filter((call) => call.method === "turns").map(({ options }) => options.cursor || null), [null, "older-turns", "older-turns"]);
  assert.deepEqual(f.calls.filter((call) => call.method === "items").map(({ turnId, options }) => [turnId, options.cursor || null]),
    [["successor", null], ["original", null], ["original", "older-items"], ["original", "older-items"]]);
  assert.deepEqual(f.reconciled, [["thread", "original", [item()]]]);
});

test("text similarities, wrong IDs and pending steering messages cannot prove answer delivery", async (t) => {
  const candidate = request();
  const original = structuredClone(candidate);
  const f = fixture(t, { listItems: async () => items([
    { id: "same-text", type: "userMessage", text: "the exact question and answer", clientId: "another-request" },
    { id: "missing-client", type: "userMessage", text: "the exact question and answer" },
    { id: "optimistic", type: "steeringUserMessage", clientUserMessageId: candidate.id, status: "pending" },
    { id: "assistant", type: "agentMessage", clientId: candidate.id },
  ]) });
  await f.tick([candidate]);
  assert.deepEqual(f.reconciled, []);
  assert.deepEqual(candidate, original);
  assert.ok(f.calls.every(({ method }) => ["turns", "items"].includes(method)), "only read operations are available");
});

test("concurrent recovery calls share the same bounded read", async (t) => {
  let release;
  const f = fixture(t, { listTurns: () => new Promise((resolve) => { release = resolve; }) });
  const first = f.recovery.recover("thread", [request()]);
  const second = f.recovery.recover("thread", [request()]);
  assert.equal(first, second);
  release(turns(["original"]));
  await first;
  assert.equal(f.calls.length, 2);
});

test("clearing all requests discards cursors and ignores an obsolete in-flight read", async (t) => {
  let release, paused = true;
  const f = fixture(t, { listTurns: async () => turns(["original", "successor"]),
    listItems: async () => paused ? new Promise((resolve) => { release = resolve; }) : items() });
  const reading = f.recovery.recover("thread", [request()]);
  await new Promise((resolve) => setImmediate(resolve));
  await f.recovery.recover("thread", []);
  assert.equal(f.calls.at(-1).options.signal.aborted, true);
  release(items([item()]));
  await reading;
  assert.deepEqual(f.reconciled, []);
  paused = false;
  await f.tick();
  assert.equal(f.calls.at(-1).turnId, "successor");
  assert.equal(f.calls.at(-2).options.cursor, undefined);
});

test("request identity changes restart from the newest turn and suppress old read results", async (t) => {
  let release;
  const f = fixture(t, { listItems: async (_, turnId) => release ? items([item("reply-two")])
    : new Promise((resolve) => { release = resolve; }) });
  const original = f.recovery.recover("thread", [request()]);
  await new Promise((resolve) => setImmediate(resolve));
  await f.tick([request("reply-two")]);
  release(items([item()]));
  await original;
  assert.deepEqual(f.reconciled, [["thread", "successor", [item("reply-two")]]]);
});

test("forget, shutdown and an external close suppress late history reconciliation", async (t) => {
  for (const mode of ["forget", "shutdown", "external"]) await t.test(mode, async (t) => {
    let release, closed = false;
    const f = fixture(t, { isClosed: () => closed,
      listItems: () => new Promise((resolve) => { release = resolve; }) });
    const pending = f.recovery.recover("thread", [request()]);
    await new Promise((resolve) => setImmediate(resolve));
    if (mode === "external") closed = true;
    else if (mode === "forget") f.recovery.forget("thread");
    else f.recovery.shutdown();
    release(items([item()]));
    await pending;
    assert.deepEqual(f.reconciled, []);
  });
});

test("partial pagination metadata does not silently skip unread items", async (t) => {
  let correct = false;
  const f = fixture(t, { listTurns: async () => turns(["original"]),
    listItems: async (_, turnId, { cursor }) => !cursor ? items([], "page-two")
      : correct ? items([item()]) : { items: [], hasMore: true, nextCursor: null } });
  await f.tick();
  await f.tick();
  correct = true;
  await f.tick();
  assert.deepEqual(f.calls.filter((call) => call.method === "items").map(({ options }) => options.cursor || null), [null, "page-two", "page-two"]);
  assert.deepEqual(f.reconciled, [["thread", "original", [item()]]]);
});

test("thread state eviction stays bounded without discarding native requests", async (t) => {
  const f = fixture(t, { listTurns: async () => turns(["original", "successor"]),
    listItems: async () => items([], "older-items") });
  for (let index = 0; index < 129; index++) await f.tick([request()], `thread-${index}`);
  await f.tick([request()], "thread-0");
  const last = f.calls.slice(-2);
  assert.equal(last[0].method, "turns", "the least recent thread restarts after bounded state eviction");
  assert.equal(last[1].options.cursor, undefined);
});
