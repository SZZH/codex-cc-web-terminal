import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { presentSubagentActivity, SubagentActivityReader } from "../src/sessions/codex/subagentActivity.js";
import { createCodexChatPresenter, presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";
import { mergeCodexSubagentActivity } from "../web/src/lib/codex-subagent-activity.js";

const started = (id = "start", extra = {}) => ({ id, type: "subAgentActivity", kind: "interacted", agentThreadId: "child", agentPath: "/root/reviewer", ...extra });
const completed = (id = "end", extra = {}) => started(id, { kind: "completed", ...extra });
const startAt = "2026-10-16T16:08:33.610Z";
const endAt = "2026-10-16T16:13:08.003Z";

function record(item, at, extra = {}) {
  return JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "item_completed", thread_id: "parent", turn_id: "turn",
    item: { type: "SubAgentActivity", id: item.id, kind: item.kind, agent_thread_id: item.agentThreadId, agent_path: item.agentPath,
      ...(item.status ? { status: item.status } : {}), ...(item.error ? { error: item.error } : {}) },
    started_at_ms: Date.parse(at), completed_at_ms: Date.parse(at), ...extra } }) + "\n";
}

function fixture(t, data = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-"));
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const file = path.join(sessions, "rollout.jsonl");
  fs.writeFileSync(file, data);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sessions, file, thread: { id: "parent", path: file }, reader: new SubagentActivityReader({ codexSessionsDir: sessions }) };
}

test("actual native interacted and completed items preserve unknown timing without execution durations", () => {
  const item = started("call-id", { durationMs: 17, completedAt: endAt });
  const activity = presentSubagentActivity(item);
  assert.deepEqual(activity, { agentThreadId: "child", agentPath: "/root/reviewer", label: "reviewer", event: "started", state: "running",
    startedAt: null, completedAt: null, durationMs: null, startedItemId: "call-id" });
  assert.deepEqual(presentSubagentActivity(completed()).startedItemId, null);
  assert.equal(presentSubagentActivity({ type: "commandExecution", durationMs: 1000 }), null);
});

test("same-page lifecycle pairs exact native item ids and prefers official event timestamps", (t) => {
  const source = [started("call-id", { startedAt: startAt }), completed("subagent-completed-id", { completedAt: endAt })];
  const original = structuredClone(source);
  const { reader } = fixture(t);
  const activities = reader.forItems(source, { turnId: "turn" });
  assert.equal(activities.get("call-id").event, "started");
  assert.equal(activities.get("call-id").state, "completed");
  assert.equal(activities.get("call-id").durationMs, 274393);
  assert.equal(activities.get("subagent-completed-id").startedItemId, "call-id");
  assert.equal(activities.get("subagent-completed-id").durationMs, 274393);
  assert.deepEqual(source, original);
});

test("bounded official rollout records recover the actual lifecycle rather than each event's zero duration", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt) + record(completed(), endAt));
  const activity = reader.forItems([started()], { thread, turnId: "turn" }).get("start");
  assert.equal(activity.state, "completed");
  assert.equal(activity.startedAt, startAt);
  assert.equal(activity.completedAt, endAt);
  assert.equal(activity.durationMs, 274393);
  const end = reader.forItems([completed()], { thread, turnId: "turn" }).get("end");
  assert.equal(end.startedItemId, "start");
  assert.equal(end.durationMs, 274393);
});

test("official timestamps override rollout timestamps without changing raw items", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt) + record(completed(), endAt));
  const activity = reader.forItems([started("start", { startedAt: "2026-10-16T16:09:00Z" })], { thread, turnId: "turn" }).get("start");
  assert.equal(activity.startedAt, "2026-10-16T16:09:00.000Z");
  assert.equal(activity.durationMs, 248003);
});

test("running observations have a real start and no fabricated completion or frozen duration", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt));
  const activity = reader.forItems([started()], { thread, turnId: "turn" }).get("start");
  assert.equal(activity.state, "running");
  assert.equal(activity.startedAt, startAt);
  assert.equal(activity.completedAt, null);
  assert.equal(activity.durationMs, null);
});

test("an unpaired historical start without verified timing stays unknown", (t) => {
  const { reader, thread } = fixture(t);
  const activity = reader.forItems([started()], { thread, turnId: "turn" }).get("start");
  assert.equal(activity.event, "started");
  assert.equal(activity.state, "unknown");
  assert.equal(activity.startedItemId, "start");
  assert.equal(activity.startedAt, null);
  assert.equal(activity.durationMs, null);
});

test("a verified start in an active parent turn remains running while a terminal parent leaves it unknown", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt));
  assert.equal(reader.forItems([started()], { thread, turnId: "turn", turnStatus: "inProgress" }).get("start").state, "running");
  const historical = reader.forItems([started()], { thread, turnId: "turn", turnStatus: "completed" }).get("start");
  assert.equal(historical.state, "unknown");
  assert.equal(historical.startedAt, startAt);
  assert.equal(historical.completedAt, null);
  assert.equal(reader.forItems([started()], { thread, turnId: "turn" }).get("start").state, "unknown");
});

test("a matching completion remains completed without timestamps in a terminal parent", (t) => {
  const { reader, thread } = fixture(t);
  const activities = reader.forItems([started(), completed()], { thread, turnId: "turn", turnStatus: "completed" });
  assert.equal(activities.get("start").state, "completed");
  assert.equal(activities.get("end").startedItemId, "start");
  assert.equal(activities.get("start").durationMs, null);
});

test("remembered parent terminal states stay thread-scoped and bounded", (t) => {
  const { reader, thread } = fixture(t);
  const source = started("start", { startedAt: startAt });
  reader.forItems([], { thread, turnId: "turn", turnStatus: "completed" });
  assert.equal(reader.forItems([source], { thread, turnId: "turn" }).get("start").state, "unknown");
  assert.equal(reader.forItems([source], { thread: { id: "another" }, turnId: "turn" }).get("start").state, "running");
  for (let index = 0; index < 300; index += 1) reader.forItems([], { thread, turnId: `turn-${index}`, turnStatus: "completed" });
  assert.equal(reader.parentTurns.size, 256);
});

test("successive rounds to the same child are paired independently and stay scoped to their parent turn", (t) => {
  const { reader, thread } = fixture(t, record(started("s1"), startAt) + record(completed("e1"), endAt) +
    record(started("s2"), "2026-10-16T16:15:00Z") + record(completed("e2"), "2026-10-16T16:17:00Z") +
    record(started("other-turn"), "2026-10-16T16:20:00Z", { turn_id: "another" }));
  const source = [started("s1"), completed("e1"), started("s2"), completed("e2")];
  const activities = reader.forItems(source, { thread, turnId: "turn" });
  assert.equal(activities.get("e1").startedItemId, "s1");
  assert.equal(activities.get("s1").durationMs, 274393);
  assert.equal(activities.get("e2").startedItemId, "s2");
  assert.equal(activities.get("s2").durationMs, 120000);
  assert.equal(reader.forItems([completed("orphan")], { thread, turnId: "another" }).get("orphan").startedItemId, null);
});

test("a later follow-up cannot complete an older unfinished lifecycle", (t) => {
  const { reader, thread } = fixture(t, record(started("older"), startAt) + record(started("newer"), endAt) +
    record(completed(), "2026-10-16T16:15:00Z"));
  const observed = reader.forItems([started("older"), completed()], { thread, turnId: "turn" });
  assert.equal(observed.get("older").state, "unknown");
  assert.equal(observed.get("older").completedAt, null);
  assert.equal(observed.get("end").startedItemId, "newer");
});

test("native child failure and interruption produce terminal lifecycle state", (t) => {
  const { reader } = fixture(t);
  for (const [extra, expected] of [[{ status: "failed" }, "failed"], [{ error: { message: "failed" } }, "failed"], [{ kind: "interrupted" }, "interrupted"]]) {
    const activities = reader.forItems([started("start", { startedAt: startAt }), completed("end", { completedAt: endAt, ...extra })]);
    assert.equal(activities.get("start").state, expected);
    assert.equal(activities.get("end").event, expected);
    assert.equal(activities.get("start").durationMs, 274393);
  }
});

test("missing, invalid or reversed timestamps never invent elapsed time", (t) => {
  const { reader } = fixture(t);
  for (const source of [[started(), completed()], [started("start", { startedAt: "invalid" }), completed("end", { completedAt: endAt })],
    [started("start", { startedAt: endAt }), completed("end", { completedAt: startAt })]]) {
    const activities = reader.forItems(source);
    assert.equal(activities.get("start").durationMs, null);
    assert.equal(activities.get("end").durationMs, null);
  }
  for (const invalid of [true, false, {}, [], "invalid"]) {
    assert.equal(presentSubagentActivity(started("start", { startedAt: invalid })).startedAt, null);
  }
});

test("path escapes, symlinks outside roots and wrong-thread observations cannot supply timings", (t) => {
  const { reader, root, sessions, thread } = fixture(t, record(started(), startAt, { thread_id: "other" }));
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, record(started(), startAt));
  const link = path.join(sessions, "link.jsonl");
  fs.symlinkSync(outside, link);
  for (const metadata of [thread, { id: "parent", path: outside }, { id: "parent", path: link }]) {
    assert.equal(reader.forItems([started()], { thread: metadata, turnId: "turn" }).get("start").startedAt, null);
  }
  const unconfigured = new SubagentActivityReader();
  assert.equal(unconfigured.forItems([started()], { thread, turnId: "turn" }).get("start").startedAt, null);
  fs.writeFileSync(thread.path, record(started(), startAt));
  assert.equal(reader.forItems([started()], { thread, turnId: "turn" }).get("start").startedAt, startAt);
  assert.equal(reader.forItems([started()], { thread: { ...thread, id: "another" }, turnId: "turn" }).get("start").startedAt, null);
});

test("failure observed in an official rollout remains failed when an item page omits status", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt) + record(completed("end", { status: "failed" }), endAt));
  reader.observeItems([started(), completed()], { threadId: thread.id, turnId: "turn", page: { sortDirection: "asc" } });
  const activities = reader.forItems([started(), completed()], { thread, turnId: "turn" });
  assert.equal(activities.get("start").state, "failed");
  assert.equal(activities.get("end").state, "failed");
});

test("rollout reads and observations stay bounded and unchanged files reuse their stat-signature cache", (t) => {
  const { reader, thread, file } = fixture(t, record(started(), startAt) + "x".repeat(1024 * 1024) + "\n" + record(completed(), endAt));
  const end = reader.forItems([completed()], { thread, turnId: "turn" }).get("end");
  assert.equal(end.startedAt, null);
  assert.equal(end.durationMs, null);
  const first = reader.rollout(thread);
  assert.equal(reader.rollout(thread), first);
  fs.appendFileSync(file, record(started("new"), "2026-10-16T16:20:00Z"));
  assert.notEqual(reader.rollout(thread), first);
  fs.writeFileSync(file, Array.from({ length: 600 }, (_, index) => record(started(`s${index}`), startAt)).join(""));
  assert.equal(reader.rollout(thread).length, 512);
  assert.equal(reader.rollout(thread)[0].id, "s88");
  for (let index = 0; index < 35; index += 1) {
    const another = path.join(path.dirname(file), `rollout-${index}.jsonl`);
    fs.writeFileSync(another, record(started(), startAt));
    reader.rollout({ ...thread, path: another });
  }
  assert.equal(reader.files.size, 32);
});

test("duplicate official event records retain one lifecycle link", (t) => {
  const { reader, thread } = fixture(t, record(started(), startAt, { type: "item_started" }) + record(started(), startAt) +
    record(completed(), endAt, { type: "item_started" }) + record(completed(), endAt));
  const activity = reader.forItems([completed()], { thread, turnId: "turn" }).get("end");
  assert.equal(activity.startedItemId, "start");
  assert.equal(activity.durationMs, 274393);
});

test("official wrapper timing survives file growth and remains isolated by thread and turn", (t) => {
  const { reader, thread, file } = fixture(t, record(started(), startAt) + record(completed(), endAt));
  const source = [started(), completed()];
  reader.observeItems(source, { threadId: thread.id, turnId: "turn", entries: source.map((item, index) => ({ turnId: "turn", item,
    startedAtMs: Date.parse(index ? endAt : startAt), completedAtMs: Date.parse(index ? endAt : startAt) })), page: { sortDirection: "asc", nextCursor: null } });
  assert.equal(reader.forItems(source, { thread, turnId: "turn" }).get("start").durationMs, 274393);
  fs.appendFileSync(file, "x".repeat(1024 * 1024 + 100) + "\n");
  const afterGrowth = reader.forItems(source, { thread, turnId: "turn" });
  assert.equal(afterGrowth.get("start").durationMs, 274393);
  assert.equal(afterGrowth.get("end").startedItemId, "start");
  assert.equal(reader.forItems(source, { thread: { id: "another" }, turnId: "turn" }).get("start").durationMs, null);
  assert.equal(reader.forItems(source, { thread, turnId: "another" }).get("start").durationMs, null);
});

test("native item metadata and page chains have bounded per-turn storage", (t) => {
  const { reader, thread } = fixture(t);
  for (let index = 0; index < 70; index += 1) reader.observeItems([started()], { threadId: thread.id, turnId: `t${index}`, page: { sortDirection: "asc" } });
  assert.equal(reader.turnItems.size, 64);
  assert.equal(reader.turnPages.size, 64);
  for (let index = 0; index < 600; index += 1) reader.observeItems([started(`s${index}`)], { threadId: thread.id, turnId: "new",
    page: { sortDirection: "asc", cursor: `cursor${index}` } });
  assert.equal(reader.turnItems.get(`${thread.id}:new`).size, 512);
  assert.equal(reader.turnPages.get(`${thread.id}:new`).size, 128);
});

test("short matching detail prefixes retain full page proofs and unchanged activity indexes", (t) => {
  const { reader, thread } = fixture(t);
  const source = [started(), { id: "generic", type: "commandExecution" }, completed()];
  const entries = source.map((item, index) => ({ item, startedAtMs: Date.parse(index === 2 ? endAt : startAt), completedAtMs: Date.parse(index === 2 ? endAt : startAt) }));
  reader.observeItems(source.slice(0, 2), { threadId: thread.id, turnId: "turn", entries: entries.slice(0, 2), page: { sortDirection: "asc", nextCursor: "next" } });
  reader.observeItems([source[2]], { threadId: thread.id, turnId: "turn", entries: [entries[2]], page: { sortDirection: "asc", cursor: "next", nextCursor: null } });
  const scope = `${thread.id}:turn`;
  const originalIndex = reader.indexedActivities(scope);
  reader.observeItems([source[0]], { threadId: thread.id, turnId: "turn", entries: [entries[0]],
    page: { sortDirection: "asc", nextCursor: "after-start" } });
  assert.equal(reader.indexedActivities(scope), originalIndex);
  const summary = reader.forItems([source[0], source[2]], { thread, turnId: "turn", contiguous: false });
  assert.equal(summary.get("start").durationMs, 274393);
  assert.equal(summary.get("end").startedItemId, "start");
  assert.equal(reader.indexedActivities(scope), originalIndex);
});

test("a changed generic prefix cannot reuse earlier page-chain proofs even when native ids match", (t) => {
  const { reader, thread } = fixture(t);
  const begin = started("start", { startedAt: startAt });
  const end = completed("end", { completedAt: endAt });
  reader.observeItems([begin, { id: "old-generic", type: "commandExecution" }], { threadId: thread.id, turnId: "turn",
    page: { sortDirection: "asc", nextCursor: "next" } });
  reader.observeItems([end], { threadId: thread.id, turnId: "turn", page: { sortDirection: "asc", cursor: "next" } });
  assert.equal(reader.forItems([begin, end], { thread, turnId: "turn", contiguous: false }).get("start").durationMs, 274393);
  reader.observeItems([begin, { id: "new-generic", type: "commandExecution" }], { threadId: thread.id, turnId: "turn",
    page: { sortDirection: "asc", nextCursor: "next" } });
  const afterConflict = reader.forItems([begin, end], { thread, turnId: "turn", turnStatus: "completed", contiguous: false });
  assert.equal(afterConflict.get("start").state, "unknown");
  assert.equal(afterConflict.get("start").durationMs, null);
  assert.equal(afterConflict.get("end").startedItemId, null);
});

test("changed native timestamps invalidate the paired index while repeated summaries reuse it", (t) => {
  const { reader, thread } = fixture(t);
  const source = [started("start", { startedAt: startAt }), completed("end", { completedAt: endAt })];
  reader.observeItems(source, { threadId: thread.id, turnId: "turn", page: { sortDirection: "asc" } });
  const scope = `${thread.id}:turn`;
  const originalIndex = reader.indexedActivities(scope);
  reader.forItems(source, { thread, turnId: "turn", contiguous: false });
  assert.equal(reader.indexedActivities(scope), originalIndex);
  reader.observeItems([{ ...source[0], startedAt: "2026-10-16T16:09:00Z" }], { threadId: thread.id, turnId: "turn" });
  assert.notEqual(reader.indexedActivities(scope), originalIndex);
  assert.equal(reader.indexedActivities(scope).get("start").durationMs, 248003);
});

function activityItem(id, event = "started", extra = {}) {
  return { id, type: "subAgentActivity", presentation: { activity: {
    agentThreadId: "child", agentPath: "/root/reviewer", label: "reviewer", event,
    state: event === "started" ? "running" : event, startedAt: event === "started" ? startAt : null,
    completedAt: event === "started" ? null : endAt, durationMs: null,
    startedItemId: event === "started" ? id : "start", ...extra
  } } };
}

function chatState(...turns) {
  return { threadId: "parent", revision: 1, turnOrder: turns.map((turn) => turn.id), requestOrder: [], requests: {},
    turns: Object.fromEntries(turns.map((turn) => [turn.id, { status: "inProgress", ...turn,
      itemOrder: turn.items.map((item) => item.id), items: Object.fromEntries(turn.items.map((item) => [item.id, item])) }])) };
}

function addActivity(state, turnId, item) {
  const turn = state.turns[turnId];
  turn.items[item.id] = item;
  if (!turn.itemOrder.includes(item.id)) turn.itemOrder.push(item.id);
  state.revision += 1;
}

for (const [label, presenter] of [["snapshot", () => presentCodexChatSnapshot], ["incremental", createCodexChatPresenter]]) {
  test(`${label} projection settles an existing start after its exact completion arrives without hiding either event`, () => {
    const state = chatState({ id: "turn", items: [activityItem("start")] });
    const present = presenter(), before = present(state);
    addActivity(state, "turn", activityItem("end", "completed", { startedAt: startAt, durationMs: 274393 }));
    const raw = structuredClone(state), after = present(state);
    assert.deepEqual(after.turns[0].items.map((item) => item.id), ["start", "end"]);
    assert.deepEqual(after.turns[0].items.map((item) => item.activity.event), ["started", "completed"]);
    const start = after.turns[0].items[0];
    assert.equal(start.activity.state, "completed");
    assert.equal(start.activity.startedItemId, "start");
    assert.equal(start.activity.startedAt, startAt);
    assert.equal(start.activity.completedAt, endAt);
    assert.equal(start.activity.durationMs, 274393);
    assert.equal(start.payload.activity, start.activity);
    assert.equal(before.turns[0].items[0].activity.state, "running");
    assert.deepEqual(state, raw, "projection must not mutate the store's official activities");
    assert.deepEqual(after, presentCodexChatSnapshot(state));
    if (label === "incremental") assert.equal(present(state).turns[0], after.turns[0], "unchanged settled activity adapters remain reusable");
  });

  test(`${label} projection handles completion before a stale start and does not settle a later wakeup`, () => {
    const state = chatState({ id: "turn", items: [activityItem("end", "completed")] });
    const present = presenter();
    present(state);
    addActivity(state, "turn", activityItem("next-wakeup"));
    addActivity(state, "turn", activityItem("start"));
    const items = present(state).turns[0].items;
    assert.deepEqual(items.map((item) => item.id), ["end", "next-wakeup", "start"]);
    assert.equal(items[2].activity.state, "completed");
    assert.equal(items[2].activity.durationMs, 274393, "verified timestamps can supply the missing duration");
    assert.equal(items[1].activity.state, "running");
    assert.equal(items[1].activity.completedAt, null);
  });

  test(`${label} projection requires an exact same-turn lifecycle link and compatible child identity`, () => {
    const state = chatState({ id: "earlier", items: [activityItem("start")] }, { id: "later", items: [
      activityItem("next-wakeup"), activityItem("end", "completed"),
      activityItem("no-link", "completed", { startedItemId: null }),
      activityItem("wrong-child", "completed", { startedItemId: "next-wakeup", agentThreadId: "another-child" })
    ] });
    const snapshot = presenter()(state);
    assert.equal(snapshot.turns[0].items[0].activity.state, "running", "an item id in another turn must not be paired");
    assert.equal(snapshot.turns[1].items[0].activity.state, "running", "shared path and an incompatible child id are insufficient");
    assert.deepEqual(snapshot.turns[1].items.map((item) => item.id), ["next-wakeup", "end", "no-link", "wrong-child"]);
  });

  test(`${label} projection uses retained exact completion evidence outside the visible item window`, () => {
    const state = chatState({ id: "turn", items: [activityItem("start"), activityItem("end", "failed", { durationMs: 274393 })] });
    state.turns.turn.itemsWindowIds = ["start"];
    const snapshot = presenter()(state);
    assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ["start"]);
    assert.equal(snapshot.turns[0].items[0].activity.state, "failed");
    assert.equal(snapshot.turns[0].items[0].activity.durationMs, 274393);
    assert.equal(state.turns.turn.items.start.presentation.activity.state, "running");
  });
}

test("activity projection preserves explicit failure and interruption and never invents missing or reversed timing", () => {
  for (const terminal of ["failed", "interrupted"]) {
    const state = chatState({ id: "turn", items: [activityItem("start"), activityItem("end", terminal)] });
    assert.equal(presentCodexChatSnapshot(state).turns[0].items[0].activity.state, terminal);
  }
  for (const [begin, end] of [[null, null], ["invalid", endAt], [endAt, startAt]]) {
    const state = chatState({ id: "turn", items: [activityItem("start", "started", { startedAt: begin }),
      activityItem("end", "completed", { completedAt: end })] });
    const activity = presentCodexChatSnapshot(state).turns[0].items[0].activity;
    assert.equal(activity.state, "completed");
    assert.equal(activity.durationMs, null);
  }
});

test("same-item activity merging retains terminal proof when an old start summary arrives", () => {
  for (const state of ["completed", "failed", "interrupted"]) {
    const previous = activityItem("start", "started", { state, completedAt: endAt, durationMs: 274393 }).presentation.activity;
    const incoming = activityItem("start", "started", { startedAt: "2026-10-16T16:09:00Z" }).presentation.activity;
    const original = structuredClone(previous);
    const merged = mergeCodexSubagentActivity(previous, incoming);
    assert.equal(merged.state, state);
    assert.equal(merged.event, "started");
    assert.equal(merged.startedAt, startAt);
    assert.equal(merged.completedAt, endAt);
    assert.equal(merged.durationMs, 274393);
    assert.deepEqual(previous, original);
    assert.equal(mergeCodexSubagentActivity(previous, undefined), previous);
    assert.equal(mergeCodexSubagentActivity(previous, { ...incoming, startedItemId: "next-wakeup" }).state, "running");
    assert.equal(mergeCodexSubagentActivity(previous, { ...incoming, agentThreadId: "another-child" }).state, "running");
  }
});

test("same-item activity merging retains exact lifecycle links and failure evidence from richer observations", () => {
  const previous = activityItem("end", "failed", { durationMs: 274393 }).presentation.activity;
  const incoming = activityItem("end", "completed", { startedItemId: null, completedAt: null }).presentation.activity;
  const merged = mergeCodexSubagentActivity(previous, incoming);
  assert.equal(merged.state, "failed");
  assert.equal(merged.event, "failed");
  assert.equal(merged.startedItemId, "start");
  assert.equal(merged.completedAt, endAt);
  assert.equal(merged.durationMs, 274393);
});
