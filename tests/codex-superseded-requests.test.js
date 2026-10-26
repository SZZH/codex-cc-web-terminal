import test from "node:test";
import assert from "node:assert/strict";
import { CodexSupersededRequests } from "../src/sessions/codex/supersededRequests.js";

const oldTime = "2026-10-24T00:00:00Z", newTime = "2026-10-26T00:00:00Z";
const oldTurn = (patch = {}) => ({ id: "old", status: "unknown", startedAt: oldTime,
  statusSource: "unconfirmed-history", statusConfirmed: false, ...patch });
const newTurn = (patch = {}) => ({ id: "new", status: "completed", startedAt: newTime, ...patch });
const receipt = (patch = {}) => ({ id: "request-old", turnId: "old", state: "running", executionRoute: "settingsQueue", ...patch });
const evidence = [{ requestId: "request-old", turnId: "old", supersededByTurnId: "new" }];

test("a newer completed turn supersedes the old unknown settings execution without changing its receipt", () => {
  const observer = new CodexSupersededRequests();
  const request = Object.freeze(receipt({ input: Object.freeze({ text: "original content" }) }));
  const turns = [Object.freeze(oldTurn()), Object.freeze(newTurn())];
  assert.deepEqual(observer.observe("thread", turns, [request]), evidence);
  assert.equal(request.state, "running");
  assert.equal(turns[0].status, "unknown");
  assert.equal(request.input.text, "original content");
});

test("an accepted turn absent from the history window is not mistaken for a superseded execution", () => {
  const observer = new CodexSupersededRequests();
  assert.deepEqual(observer.observe("thread", [newTurn()], [receipt({ state: "accepted", turnId: "not-loaded" })]), []);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt({ state: "accepted", turnId: "not-loaded" })]), []);
  assert.deepEqual(observer.observe("thread", [newTurn({ id: "not-loaded", status: "inProgress",
    startedAt: "2026-10-26T01:00:00Z" })], [receipt({ state: "accepted", turnId: "not-loaded" })]), []);
});

test("recovery can load the newest page first and then reconcile an older page without replacing newer evidence", () => {
  for (let restart = 0; restart < 2; restart += 1) {
    const observer = new CodexSupersededRequests();
    assert.deepEqual(observer.observe("thread", [newTurn()], [receipt()]), []);
    assert.deepEqual(observer.observe("thread", [newTurn({ id: "middle", startedAt: "2026-10-25T00:00:00Z" })], []), []);
    assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), evidence);
    assert.deepEqual(observer.observe("thread", [oldTurn({ status: "inProgress", statusConfirmed: true })], [receipt()]), evidence);
  }
});

test("request submission and update timestamps never replace official turn chronology", () => {
  const observer = new CodexSupersededRequests();
  assert.deepEqual(observer.observe("thread", [oldTurn(), newTurn()], [receipt({
    createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z"
  })]), evidence);
  assert.deepEqual(observer.observe("thread", [newTurn({ id: "next", status: "running",
    startedAt: "2026-10-27T00:00:00Z" })], [receipt({ turnId: "next", state: "accepted", createdAt: oldTime })]), []);
});

test("seconds, milliseconds, numeric strings and ISO timestamps describe the same ordering", () => {
  const oldMs = Date.parse(oldTime), newMs = Date.parse(newTime);
  for (const [older, newer] of [[oldMs / 1000, newMs], [oldMs, newTime], [oldTime, newMs / 1000],
    [String(oldMs / 1000), String(newMs)]]) {
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn({ startedAt: older }),
      newTurn({ startedAt: newer })], [receipt()]), evidence);
  }
});

test("missing or invalid timestamps cannot prove that another turn started later", () => {
  for (const value of [undefined, null, "", " ", "not-a-date", NaN, Infinity, 0, -1, true, {}, []]) {
    const observer = new CodexSupersededRequests();
    assert.deepEqual(observer.observe("thread", [oldTurn({ startedAt: value }), newTurn()], [receipt()]), []);
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ startedAt: value })], [receipt()]), []);
  }
  assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn({ startedAt: newTime }), newTurn()], [receipt()]), []);
});

test("only a confirmed started or finished turn supplies newer execution evidence", () => {
  for (const status of ["inProgress", "running", "completed", "failed"]) {
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status })], [receipt()]), evidence);
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status, statusConfirmed: false })], [receipt()]), []);
  }
  for (const status of ["unknown", "pending", "cancelled", undefined]) {
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status })], [receipt()]), []);
  }
  for (const status of ["interrupted", "aborted"]) {
    for (const completedAt of [undefined, null, "", "invalid"]) {
      assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status, completedAt })], [receipt()]), []);
    }
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status, completedAt: newTime })], [receipt()]), evidence);
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn({ status, completedAt: newTime,
      statusConfirmed: false })], [receipt()]), []);
  }
});

test("failed or empty reads do not invent execution evidence or remove an earlier authoritative observation", () => {
  const observer = new CodexSupersededRequests();
  for (const failed of [undefined, null, [], { error: "read failed" }]) {
    assert.deepEqual(observer.observe("thread", failed, [receipt()]), []);
  }
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), []);
  observer.observe("thread", [newTurn()], []);
  assert.deepEqual(observer.observe("thread", null, [receipt()]), []);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), evidence);
});

test("only bound nonterminal receipts with an unfinished target in the current page are returned", () => {
  for (const state of ["accepted", "running", "unknown"]) {
    for (const status of ["unknown", "inProgress", "running"]) {
      assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn({ status }), newTurn()], [receipt({ state })]), evidence);
    }
  }
  for (const state of ["received", "queued", "dispatching", "completed", "failed", "interrupted", "superseded", "removed"]) {
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn()], [receipt({ state })]), []);
  }
  for (const status of ["completed", "failed", "interrupted", "aborted", "cancelled"]) {
    assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn({ status }), newTurn()], [receipt()]), []);
  }
  assert.deepEqual(new CodexSupersededRequests().observe("thread", [oldTurn(), newTurn()],
    [receipt({ turnId: null, input: { text: "matching user text" } })]), []);
});

test("the same turn cannot supersede itself and the caller owns terminal deduplication", () => {
  const observer = new CodexSupersededRequests();
  observer.observe("thread", [newTurn({ id: "old" })], []);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), []);
  observer.observe("thread", [newTurn({ startedAt: "2026-10-27T00:00:00Z" })], []);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), evidence);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt()]), evidence);
  assert.deepEqual(observer.observe("thread", [oldTurn()], [receipt({ state: "superseded" })]), []);
});

test("evidence stays within its thread and forget removes it", () => {
  const observer = new CodexSupersededRequests();
  observer.observe("first", [newTurn()], []);
  assert.deepEqual(observer.observe("second", [oldTurn()], [receipt()]), []);
  assert.deepEqual(observer.observe("first", [oldTurn()], [receipt({ threadId: "second" })]), []);
  assert.deepEqual(observer.observe("second", [oldTurn(), newTurn({ threadId: "first" })], [receipt()]), []);
  assert.deepEqual(observer.observe("first", [oldTurn()], [receipt()]), evidence);
  observer.forget("first");
  assert.deepEqual(observer.observe("first", [oldTurn()], [receipt()]), []);
});

test("the bounded cache keeps 128 recently observed threads and evicts older evidence", () => {
  const observer = new CodexSupersededRequests();
  for (let index = 0; index < 128; index += 1) observer.observe(`thread-${index}`, [newTurn()], []);
  assert.deepEqual(observer.observe("thread-0", [oldTurn()], [receipt()]), evidence);
  observer.observe("thread-128", [newTurn()], []);
  assert.deepEqual(observer.observe("thread-1", [oldTurn()], [receipt()]), []);
  assert.deepEqual(observer.observe("thread-0", [oldTurn()], [receipt()]), evidence);
  assert.deepEqual(observer.observe("thread-128", [oldTurn()], [receipt()]), evidence);
});
