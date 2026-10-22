import test from "node:test";
import assert from "node:assert/strict";
import { CodexTurnController } from "../src/sessions/codex/turnController.js";

function fixture() {
  const calls = [];
  const service = {
    closed: false, active: new Map(), requests: { get: () => null },
    reader: { listTurns: async () => ({ turns: [{ id: "visible", status: "inProgress" }] }) },
    desktopClient: {
      discover: async () => ({ clientId: "desktop" }),
      interruptTurn: async (...args) => { calls.push({ route: "desktop", args }); return { ok: true, turnId: "visible" }; }
    },
    bridge: { request: async (...args) => { calls.push({ route: "owned", args }); return {}; } }
  };
  return { service, calls, control: new CodexTurnController(service) };
}

test("desktop stop works without a web submission receipt and never resumes the thread", async () => {
  const f = fixture();
  assert.deepEqual(await f.control.interrupt("thread", { expectedTurnId: "visible" }), { ok: true, turnId: "visible" });
  assert.deepEqual(f.calls, [{ route: "desktop", args: ["thread", { owner: { clientId: "desktop" }, expectedTurnId: "visible" }] }]);
});

test("desktop queues, question answers and settings receipts retain desktop stop ownership", async () => {
  for (const executionRoute of ["desktopQueue", "desktopQuestion", "desktopSettings"]) {
    const f = fixture();
    f.service.active.set("thread", { requestId: "receipt", turnId: "visible" });
    f.service.requests.get = () => ({ executionRoute });
    await f.control.interrupt("thread", { expectedTurnId: "visible" });
    assert.equal(f.calls[0].route, "desktop");
  }
});

test("a stale stop never targets a successor and completed turns need no mutation", async () => {
  for (const turn of [{ id: "new-turn", status: "inProgress" }, { id: "visible", status: "completed" }, null]) {
    const f = fixture(); f.service.reader.listTurns = async () => ({ turns: turn ? [turn] : [] });
    assert.deepEqual(await f.control.interrupt("thread", { expectedTurnId: "visible" }), { ok: true, turnId: null });
    assert.equal(f.calls.length, 0);
  }
});

test("owned stop keeps its explicit turn ID and rejects a stale target", async () => {
  const f = fixture(); f.service.active.set("thread", { turnId: "visible", requestId: "owned" });
  await f.control.interrupt("thread", { expectedTurnId: "visible" });
  assert.deepEqual(f.calls, [{ route: "owned", args: ["turn/interrupt", { threadId: "thread", turnId: "visible" }] }]);
  await assert.rejects(f.control.interrupt("thread", { expectedTurnId: "older" }), { code: "turn_not_active" });
  assert.equal(f.calls.length, 1);
});

test("duplicate pending stops share one dispatch and keep other threads independent", async () => {
  const f = fixture(); let release;
  f.service.reader.listTurns = () => new Promise((r) => { release = r; });
  const first = f.control.interrupt("thread", { expectedTurnId: "visible" });
  assert.equal(first, f.control.interrupt("thread", { expectedTurnId: "visible" }));
  release({ turns: [{ id: "visible", status: "inProgress" }] }); await first;
  assert.equal(f.calls.length, 1); assert.equal(f.control.pending.size, 0);
});

test("an uncertain desktop stop cannot fall back to the wrong runtime or automatically retry", async () => {
  const f = fixture();
  f.service.desktopClient.interruptTurn = async () => { f.calls.push("desktop"); throw Object.assign(new Error("lost"), { uncertain: true }); };
  await assert.rejects(f.control.interrupt("thread", { expectedTurnId: "visible" }), { code: "interrupt_unconfirmed", status: 503 });
  assert.deepEqual(f.calls, ["desktop"]);
});

test("a missing desktop target, invalid request or shutdown causes no mutation", async () => {
  const f = fixture();
  for (const body of [{}, null, [], { expectedTurnId: 3 }, { expectedTurnId: "" }]) await assert.rejects(f.control.interrupt("thread", body));
  f.service.closed = true;
  await assert.rejects(f.control.interrupt("thread", { expectedTurnId: "visible" }), { status: 503 });
  assert.equal(f.calls.length, 0);
});

test("shutdown during desktop discovery cancels the pending stop and preserves goal pause feedback", async () => {
  const f = fixture();
  f.service.desktopClient.discover = async () => { f.service.closed = true; return { clientId: "desktop" }; };
  await assert.rejects(f.control.interrupt("thread", { expectedTurnId: "visible" }), { status: 503 });
  assert.equal(f.calls.length, 0);
  f.service.closed = false; f.service.desktopClient.discover = async () => ({ clientId: "desktop" });
  f.service.desktopClient.interruptTurn = async () => ({ ok: true, turnId: "visible", goalPauseError: "pause unavailable" });
  assert.equal((await f.control.interrupt("thread", { expectedTurnId: "visible" })).goalPauseError, "pause unavailable");
});
