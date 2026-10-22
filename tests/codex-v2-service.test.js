import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { CodexRequestStore } from "../src/sessions/codex/requestStore.js";
import { DesktopQueueObserver } from "../src/sessions/codex/desktopQueueObserver.js";
import { saveUploadedImage } from "../src/sessions/shared/imageAttachments.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";

function fixture(t, { request, recoveryMs, queueRecoveryMs } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-service-"));
  const calls = [];
  const bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (request) return request(method, params);
    return method === "turn/start" ? { turn: { id: "turn-official", status: "inProgress", items: [] } } : {};
  };
  const reader = { getThread: async (id) => ({ id, cwd: dataDir }), listTurns: async () => ({ turns: [] }) };
  const config = { dataDir, defaultCwd: dataDir };
  const service = new CodexThreadService({ config, bridge, reader, sessionManager: { codexModelCatalog: () => [] }, pollMs: 60_000, recoveryMs, queueRecoveryMs });
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, calls, bridge, reader };
}
const body = (id = "request-123") => ({ clientRequestId: id, input: { text: "继续", attachments: [] }, options: { model: "test", reasoningEffort: "low", permissionMode: "default" } });
const desktopBody = (id = "request-123") => ({ ...body(id), options: {} });
async function flush() { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); }

test("desktop removal notification clears durable waiting receipts and never resends them", async (t) => {
  let members = [{ id: "queue-123", clientUserMessageId: "request-123" }];
  const { service, bridge, calls } = fixture(t, { request: (method) => method === "thread/queue/list"
    ? { data: members, nextCursor: null } : {} });
  service.requests.receive("thread-123", desktopBody());
  service.updateRequest("thread-123", "request-123", { state: "queued", executionRoute: "desktopQueue", upstreamQueueId: "queue-123" });
  await service.syncQueue("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
  members = [];
  bridge.emit("notification", { method: "thread/queue/changed", params: { threadId: "thread-123" } });
  await flush();
  const removed = service.requests.get("thread-123", "request-123");
  assert.equal(removed.state, "removed");
  assert.equal(removed.turnId, null);
  assert.deepEqual(service.pendingReceipts("thread-123"), []);
  assert.equal(service.recoveryTimers.has("thread-123"), false);
  assert.equal(service.submit("thread-123", desktopBody()).state, "removed");
  await flush();
  assert.ok(calls.every((call) => call.method === "thread/queue/list"));
});

test("consumed queue receipt can be recovered by late official items after leaving the recent journal window", async (t) => {
  const { service } = fixture(t);
  service.requests.receive("thread-123", desktopBody());
  service.updateRequest("thread-123", "request-123", { state: "removed", executionRoute: "desktopQueue", upstreamQueueId: "queue-123" });
  service.requests.indexes.get("thread-123").recent.delete("request-123");
  service.reconcileItems("thread-123", "turn-late", [{ id: "user-late", type: "userMessage", clientId: "request-123" }]);
  assert.equal(service.requests.get("thread-123", "request-123").state, "accepted");
  assert.equal(service.pendingReceipts("thread-123")[0].turnId, "turn-late");
  service.reconcileRequests("thread-123", [{ id: "turn-late", status: "completed", items: [] }]);
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
});

test("polling a subscribed thread removes absent desktop queue entries without a native notification", async (t) => {
  const { service, reader } = fixture(t, { request: () => ({ data: [], nextCursor: null }) });
  service.requests.receive("thread-123", desktopBody());
  service.updateRequest("thread-123", "request-123", { state: "queued", executionRoute: "desktopQueue", upstreamQueueId: "queue-123" });
  reader.listTurns = async () => ({ turns: [] });
  const events = [];
  const stop = service.subscribe("thread-123", (event) => events.push(event));
  await flush();
  assert.ok(events.some((event) => event.type === "request.updated" && event.payload.request.state === "removed"));
  stop();
  assert.equal(service.requests.get("thread-123", "request-123").state, "removed");
});

test("late official turn identity recovers removal even when poll passes an empty pending set", async (t) => {
  const { service } = fixture(t);
  service.requests.receive("thread-123", desktopBody());
  service.updateRequest("thread-123", "request-123", { state: "removed", executionRoute: "desktopQueue" });
  service.reconcileRequests("thread-123", [{ id: "turn-late", status: "inProgress", items: [
    { id: "user-late", type: "userMessage", clientId: "request-123" }
  ] }], []);
  assert.equal(service.requests.get("thread-123", "request-123").state, "running");
});

test("late official user notification revives consumed membership after the last observer closes", async (t) => {
  const { service, bridge } = fixture(t);
  service.requests.receive("thread-123", desktopBody());
  service.updateRequest("thread-123", "request-123", { state: "removed", executionRoute: "desktopQueue" });
  service.finish("thread-123", "request-123");
  assert.equal(service.streams.has("thread-123"), false);
  assert.equal(service.trackedRequests.has("thread-123"), false);
  bridge.emit("notification", { method: "item/started", params: { threadId: "thread-123", turnId: "late-turn",
    item: { id: "late-user", type: "userMessage", clientId: "request-123", content: [] } } });
  assert.equal(service.requests.get("thread-123", "request-123").state, "running");
  assert.equal(service.recoveryTimers.has("thread-123"), true);
  assert.equal(service.trackedRequests.has("thread-123"), true);
});

test("submission creates a durable receipt before dispatch and passes stable client identity", async (t) => {
  const { service, calls } = fixture(t);
  const receipt = service.submit("thread-123", body());
  assert.equal(receipt.state, "received");
  assert.equal(calls.length, 0);
  await flush();
  assert.equal(service.requests.get("thread-123", receipt.id).state, "accepted");
  assert.equal(calls.find((entry) => entry.method === "turn/start").params.clientUserMessageId, receipt.id);
  service.submit("thread-123", body());
  await flush();
  assert.equal(calls.filter((entry) => entry.method === "turn/start").length, 1);
});

test("writer conflict queues the original request once for the owning desktop runtime", async (t) => {
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  const receipt = service.requests.get("thread-123", "request-123");
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.executionRoute, "desktopQueue");
  assert.equal(receipt.upstreamQueueId, "queue-123");
  assert.equal(receipt.input.text, "继续");
  assert.equal(calls.some((entry) => entry.method === "turn/start"), false);
  assert.equal(calls.find((entry) => entry.method === "thread/queue/add").params.clientUserMessageId, receipt.id);
  assert.equal(service.submit("thread-123", desktopBody()).state, "queued");
  await flush();
  assert.equal(calls.filter((entry) => entry.method === "thread/queue/add").length, 1);
  service.reconcileRequests("thread-123", [{ id: "desktop-turn", status: "completed", items: [
    { type: "userMessage", id: "desktop-user", clientId: receipt.id }
  ] }]);
  assert.equal(service.requests.get("thread-123", receipt.id).state, "completed");
  assert.equal(service.requests.get("thread-123", receipt.id).turnId, "desktop-turn");
});

test("desktop queue publishes persisted items before completion without accepting an unconfirmed interruption", async (t) => {
  const { service, reader } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  let stage = 0;
  const user = { id: "desktop-user", type: "userMessage", clientId: "request-123" };
  const commentary = { id: "desktop-agent", type: "agentMessage", status: "completed", text: "正在检查文件" };
  const command = { id: "desktop-command", type: "commandExecution", status: "completed", command: "pwd" };
  reader.listTurns = async () => ({ turns: stage ? [{ id: "desktop-turn", status: stage === 5 ? "completed" : stage === 3 ? "inProgress" : "interrupted",
    completedAt: stage === 5 ? "2026-10-17T10:00:00Z" : null,
    items: stage === 1 ? [user] : [user, command] }] : [] });
  reader.listItems = async (_threadId, _turnId, options) => {
    assert.equal(options.sortDirection, "desc");
    return { items: stage === 1 ? [user] : [user, commentary, command] };
  };
  const events = [];
  const unsubscribe = service.subscribe("thread-123", (event) => events.push(event));
  service.submit("thread-123", desktopBody());
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");

  stage = 1;
  await service.pollHistory("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "accepted");
  assert.equal(service.requests.get("thread-123", "request-123").turnId, "desktop-turn");
  assert.equal(events.find((event) => event.type === "turn.upsert").payload.turn.status, "unknown");

  stage = 2;
  await service.pollHistory("thread-123");
  const itemEvents = events.filter((event) => event.type === "item.upsert");
  assert.deepEqual(itemEvents.map((event) => event.payload.item.id), ["desktop-user", "desktop-agent", "desktop-command"]);
  assert.equal(itemEvents[1].payload.item.text, "正在检查文件");
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  await service.pollHistory("thread-123");
  assert.equal(events.filter((event) => event.type === "item.upsert").length, itemEvents.length);

  stage = 3;
  await service.pollHistory("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "running");
  const turnEvents = events.filter((event) => event.type === "turn.upsert");
  assert.equal(turnEvents.at(-1).payload.turn.status, "inProgress");
  assert.equal(service.stream("thread-123").intervalMs, service.desktopPollMs);
  const originalList = service.requests.list;
  let directoryScans = 0;
  service.requests.list = (...args) => { directoryScans += 1; return originalList.apply(service.requests, args); };
  await service.pollHistory("thread-123");
  await service.pollHistory("thread-123");
  service.requests.list = originalList;
  assert.equal(directoryScans, 0);
  stage = 4;
  await service.pollHistory("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  assert.equal(events.filter((event) => event.type === "turn.upsert").at(-1).payload.turn.status, "unknown");
  assert.equal(service.requests.get("thread-123", "request-123").error.code, "confirmation_required");
  service.reconcileItems("thread-123", "desktop-turn", [user]);
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");

  stage = 5;
  await service.pollHistory("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
  assert.equal(events.filter((event) => event.type === "turn.upsert").at(-1).payload.turn.status, "completed");
  assert.equal(service.stream("thread-123").intervalMs, service.pollMs);
  unsubscribe();
});

test("desktop queue observer ignores unrelated items while polling still synchronizes turn metadata", async (t) => {
  const { service, reader } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  reader.listTurns = async () => ({ turns: [{ id: "other-turn", status: "completed", items: [
    { id: "other-user", type: "userMessage", clientId: "someone-else" },
    { id: "other-agent", type: "agentMessage", text: "Other answer" }
  ] }] });
  reader.listItems = async () => { throw new Error("unrelated turn items must not be read"); };
  const events = [];
  const unsubscribe = service.subscribe("thread-123", (event) => events.push(event));
  service.submit("thread-123", desktopBody());
  await flush();
  await service.pollHistory("thread-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
  assert.equal(events.some((event) => event.type === "item.upsert"), false);
  assert.deepEqual(events.filter((event) => event.type === "turn.metadata").map((event) => event.payload.turn),
    [{ id: "other-turn", status: "completed" }]);
  unsubscribe();
});

test("a long desktop turn does not append old summary commentary after its recent items", async () => {
  const user = { id: "user", type: "userMessage", clientId: "request-123" };
  const oldCommentary = { id: "old-commentary", type: "agentMessage", text: "early" };
  const recent = Array.from({ length: 29 }, (_, index) => ({ id: `recent-${index}`, type: "commandExecution" }));
  recent.push({ id: "final", type: "agentMessage", text: "latest" });
  const events = [];
  const observer = new DesktopQueueObserver({ reader: { listItems: async () => ({ items: recent }) },
    publish: (_threadId, type, payload) => events.push({ type, payload }) });
  await observer.observe("thread-123", [{ id: "turn-123", status: "inProgress", items: [user, oldCommentary, recent.at(-1)] }],
    [{ id: "request-123", state: "running", executionRoute: "desktopQueue", turnId: "turn-123" }]);
  assert.deepEqual(events.filter((event) => event.type === "item.upsert").map((event) => event.payload.item.id),
    ["user", ...recent.map((item) => item.id)]);
  assert.equal(events.some((event) => event.payload.item?.id === "old-commentary"), false);
});

test("a late desktop item read cannot recreate a released event stream", async (t) => {
  const { service, reader } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  let visible = false;
  let releaseItems;
  reader.listTurns = async () => ({ turns: visible ? [{ id: "desktop-turn", status: "inProgress", items: [
    { id: "desktop-user", type: "userMessage", clientId: "request-123" }
  ] }] : [] });
  reader.listItems = async () => new Promise((resolve) => { releaseItems = resolve; });
  const unsubscribe = service.subscribe("thread-123", () => {});
  service.submit("thread-123", desktopBody());
  await flush();
  visible = true;
  const polling = service.pollHistory("thread-123");
  await until(() => Boolean(releaseItems));
  unsubscribe();
  releaseItems({ items: [{ id: "desktop-agent", type: "agentMessage", text: "late" }] });
  await polling;
  assert.equal(service.streams.size, 0);
  assert.equal(service.desktopQueueObserver.signatures.size, 0);
});

test("synchronous unsubscribe during a desktop turn event stops later item publication", async (t) => {
  const { service, reader } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  let visible = false;
  reader.listTurns = async () => ({ turns: visible ? [{ id: "desktop-turn", status: "inProgress", items: [
    { id: "desktop-user", type: "userMessage", clientId: "request-123" }
  ] }] : [] });
  reader.listItems = async () => { throw new Error("item read after unsubscribe"); };
  let unsubscribe;
  const events = [];
  unsubscribe = service.subscribe("thread-123", (event) => {
    events.push(event);
    if (event.type === "turn.upsert") unsubscribe();
  });
  service.submit("thread-123", desktopBody());
  await flush();
  visible = true;
  await service.pollHistory("thread-123");
  assert.equal(events.some((event) => event.type === "turn.upsert"), true);
  assert.equal(events.some((event) => event.type === "item.upsert"), false);
  assert.equal(service.streams.size, 0);
});

test("shutdown during a desktop item read cannot publish after closure", async (t) => {
  const { service, reader } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  let visible = false;
  let releaseItems;
  reader.listTurns = async () => ({ turns: visible ? [{ id: "desktop-turn", status: "inProgress", items: [
    { id: "desktop-user", type: "userMessage", clientId: "request-123" }
  ] }] : [] });
  reader.listItems = async () => new Promise((resolve) => { releaseItems = resolve; });
  const events = [];
  service.subscribe("thread-123", (event) => events.push(event));
  service.submit("thread-123", desktopBody());
  await flush();
  visible = true;
  const polling = service.pollHistory("thread-123");
  await until(() => Boolean(releaseItems));
  service.shutdown();
  const before = events.length;
  releaseItems({ items: [{ id: "desktop-agent", type: "agentMessage", text: "late" }] });
  await polling;
  assert.equal(events.length, before);
  assert.equal(service.stream("thread-123").timer, null);
});

test("a definitive turn/start writer rejection queues without replaying the turn", async (t) => {
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "turn/start") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
  assert.equal(calls.filter((entry) => entry.method === "turn/start").length, 1);
  assert.equal(calls.filter((entry) => entry.method === "thread/queue/add").length, 1);
});

test("desktop queue keeps explicit settings locally instead of discarding or rejecting them", async (t) => {
  const { service, calls } = fixture(t, { request: async (method) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    return {};
  } });
  service.submit("thread-123", body());
  await flush();
  const receipt = service.requests.get("thread-123", "request-123");
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.executionRoute, "settingsQueue");
  assert.deepEqual(receipt.options, body().options);
  assert.equal(receipt.error, null);
  assert.equal(calls.some((entry) => entry.method === "thread/queue/add"), false);
  assert.equal(receipt.input.text, "继续");
});

test("lost desktop queue acknowledgement stays unknown and blocks following requests", async (t) => {
  const { service, calls } = fixture(t, { request: async (method) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") throw Object.assign(new Error("queue response lost"), { uncertain: true });
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  service.submit("thread-123", desktopBody("request-456"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  assert.equal(service.requests.get("thread-123", "request-456").state, "received");
  assert.equal(calls.filter((entry) => entry.method === "thread/queue/add").length, 1);
});

test("desktop queue snapshots the uploaded image path with its original client identity", async (t) => {
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-image", clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCe8AAAAASUVORK5CYII=", "base64");
  const image = saveUploadedImage(service.config, png, { type: "image/png", name: "desktop.png" });
  service.submit("thread-123", { ...desktopBody(), input: { text: "描述图片", attachments: [{ id: image.id }] } });
  await flush();
  const queue = calls.find((entry) => entry.method === "thread/queue/add");
  assert.deepEqual(queue.params.input, [
    { type: "text", text: "描述图片", text_elements: [] },
    { type: "localImage", path: path.join(service.config.dataDir, "uploads", "images", `${image.id}.png`) }
  ]);
  assert.equal(queue.params.clientUserMessageId, "request-123");
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
});

test("confirmed desktop queue work does not block another distinct queued message", async (t) => {
  let queueNumber = 0;
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: `queue-${++queueNumber}`, clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  service.submit("thread-123", desktopBody("request-456"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
  assert.equal(service.requests.get("thread-123", "request-456").state, "queued");
  assert.deepEqual(calls.filter((entry) => entry.method === "thread/queue/add").map((entry) => entry.params.clientUserMessageId),
    ["request-123", "request-456"]);
});

test("a later request stays behind a desktop queued request even when writer ownership changes", async (t) => {
  let resumeCalls = 0;
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume" && ++resumeCalls === 1) {
      throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    }
    if (method === "thread/queue/add") return { queuedSubmission: { id: `queue-${params.clientUserMessageId}`, clientUserMessageId: params.clientUserMessageId } };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  service.submit("thread-123", desktopBody("request-456"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-456").state, "queued");
  assert.equal(resumeCalls, 1);
  assert.equal(calls.some((entry) => entry.method === "turn/start"), false);
});

test("desktop queue recovery walks one older turn page per pass until a client ID is found", async (t) => {
  const { service, reader } = fixture(t, { recoveryMs: 5, queueRecoveryMs: 5 });
  service.requests.receive("thread-123", desktopBody());
  service.requests.update("thread-123", "request-123", { state: "queued", executionRoute: "desktopQueue", upstreamQueueId: "queue-123" });
  const cursors = [];
  reader.listTurns = async (_threadId, options) => {
    cursors.push(options.cursor || "latest");
    if (!options.cursor) return { turns: [{ id: "latest", status: "completed", items: [] }], olderCursor: "page-1" };
    if (options.cursor === "page-1") return { turns: [{ id: "middle", status: "completed", items: [] }], olderCursor: "page-2" };
    return { turns: [{ id: "queued-turn", status: "completed", items: [
      { id: "queued-user", type: "userMessage", clientId: "request-123" }
    ] }] };
  };
  service.scheduleRecovery("thread-123");
  await until(() => service.requests.get("thread-123", "request-123").state === "completed");
  assert.deepEqual(cursors.slice(0, 4), ["latest", "page-1", "latest", "page-2"]);
  assert.equal(service.requests.get("thread-123", "request-123").turnId, "queued-turn");
});

test("a lost queue acknowledgement is recovered by client ID without another enqueue", async (t) => {
  let queueReads = 0;
  const { service, calls } = fixture(t, { recoveryMs: 5, request: async (method) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") throw Object.assign(new Error("response lost"), { uncertain: true });
    if (method === "thread/queue/list") { queueReads += 1; return { data: [{ id: "queue-123", clientUserMessageId: "request-123" }], nextCursor: null }; }
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await until(() => service.requests.get("thread-123", "request-123")?.state === "queued");
  assert.equal(service.requests.get("thread-123", "request-123").upstreamQueueId, "queue-123");
  assert.ok(queueReads >= 1);
  assert.equal(calls.filter((entry) => entry.method === "thread/queue/add").length, 1);
});

test("desktop queued message can be withdrawn before execution and remains an idempotent receipt", async (t) => {
  const { service, calls } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    if (method === "thread/queue/list") return { data: [{ id: "queue-123", clientUserMessageId: "request-123" }], nextCursor: null };
    if (method === "thread/queue/delete") return { deleted: true };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  const cancelled = await service.cancelQueuedRequest("thread-123", "request-123");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(service.submit("thread-123", desktopBody()).state, "cancelled");
  assert.equal((await service.cancelQueuedRequest("thread-123", "request-123")).state, "cancelled");
  assert.equal(calls.filter((entry) => entry.method === "thread/queue/delete").length, 1);
});

test("desktop queued message cannot be marked cancelled after the queue item was consumed", async (t) => {
  const { service } = fixture(t, { request: async (method, params) => {
    if (method === "thread/resume") throw Object.assign(new Error("thread thread-123 already has an active writer"), { rpcError: true });
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-123", clientUserMessageId: params.clientUserMessageId } };
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  await assert.rejects(service.cancelQueuedRequest("thread-123", "request-123"), (error) => error.status === 409);
  assert.equal(service.requests.get("thread-123", "request-123").state, "queued");
});

test("lost upstream acknowledgement becomes unknown and blocks subsequent automatic dispatch", async (t) => {
  const { service, calls } = fixture(t, { request: async (method) => {
    if (method === "turn/start") throw new Error("app-server request timeout: turn/start");
    return {};
  } });
  service.submit("thread-123", body());
  await flush();
  service.submit("thread-123", body("request-456"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  assert.equal(calls.filter((entry) => entry.method === "turn/start").length, 1);
});

test("official clientId reconciles an unknown request without replaying its prompt", async (t) => {
  const { service, calls } = fixture(t);
  service.requests.receive("thread-123", body());
  service.requests.update("thread-123", "request-123", { state: "unknown" });
  service.reconcileRequests("thread-123", [{ id: "official-turn", status: "completed", items: [{ type: "userMessage", id: "official-user", clientId: "request-123", content: [] }] }]);
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
  assert.equal(service.requests.get("thread-123", "request-123").userItemId, "official-user");
  await flush();
  assert.equal(calls.length, 0);
});

test("an unknown external history projection cannot terminate or start a pending request", (t) => {
  const { service, calls } = fixture(t);
  service.requests.receive("thread-123", body());
  service.requests.update("thread-123", "request-123", { state: "unknown", turnId: "external-turn" });
  service.reconcileRequests("thread-123", [{ id: "external-turn", status: "unknown", statusConfirmed: false,
    items: [{ id: "user", type: "userMessage", clientId: "request-123" }] }]);
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  assert.equal(service.terminalTurns.has("thread-123:external-turn"), false);
  assert.equal(calls.length, 0);
});

test("turn completion before RPC acknowledgement is not downgraded, and full file change payload is retained", async (t) => {
  let resolveTurn;
  const { service, bridge } = fixture(t, { request: async (method) => method === "turn/start" ? new Promise((resolve) => { resolveTurn = resolve; }) : {} });
  const events = [];
  const unsubscribe = service.subscribe("thread-123", (event) => events.push(event));
  service.submit("thread-123", body());
  await flush();
  bridge.emit("notification", { method: "turn/started", params: { threadId: "thread-123", turn: { id: "official-turn", status: "inProgress", items: [] } } });
  bridge.emit("notification", { method: "item/completed", params: { threadId: "thread-123", turnId: "official-turn", item: { id: "file-1", type: "fileChange", status: "completed", changes: [{ path: "a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" }] } } });
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "official-turn", status: "completed", items: [] } } });
  resolveTurn({ turn: { id: "official-turn", status: "inProgress", items: [] } });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
  assert.equal(events.find((event) => event.type === "item.upsert").payload.item.presentation.fileChanges[0].path, "a.txt");
  unsubscribe();
});

test("observers can replay bounded events without creating or resuming an execution", async (t) => {
  const { service, calls } = fixture(t);
  service.publish("thread-123", "turn.upsert", { turn: { id: "turn-a" } });
  service.publish("thread-123", "turn.upsert", { turn: { id: "turn-b" } });
  const events = [];
  const unsubscribe = service.subscribe("thread-123", (event) => events.push(event), { epoch: service.stream("thread-123").epoch, after: 1 });
  await flush();
  assert.deepEqual(events.map((event) => event.seq), [2]);
  assert.equal(calls.length, 0);
  unsubscribe();
});

test("history polling clears a previous sync error once on recovery and reports a later recurrence", async (t) => {
  const { service, reader, calls } = fixture(t);
  let failed = true;
  reader.listTurns = async () => {
    if (failed) throw new Error("temporary history read failure");
    return { turns: [{ id: "first-turn", status: "completed", items: [] }] };
  };
  const events = [];
  const unsubscribe = service.subscribe("thread-123", (event) => events.push(event));
  await flush();
  const errors = () => events.filter((event) => event.type === "thread.updated").map((event) => event.payload.thread.syncError);
  assert.deepEqual(errors(), ["temporary history read failure"]);
  await service.pollHistory("thread-123");
  assert.deepEqual(errors(), ["temporary history read failure"]);
  failed = false;
  await service.pollHistory("thread-123");
  assert.deepEqual(errors(), ["temporary history read failure", ""]);
  assert.equal(service.stream("thread-123").lastError, "");
  await service.pollHistory("thread-123");
  assert.deepEqual(errors(), ["temporary history read failure", ""]);
  failed = true;
  await service.pollHistory("thread-123");
  assert.deepEqual(errors(), ["temporary history read failure", "", "temporary history read failure"]);
  assert.equal(calls.length, 0);
  unsubscribe();
});

test("history polling completes the previous visible turn without injecting sparse summary items", async (t) => {
  const { service, reader, calls } = fixture(t);
  const old = { id: "old-turn", status: "inProgress", startedAt: 100, completedAt: null,
    statusConfirmed: true, statusSource: "rollout", itemsView: "summary", itemsTruncated: true, hasMoreItems: true,
    items: [{ id: "old-user", type: "userMessage", text: "继续" }] };
  let turns = [old];
  reader.listTurns = async (_threadId, options) => {
    assert.equal(options.limit, 2);
    return { turns };
  };
  const store = createCodexChatStore("thread-123");
  store.applyTurnsPage({ turns: [{ ...old, items: [] }] });
  store.applyLatestItemsPage(old.id, { items: [{ id: "visible", type: "agentMessage", text: "current response" }],
    hasMore: true, nextCursor: "earlier" }, undefined, { reset: true });
  const generation = store.beginSocket();
  const events = [];
  const stop = service.subscribe("thread-123", (event) => { events.push(event); store.applyEvent(event, generation); });
  await flush();
  assert.equal(events.filter((event) => event.type === "turn.metadata").length, 1, "the first observation must synchronize metadata");
  turns = [{ ...old, status: "completed", completedAt: 200 }, { id: "new-turn", status: "inProgress", startedAt: 201,
    itemsView: "summary", items: [{ id: "new-user", type: "userMessage", text: "new question" }] }];
  await service.pollHistory("thread-123");
  assert.equal(store.state.turns[old.id].status, "completed");
  assert.equal(store.state.turns[old.id].completedAt, 200);
  assert.equal(store.state.turns["new-turn"], undefined, "metadata must not append an unloaded turn");
  assert.deepEqual(store.state.turns[old.id].itemsWindowIds, ["visible"]);
  assert.deepEqual(Object.keys(store.state.turns[old.id].items), ["visible"]);
  assert.deepEqual(store.state.turnOrder, [old.id]);
  for (const event of events.filter((event) => event.type === "turn.metadata")) {
    for (const key of ["items", "itemsView", "itemsTruncated", "hasMoreItems"]) assert.equal(Object.hasOwn(event.payload.turn, key), false);
  }
  const count = events.length;
  await service.pollHistory("thread-123");
  assert.equal(events.length, count, "an unchanged poll must not repeat metadata or history notifications");
  const turnEvents = events.filter((event) => event.type === "turn.metadata").length;
  turns = turns.map((turn) => ({ ...turn, items: [...turn.items, { id: "summary-only", type: "agentMessage", text: "summary changed" }] }));
  await service.pollHistory("thread-123");
  assert.equal(events.filter((event) => event.type === "turn.metadata").length, turnEvents, "item-only changes must not republish turn metadata");
  assert.equal(events.at(-1).type, "history.changed");
  assert.deepEqual(store.state.turns[old.id].itemsWindowIds, ["visible"]);
  assert.equal(calls.length, 0, "observation must not execute or resume a thread");
  stop();
});

test("the first history poll repairs existing stale status and preserves an unconfirmed latest turn", async (t) => {
  const { service, reader } = fixture(t);
  const store = createCodexChatStore("thread-123");
  store.applyTurnsPage({ turns: [{ id: "old-turn", status: "inProgress", items: [] }, { id: "new-turn", status: "inProgress", items: [] }] });
  reader.listTurns = async () => ({ turns: [
    { id: "old-turn", status: "completed", completedAt: 200, items: [] },
    { id: "new-turn", status: "unknown", historyStatus: "interrupted", statusConfirmed: false,
      statusSource: "unconfirmed-history", statusObservedAt: null, completedAt: null, items: [] }
  ] });
  const generation = store.beginSocket();
  const events = [];
  const stop = service.subscribe("thread-123", (event) => { events.push(event); store.applyEvent(event, generation); });
  await flush();
  assert.equal(store.state.turns["old-turn"].status, "completed");
  assert.equal(store.state.turns["new-turn"].status, "unknown");
  assert.equal(store.state.turns["new-turn"].statusConfirmed, false);
  assert.equal(store.state.turns["new-turn"].statusSource, "unconfirmed-history");
  assert.equal(store.state.turns["new-turn"].completedAt, null);
  assert.equal(events.filter((event) => event.type === "turn.metadata").length, 2);
  stop();
});

test("a history page arriving after unsubscribe cannot publish turn metadata", async (t) => {
  const { service, reader } = fixture(t);
  let release;
  reader.listTurns = () => new Promise((resolve) => { release = resolve; });
  const events = [];
  const stop = service.subscribe("thread-123", (event) => events.push(event));
  await flush();
  stop();
  const count = events.length;
  release({ turns: [{ id: "old-turn", status: "completed", items: [] }] });
  await flush();
  assert.equal(events.length, count);
  assert.equal(service.streams.has("thread-123"), false);
});

test("unsubscribe during a polled turn update stops the remaining metadata batch", async (t) => {
  const { service, reader } = fixture(t);
  reader.listTurns = async () => ({ turns: [
    { id: "old-turn", status: "completed", items: [] },
    { id: "new-turn", status: "inProgress", items: [] }
  ] });
  const events = [];
  let stop;
  stop = service.subscribe("thread-123", (event) => {
    events.push(event);
    if (event.type === "turn.metadata") stop();
  });
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "turn.metadata").map((event) => event.payload.turn.id), ["old-turn"]);
  assert.equal(events.some((event) => event.type === "history.changed"), false);
  assert.equal(service.streams.has("thread-123"), false);
});

test("completion for an unrelated old turn cannot claim a new unacknowledged request", async (t) => {
  let resolveTurn;
  const { service, bridge, calls } = fixture(t, { request: async (method) => method === "turn/start"
    ? new Promise((resolve) => { resolveTurn = resolve; }) : {} });
  service.submit("thread-123", body());
  await flush();
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "old-unrelated", status: "completed" } } });
  service.submit("thread-123", body("request-456"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "dispatching");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  resolveTurn({ turn: { id: "correct-turn", status: "inProgress", items: [] } });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").turnId, "correct-turn");
});

test("a known turn completion resolves an unknown receipt after an upstream timeout", async (t) => {
  let rejectTurn;
  const { service, bridge } = fixture(t, { request: async (method) => method === "turn/start"
    ? new Promise((_, reject) => { rejectTurn = reject; }) : {} });
  service.submit("thread-123", body());
  await flush();
  bridge.emit("notification", { method: "item/started", params: { threadId: "thread-123", turnId: "correct-turn",
    item: { id: "user-123", type: "userMessage", clientId: "request-123", content: [{ type: "text", text: "继续" }] } } });
  rejectTurn(new Error("timeout"));
  await flush();
  assert.equal(service.requests.get("thread-123", "request-123").state, "unknown");
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "correct-turn", status: "completed" } } });
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
  assert.equal(service.streams.size, 0);
});

test("a durable received request resumes dispatch once, while dispatched work stays unknown", async (t) => {
  const { service, bridge, reader } = fixture(t);
  service.shutdown();
  service.requests.receive("thread-123", body());
  const restarted = new CodexThreadService({ config: service.config, bridge, reader,
    sessionManager: service.sessionManager, requests: new CodexRequestStore({ dataDir: service.config.dataDir }) });
  t.after(() => restarted.shutdown());
  await flush();
  assert.equal(restarted.requests.get("thread-123", "request-123").state, "accepted");
  restarted.shutdown();
});

test("closed observer buffers are released and a new subscription receives a fresh epoch", async (t) => {
  const { service } = fixture(t);
  let firstEpoch;
  for (let i = 0; i < 20; i++) {
    const unsubscribe = service.subscribe(`thread-${i}`, (event) => { firstEpoch ||= event.epoch; });
    service.publish(`thread-${i}`, "thread.updated", { thread: { id: `thread-${i}`, name: "x".repeat(90_000) } });
    unsubscribe();
  }
  await flush();
  assert.equal(service.streams.size, 0);
  let nextEpoch;
  const unsubscribe = service.subscribe("thread-0", (event) => { nextEpoch = event.epoch; }, { epoch: firstEpoch, after: 1 });
  assert.notEqual(nextEpoch, firstEpoch);
  unsubscribe();
});

test("queue waits for completion while steer reaches the current turn immediately", async (t) => {
  let starts = 0;
  const { service, bridge, calls } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: `official-turn-${++starts}`, status: "inProgress", items: [] } };
    if (method === "turn/steer") return { turnId: "official-turn-1" };
    return {};
  } });
  service.submit("thread-123", desktopBody());
  await flush();
  service.submit("thread-123", desktopBody("request-queued"));
  service.submit("thread-123", { ...desktopBody("request-steer"), mode: "steer", expectedTurnId: "official-turn-1" });
  await flush();
  assert.equal(starts, 1);
  assert.equal(service.requests.get("thread-123", "request-queued").state, "received");
  assert.equal(service.requests.get("thread-123", "request-steer").state, "accepted");
  const steering = calls.find((entry) => entry.method === "turn/steer");
  assert.equal(steering.params.expectedTurnId, "official-turn-1");
  assert.equal(steering.params.clientUserMessageId, "request-steer");
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "official-turn-1", status: "completed" } } });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-steer").state, "completed");
  assert.equal(starts, 2);
  assert.equal(service.requests.get("thread-123", "request-queued").turnId, "official-turn-2");
});

test("steer with a stale target is retained as rejected and is never turned into a new turn", async (t) => {
  const { service, calls } = fixture(t);
  service.submit("thread-123", { ...desktopBody("request-steer"), mode: "steer", expectedTurnId: "finished-turn" });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-steer").state, "rejected");
  assert.equal(service.requests.get("thread-123", "request-steer").input.text, "继续");
  assert.equal(calls.length, 0);
});

test("lost steer acknowledgement blocks the queued turn until client identity confirms it", async (t) => {
  let starts = 0;
  const { service, bridge } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: `official-turn-${++starts}`, status: "inProgress", items: [] } };
    if (method === "turn/steer") throw new Error("steer timeout");
    return {};
  } });
  service.submit("thread-123", desktopBody()); await flush();
  service.submit("thread-123", { ...desktopBody("request-steer"), mode: "steer", expectedTurnId: "official-turn-1" });
  service.submit("thread-123", desktopBody("request-queued")); await flush();
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "official-turn-1", status: "completed" } } });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-steer").state, "unknown");
  assert.equal(starts, 1);
  bridge.emit("notification", { method: "item/completed", params: { threadId: "thread-123", turnId: "official-turn-1", item: {
    id: "official-steer-user", type: "userMessage", clientId: "request-steer", content: [{ type: "text", text: "继续" }]
  } } });
  await flush();
  assert.equal(service.requests.get("thread-123", "request-steer").state, "completed");
  assert.equal(starts, 2);
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "expected recovery to settle");
}

test("unknown steer omitted from summaries recovers through item pages without an observer", async (t) => {
  const { service, reader, calls } = fixture(t, { recoveryMs: 5 });
  service.requests.receive("thread-123", { ...desktopBody("request-steer"), mode: "steer", expectedTurnId: "older-turn" });
  service.requests.update("thread-123", "request-steer", { state: "unknown" });
  service.requests.receive("thread-123", desktopBody("request-queued"));
  const cursors = [];
  reader.listTurns = async (_, options) => {
    cursors.push(options.cursor || "latest");
    return options.cursor ? { turns: [{ id: "older-turn", status: "completed", items: [] }] }
      : { turns: [{ id: "newer-turn", status: "completed", items: [] }], olderCursor: "previous-page" };
  };
  reader.listItems = async () => ({ items: [{ id: "steer-user", type: "userMessage", clientId: "request-steer" }], latestItemId: "steer-user" });
  service.scheduleRecovery("thread-123");
  await until(() => service.requests.get("thread-123", "request-queued").state === "accepted");
  assert.equal(service.requests.get("thread-123", "request-steer").state, "completed");
  assert.ok(cursors.includes("previous-page"));
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(calls.some((call) => call.method === "turn/steer"), false);
  assert.equal(service.recoveryPositions.size, 0);
});

test("recovery keeps following running work until completion after losing its owner", async (t) => {
  const { service, reader, calls } = fixture(t, { recoveryMs: 5 });
  service.requests.receive("thread-123", desktopBody());
  service.requests.update("thread-123", "request-123", { state: "unknown", turnId: "recovered-turn" });
  service.requests.receive("thread-123", desktopBody("request-queued"));
  let reads = 0;
  reader.listTurns = async () => ({ turns: [{ id: "recovered-turn", status: ++reads < 3 ? "inProgress" : "completed", items: [] }] });
  reader.listItems = async () => ({ items: [] });
  service.scheduleRecovery("thread-123");
  await until(() => service.requests.get("thread-123", "request-queued").state === "accepted");
  assert.equal(service.requests.get("thread-123", "request-123").state, "completed");
  assert.ok(reads >= 3);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
});

test("a late steer timeout releases its event buffer but retains confirmation tracking", async (t) => {
  let rejectSteer;
  const { service, bridge } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: "official-turn", status: "inProgress", items: [] } };
    if (method === "turn/steer") return new Promise((_, reject) => { rejectSteer = reject; });
    return {};
  } });
  service.submit("thread-123", desktopBody()); await flush();
  service.submit("thread-123", { ...desktopBody("request-steer"), mode: "steer", expectedTurnId: "official-turn" }); await flush();
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "official-turn", status: "completed" } } });
  rejectSteer(new Error("timeout")); await flush();
  assert.equal(service.streams.size, 0);
  assert.equal(service.requests.get("thread-123", "request-steer").state, "unknown");
  assert.equal(service.trackedRequests.has("thread-123"), true);
  service.reconcileItems("thread-123", "official-turn", [{ type: "userMessage", id: "steer-item", clientId: "request-steer" }]);
  assert.equal(service.requests.get("thread-123", "request-steer").state, "completed");
  assert.equal(service.streams.size, 0);
});

test("promoting a queued request preserves its identity, images and original submission retry", async (t) => {
  const { service, bridge, calls } = fixture(t, { request: async (method) => method === "turn/start"
    ? { turn: { id: "active-turn", status: "inProgress", items: [] } } : method === "turn/steer" ? { turnId: "active-turn" } : {} });
  service.submit("thread-123", desktopBody()); await flush();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCe8AAAAASUVORK5CYII=", "base64");
  const image = saveUploadedImage(service.config, png, { type: "image/png", name: "queued.png" });
  const submission = { ...desktopBody("request-queued"), input: { text: "补充\n    保留缩进", attachments: [{ id: image.id }] } };
  const queued = service.submit("thread-123", submission);
  const fingerprint = service.requests.read("thread-123", queued.id).fingerprint;
  const promoted = service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "active-turn" });
  assert.equal(promoted.state, "received");
  assert.equal(promoted.mode, "steer");
  assert.equal(promoted.id, queued.id);
  assert.deepEqual(promoted.input, queued.input);
  assert.deepEqual(promoted.options, queued.options);
  assert.equal(promoted.createdAt, queued.createdAt);
  assert.equal(promoted.order, queued.order);
  assert.equal(service.requests.read("thread-123", queued.id).fingerprint, fingerprint);
  assert.deepEqual(service.submit("thread-123", submission), promoted);
  assert.deepEqual(service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "active-turn" }), promoted);
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "other-turn" }),
    (error) => error.status === 409 && error.code === "steer_target_conflict");
  await flush();
  const steering = calls.filter((call) => call.method === "turn/steer");
  assert.equal(steering.length, 1);
  assert.equal(steering[0].params.clientUserMessageId, queued.id);
  assert.equal(steering[0].params.expectedTurnId, "active-turn");
  assert.deepEqual(steering[0].params.input, [{ type: "text", text: submission.input.text, text_elements: [] },
    { type: "localImage", path: path.join(service.config.dataDir, "uploads", "images", `${image.id}.png`) }]);
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "active-turn", status: "completed" } } });
  await flush();
  assert.equal(service.submit("thread-123", submission).state, "completed");
  assert.equal(service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "active-turn" }).state, "completed");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(calls.filter((call) => call.method === "turn/steer").length, 1);
});

test("promotion rejects a stale or unowned target without changing the queued request", async (t) => {
  const { service, calls } = fixture(t);
  service.submit("thread-123", desktopBody()); await flush();
  const queued = service.submit("thread-123", desktopBody("request-queued"));
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "old-turn" }),
    (error) => error.status === 409 && error.code === "turn_not_active");
  service.loaded.delete("thread-123");
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "turn-official" }),
    (error) => error.status === 409 && error.code === "turn_not_active");
  assert.deepEqual(service.requests.get("thread-123", queued.id), queued);
  await flush();
  assert.equal(calls.some((call) => call.method === "turn/steer"), false);
});

test("an unknown request blocks promotion until its client identity is confirmed", async (t) => {
  let steers = 0;
  const { service, bridge, calls } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: "active-turn", status: "inProgress", items: [] } };
    if (method === "turn/steer" && ++steers === 1) throw new Error("lost acknowledgement");
    return method === "turn/steer" ? { turnId: "active-turn" } : {};
  } });
  service.submit("thread-123", desktopBody()); await flush();
  service.submit("thread-123", { ...desktopBody("request-uncertain"), mode: "steer", expectedTurnId: "active-turn" }); await flush();
  const queued = service.submit("thread-123", desktopBody("request-queued"));
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "active-turn" }),
    (error) => error.status === 409 && error.code === "confirmation_required");
  assert.deepEqual(service.requests.get("thread-123", queued.id), queued);
  bridge.emit("notification", { method: "item/completed", params: { threadId: "thread-123", turnId: "active-turn",
    item: { id: "user-uncertain", type: "userMessage", clientId: "request-uncertain", content: [] } } });
  service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "active-turn" }); await flush();
  assert.equal(service.requests.get("thread-123", queued.id).state, "accepted");
  assert.equal(calls.filter((call) => call.method === "turn/steer").length, 2);
});

test("double promotion and original submission retries never replay a lost steer acknowledgement", async (t) => {
  let rejectSteer;
  let starts = 0;
  const { service, bridge, calls } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: `turn-${++starts}`, status: "inProgress", items: [] } };
    if (method === "turn/steer") return new Promise((_, reject) => { rejectSteer = reject; });
    return {};
  } });
  service.submit("thread-123", desktopBody()); await flush();
  const submission = desktopBody("request-promoted");
  service.submit("thread-123", submission);
  service.promoteQueuedRequest("thread-123", submission.clientRequestId, { expectedTurnId: "turn-1" });
  service.promoteQueuedRequest("thread-123", submission.clientRequestId, { expectedTurnId: "turn-1" }); await flush();
  assert.equal(service.promoteQueuedRequest("thread-123", submission.clientRequestId, { expectedTurnId: "turn-1" }).state, "dispatching");
  rejectSteer(new Error("lost steer acknowledgement")); await flush();
  assert.equal(service.promoteQueuedRequest("thread-123", submission.clientRequestId, { expectedTurnId: "turn-1" }).state, "unknown");
  assert.equal(service.submit("thread-123", submission).state, "unknown");
  service.submit("thread-123", desktopBody("request-next"));
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-1", status: "completed" } } }); await flush();
  assert.equal(starts, 1);
  bridge.emit("notification", { method: "item/completed", params: { threadId: "thread-123", turnId: "turn-1",
    item: { id: "promoted-user", type: "userMessage", clientId: submission.clientRequestId, content: [] } } }); await flush();
  assert.equal(service.requests.get("thread-123", submission.clientRequestId).state, "completed");
  assert.equal(starts, 2);
  assert.equal(calls.filter((call) => call.method === "turn/steer").length, 1);
  assert.equal(calls.filter((call) => call.method === "turn/start").some((call) => call.params.clientUserMessageId === submission.clientRequestId), false);
});

test("turn completion winning promotion preserves the original queue and dispatches it only once", async (t) => {
  let starts = 0;
  const { service, bridge, calls } = fixture(t, { request: async (method) => method === "turn/start"
    ? { turn: { id: `turn-${++starts}`, status: "inProgress", items: [] } } : {} });
  service.submit("thread-123", desktopBody()); await flush();
  const queued = service.submit("thread-123", desktopBody("request-queued"));
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-1", status: "completed" } } });
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "turn-1" }), (error) => error.status === 409);
  assert.deepEqual(service.requests.get("thread-123", queued.id), queued);
  await flush();
  assert.equal(starts, 2);
  assert.equal(service.requests.get("thread-123", queued.id).mode, "queue");
  assert.equal(calls.some((call) => call.method === "turn/steer"), false);
});

test("queue dispatch claiming a request before promotion cannot also steer it", async (t) => {
  let resolveThread;
  const { service, bridge, calls, reader } = fixture(t);
  service.submit("thread-123", desktopBody()); await flush();
  const queued = service.submit("thread-123", desktopBody("request-queued"));
  reader.getThread = (id) => new Promise((resolve) => { resolveThread = () => resolve({ id, cwd: service.config.defaultCwd }); });
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-official", status: "completed" } } });
  await flush();
  const dispatching = service.requests.get("thread-123", queued.id);
  assert.equal(dispatching.state, "dispatching");
  assert.throws(() => service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "turn-official" }),
    (error) => error.status === 409 && error.code === "request_not_queued");
  assert.deepEqual(service.requests.get("thread-123", queued.id), dispatching);
  resolveThread(); await flush();
  assert.equal(calls.filter((call) => call.method === "turn/start" && call.params.clientUserMessageId === queued.id).length, 1);
  assert.equal(calls.some((call) => call.method === "turn/steer"), false);
});

test("promotion winning completion never falls back to starting the same request as a new turn", async (t) => {
  const { service, bridge, calls } = fixture(t);
  service.submit("thread-123", desktopBody()); await flush();
  const queued = service.submit("thread-123", desktopBody("request-queued"));
  service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "turn-official" });
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-official", status: "completed" } } });
  await flush();
  const rejected = service.requests.get("thread-123", queued.id);
  assert.equal(rejected.mode, "steer");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.error.code, "turn_not_active");
  assert.deepEqual(rejected.input, queued.input);
  assert.equal(service.promoteQueuedRequest("thread-123", queued.id, { expectedTurnId: "turn-official" }).state, "rejected");
  await flush();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(calls.some((call) => call.method === "turn/steer"), false);
});

test("a promoted request rejected upstream remains recoverable without a silent queue fallback", async (t) => {
  const { service, bridge, calls } = fixture(t, { request: async (method) => {
    if (method === "turn/start") return { turn: { id: "active-turn", status: "inProgress", items: [] } };
    if (method === "turn/steer") throw Object.assign(new Error("turn already completed"), { rpcError: true });
    return {};
  } });
  const submission = desktopBody("request-promoted");
  service.submit("thread-123", desktopBody()); await flush();
  service.submit("thread-123", submission);
  service.promoteQueuedRequest("thread-123", submission.clientRequestId, { expectedTurnId: "active-turn" }); await flush();
  const rejected = service.submit("thread-123", submission);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.error.code, "steer_rejected");
  assert.deepEqual(rejected.input, submission.input);
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "active-turn", status: "completed" } } }); await flush();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(calls.filter((call) => call.method === "turn/steer").length, 1);
});

test("read-only V2 activity distinguishes an accepted turn from queued, completed and unknown work", async (t) => {
  const { service, bridge, calls } = fixture(t);
  assert.equal(service.getThreadActivity("desktop-thread"), null);
  assert.equal(calls.length, 0);
  service.submit("thread-123", body());
  assert.equal(service.getThreadActivity("thread-123").activityState, "unknown");
  await flush();
  assert.equal(service.getThreadActivity("thread-123").activityState, "running");
  const callCount = calls.length;
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-official", status: "completed" } } });
  assert.equal(service.getThreadActivity("thread-123"), null);
  assert.equal(calls.length, callCount);
  service.submit("thread-456", body("request-456")); await flush();
  service.handleDisconnect();
  assert.equal(service.getThreadActivity("thread-456").activityState, "unknown");
});

test("V2 activity ordering uses actual input time rather than receipt reads or confirmation updates", async (t) => {
  const { service, bridge } = fixture(t);
  service.requests.now = () => "2026-10-16T06:00:00.000Z";
  service.submit("thread-123", body()); await flush();
  const original = service.getThreadActivity("thread-123");
  service.requests.now = () => "2026-10-16T07:00:00.000Z";
  service.updateRequest("thread-123", "request-123", { state: "running" });
  assert.equal(service.getThreadActivity("thread-123").lastActivityAt, original.lastActivityAt);
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: {
    id: "turn-official", status: "completed", completedAt: Date.parse("2026-10-16T07:00:00.000Z") / 1000
  } } });
  const list = service.requests.list;
  service.requests.list = () => { throw new Error("Idle sidebar lookup must not scan the receipt journal"); };
  assert.equal(service.getThreadActivity("thread-123"), null);
  service.requests.list = list;
});
