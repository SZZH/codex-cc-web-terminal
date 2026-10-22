import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionActivityCache, latestActivityTimestamp, observeCodexTurnStatus, withSessionActivity } from "../src/sessions/history/sessionActivity.js";
import { buildSessionSidebarPayload } from "../src/routes/sessionSidebar.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const session = (id, updatedAt = "2026-10-16T06:00:00.000Z") => ({ id: `history:codex:${id}`, threadId: id,
  provider: "codex", kind: "history", status: "saved", updatedAt });
const page = (id, status, extra = {}) => ({ threadId: id, turns: [{ id: `turn-${id}`, status, startedAt: 1792130400, ...extra }] });
function rolloutFixture(t, rows = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-activity-"));
  const file = path.join(directory, "rollout.jsonl");
  const write = (records) => fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  write(rows);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { write, file, config: { codexSessionsDir: directory }, thread: { id: "one", path: file, status: { type: "notLoaded" } },
    turn: { id: "turn-one", status: "interrupted", completedAt: null } };
}
const lifecycle = (type, at, turnId = "turn-one") => ({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type, turn_id: turnId } });

test("external unfinished turns use fresh lifecycle evidence and stale tool waits become unknown rather than interrupted", (t) => {
  const now = Date.now();
  const { config, thread, turn, write } = rolloutFixture(t, [lifecycle("task_started", now - 30000)]);
  const running = observeCodexTurnStatus(thread, turn, { config, now });
  assert.equal(running.status, "inProgress");
  assert.equal(running.historyStatus, "interrupted");
  assert.equal(running.statusSource, "rollout");
  const waiting = observeCodexTurnStatus(thread, turn, { config, now: now + 120000 });
  assert.equal(waiting.status, "unknown");
  assert.equal(waiting.statusConfirmed, false);
  write([lifecycle("task_started", now - 600000), lifecycle("item_completed", now - 1000)]);
  assert.equal(observeCodexTurnStatus(thread, turn, { config, now }).status, "inProgress");
  write([lifecycle("task_started", now - 600000), lifecycle("item_completed", now - 1000, "another-turn")]);
  assert.equal(observeCodexTurnStatus(thread, turn, { config, now }).status, "unknown");
});

test("explicit completion and interruption outrank fresh output and loaded-runtime states remain authoritative", (t) => {
  const now = Date.now();
  const { config, thread, turn, write } = rolloutFixture(t);
  for (const [event, expected] of [["task_complete", "completed"], ["turn_aborted", "interrupted"]]) {
    write([lifecycle("task_started", now - 60000), lifecycle(event, now - 2000), lifecycle("item_completed", now - 1000)]);
    const observed = observeCodexTurnStatus(thread, turn, { config, now });
    assert.equal(observed.status, expected);
    assert.equal(observed.completedAt, new Date(now - 2000).toISOString());
    assert.equal(observed.statusConfirmed, true);
  }
  assert.equal(observeCodexTurnStatus({ ...thread, status: { type: "idle" } }, turn, { config, now }), turn);
  const confirmed = { ...turn, completedAt: new Date(now).toISOString() };
  assert.equal(observeCodexTurnStatus(thread, confirmed, { config, now }), confirmed);
});

test("rollout activity reads only a bounded tail under configured session roots and caches metadata without extending freshness", (t) => {
  const now = Date.now();
  const { config, thread, turn, file } = rolloutFixture(t, [{ payload: "x".repeat(1024 * 1024) }, lifecycle("task_started", now - 1000)]);
  const original = fs.readSync, reads = [];
  fs.readSync = (...args) => { reads.push({ length: args[3], offset: args[4] }); return original(...args); };
  try {
    assert.equal(observeCodexTurnStatus(thread, turn, { config: {}, now }).status, "unknown");
    assert.equal(reads.length, 0);
    assert.equal(observeCodexTurnStatus(thread, turn, { config, now }).status, "inProgress");
    assert.ok(reads[0].length <= 256 * 1024 && reads[0].offset > 0);
    assert.equal(observeCodexTurnStatus(thread, turn, { config, now: now + 120000 }).status, "unknown");
    assert.equal(reads.length, 1);
    fs.unlinkSync(file);
    assert.equal(observeCodexTurnStatus(thread, turn, { config, now }).status, "unknown");
  } finally { fs.readSync = original; }
});

test("sidebar observes external running turns through the same read-only rollout status path", async (t) => {
  const { config, thread, turn } = rolloutFixture(t, [lifecycle("task_started", Date.now() - 1000)]);
  const calls = [];
  const manager = { listSidebarSnapshot: () => ({ sessions: [session("one")], projectGroups: [] }) };
  const codexThreads = { config, bridge: { connected: true, initialized: true, request: async (method, params) => {
    calls.push({ method, params });
    return method === "thread/turns/list" ? { data: [turn] } : { thread };
  } } };
  await buildSessionSidebarPayload(manager, codexThreads); await tick();
  assert.equal((await buildSessionSidebarPayload(manager, codexThreads)).sessions[0].activityState, "running");
  assert.deepEqual(calls.map((call) => call.method), ["thread/turns/list", "thread/read"]);
  assert.equal(calls[1].params.includeTurns, false);
});

test("activity timestamps use recorded seconds, milliseconds and ISO values without inventing a current time", () => {
  assert.equal(latestActivityTimestamp(null, "", 0, "invalid"), null);
  assert.equal(latestActivityTimestamp(1792130400, "2026-10-16T06:00:01.000Z", 1792130402000), "2026-10-16T06:00:02.000Z");
});

test("saved status and a running process alone never imply execution; explicit live turns do", () => {
  const sessions = [session("saved"), { ...session("process"), kind: "live", status: "running" }, session("turn"), session("idle")];
  const raw = { process: { status: "running" }, turn: { turnRunning: true, currentTurnId: "official-turn" }, idle: { turnRunning: false } };
  const result = withSessionActivity({ sessions, projectGroups: [] }, {
    sessionManager: { findLiveSessionByThreadId: (id) => raw[id] }
  });
  assert.deepEqual(result.sessions.map((entry) => entry.activityState), ["unknown", "unknown", "running", "idle"]);
});

test("sidebar decorates both views without mutating group order and native recency outranks output timestamps", async () => {
  const first = session("one"), second = session("two");
  const source = { sessions: [first, second], projectGroups: [{ id: "manual-group", sessions: [second, first] }], sidebarPreferences: { chats: "manual" } };
  const recency = Date.parse("2026-10-16T06:00:00.000Z");
  const manager = { listSidebarSnapshot: () => source, codexSidebarService: { lastThreads: [
    { id: "one", recency_at_ms: recency, updated_at_ms: recency + 300000 }, { id: "two", updated_at_ms: recency - 1000 }
  ] } };
  const codexThreads = { getThreadActivity: (id) => id === "one" ? { activityState: "running", lastActivityAt: "2026-10-16T06:00:02.000Z" } : null };
  const result = await buildSessionSidebarPayload(manager, codexThreads);
  assert.deepEqual(result.sessions.map((entry) => entry.threadId), ["one", "two"]);
  assert.deepEqual(result.projectGroups[0].sessions.map((entry) => entry.threadId), ["two", "one"]);
  assert.equal(result.sessions[0].activityState, "running");
  assert.equal(result.projectGroups[0].sessions[1].activityState, "running");
  assert.equal(result.sessions[0].lastActivityAt, "2026-10-16T06:00:02.000Z");
  assert.equal(result.sessions[1].lastActivityAt, "2026-10-16T05:59:59.000Z");
  assert.equal(first.activityState, undefined);
  manager.codexSidebarService.lastThreads[0].updated_at_ms += 300000;
  assert.equal((await buildSessionSidebarPayload(manager, codexThreads)).sessions[0].lastActivityAt, result.sessions[0].lastActivityAt);
});

test("initial sidebar response does not await latest-turn reads and idle signatures are not polled again", async () => {
  let calls = 0, resolve, metadataFinished = false;
  const manager = { listSidebarSnapshot: () => ({ sessions: [session("one")], projectGroups: [] }) };
  const codexThreads = { bridge: { connected: true, initialized: true, request: (method, options) => {
    calls += 1; assert.equal(method, "thread/turns/list");
    assert.deepEqual(options, { threadId: "one", limit: 1, sortDirection: "desc", itemsView: "summary" });
    return new Promise((done) => { resolve = () => { metadataFinished = true; done({ data: page("one", "completed").turns }); }; });
  } } };
  const initial = await buildSessionSidebarPayload(manager, codexThreads);
  assert.equal(initial.sessions[0].activityState, "unknown");
  assert.equal(metadataFinished, false, "the payload resolves while its metadata reader is still pending");
  await tick(); assert.equal(calls, 1);
  resolve(); await tick();
  assert.equal((await buildSessionSidebarPayload(manager, codexThreads)).sessions[0].activityState, "idle");
  await buildSessionSidebarPayload(manager, codexThreads); await tick();
  assert.equal(calls, 1);
});

test("activity scanning never falls back to full legacy history or starts an app-server", async () => {
  let reads = 0;
  const manager = { listSidebarSnapshot: () => ({ sessions: [session("legacy")], projectGroups: [] }) };
  const codexThreads = { reader: { listTurns: () => { throw new Error("Full history fallback must not run"); } },
    bridge: { connected: false, initialized: false, ensureReady: () => { throw new Error("Must not initialize a runtime"); },
      request: async (method) => { reads += 1; assert.equal(method, "thread/turns/list"); throw Object.assign(new Error("legacy history does not support pagination"), { rpcError: true }); } } };
  await buildSessionSidebarPayload(manager, codexThreads); await tick();
  assert.equal(reads, 0);
  codexThreads.bridge.connected = codexThreads.bridge.initialized = true;
  await buildSessionSidebarPayload(manager, codexThreads); await tick();
  assert.equal(reads, 1);
  assert.equal((await buildSessionSidebarPayload(manager, codexThreads)).sessions[0].activityState, "unknown");
  await tick(); assert.equal(reads, 1);
});

test("background activity reads have two-worker and queue bounds and removed threads release cache entries", async () => {
  const pending = []; let active = 0, peak = 0;
  const cache = new SessionActivityCache({ listTurns: (id) => {
    active += 1; peak = Math.max(peak, active);
    return new Promise((resolve) => pending.push(() => { active -= 1; resolve(page(id, "completed")); }));
  } }, { maxQueued: 3 });
  const entries = Array.from({ length: 8 }, (_, index) => cache.observe(`t-${index}`, "v1"));
  cache.refresh(entries); await tick();
  assert.equal(pending.length, 2);
  assert.equal(cache.queue.length, 1);
  cache.prune(new Set(["t-0"]));
  pending.splice(0).forEach((resolve) => resolve()); await tick();
  assert.equal(peak, 2);
  assert.equal(cache.entries.size, 1);
  assert.equal(cache.queue.length, 0);
  assert.equal(cache.active, 0);
  cache.prune(new Set());
  assert.equal(cache.entries.size, 0);
});

test("running state is checked on list requests until terminal but does not create an autonomous poll loop", async () => {
  let now = 0, calls = 0;
  const cache = new SessionActivityCache({ listTurns: async (id) => page(id, ++calls < 3 ? "inProgress" : "completed") }, { now: () => now });
  const entry = cache.observe("one", "v1");
  cache.refresh([entry]); await tick();
  assert.equal(entry.activityState, "running");
  const activityTime = entry.lastActivityAt;
  now = 4999; cache.refresh([entry]); await tick(); assert.equal(calls, 1);
  now = 5000; cache.refresh([entry]); await tick(); assert.equal(calls, 2);
  now = 10000; cache.refresh([entry]); await tick(); assert.equal(entry.activityState, "idle");
  now = 100000; cache.refresh([entry]); await tick(); assert.equal(calls, 3);
  assert.equal(entry.lastActivityAt, activityTime);
});

test("uncompleted interrupted desktop snapshots and read errors remain unknown with bounded retry backoff", async () => {
  let now = 0, calls = 0;
  const cache = new SessionActivityCache({ listTurns: async (id) => {
    calls += 1;
    if (calls === 2) throw new Error("read failed");
    return page(id, "interrupted", { completedAt: calls < 3 ? null : 1792130410 });
  } }, { now: () => now });
  const entry = cache.observe("one", "v1");
  cache.refresh([entry]); await tick(); assert.equal(entry.activityState, "unknown");
  now = 5000; cache.refresh([entry]); await tick(); assert.equal(entry.activityState, "unknown");
  assert.equal(entry.nextCheckAt, 15000);
  now = 14999; cache.refresh([entry]); await tick(); assert.equal(calls, 2);
  now = 15000; cache.refresh([entry]); await tick(); assert.equal(entry.activityState, "idle");
});

test("changed signatures share their pending reader and recheck before accepting an obsolete result", async () => {
  let now = 1000;
  const waiting = [];
  const cache = new SessionActivityCache({ listTurns: (id) => new Promise((resolve) => waiting.push((status) => resolve(page(id, status)))) }, { now: () => now });
  const old = cache.observe("one", "old"); cache.refresh([old]); await tick();
  const current = cache.observe("one", "new"); cache.refresh([current]); await tick();
  assert.equal(current, old);
  assert.equal(waiting.length, 1, "metadata updates cannot create overlapping reads for one thread");
  waiting[0]("completed"); await tick(); assert.equal(current.activityState, "unknown");
  assert.equal(waiting.length, 2, "changed metadata schedules one immediate followup read");
  waiting[1]("inProgress"); await tick(); assert.equal(current.activityState, "running");
  now = 4000;
  const writing = cache.observe("one", "more-output");
  assert.equal(writing.activityState, "running");
  assert.equal(writing.lastActivityAt, current.lastActivityAt);
  now = 31001;
  assert.equal(cache.observe("one", "later-output").activityState, "unknown");
});

test("15-second catalog refreshes retain bounded running evidence while new metadata is checked", async () => {
  let now = 0, calls = 0, status = "inProgress";
  const cache = new SessionActivityCache({ listTurns: async (id) => { calls += 1; return page(id, status); } }, { now: () => now });
  const first = cache.observe("one", "v1"); cache.refresh([first]); await tick();
  for (const time of [15000, 30000]) {
    now = time;
    const next = cache.observe("one", `v${time}`);
    assert.equal(next.activityState, "running", "a new metadata signature must not erase recent confirmed execution");
    cache.refresh([next]); await tick();
  }
  assert.equal(calls, 3);
  now = 45000; status = "completed";
  const ending = cache.observe("one", "complete"); cache.refresh([ending]); await tick();
  assert.equal(ending.activityState, "idle", "official completion retires the retained running state immediately");
  assert.equal(ending.confirmedRunningAt, null);
});

test("running evidence expires without confirmation and read failures never retain a false running state", async () => {
  let now = 0, fail = false;
  const cache = new SessionActivityCache({ listTurns: async (id) => {
    if (fail) throw new Error("unavailable");
    return page(id, "inProgress");
  } }, { now: () => now });
  const entry = cache.observe("one", "v1"); cache.refresh([entry]); await tick();
  now = 30001;
  assert.equal(cache.observe("one", "v2").activityState, "unknown");
  cache.refresh([entry]); await tick();
  assert.equal(entry.activityState, "running");
  now += 15000; fail = true;
  cache.refresh([cache.observe("one", "v3")]); await tick();
  assert.equal(entry.activityState, "unknown");
  assert.equal(entry.confirmedRunningAt, null);
});

test("continuous metadata updates do not discard confirmed running reads or create parallel readers", async () => {
  let now = 0;
  const waiting = [];
  const cache = new SessionActivityCache({ listTurns: (id) => new Promise((resolve) => waiting.push(() => resolve(page(id, "inProgress")))) }, { now: () => now });
  const entry = cache.observe("one", "v1"); cache.refresh([entry]); await tick();
  now = 15000; cache.refresh([cache.observe("one", "v2")]);
  assert.equal(waiting.length, 1);
  waiting.shift()(); await tick();
  assert.equal(entry.activityState, "running");
  assert.equal(waiting.length, 1, "one followup reads the newest metadata without overlapping the old read");
  now = 30000; cache.observe("one", "v3");
  waiting.shift()(); await tick();
  assert.equal(entry.activityState, "running");
  assert.equal(waiting.length, 1);
  waiting.shift()(); await tick();
  assert.equal(entry.pending, false);
});
