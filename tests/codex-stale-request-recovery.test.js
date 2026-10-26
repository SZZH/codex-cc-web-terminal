import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { CodexRequestStore } from "../src/sessions/codex/requestStore.js";
import { activeCodexTurnId, createCodexChatStore } from "../web/src/lib/codex-chat-store.js";

const old = { id: "old-turn", status: "unknown", startedAt: 1792850827, statusConfirmed: false };
const latest = { id: "latest-turn", status: "completed", startedAt: 1793004244, completedAt: 1793005314 };
const body = (clientRequestId) => ({ clientRequestId, input: { text: "keep original input", attachments: [] } });
async function flush() { for (let n = 0; n < 20; n++) await new Promise(setImmediate); }

test("a recovered old running receipt releases the next message without resending the old request", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-queue-"));
  const bridge = new EventEmitter(), calls = [];
  bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "native-queue", clientUserMessageId: params.clientUserMessageId } };
    return { data: [], nextCursor: null };
  };
  const service = new CodexThreadService({ config: { dataDir, defaultCwd: dataDir }, bridge,
    reader: { getThread: async (id) => ({ id, cwd: dataDir }), listTurns: async () => ({ turns: [latest] }) },
    desktopClient: { discover: async () => ({ clientId: "owner" }), shutdown() {} },
    sessionManager: { codexModelCatalog: () => [] }, recoveryMs: 60_000 });
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  service.requests.receive("thread", body("old-request"));
  service.updateRequest("thread", "old-request", { state: "running", executionRoute: "settingsQueue", turnId: old.id });
  service.requests.receive("thread", body("next-request"));
  await service.dispatchNext("thread");
  assert.equal(calls.length, 0, "the stale receipt reproduces the original queue blockage");
  service.reconcileRequests("thread", [latest]);
  assert.equal(service.requests.get("thread", "old-request").state, "running", "missing target metadata is not enough evidence");
  service.reconcileRequests("thread", [old]);
  await flush();
  const settled = service.requests.get("thread", "old-request");
  assert.equal(settled.state, "superseded");
  assert.equal(settled.supersededByTurnId, latest.id);
  assert.equal(settled.error.code, "turn_superseded");
  assert.equal(settled.input.text, "keep original input");
  assert.equal(service.requests.get("thread", "next-request").state, "queued");
  assert.deepEqual(calls.filter((call) => call.method === "thread/queue/add").map((call) => call.params.clientUserMessageId), ["next-request"]);
  assert.equal(calls.some((call) => call.method === "turn/start"), false);
  service.reconcileItems("thread", old.id, [{ id: "old-user", type: "userMessage", clientId: "old-request" }]);
  service.reconcileRequests("thread", [{ ...old, status: "inProgress" }]);
  assert.equal(service.requests.get("thread", "old-request").state, "superseded", "late old activity cannot revive execution");
  assert.equal(new CodexRequestStore({ dataDir }).get("thread", "old-request").state, "superseded", "restart preserves the settled receipt");
  const stream = service.stream("thread");
  service.handleNotification({ method: "turn/started", params: { threadId: "thread", turn: { ...old, status: "inProgress" } } });
  assert.equal(service.requests.get("thread", "old-request").state, "superseded");
  service.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { ...old, status: "completed" } } });
  assert.equal(service.requests.get("thread", "old-request").state, "completed");
  const completion = stream.events.map(({ event }) => event).filter((event) => event.payload.turn).at(-1);
  assert.equal(completion.type, "turn.metadata", "a late completion must not insert an unseen old turn into the latest window");
  assert.equal(completion.payload.turn.status, "completed", "publish the actual completion rather than a receipt-only status");
  service.reconcileRequests("thread", [old, latest], [{ ...settled, state: "running" }]);
  assert.equal(service.requests.get("thread", "old-request").state, "completed", "a stale poll snapshot cannot replace a real completion with superseded");
  service.requests.receive("thread", body("history-request"));
  service.updateRequest("thread", "history-request", { ...settled, id: "history-request", state: "superseded" });
  service.reconcileRequests("thread", [{ ...old, status: "completed", statusConfirmed: true }]);
  assert.equal(service.requests.get("thread", "history-request").state, "completed", "authoritative HTTP history may also recover the final result");
  assert.equal(service.requests.get("thread", "history-request").error, null);
});

test("a later authoritative completion may replace superseded without replaying input", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "settled-receipt-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new CodexRequestStore({ dataDir });
  store.receive("thread", body("old-request"));
  store.update("thread", "old-request", { state: "superseded", turnId: old.id, supersededByTurnId: latest.id });
  assert.equal(store.update("thread", "old-request", { state: "running" }).state, "superseded");
  assert.equal(store.update("thread", "old-request", { state: "completed", error: null }).state, "completed");
});

function observationFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-observer-"));
  const bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async () => ({ data: [] });
  const reader = { listTurns: async () => ({ turns: [] }), listItems: async () => ({ items: [] }) };
  const service = new CodexThreadService({ config: { dataDir }, bridge, reader, pollMs: 60_000, recoveryMs: 60_000 });
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  service.requests.receive("thread", body("old-request"));
  service.updateRequest("thread", "old-request", { state: "running", executionRoute: "desktopQueue", turnId: old.id });
  const store = createCodexChatStore("thread");
  const stream = service.stream("thread"), generation = store.beginSocket(), events = [];
  store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: stream.epoch, seq: stream.seq, type: "sync.required", payload: {} }, generation);
  stream.subscribers.add((event) => { events.push(event); store.applyEvent(event, generation); });
  return { service, reader, store, events };
}

test("history reconciliation cannot append a superseded desktop turn after the latest turn", async (t) => {
  const { service, reader, store, events } = observationFixture(t);
  const newer = { ...latest, status: "inProgress", completedAt: null };
  store.upsertTurn(newer);
  reader.listTurns = async () => ({ turns: [{ ...old, status: "inProgress" }, newer] });
  reader.listItems = async () => { assert.fail("superseded turn items must not be requested"); };
  await service.pollHistory("thread");
  assert.equal(service.requests.get("thread", "old-request").state, "superseded");
  assert.deepEqual(store.state.turnOrder, [newer.id]);
  assert.equal(activeCodexTurnId(store.state), newer.id);
  assert.equal(events.some((event) => event.type === "turn.upsert" || event.type === "item.upsert"), false);
});

for (const outcome of ["superseded", "completed"]) test(`a desktop item read cannot publish stale activity after its receipt becomes ${outcome}`, async (t) => {
  const { service, reader, events } = observationFixture(t);
  let releaseItems;
  reader.listTurns = async () => ({ turns: [{ ...old, status: "inProgress" }] });
  reader.listItems = async () => new Promise((resolve) => { releaseItems = resolve; });
  const polling = service.pollHistory("thread");
  await flush();
  assert.equal(typeof releaseItems, "function");
  if (outcome === "superseded") service.reconcileRequests("thread", [old, latest]);
  else service.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { ...old, status: "completed" } } });
  const count = events.length;
  releaseItems({ items: [{ id: "late-item", type: "agentMessage", text: "stale activity" }] });
  await polling;
  assert.equal(service.requests.get("thread", "old-request").state, outcome);
  assert.equal(events.length, count, "no old metadata or items can be emitted after settlement");
});

test("normal desktop completion still synchronizes the preceding turn and its final answer", async (t) => {
  const { service, reader, store } = observationFixture(t);
  const newer = { ...latest, status: "inProgress", completedAt: null };
  store.upsertTurn({ ...old, status: "inProgress", statusConfirmed: true });
  store.upsertTurn(newer);
  reader.listTurns = async () => ({ turns: [{ ...old, status: "completed", statusConfirmed: true, completedAt: old.startedAt + 10 }, newer] });
  reader.listItems = async () => ({ items: [{ id: "final-answer", type: "agentMessage", text: "answer delivered", status: "completed" }] });
  await service.pollHistory("thread");
  assert.equal(service.requests.get("thread", "old-request").state, "completed");
  assert.equal(store.state.turns[old.id].status, "completed");
  assert.equal(store.state.turns[old.id].items["final-answer"].text, "answer delivered");
  assert.deepEqual(store.state.turnOrder, [old.id, newer.id]);
  assert.equal(activeCodexTurnId(store.state), newer.id);
});
