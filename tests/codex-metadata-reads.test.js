import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";

const thread = { id: "thread", cwd: "", historyMode: "paginated", turns: [] };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const aborted = (error) => error?.name === "AbortError";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < end, "bounded condition wait"); await tick(); }
}
function fixture() {
  const calls = [];
  const bridge = { ensureReady: async () => {}, request(method, params, options) {
    if (method !== "thread/read") return Promise.resolve({ data: [], nextCursor: null });
    const reply = deferred(); calls.push({ params, options, reply }); return reply.promise;
  } };
  const reader = new CodexHistoryReader({ bridge });
  const jobs = [];
  const start = (operation) => {
    const job = operation(); job.catch(() => {}); jobs.push(job); return job;
  };
  const close = async () => {
    for (const call of calls) call.reply.resolve({ thread: { ...thread, id: call.params.threadId } });
    await Promise.allSettled(jobs); await tick();
    assert.equal(reader.metadataReads?.entries.size || 0, 0);
    for (const call of calls) if (call.options?.signal) assert.equal(getEventListeners(call.options.signal, "abort").length, 0);
  };
  return { reader, bridge, calls, start, close };
}

test("overlapping fresh, turns, items and background callers share one metadata RPC", async () => {
  const f = fixture();
  try {
    const jobs = [f.start(() => f.reader.getThread(thread.id)), f.start(() => f.reader.listTurns(thread.id)),
      f.start(() => f.reader.listItems(thread.id, "turn")), f.start(() => f.reader.threadMetadata(thread.id))];
    await until(() => f.calls.length > 0);
    assert.equal(f.calls.length, 1);
    f.calls[0].reply.resolve({ thread });
    const [metadata, turns, items, background] = await Promise.all(jobs);
    assert.deepEqual(metadata, thread); assert.deepEqual(background, thread);
    assert.deepEqual(turns.turns, []); assert.deepEqual(items.items, []);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("fresh GET does not reuse a warm value, but overlapping fresh GETs join", async () => {
  const f = fixture();
  try {
    f.reader.remember({ ...thread, name: "cached" });
    const first = f.start(() => f.reader.getThread(thread.id));
    const second = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length > 0);
    assert.equal(f.calls.length, 1);
    f.calls[0].reply.resolve({ thread: { ...thread, name: "fresh" } });
    assert.equal((await first).name, "fresh"); assert.equal((await second).name, "fresh");
    const later = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 2);
    f.calls[1].reply.resolve({ thread: { ...thread, name: "later" } });
    assert.equal((await later).name, "later");
  } finally { await f.close(); }
});

test("metadata value cache retains its two-second expiry and 64-thread bound", async () => {
  const f = fixture();
  try {
    const remembered = { ...thread, name: "cached" };
    f.reader.remember(remembered);
    assert.equal(await f.reader.threadMetadata(thread.id), remembered);
    assert.equal(f.calls.length, 0);
    f.reader.metadata.get(thread.id).at = Date.now() - 2000;
    const expired = f.start(() => f.reader.threadMetadata(thread.id));
    await until(() => f.calls.length === 1); f.calls[0].reply.resolve({ thread }); await expired;
    f.reader.legacyThreads.add(thread.id); f.reader.itemPositions.set(thread.id, new Map());
    for (let index = 0; index < 64; index += 1) f.reader.remember({ ...thread, id: `other-${index}` });
    assert.equal(f.reader.metadata.size, 64); assert.equal(f.reader.metadata.has(thread.id), false);
    assert.equal(f.reader.legacyThreads.has(thread.id), false); assert.equal(f.reader.itemPositions.has(thread.id), false);
  } finally { await f.close(); }
});

test("different thread identities never share RPCs or cached values", async () => {
  const f = fixture();
  try {
    const one = f.start(() => f.reader.getThread("one"));
    const two = f.start(() => f.reader.getThread("two"));
    await until(() => f.calls.length === 2);
    for (const call of f.calls) call.reply.resolve({ thread: { ...thread, id: call.params.threadId } });
    assert.equal((await one).id, "one"); assert.equal((await two).id, "two");
    assert.equal(f.reader.metadata.size, 2);
  } finally { await f.close(); }
});

test("one HTTP waiter abort cannot cancel another waiter or an unsignaled background read", async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  try {
    const left = f.start(() => f.reader.getThread(thread.id, { signal: first.signal }));
    const surviving = f.start(() => f.reader.getThread(thread.id, { signal: second.signal }));
    const background = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1);
    const owner = f.calls[0].options.signal;
    assert.notEqual(owner, first.signal); assert.notEqual(owner, second.signal);
    first.abort(); await assert.rejects(left, aborted);
    second.abort(); await assert.rejects(surviving, aborted);
    assert.equal(owner.aborted, false);
    f.calls[0].reply.resolve({ thread }); assert.deepEqual(await background, thread);
    assert.equal(owner.aborted, false);
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    assert.equal(getEventListeners(second.signal, "abort").length, 0);
  } finally { first.abort(); second.abort(); await f.close(); }
});

test("last waiter abort synchronously releases its owner and late ignored replies cannot cache", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const reading = f.start(() => f.reader.getThread(thread.id, { signal: controller.signal }));
    await until(() => f.calls.length === 1);
    controller.abort();
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.reader.metadataReads.entries.size, 0);
    await assert.rejects(reading, aborted);
    f.calls[0].reply.resolve({ thread }); await tick();
    assert.equal(f.reader.metadata.size, 0);
  } finally { controller.abort(); await f.close(); }
});

test("pre-aborted callers do not join a current read or consume warm metadata", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  try {
    f.reader.remember(thread);
    const background = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1);
    await assert.rejects(f.reader.getThread(thread.id, { signal: controller.signal }), aborted);
    await assert.rejects(f.reader.threadMetadata(thread.id, { signal: controller.signal }), aborted);
    assert.equal(f.calls.length, 1);
    f.calls[0].reply.resolve({ thread }); await background;
  } finally { await f.close(); }
});

test("all waiters can leave shared readiness without cancelling initialization or sending metadata", async () => {
  const f = fixture(), ready = deferred(), controller = new AbortController();
  let initializing = 0; f.bridge.connecting = ready.promise;
  f.bridge.ensureReady = () => { initializing += 1; return f.bridge.connecting; };
  try {
    const left = f.start(() => f.reader.getThread(thread.id, { signal: controller.signal }));
    await until(() => initializing === 1); controller.abort(); await assert.rejects(left, aborted);
    assert.equal(f.calls.length, 0); assert.equal(f.bridge.connecting, ready.promise);
    ready.resolve(); await tick(); assert.equal(f.calls.length, 0);
    const background = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1); f.calls[0].reply.resolve({ thread }); await background;
  } finally { controller.abort(); ready.resolve(); await f.close(); }
});

test("shared failures preserve the original error and the next caller retries", async () => {
  const f = fixture(), denied = Object.assign(new Error("permission denied"), { statusCode: 403 });
  try {
    const one = f.start(() => f.reader.getThread(thread.id)), two = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1); f.calls[0].reply.reject(denied);
    await assert.rejects(one, (error) => error === denied); await assert.rejects(two, (error) => error === denied);
    assert.equal(f.reader.metadata.size, 0); assert.equal(f.reader.metadataReads.entries.size, 0);
    const retry = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 2); f.calls[1].reply.resolve({ thread }); await retry;
  } finally { await f.close(); }
});

test("invalid thread identities reject every waiter without caching and remain retryable", async () => {
  const f = fixture();
  try {
    const reading = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1); f.calls[0].reply.resolve({ thread: { ...thread, id: "wrong" } });
    await assert.rejects(reading, /different history thread/); assert.equal(f.reader.metadata.size, 0);
    const retry = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 2); f.calls[1].reply.resolve({ thread: { ...thread, turns: [{ id: "accidental-full-hydration" }] } });
    assert.deepEqual((await retry).turns, []);
  } finally { await f.close(); }
});

test("external remember detaches old reads, protects its value and permits a new fresh read", async () => {
  const f = fixture();
  try {
    const older = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1);
    const remembered = { ...thread, name: "external-new-value" }; f.reader.remember(remembered);
    const newer = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 2);
    f.calls[0].reply.resolve({ thread: { ...thread, name: "older-read" } });
    assert.equal((await older).name, "older-read");
    assert.equal(f.reader.metadata.get(thread.id).thread, remembered);
    assert.equal(f.reader.metadataReads.entries.size, 1);
    f.calls[1].reply.resolve({ thread: { ...thread, name: "newest-read" } });
    assert.equal((await newer).name, "newest-read");
    assert.equal(f.reader.metadata.get(thread.id).thread.name, "newest-read");
  } finally { await f.close(); }
});

test("external remember protection survives eviction without retaining per-thread generations", async () => {
  const f = fixture();
  try {
    const old = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1); f.reader.remember({ ...thread, name: "newer" });
    for (let index = 0; index < 128; index += 1) f.reader.remember({ ...thread, id: `remembered-${index}` });
    assert.equal(f.reader.metadata.size, 64); assert.equal(f.reader.metadataReads.entries.size, 0);
    f.calls[0].reply.resolve({ thread: { ...thread, name: "old" } }); await old;
    assert.equal(f.reader.metadata.has(thread.id), false); assert.equal(f.reader.metadata.size, 64);
  } finally { await f.close(); }
});

test("late aborted replies cannot publish or remove a newer entry for the same thread", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const old = f.start(() => f.reader.getThread(thread.id, { signal: controller.signal }));
    await until(() => f.calls.length === 1); controller.abort(); await assert.rejects(old, aborted);
    const current = f.start(() => f.reader.getThread(thread.id)); await until(() => f.calls.length === 2);
    f.calls[0].reply.resolve({ thread: { ...thread, name: "old" } }); await tick();
    assert.equal(f.reader.metadata.size, 0); assert.equal(f.reader.metadataReads.entries.size, 1);
    f.calls[1].reply.resolve({ thread: { ...thread, name: "current" } }); await current;
    assert.equal(f.reader.metadata.get(thread.id).thread.name, "current");
  } finally { controller.abort(); await f.close(); }
});

test("leaving before the deferred load starts sends no metadata RPC or initialization", async () => {
  const f = fixture(), controller = new AbortController();
  let initialized = 0; f.bridge.ensureReady = async () => { initialized += 1; };
  try {
    const reading = f.start(() => f.reader.getThread(thread.id, { signal: controller.signal }));
    controller.abort(); await assert.rejects(reading, aborted); await tick();
    assert.equal(initialized, 0); assert.equal(f.calls.length, 0); assert.equal(f.reader.metadata.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { controller.abort(); await f.close(); }
});

test("a synchronous readiness failure is observed and does not poison a retry", async () => {
  const f = fixture(), failed = new Error("synchronous readiness failure");
  f.bridge.ensureReady = () => { throw failed; };
  try {
    const one = f.start(() => f.reader.getThread(thread.id)), two = f.start(() => f.reader.getThread(thread.id));
    await assert.rejects(one, (error) => error === failed); await assert.rejects(two, (error) => error === failed);
    assert.equal(f.reader.metadataReads.entries.size, 0); assert.equal(f.calls.length, 0);
    f.bridge.ensureReady = async () => {};
    const retry = f.start(() => f.reader.getThread(thread.id));
    await until(() => f.calls.length === 1); f.calls[0].reply.resolve({ thread }); await retry;
  } finally { await f.close(); }
});

test("an old detached waiter can cancel without aborting or deleting the replacement read", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const old = f.start(() => f.reader.getThread(thread.id, { signal: controller.signal }));
    await until(() => f.calls.length === 1); f.reader.remember({ ...thread, name: "external" });
    const replacement = f.start(() => f.reader.getThread(thread.id)); await until(() => f.calls.length === 2);
    controller.abort(); await assert.rejects(old, aborted);
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[1].options.signal.aborted, false);
    assert.equal(f.reader.metadataReads.entries.size, 1);
    f.calls[0].reply.resolve({ thread: { ...thread, name: "old" } });
    f.calls[1].reply.resolve({ thread: { ...thread, name: "replacement" } });
    assert.equal((await replacement).name, "replacement");
    assert.equal(f.reader.metadata.get(thread.id).thread.name, "replacement");
  } finally { controller.abort(); await f.close(); }
});
