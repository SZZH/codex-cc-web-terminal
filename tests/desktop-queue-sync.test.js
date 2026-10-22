import test from "node:test";
import assert from "node:assert/strict";
import { DesktopQueueSync } from "../src/sessions/codex/desktopQueueSync.js";

const receipt = (id, state = "queued") => ({ id, state, executionRoute: "desktopQueue", upstreamQueueId: `queue-${id}`, updatedAt: "v1" });
function fixture(t, list, receipts = [receipt("one")]) {
  const records = new Map(receipts.map((item) => [item.id, item]));
  const patches = [], finished = [];
  let reads = 0;
  const sync = new DesktopQueueSync({ intervalMs: 0,
    writer: { list: async (...args) => { reads++; return list(...args); } },
    pending: () => [...records.values()], current: (_, id) => records.get(id),
    update: (_, id, patch) => { records.set(id, { ...records.get(id), ...patch }); patches.push({ id, ...patch }); },
    finish: (_, id) => finished.push(id) });
  t.after(() => sync.shutdown());
  return { sync, records, patches, finished, reads: () => reads };
}

test("one snapshot reconciles all tracked queue members; absence is not cancellation or execution", async (t) => {
  const f = fixture(t, () => [{ id: "queue-two", clientUserMessageId: "two" }], [receipt("one"), receipt("two"), receipt("uncertain", "unknown")]);
  await f.sync.sync("thread");
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.patches, [{ id: "one", state: "removed", error: null }]);
  assert.deepEqual(f.finished, ["one"]);
  assert.equal(f.records.get("two").state, "queued");
  assert.equal(f.records.get("uncertain").state, "unknown", "missing unacknowledged enqueue stays uncertain");
});

test("failed reads retain queue members and a later successful read converges", async (t) => {
  let fail = true;
  const f = fixture(t, () => { if (fail) throw new Error("offline"); return []; });
  await f.sync.sync("thread");
  assert.deepEqual(f.patches, []);
  fail = false;
  await f.sync.sync("thread");
  assert.equal(f.records.get("one").state, "removed");
});

test("an exact client identity refreshes its queue ID and recovers an uncertain acknowledgement", async (t) => {
  const f = fixture(t, () => [{ id: "replacement", clientUserMessageId: "one" },
    { id: "queue-two", clientUserMessageId: "two" }], [receipt("one"), receipt("two", "unknown")]);
  await f.sync.sync("thread");
  assert.equal(f.records.get("one").upstreamQueueId, "replacement");
  assert.equal(f.records.get("two").state, "queued");
  assert.deepEqual(f.finished, []);
});

test("a snapshot cannot remove a message added later or one that has started executing", async (t) => {
  let resolve;
  const f = fixture(t, () => new Promise((done) => { resolve = done; }));
  const pending = f.sync.sync("thread");
  f.records.set("two", receipt("two"));
  f.records.set("one", { ...receipt("one"), state: "running", turnId: "official-turn" });
  resolve([]);
  await pending;
  assert.deepEqual(f.patches, []);
});

test("concurrent reads coalesce and a changed notification discards the obsolete snapshot", async (t) => {
  let resolve;
  const f = fixture(t, () => f.reads() === 1 ? new Promise((done) => { resolve = done; })
    : [{ id: "queue-one", clientUserMessageId: "one" }]);
  const first = f.sync.sync("thread");
  assert.equal(f.sync.sync("thread"), first);
  f.sync.sync("thread", { invalidate: true });
  resolve([]);
  await first;
  await new Promise((done) => setImmediate(done));
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.patches, []);
});

test("shutdown and newer receipt versions prevent late queue reads from changing receipts", async (t) => {
  for (const stop of [true, false]) {
    let resolve;
    const f = fixture(t, () => new Promise((done) => { resolve = done; }));
    const pending = f.sync.sync("thread");
    if (stop) f.sync.shutdown();
    else f.records.set("one", { ...receipt("one"), updatedAt: "v2" });
    resolve([]);
    await pending;
    assert.deepEqual(f.patches, []);
  }
});
