import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";

const settings = { model: "model-new", reasoningEffort: "high", permissionMode: "manual-review" };
const input = (id = "request-settings-1") => ({ clientRequestId: id, mode: "queue", options: { ...settings }, input: { text: "next task", attachments: [] } });
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)); };
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-"));
  const calls = [], starts = [];
  const state = { status: "completed", nativeQueue: [], start: null, reading: null };
  const bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/queue/list") return { data: state.nativeQueue, nextCursor: null };
    if (method === "turn/start") return { turn: { id: "owned-turn", status: "inProgress" } };
    return {};
  };
  const reader = { getThread: async (id) => ({ id, cwd: dataDir, status: "active" }),
    listTurns: async () => { if (state.reading) await state.reading; return { turns: [{ id: "last-turn", status: state.status }], hasMore: false }; } };
  const desktopClient = { discover: async () => ({ clientId: "owner", supportsUntrustedAppInput: true }), shutdown() {},
    startMessage: async (threadId, args) => {
      state.beforeStart?.();
      if (args.beforeSend && !await args.beforeSend()) throw Object.assign(new Error("not idle"), { code: "CODEX_DESKTOP_NOT_IDLE" });
      const { beforeSend, ...wire } = args; starts.push({ threadId, ...structuredClone(wire) }); return state.start ? state.start(args) : { turnId: "new-turn" }; } };
  const service = new CodexThreadService({ config: { dataDir, defaultCwd: dataDir }, bridge, reader, desktopClient,
    sessionManager: { codexModelCatalog: () => [] }, pollMs: 60_000, recoveryMs: 60_000 });
  service.settingsDispatcher.retryMs = 60_000;
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { force: true, recursive: true }); });
  return { service, calls, starts, state, reader };
}

test("idle desktop holding a writer starts once with all selected settings despite stale active metadata", async (t) => {
  const f = fixture(t);
  f.service.submit("thread", input()); await flush();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].settings.model, "model-new");
  assert.equal(f.starts[0].settings.effort, "high");
  assert.equal(f.starts[0].settings.approvalPolicy, "on-request");
  assert.equal(f.starts[0].settings.approvalsReviewer, "user");
  assert.equal(f.starts[0].settings.sandboxPolicy.type, "readOnly");
  assert.equal(f.service.requests.get("thread", input().clientRequestId).state, "accepted");
  assert.deepEqual(f.calls.map((c) => c.method), ["thread/queue/list", "thread/queue/list"]);
});

test("running settings submissions queue unchanged and retain their snapshot until the turn finishes", async (t) => {
  const f = fixture(t); f.state.status = "inProgress";
  const message = input(); message.mode = "steer"; message.expectedTurnId = "last-turn";
  f.service.submit("thread", message); message.options.model = "later-choice"; await flush();
  const queued = f.service.requests.get("thread", message.clientRequestId);
  assert.equal(queued.state, "queued"); assert.equal(queued.mode, "queue");
  assert.equal(queued.executionRoute, "settingsQueue"); assert.equal(queued.options.model, "model-new");
  const before = queued.updatedAt;
  await f.service.dispatchNext("thread");
  assert.equal(f.service.requests.get("thread", message.clientRequestId).updatedAt, before, "waiting must not flicker through dispatching");
  assert.equal(f.starts.length, 0); assert.equal(f.calls.length, 0);
  f.state.status = "completed";
  await f.service.dispatchNext("thread");
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0].settings.model, "model-new");
  assert.equal(f.calls.some((c) => c.method === "turn/steer" || c.method.includes("settings/update")), false);
});

test("new settings never overtake or overwrite the native desktop queue", async (t) => {
  const f = fixture(t); f.state.nativeQueue = [{ id: "old-queue", clientUserMessageId: "old-message" }];
  f.service.submit("thread", input()); await flush();
  assert.equal(f.starts.length, 0); assert.equal(f.service.requests.get("thread", input().clientRequestId).state, "queued");
  assert.deepEqual(f.state.nativeQueue, [{ id: "old-queue", clientUserMessageId: "old-message" }]);
  f.state.nativeQueue = []; await f.service.dispatchNext("thread");
  assert.equal(f.starts.length, 1);
});

test("a local settings queue can be cancelled and cannot be promoted to a turn using old settings", async (t) => {
  const f = fixture(t); f.state.status = "inProgress";
  f.service.submit("thread", input()); await flush();
  assert.throws(() => f.service.promoteQueuedRequest("thread", input().clientRequestId, { expectedTurnId: "last-turn" }));
  assert.equal((await f.service.cancelQueuedRequest("thread", input().clientRequestId)).state, "cancelled");
  f.state.status = "completed"; await f.service.dispatchNext("thread");
  assert.equal(f.starts.length, 0);
});

test("cancel during the final idle read prevents the desktop mutation", async (t) => {
  const f = fixture(t); f.state.status = "inProgress";
  f.service.submit("thread", input()); await flush();
  let release; f.state.reading = new Promise((r) => { release = r; }); f.state.status = "completed";
  const dispatch = f.service.dispatchNext("thread"); await flush();
  await f.service.cancelQueuedRequest("thread", input().clientRequestId);
  release(); await dispatch;
  assert.equal(f.starts.length, 0);
});

test("lost desktop settings-start receipt is unknown and never replayed or queued natively", async (t) => {
  const f = fixture(t); f.state.start = () => { throw Object.assign(new Error("lost acknowledgement"), { uncertain: true }); };
  f.service.submit("thread", input()); await flush();
  assert.equal(f.service.requests.get("thread", input().clientRequestId).state, "unknown");
  f.service.submit("thread", input()); await f.service.dispatchNext("thread");
  assert.equal(f.starts.length, 1);
  assert.equal(f.calls.some((c) => c.method === "thread/queue/add"), false);
});

test("a web-owned running turn finishes before its settings snapshot starts the next turn", async (t) => {
  const f = fixture(t); f.reader.getThread = async (id) => ({ id, cwd: f.service.config.defaultCwd, status: "idle" });
  f.service.loaded.add("thread");
  f.service.active.set("thread", { requestId: "previous-request", turnId: "previous-turn" });
  f.service.submit("thread", input()); await flush();
  assert.equal(f.service.requests.get("thread", input().clientRequestId).state, "received");
  assert.equal(f.calls.length, 0);
  f.service.active.delete("thread"); await f.service.dispatchNext("thread");
  const sent = f.calls.find((c) => c.method === "turn/start");
  assert.equal(sent.params.model, "model-new"); assert.equal(sent.params.sandboxPolicy.type, "readOnly");
  assert.equal(f.starts.length, 0);
});


test("desktop activity changing during owner discovery keeps the settings message queued", async (t) => {
  const f = fixture(t); f.state.beforeStart = () => { f.state.status = "inProgress"; };
  f.service.submit("thread", input()); await flush();
  assert.equal(f.starts.length, 0);
  assert.equal(f.service.requests.get("thread", input().clientRequestId).state, "queued");
});

test("uncertain web-owned settings starts are reconciled without resending", async (t) => {
  const f = fixture(t);
  f.reader.getThread = async (id) => ({ id, cwd: f.service.config.defaultCwd, status: "idle" });
  f.service.loaded.add("thread");
  f.service.bridge.request = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "turn/start") throw Object.assign(new Error("lost receipt"), { uncertain: true });
    return {};
  };
  f.service.submit("thread", input()); await flush();
  const request = f.service.requests.get("thread", input().clientRequestId);
  assert.equal(request.state, "unknown");
  assert.equal(f.service.recoveryRequests("thread").some((r) => r.id === request.id), true);
  assert.equal(f.service.recoveryTimers.has("thread"), true);
  await f.service.dispatchNext("thread");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("settings overrides do not mask an invalid send mode", (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.submit("thread", { ...input(), mode: "invalid" }), /不支持的发送方式/);
  assert.equal(f.service.requests.list("thread").length, 0);
});
