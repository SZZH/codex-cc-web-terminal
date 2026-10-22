import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

import { SessionManager } from "../src/sessionManager.js";
import { applySessionInputEvents } from "../src/transport/sse/sessionStream.js";
import { createBaseConfig, createTempDir, waitForCondition, waitForMicrotasks } from "./helpers/backendTestUtils.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControlledBridge extends EventEmitter {
  turns = [];
  interrupts = [];

  startTurn(session, prompt) {
    session.resumeSessionId ||= "thread-control";
    const result = deferred();
    this.turns.push({ prompt, result });
    return result.promise;
  }

  interruptTurn(session, turnId) {
    const result = deferred();
    this.interrupts.push({ sessionId: session.id, turnId, result });
    return result.promise;
  }
}

function createManager(overrides = {}) {
  const rootDir = createTempDir();
  const bridge = new ControlledBridge();
  const manager = new SessionManager(createBaseConfig(rootDir, overrides), { appServerBridge: bridge });
  const events = [];
  manager.broadcast = (session, payload) => { events.push(payload); };
  manager.scheduleConversationHistoryResync = () => {};
  manager.maybeAutoRename = () => {};
  const session = manager.get(manager.create({ provider: "codex" }).id);
  return { manager, bridge, session, events };
}

function notify(bridge, method, turnId, extra = {}) {
  bridge.emit("notification", {
    method,
    params: { threadId: "thread-control", turn: { id: turnId }, ...extra }
  });
}

function turnStatus(session, turnId) {
  return session.conversationState.turns.find((turn) => turn.id === turnId)?.assistant.status;
}

async function startRunningTurn(context, turnId = "server-active") {
  const localTurnId = context.manager.write(context.session.id, "active");
  context.bridge.turns[0].result.resolve({ turn: { id: turnId, status: "inProgress", items: [] } });
  await waitForMicrotasks();
  return localTurnId;
}

test("interrupt input uses explicit session control without creating prompt input", () => {
  const calls = [];
  const result = applySessionInputEvents({
    interrupt: (id) => { calls.push(["interrupt", id]); },
    write: () => { assert.fail("interrupt must not enter the prompt queue"); }
  }, "session-control", [{ type: "interrupt" }]);
  assert.deepEqual(calls, [["interrupt", "session-control"]]);
  assert.deepEqual(result, { lastInputTurnId: "" });
});

test("ESC interruption is limited to non-Codex PTY sessions", () => {
  const { manager } = createManager();
  const writes = [];
  manager.sessions.set("pty", { id: "pty", provider: "cc", runnerMode: "pty", shell: { write: (data) => writes.push(data) } });
  assert.equal(manager.interrupt("pty"), true);
  assert.deepEqual(writes, ["\u001b"]);
  manager.sessions.set("codex-pty", { id: "codex-pty", provider: "codex", runnerMode: "pty", shell: { write: () => assert.fail("unsupported Codex PTY") } });
  assert.throws(() => manager.interrupt("codex-pty"), /不支持中断/);
  assert.throws(() => manager.interrupt("missing"), /Session not found/);
});

test("interrupting idle Codex sessions performs no RPC or new turn", () => {
  const { manager, bridge, session } = createManager();
  assert.equal(manager.interrupt(session.id), false);
  assert.deepEqual(session.queuedInputs, []);
  assert.equal(session.currentTurnId, "");
  assert.equal(bridge.turns.length, 0);
  assert.equal(bridge.interrupts.length, 0);
});

test("app-server interruption clears old queued turns and drains before starting new input", async () => {
  const context = createManager();
  const { manager, bridge, session, events } = context;
  const localTurnId = manager.write(session.id, "active");
  notify(bridge, "turn/started", "server-active");
  const queuedTurnId = manager.write(session.id, "queued before interrupt");
  const interruption = manager.interrupt(session.id);
  const nextLocalTurnId = manager.write(session.id, "submitted after interrupt");
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 1);
  assert.equal(bridge.interrupts[0].turnId, "server-active");
  assert.equal(session.turnIdAliases.get(localTurnId), "server-active");
  assert.equal(turnStatus(session, queuedTurnId), "interrupted");
  assert.deepEqual(session.queuedInputs, ["submitted after interrupt"]);
  bridge.interrupts[0].result.resolve({});
  assert.equal(await interruption, true);
  assert.equal(turnStatus(session, "server-active"), "running");
  assert.equal(session.turnRunning, true);
  assert.equal(bridge.turns.length, 1);
  notify(bridge, "item/agentMessage/delta", "server-active", { turnId: "server-active", delta: "output before termination" });
  assert.equal(session.buffer.includes("output before termination"), true);
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 1);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "interrupted" } });
  assert.equal(bridge.turns.length, 2);
  assert.equal(bridge.turns[1].prompt, "submitted after interrupt");
  assert.equal(session.currentTurnId, nextLocalTurnId);
  bridge.turns[0].result.resolve({ turn: { id: "server-active", status: "completed", items: [{ type: "agent_message", text: "stale result" }] } });
  notify(bridge, "turn/started", "server-active");
  notify(bridge, "item/agentMessage/delta", "server-active", { turnId: "server-active", delta: "late text" });
  notify(bridge, "turn/completed", "server-active");
  await waitForMicrotasks();
  assert.equal(session.currentTurnId, nextLocalTurnId);
  assert.equal(session.buffer.includes("stale result"), false);
  assert.equal(session.buffer.includes("late text"), false);
  assert.equal(turnStatus(session, "server-active"), "interrupted");
  assert.equal(bridge.turns.length, 2);
  assert.equal(events.filter((event) => event.type === "turn.interrupted" && event.turnId === "server-active").length, 1);
});

test("startup interruption waits for a server turn ID returned by startTurn", async () => {
  const context = createManager();
  const { manager, bridge, session } = context;
  const localTurnId = manager.write(session.id, "active");
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 0);
  bridge.turns[0].result.resolve({ turn: { id: "server-startup", status: "inProgress", items: [] } });
  await waitForMicrotasks();
  assert.equal(session.turnIdAliases.get(localTurnId), "server-startup");
  assert.equal(bridge.interrupts[0].turnId, "server-startup");
  assert.notEqual(bridge.interrupts[0].turnId, localTurnId);
  bridge.interrupts[0].result.resolve({});
  assert.equal(await interruption, true);
  notify(bridge, "turn/completed", "server-startup", { turn: { id: "server-startup", status: "interrupted" } });
  assert.equal(session.turnRunning, false);
  assert.equal(turnStatus(session, "server-startup"), "interrupted");
});

test("RPC interruption failures stay visible and leave the active turn running for retry", async () => {
  const context = createManager();
  const { manager, bridge, session, events } = context;
  await startRunningTurn(context);
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  bridge.interrupts[0].result.reject(new Error("RPC unavailable"));
  assert.equal(await interruption, false);
  assert.equal(session.turnRunning, true);
  assert.equal(session.currentTurnId, "server-active");
  assert.equal(turnStatus(session, "server-active"), "running");
  assert.equal(events.some((event) => event.type === "transport.error" && event.code === "turn_interrupt_failed" && event.message.includes("RPC unavailable")), true);
  const retry = manager.interrupt(session.id);
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 2);
  bridge.interrupts[1].result.resolve({});
  assert.equal(await retry, true);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "interrupted" } });
});

test("a startTurn failure while interruption awaits a server ID remains a real failure", async () => {
  const { manager, bridge, session, events } = createManager();
  const localTurnId = manager.write(session.id, "active");
  const interruption = manager.interrupt(session.id);
  bridge.turns[0].result.reject(new Error("start failed"));
  assert.equal(await interruption, false);
  await waitForMicrotasks();
  assert.equal(session.turnRunning, false);
  assert.equal(turnStatus(session, localTurnId), "failed");
  assert.equal(events.some((event) => event.part?.text?.includes("start failed")), true);
  assert.equal(bridge.interrupts.length, 0);
});

test("server terminal interruption can confirm cancellation before the RPC response", async () => {
  const context = createManager();
  const { manager, bridge, session, events } = context;
  await startRunningTurn(context);
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "interrupted" } });
  assert.equal(await interruption, true);
  bridge.interrupts[0].result.reject(new Error("turn already finished"));
  await waitForMicrotasks();
  assert.equal(turnStatus(session, "server-active"), "interrupted");
  assert.equal(session.turnRunning, false);
  assert.equal(events.some((event) => event.code === "turn_interrupt_failed"), false);
});

test("a terminal startup response settles interruption before any redundant interrupt RPC", async () => {
  const { manager, bridge, session } = createManager();
  manager.write(session.id, "active");
  const interruption = manager.interrupt(session.id);
  assert.equal(manager.interrupt(session.id), interruption);
  bridge.turns[0].result.resolve({ turn: { id: "server-finished", status: "interrupted", items: [] } });
  assert.equal(await interruption, true);
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 0);
  assert.equal(turnStatus(session, "server-finished"), "interrupted");
  assert.equal(session.turnRunning, false);
});

test("server interrupted completion preserves its terminal status without an explicit local request", async () => {
  const context = createManager();
  const { bridge, session } = context;
  await startRunningTurn(context);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "interrupted" } });
  assert.equal(turnStatus(session, "server-active"), "interrupted");
  assert.equal(session.turnRunning, false);
  assert.equal(bridge.interrupts.length, 0);
});

test("cancellation confirmation timeout keeps the active execution occupied and permits retry", async () => {
  const context = createManager({ codexAppServerRequestTimeoutMs: 20 });
  const { manager, bridge, session, events } = context;
  await startRunningTurn(context);
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  bridge.interrupts[0].result.resolve({});
  assert.equal(await interruption, true);
  manager.write(session.id, "still queued");
  await waitForCondition(() => events.some((event) => event.code === "turn_interrupt_confirmation_timeout"));
  assert.equal(session.turnRunning, true);
  assert.equal(turnStatus(session, "server-active"), "running");
  assert.equal(bridge.turns.length, 1);
  const retry = manager.interrupt(session.id);
  await waitForMicrotasks();
  assert.equal(bridge.interrupts.length, 2);
  bridge.interrupts[1].result.resolve({});
  assert.equal(await retry, true);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "interrupted" } });
  assert.equal(session.turnRunning, false);
  assert.equal(turnStatus(session, "server-active"), "interrupted");
});

test("a turn completing normally before cancellation takes effect retains its actual result", async () => {
  const context = createManager();
  const { manager, bridge, session, events } = context;
  await startRunningTurn(context);
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  bridge.interrupts[0].result.resolve({});
  assert.equal(await interruption, true);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "completed" } });
  assert.equal(turnStatus(session, "server-active"), "completed");
  assert.equal(session.turnRunning, false);
  assert.equal(events.some((event) => event.type === "turn.interrupted"), false);
});

test("a genuine failed terminal response remains visible after an interruption request was acknowledged", async () => {
  const context = createManager();
  const { manager, bridge, session, events } = context;
  await startRunningTurn(context);
  const interruption = manager.interrupt(session.id);
  await waitForMicrotasks();
  bridge.interrupts[0].result.resolve({});
  assert.equal(await interruption, true);
  notify(bridge, "turn/completed", "server-active", { turn: { id: "server-active", status: "failed", error: { message: "actual server failure" } } });
  assert.equal(turnStatus(session, "server-active"), "failed");
  assert.equal(session.turnRunning, false);
  assert.equal(events.some((event) => event.type === "transport.error" && event.message.includes("actual server failure")), true);
});

function fakeChild(killResult = true) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return killResult; };
  return child;
}

test("JSON exec interruption kills only its current child and does not report cancellation as failure", async (t) => {
  const children = [];
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const { manager, session, events } = createManager({ codexAppServerEnabled: false });
    const activeTurnId = manager.write(session.id, "active");
    const queuedTurnId = manager.write(session.id, "old queue");
    const interruption = manager.interrupt(session.id);
    const nextTurnId = manager.write(session.id, "new queue");
    assert.deepEqual(children[0].signals, ["SIGINT"]);
    assert.equal(children.length, 1);
    assert.equal(turnStatus(session, queuedTurnId), "interrupted");
    children[0].stderr.emit("data", "expected cancellation diagnostic");
    children[0].stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "late text" } })}\n`);
    children[0].emit("close", 130);
    assert.equal(await interruption, true);
    assert.equal(turnStatus(session, activeTurnId), "interrupted");
    assert.equal(children.length, 2);
    assert.equal(session.currentTurnId, nextTurnId);
    assert.equal(session.runningProcess, children[1]);
    assert.equal(session.buffer.includes("late text"), false);
    assert.equal(events.some((event) => /执行失败|本轮未返回/.test(event.part?.text || "")), false);
    children[0].emit("close", 1);
    assert.equal(session.runningProcess, children[1]);
    children[1].stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "new reply" } })}\n`);
    children[1].emit("close", 0);
    assert.equal(turnStatus(session, nextTurnId), "completed");
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("JSON exec signal failures stay visible and do not mask a subsequent execution failure", async (t) => {
  const child = fakeChild(false);
  const spawnMock = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try {
    const { manager, session, events } = createManager({ codexAppServerEnabled: false });
    const turnId = manager.write(session.id, "active");
    assert.equal(await manager.interrupt(session.id), false);
    assert.equal(session.runningProcess, child);
    assert.equal(events.some((event) => event.code === "turn_interrupt_failed"), true);
    child.stderr.emit("data", "actual process failure");
    child.emit("close", 1);
    assert.equal(turnStatus(session, turnId), "failed");
    assert.equal(events.some((event) => event.part?.text?.includes("actual process failure")), true);
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a fresh JSON exec interrupted before thread.started resumes its real thread for the next input", async (t) => {
  const children = [];
  const spawnArgs = [];
  const spawnMock = t.mock.method(childProcess, "spawn", (file, args) => {
    const child = fakeChild();
    children.push(child);
    spawnArgs.push([...args]);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const { manager, session } = createManager({ codexAppServerEnabled: false });
    manager.write(session.id, "first input");
    assert.equal(spawnArgs[0].includes("resume"), false);
    const interruption = manager.interrupt(session.id);
    const nextTurnId = manager.write(session.id, "next input");
    children[0].stdout.emit("data", `${JSON.stringify({ type: "thread.started", thread_id: "real-json-thread" })}\n`);
    children[0].stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "canceled body" } })}\n`);
    assert.equal(session.resumeSessionId, "real-json-thread");
    assert.equal(session.buffer.includes("canceled body"), false);
    children[0].emit("close", 130);
    assert.equal(await interruption, true);
    assert.equal(children.length, 2);
    const resumeIndex = spawnArgs[1].indexOf("resume");
    assert.notEqual(resumeIndex, -1);
    assert.deepEqual(spawnArgs[1].slice(resumeIndex, resumeIndex + 3), ["resume", "--all", "real-json-thread"]);
    assert.equal(spawnArgs[1].at(-1), "next input");
    assert.equal(session.currentTurnId, nextTurnId);
    children[0].stdout.emit("data", `${JSON.stringify({ type: "thread.started", thread_id: "stale-old-thread" })}\n`);
    assert.equal(session.resumeSessionId, "real-json-thread");
    assert.equal(session.runningProcess, children[1]);
    children[1].stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "next reply" } })}\n`);
    children[1].emit("close", 0);
    assert.equal(turnStatus(session, nextTurnId), "completed");
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("JSON exec confirmation timeout retains the child until its real close event", async (t) => {
  const children = [];
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const { manager, session, events } = createManager({ codexAppServerEnabled: false, codexAppServerRequestTimeoutMs: 20 });
    const turnId = manager.write(session.id, "active");
    const interruption = manager.interrupt(session.id);
    manager.write(session.id, "next input");
    await waitForCondition(() => events.some((event) => event.code === "turn_interrupt_confirmation_timeout"));
    assert.equal(await interruption, false);
    assert.equal(session.runningProcess, children[0]);
    assert.equal(session.turnRunning, true);
    assert.equal(turnStatus(session, turnId), "running");
    assert.equal(spawnMock.mock.callCount(), 1);
    children[0].emit("close", 130);
    assert.equal(turnStatus(session, turnId), "interrupted");
    assert.equal(spawnMock.mock.callCount(), 2);
    children[1].emit("close", 0);
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});
