import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { CodexRequestStore } from "../src/sessions/codex/requestStore.js";

function fixture(t, { remove = async () => true, steer, turns, options = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-promotion-"));
  const events = [], bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async () => { throw new Error("Unexpected app-server mutation"); };
  const desktopClient = { discover: async () => ({ clientId: "owner" }), shutdown() {},
    steerMessage: async (id, args) => {
      if (!await args.beforeSend()) throw Object.assign(new Error("target changed"), { uncertain: false });
      events.push(["send", args.clientUserMessageId, args.input]);
      return steer ? steer(id, args) : { turnId: "active-turn" };
    } };
  const reader = { getThread: async () => ({ id: "thread" }),
    listTurns: turns || (async () => ({ turns: [{ id: "active-turn", status: "inProgress", items: [] }] })) };
  const service = new CodexThreadService({ config: { dataDir }, bridge, reader, desktopClient,
    recoveryMs: 60_000, queueRecoveryMs: 60_000 });
  service.queuedWriter.find = async () => ({ id: "queue-entry", clientUserMessageId: "request-123" });
  service.queuedWriter.delete = async () => { events.push(["delete"]); return remove(); };
  service.queuedWriter.list = async () => [{ id: "queue-entry", clientUserMessageId: "request-123" }];
  service.requests.receive("thread", { clientRequestId: "request-123", mode: "queue", options,
    input: { text: "continue here", attachments: [] } });
  service.updateRequest("thread", "request-123", { state: "queued", executionRoute: "desktopQueue", upstreamQueueId: "queue-entry" });
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, events, dataDir, reader,
    promote: () => service.promoteQueuedRequest("thread", "request-123", { expectedTurnId: "active-turn" }),
    receipt: () => service.requests.get("thread", "request-123") };
}

test("phone guidance claims one queue entry, reuses its ID and serializes cancellation", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { remove: () => gate });
  const first = f.promote();
  assert.equal(f.promote(), first);
  await assert.rejects(f.service.cancelQueuedRequest("thread", "request-123"), { code: "queue_action_pending" });
  release(true);
  assert.equal((await first).state, "accepted");
  assert.deepEqual(f.events, [["delete"], ["send", "request-123", [{ type: "text", text: "continue here" }]]]);
  assert.equal(f.receipt().turnId, "active-turn");
  assert.equal(f.receipt().executionRoute, "desktopSteer");
  await f.promote();
  assert.equal(f.events.length, 2, "retrying the same receipt never delivers a second copy");
  f.service.active.set("thread", { requestId: "unrelated", turnId: "other-turn" });
  assert.equal(f.service.recoveryRequests("thread").length, 1, "desktop acceptance is still reconciled");
  assert.equal(f.service.getThreadActivity("thread").activityState, "unknown");
});

for (const type of ["missing", "lost"]) test(`an ${type} queue claim never steers or resets to queued`, async (t) => {
  const f = fixture(t, { remove: async () => { if (type === "lost") throw new Error("connection lost"); return false; } });
  await f.promote();
  assert.equal(f.receipt().state, "unknown");
  assert.equal(f.receipt().promotionPhase, "claiming");
  await f.service.syncQueue("thread", { invalidate: true });
  assert.equal(f.receipt().state, "unknown");
  await f.promote();
  assert.deepEqual(f.events, [["delete"]]);
  const restarted = new CodexRequestStore({ dataDir: f.dataDir });
  assert.equal(restarted.get("thread", "request-123").state, "unknown");
  assert.equal(restarted.get("thread", "request-123").input.text, "continue here");
});

for (const uncertain of [true, false]) test(`delivery failure keeps ${uncertain ? "unknown" : "restorable"} input without resending`, async (t) => {
  const f = fixture(t, { steer: async () => { throw Object.assign(new Error("delivery failed"), { uncertain }); } });
  await f.promote();
  assert.equal(f.receipt().state, uncertain ? "unknown" : "rejected");
  assert.equal(f.receipt().input.text, "continue here");
  await f.promote();
  assert.equal(f.events.length, 2);
});

test("a target change after removal preserves recoverable input without calling steer", async (t) => {
  let reads = 0;
  const f = fixture(t, { turns: async () => ({ turns: [{ id: ++reads === 1 ? "active-turn" : "next-turn", status: "inProgress" }] }) });
  await f.promote();
  assert.equal(f.receipt().state, "rejected");
  assert.equal(f.receipt().promotionPhase, "claimed");
  assert.deepEqual(f.events, [["delete"]]);
});

test("the native acknowledged turn is authoritative and never causes a retry", async (t) => {
  const f = fixture(t, { steer: async () => ({ turnId: "actual-turn" }) });
  await f.promote();
  assert.equal(f.receipt().state, "accepted");
  assert.equal(f.receipt().expectedTurnId, "active-turn");
  assert.equal(f.receipt().turnId, "actual-turn");
  f.service.reconcileRequests("thread", [{ id: "actual-turn", status: "interrupted", items: [] }]);
  assert.equal(f.receipt().state, "unknown", "unconfirmed desktop interruption is not a terminal result");
  f.service.reconcileItems("thread", "actual-turn", [{ id: "user", type: "userMessage", clientId: "request-123" }]);
  f.service.reconcileRequests("thread", [{ id: "actual-turn", status: "completed", completedAt: 123, items: [] }]);
  assert.equal(f.receipt().state, "completed");
});

test("new settings and unavailable targets leave the original queue intact", async (t) => {
  for (const config of [{ options: { model: "new-model" } }, { turns: async () => ({ turns: [] }) }]) {
    const f = fixture(t, config);
    await assert.rejects(f.promote());
    assert.equal(f.receipt().state, "queued");
    assert.equal(f.events.length, 0);
  }
});

for (const source of ["history", "notification"]) test(`stale history interruption cannot finish a promoted ${source} item`, async (t) => {
  const f = fixture(t);
  f.service.reconcileRequests("thread", [{ id: "active-turn", status: "interrupted", items: [] }]);
  await f.promote();
  const item = { id: "user", type: "userMessage", clientId: "request-123" };
  if (source === "history") f.service.reconcileItems("thread", "active-turn", [item]);
  else f.service.handleNotification({ method: "item/started", params: { threadId: "thread", turnId: "active-turn", item } });
  assert.ok(["accepted", "running"].includes(f.receipt().state));
  f.service.reconcileRequests("thread", [{ id: "active-turn", status: "inProgress", items: [] }]);
  assert.equal(f.service.terminalTurns.has("thread:active-turn"), false);
  f.service.reconcileItems("thread", "active-turn", [item]);
  assert.equal(f.receipt().state, "running");
  f.service.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "active-turn", status: "interrupted" } } });
  assert.equal(f.receipt().state, "interrupted", "a real completion event remains authoritative without timestamps");
});


test("restart distinguishes a claimed unsent message from an uncertain delivery", (t) => {
  for (const state of ["dispatching", "unknown"]) for (const phase of ["claimed", "claiming", "sending", "accepted"]) {
    const f = fixture(t);
    f.service.requests.update("thread", "request-123", { state, mode: "steer",
      executionRoute: "desktopSteer", promotionPhase: phase });
    const restarted = new CodexRequestStore({ dataDir: f.dataDir });
    const request = restarted.get("thread", "request-123");
    assert.equal(request.state, phase === "claimed" ? "rejected" : "unknown");
    assert.equal(request.input.text, "continue here");
  }
});

test("restart preserves official execution evidence even with an older claimed phase", (t) => {
  const f = fixture(t);
  f.service.requests.update("thread", "request-123", { state: "unknown", mode: "steer",
    executionRoute: "desktopSteer", promotionPhase: "claimed", turnId: "actual-turn", userItemId: "official-user" });
  const restarted = new CodexRequestStore({ dataDir: f.dataDir });
  assert.equal(restarted.get("thread", "request-123").state, "unknown");
});
