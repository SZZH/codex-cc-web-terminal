import assert from "node:assert/strict";
import test from "node:test";

import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";
import { canonicalizeRawRecords, createCanonicalizerState, createRawRecord, reduceCanonicalEvents } from "../src/threads/index.js";

const item = (id, text = "same") => ({ id, type: "agentMessage", text, phase: "final_answer" });
const turn = (id, items = [item(`${id}-a`)], status = "completed") => ({ id, status, items, itemsView: "summary" });

function fixture(handler = () => ({ data: [], nextCursor: null }), options = {}) {
  const calls = [];
  const thread = { id: "thread", cwd: "/tmp/work", name: "Test", historyMode: "paginated", turns: [], status: { type: "notLoaded" }, ...options.thread };
  const bridge = { ensureReady: async () => {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread };
    return handler(method, params);
  } };
  return { reader: new CodexHistoryReader({ bridge, sessionManager: options.sessionManager, config: options.config }), calls, thread };
}

test("metadata reads never resume or hydrate all turns", async () => {
  const { reader, calls, thread } = fixture();
  assert.deepEqual(await reader.getThread("thread"), thread);
  assert.deepEqual(calls, [{ method: "thread/read", params: { threadId: "thread", includeTurns: false } }]);
});

test("an unloaded external interrupted projection without completion becomes unknown, while true interrupted history remains terminal", async () => {
  const { reader, calls } = fixture(() => ({ data: [
    { ...turn("uncertain", [], "interrupted"), completedAt: null },
    { ...turn("confirmed", [], "interrupted"), completedAt: 1792130410 }
  ], nextCursor: null }));
  const result = await reader.listTurns("thread");
  assert.equal(result.turns.find((turn) => turn.id === "uncertain").status, "unknown");
  assert.equal(result.turns.find((turn) => turn.id === "uncertain").statusConfirmed, false);
  assert.equal(result.turns.find((turn) => turn.id === "confirmed").status, "interrupted");
  assert.ok(calls.every((call) => ["thread/read", "thread/turns/list"].includes(call.method)));
});

test("official unmaterialized first-use thread reads as empty and later exposes its real history", async () => {
  let materialized = false;
  const { reader, calls } = fixture((method) => {
    assert.equal(method, "thread/turns/list");
    if (!materialized) throw Object.assign(new Error("thread thread is not materialized yet; thread/turns/list is unavailable before first user message"), { rpcError: true });
    return { data: [turn("first-turn")], nextCursor: null };
  });
  assert.deepEqual(await reader.listTurns("thread"), { threadId: "thread", turns: [], olderCursor: null, hasMore: false });
  materialized = true;
  assert.deepEqual((await reader.listTurns("thread")).turns.map((value) => value.id), ["first-turn"]);
  assert.equal(calls.filter((call) => call.method === "thread/turns/list").length, 2);
  assert.ok(calls.every((call) => ["thread/read", "thread/turns/list"].includes(call.method)));
});

test("empty-thread handling does not hide unrelated RPC, network or cursor failures", async () => {
  const known = "thread thread is not materialized yet; thread/turns/list is unavailable before first user message";
  for (const error of [
    Object.assign(new Error("permission denied"), { rpcError: true, code: -32000 }),
    new Error("connection lost"), new Error(known),
    Object.assign(new Error(known.replace("thread thread ", "thread other ")), { rpcError: true }),
    Object.assign(new Error("thread thread is not materialized yet"), { rpcError: true })
  ]) {
    const { reader } = fixture(() => { throw error; });
    await assert.rejects(reader.listTurns("thread"), (actual) => actual === error);
  }
  const cursorError = Object.assign(new Error(known), { rpcError: true });
  const { reader } = fixture(() => { throw cursorError; });
  await assert.rejects(reader.listTurns("thread", { cursor: "previous-page" }), (actual) => actual === cursorError);
});

test("turns read exactly one descending summary page and reverse only that page", async () => {
  const { reader, calls } = fixture((method, params) => {
    assert.equal(method, "thread/turns/list");
    return params.cursor ? { data: [turn("t1")], nextCursor: null } : { data: [turn("t3"), turn("t2")], nextCursor: "older" };
  });
  const latest = await reader.listTurns("thread", { limit: 2 });
  assert.deepEqual(latest.turns.map((value) => value.id), ["t2", "t3"]);
  assert.equal(latest.olderCursor, "older");
  assert.equal(latest.hasMore, true);
  assert.equal(calls.filter((value) => value.method === "thread/turns/list").length, 1);
  assert.deepEqual(calls[1].params, { threadId: "thread", limit: 2, sortDirection: "desc", itemsView: "summary" });
  const older = await reader.listTurns("thread", { cursor: latest.olderCursor, limit: 2 });
  assert.deepEqual(older.turns.map((value) => value.id), ["t1"]);
  assert.equal(older.hasMore, false);
  assert.ok(calls.every((value) => ["thread/read", "thread/turns/list"].includes(value.method)));
});

test("summary gaps stay visible and duplicate text with distinct ids survives", async () => {
  const { reader } = fixture(() => ({ data: [turn("t", [item("one"), item("two")], "failed")], nextCursor: null }));
  const page = await reader.listTurns("thread");
  assert.equal(page.turns[0].status, "failed");
  assert.equal(page.turns[0].hasMoreItems, true);
  assert.deepEqual(page.turns[0].items.map((value) => value.id), ["one", "two"]);
});

test("item pagination stays scoped to a single turn and carries the official cursor", async () => {
  const { reader, calls } = fixture((method) => {
    assert.equal(method, "thread/items/list");
    return { data: [{ turnId: "t", item: item("i") }], nextCursor: "after-i" };
  });
  const page = await reader.listItems("thread", "t", { cursor: "before-i", limit: 1 });
  assert.equal(page.nextCursor, "after-i");
  assert.equal(page.hasMore, true);
  assert.deepEqual(calls[1].params, { threadId: "thread", turnId: "t", cursor: "before-i", limit: 1, sortDirection: "asc" });
  assert.equal(page.items[0].id, "i");
  assert.equal(page.latestItemId, "i");
});

test("recent item reads use official descending pagination and return chronological items", async () => {
  const { reader, calls } = fixture((method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.sortDirection, "desc");
    return { data: ["new", "middle", "old"].map((id) => ({ turnId: "t", item: item(id) })), nextCursor: "older-items" };
  });
  const page = await reader.listItems("thread", "t", { limit: 3, sortDirection: "desc" });
  assert.deepEqual(page.items.map((value) => value.id), ["old", "middle", "new"]);
  assert.equal(page.latestItemId, "new");
  assert.equal(page.nextCursor, "older-items");
  assert.deepEqual(calls.at(-1).params, { threadId: "thread", turnId: "t", limit: 3, sortDirection: "desc" });
  await assert.rejects(reader.listItems("thread", "t", { sortDirection: "newest" }), (error) => error.statusCode === 400);
});

test("after reads only new items once an initial turn has been paged through", async () => {
  const source = [item("old-one"), item("old-two"), item("old-three")];
  const { reader, calls } = fixture((method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.sortDirection, "asc");
    const start = typeof params.cursor === "string" ? Number(params.cursor.slice(5)) : params.cursor ? source.findIndex((entry) => entry.id === params.cursor.itemId) + 1 : 0;
    const values = source.slice(start, start + params.limit);
    return { data: values.map((value) => ({ turnId: "t", item: value })), nextCursor: start + values.length < source.length ? `page-${start + values.length}` : null };
  });
  const first = await reader.listItems("thread", "t", { limit: 2 });
  assert.equal(first.latestItemId, "old-two");
  const second = await reader.listItems("thread", "t", { limit: 2, cursor: first.nextCursor, after: first.latestItemId });
  assert.deepEqual(second.items.map((value) => value.id), ["old-three"]);
  assert.equal(second.hasMore, false);
  source.push(item("new-one"));
  const fresh = await reader.listItems("thread", "t", { after: second.latestItemId, limit: 2 });
  assert.deepEqual(fresh.items.map((value) => value.id), ["new-one"]);
  const idle = await reader.listItems("thread", "t", { after: fresh.latestItemId, limit: 2 });
  assert.deepEqual(idle.items, []);
  assert.equal(idle.latestItemId, "new-one");
  assert.equal(idle.hasMore, false);
  const reads = calls.filter((call) => call.method === "thread/items/list");
  assert.equal(reads.length, 4);
  assert.equal(reads[0].params.cursor, undefined);
  assert.equal(reads[1].params.cursor, "page-2");
  assert.deepEqual(reads[2].params.cursor, { type: "item", itemId: "old-three" });
  assert.deepEqual(reads[3].params.cursor, { type: "item", itemId: "new-one" });
  assert.ok(calls.every((call) => ["thread/read", "thread/items/list"].includes(call.method)));
});

test("cursor takes priority over after and empty pages preserve the caller's last item", async () => {
  const { reader, calls } = fixture(() => ({ data: [], nextCursor: null }));
  const page = await reader.listItems("thread", "t", { cursor: "opaque-page", after: "last-known" });
  assert.equal(calls.at(-1).params.cursor, "opaque-page");
  assert.equal(page.latestItemId, "last-known");
  const empty = await reader.listItems("thread", "t", { after: "" });
  assert.equal(calls.at(-1).params.cursor, undefined);
  assert.equal(empty.latestItemId, null);
});

test("invalid or repeated incremental anchors fail without restarting from the first page", async () => {
  const upstream = Object.assign(new Error("Item anchor is not in the requested turn"), { statusCode: 404 });
  const missing = fixture(() => { throw upstream; });
  await assert.rejects(missing.reader.listItems("thread", "t", { after: "wrong-turn-item" }), (error) => error === upstream);
  assert.equal(missing.calls.filter((call) => call.method === "thread/items/list").length, 1);
  await assert.rejects(missing.reader.listItems("thread", "t", { after: " " }), (error) => error.statusCode === 400);
  await assert.rejects(missing.reader.listItems("thread", "t", { after: "a".repeat(513) }), (error) => error.statusCode === 400);
  const repeatedAnchor = fixture(() => ({ data: [{ turnId: "t", item: item("anchor") }], nextCursor: null }));
  await assert.rejects(repeatedAnchor.reader.listItems("thread", "t", { after: "anchor" }), /exclusive item anchor/);
  const repeatedCursor = fixture(() => ({ data: [], nextCursor: "same-page" }));
  await assert.rejects(repeatedCursor.reader.listItems("thread", "t", { cursor: "same-page", after: "old" }), /Repeated item history cursor/);
});

test("incremental process previews stay compact while details preserve full ordinary output", async () => {
  const output = "command output\n".repeat(6000);
  const command = { id: "command", type: "commandExecution", status: "inProgress", phase: "commentary", aggregatedOutput: output, command: "run" };
  const { reader } = fixture((method, params) => ({ data: [{ turnId: "t", item: params.sortDirection === "desc" ? item("before") : command }], nextCursor: null }));
  const preview = (await reader.listItems("thread", "t", { after: "before" })).items[0];
  assert.ok(preview.aggregatedOutput.length <= 512);
  assert.ok(JSON.stringify(preview).length < 3000);
  assert.equal(preview.status, "inProgress");
  assert.equal(preview.phase, "commentary");
  assert.equal(preview.hasDetails, true);
  assert.equal(preview.truncated, true);
  assert.equal((await reader.getItem("thread", "t", "command")).item.aggregatedOutput, output);
});

test("getItem uses at most two one-item pages, without walking earlier history", async () => {
  const output = "large\n".repeat(2000);
  const { reader, calls } = fixture((method, params) => {
    assert.equal(method, "thread/items/list");
    if (params.sortDirection === "desc") return { data: [{ turnId: "t", item: item("before") }], nextCursor: "even-older" };
    assert.deepEqual(params.cursor, { type: "item", itemId: "before" });
    return { data: [{ turnId: "t", item: { id: "target", type: "commandExecution", aggregatedOutput: output } }], nextCursor: "newer" };
  });
  const detail = await reader.getItem("thread", "t", "target");
  assert.equal(detail.item.aggregatedOutput, output);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].params.cursor, { type: "item", itemId: "target" });
  assert.ok(calls.slice(1).every((value) => value.params.limit === 1));
});

test("first item detail and missing target never return a neighbouring item", async () => {
  const { reader } = fixture((method, params) => ({ data: params.sortDirection === "desc" ? [] : [{ turnId: "t", item: item("first") }], nextCursor: null }));
  assert.equal((await reader.getItem("thread", "t", "first")).item.id, "first");
  await assert.rejects(reader.getItem("thread", "t", "missing"), (error) => error.statusCode === 404);
});

test("limits clamp and malformed/repeated upstream pages fail explicitly", async () => {
  const { reader, calls } = fixture(() => ({ data: [], nextCursor: "repeat" }));
  await reader.listTurns("thread", { limit: 999 });
  assert.equal(calls[1].params.limit, 20);
  await assert.rejects(reader.listTurns("thread", { cursor: "repeat" }), /Repeated/);
  await assert.rejects(reader.listTurns("thread", { limit: -1 }), (error) => error.statusCode === 400);
  const wrong = fixture(() => ({ data: [{ turnId: "other", item: item("i") }], nextCursor: null }));
  await assert.rejects(wrong.reader.listItems("thread", "t"), /different turn/);
});

test("huge process items and excessive summary items have bounded responses", async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `i-${index}`, type: "commandExecution", aggregatedOutput: "x".repeat(100_000) }));
  const { reader } = fixture(() => ({ data: [{ ...turn("t", many), itemsView: "full" }], nextCursor: null }));
  const page = await reader.listTurns("thread");
  assert.equal(page.turns[0].items.length, 12);
  assert.equal(page.turns[0].hasMoreItems, true);
  assert.equal(page.turns[0].itemsTruncated, true);
  assert.ok(JSON.stringify(page).length < 150_000);
  assert.ok(page.turns[0].items.every((value) => value.truncated));
  assert.ok(page.turns[0].items.every((value) => value.aggregatedOutput.length <= 512));
});

test("native subagent lifecycle survives generic process summary limits and retains chronological order", async () => {
  const child = (id, kind, extra = {}) => ({ id, type: "subAgentActivity", kind, agentThreadId: "child", agentPath: "/root/reviewer", ...extra });
  const tools = Array.from({ length: 100 }, (_, index) => ({ id: `tool-${index}`, type: "commandExecution", aggregatedOutput: "output" }));
  const source = [item("user"), ...tools.slice(0, 40), child("native-start", "interacted", { startedAt: "2026-10-16T16:08:33.610Z" }),
    ...tools.slice(40, 80), child("native-end", "completed", { completedAt: "2026-10-16T16:13:08.003Z" }), ...tools.slice(80), item("final")];
  const { reader } = fixture(() => ({ data: [{ ...turn("t", source), itemsView: "full" }], nextCursor: null }));
  const summary = (await reader.listTurns("thread")).turns[0];
  const activities = summary.items.filter((entry) => entry.type === "subAgentActivity");
  assert.deepEqual(activities.map((entry) => entry.id), ["native-start", "native-end"]);
  assert.equal(activities[0].presentation.activity.state, "completed");
  assert.equal(activities[0].presentation.activity.durationMs, 274393);
  assert.equal(activities[1].presentation.activity.startedItemId, "native-start");
  assert.equal(summary.items.filter((entry) => entry.type === "commandExecution").length, 12);
  assert.deepEqual(summary.items.map((entry) => entry.position), summary.items.map((entry) => entry.position).sort((a, b) => a - b));
});

test("item pages expose native child state without parent-turn-clock duration or extra history RPCs", async () => {
  const source = [{ id: "start", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/worker" },
    { id: "end", type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "/root/worker", status: "failed" }];
  const { reader, calls } = fixture(() => ({ data: source.map((entry) => ({ turnId: "t", item: entry })), nextCursor: null }));
  const page = await reader.listItems("thread", "t");
  assert.equal(page.items[0].presentation.activity.state, "failed");
  assert.equal(page.items[0].presentation.activity.durationMs, null);
  assert.equal(page.items[1].presentation.activity.startedItemId, "start");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => ["thread/read", "thread/items/list"].includes(call.method)));
});

test("historical starts cannot appear running again when a terminal summary is followed by item pagination", async () => {
  const source = { id: "old-start", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/worker",
    startedAt: "2026-10-16T16:08:33.610Z" };
  const { reader } = fixture((method) => method === "thread/turns/list"
    ? { data: [turn("t", [source])], nextCursor: null }
    : { data: [{ turnId: "t", item: source }], nextCursor: null });
  const summary = (await reader.listTurns("thread")).turns[0];
  assert.equal(summary.items[0].presentation.activity.state, "unknown");
  const page = await reader.listItems("thread", "t");
  assert.equal(page.items[0].presentation.activity.state, "unknown");
  assert.equal(page.items[0].presentation.activity.event, "started");
  assert.equal(page.items[0].presentation.activity.completedAt, null);
});

test("official item-entry timestamps restore native lifecycle time after a reader restart without rewriting raw items", async () => {
  const source = [{ id: "start", type: "subAgentActivity", kind: "interacted", agentThreadId: "child", agentPath: "/root/reviewer" },
    { id: "end", type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "/root/reviewer" }];
  const original = structuredClone(source);
  const times = [1792166913610, 1792167188003];
  const makeReader = () => fixture((method) => method === "thread/turns/list"
    ? { data: [turn("t", source)], nextCursor: null }
    : { data: source.map((entry, index) => ({ turnId: "t", item: entry, startedAtMs: times[index], completedAtMs: times[index] })), nextCursor: null }).reader;
  for (const reader of [makeReader(), makeReader()]) {
    const initial = (await reader.listTurns("thread")).turns[0];
    assert.equal(initial.items[0].presentation.activity.state, "unknown");
    assert.equal(initial.items[1].presentation.activity.state, "completed");
    const page = await reader.listItems("thread", "t");
    assert.equal(page.items[0].presentation.activity.state, "completed");
    assert.equal(page.items[0].presentation.activity.durationMs, 274393);
    assert.equal(page.items[1].presentation.activity.startedItemId, "start");
    assert.equal(page.items[1].presentation.activity.durationMs, 274393);
    assert.equal(page.items[0].startedAtMs, undefined);
    const refreshed = (await reader.listTurns("thread")).turns[0];
    assert.equal(refreshed.items[0].presentation.activity.durationMs, 274393);
  }
  assert.deepEqual(source, original);
});

test("reading the first native item detail cannot replace its full page or erase completed summary timing", async () => {
  const source = [{ id: "start", type: "subAgentActivity", kind: "interacted", agentThreadId: "child", agentPath: "/root/reviewer" },
    item("between"), { id: "end", type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "/root/reviewer" }];
  const times = [1792166913610, 1792166915000, 1792167188003];
  const wrappers = source.map((entry, index) => ({ turnId: "t", item: entry, startedAtMs: times[index], completedAtMs: times[index] }));
  const { reader } = fixture((method, params) => {
    if (method === "thread/turns/list") return { data: [turn("t", [source[0], source[2]])], nextCursor: null };
    if (params.sortDirection === "desc") return { data: [], nextCursor: null };
    if (params.limit === 1) return { data: [wrappers[0]], nextCursor: "after-start" };
    return { data: wrappers, nextCursor: null };
  });
  await reader.listItems("thread", "t");
  assert.equal((await reader.getItem("thread", "t", "start")).item.presentation.activity.durationMs, 274393);
  const refreshed = (await reader.listTurns("thread")).turns[0];
  assert.equal(refreshed.items[0].presentation.activity.state, "completed");
  assert.equal(refreshed.items[0].presentation.activity.durationMs, 274393);
  assert.equal(refreshed.items[1].presentation.activity.startedItemId, "start");
  assert.equal(refreshed.items[1].presentation.activity.durationMs, 274393);
});

test("native lifecycle pairing follows consecutive official item pages and never bridges sparse summaries or page gaps", async () => {
  const activity = (id, kind) => ({ id, type: "subAgentActivity", kind, agentThreadId: "child", agentPath: "/root/reviewer" });
  const source = [activity("s1", "started"), activity("e1", "completed"), activity("s2", "interacted"), activity("e2", "completed")];
  const wrapper = (index) => ({ turnId: "t", item: source[index], startedAtMs: 1792166913610 + index * 10000, completedAtMs: 1792166913610 + index * 10000 });
  const { reader } = fixture((method, params) => {
    if (method === "thread/turns/list") return { data: [turn("t", [source[0], source[3]])], nextCursor: null };
    if (params.cursor === "page-two") return { data: [wrapper(1), wrapper(2)], nextCursor: "page-three" };
    if (params.cursor === "page-three") return { data: [wrapper(3)], nextCursor: null };
    return { data: [wrapper(0)], nextCursor: "page-two" };
  });
  const sparse = (await reader.listTurns("thread")).turns[0];
  assert.equal(sparse.items[0].presentation.activity.state, "unknown");
  assert.equal(sparse.items[1].presentation.activity.startedItemId, null);
  await reader.listItems("thread", "t", { cursor: "page-three" });
  const gap = (await reader.listTurns("thread")).turns[0];
  assert.equal(gap.items[1].presentation.activity.startedItemId, null);
  await reader.listItems("thread", "t", { cursor: "page-two" });
  const secondRound = (await reader.listTurns("thread")).turns[0];
  assert.equal(secondRound.items[1].presentation.activity.startedItemId, "s2");
  assert.equal(secondRound.items[1].presentation.activity.durationMs, 10000);
  assert.equal(secondRound.items[0].presentation.activity.state, "unknown");
  await reader.listItems("thread", "t");
  const complete = (await reader.listTurns("thread")).turns[0];
  assert.equal(complete.items[0].presentation.activity.state, "completed");
  assert.equal(complete.items[0].presentation.activity.durationMs, 10000);
  assert.equal(complete.items[1].presentation.activity.startedItemId, "s2");
});

test("long-turn summaries retain user, early files, all ordinary primary items and the final reply", async () => {
  const userItem = { id: "user", type: "userMessage", content: [{ type: "text", text: "Fix it" }] };
  const file = { id: "early-file", type: "fileChange", changes: [{ path: "a.js", kind: { type: "update" }, diff: "+fixed" }] };
  const tools = Array.from({ length: 100 }, (_, index) => ({ id: `tool-${index}`, type: "commandExecution", aggregatedOutput: "x".repeat(10_000) }));
  const source = [userItem, file, item("commentary", "same"), { id: "plan", type: "plan", text: "plan" }, ...tools,
    { id: "image", type: "imageView", path: "/tmp/result.png" }, item("final", "same")];
  const { reader, calls } = fixture((method) => method === "thread/turns/list"
    ? { data: [{ ...turn("t", source), itemsView: "full" }], nextCursor: null }
    : { data: [source[1], source[6], source.at(-1)].map((value) => ({ turnId: "t", item: value })), nextCursor: null });
  const summary = (await reader.listTurns("thread")).turns[0];
  assert.deepEqual(summary.items.filter((value) => value.type !== "commandExecution").map((value) => value.id),
    ["user", "early-file", "commentary", "plan", "image", "final"]);
  assert.equal(summary.items.at(-1).presentation.text, "same");
  assert.equal(summary.items.at(-1).position, source.length - 1);
  assert.equal(summary.items.find((value) => value.id === "early-file").presentation.fileChanges[0].diff, "+fixed");
  assert.equal(summary.itemsTruncated, true);
  assert.equal(summary.hasMoreItems, true);
  assert.deepEqual(summary.items.map((value) => value.position), summary.items.map((value) => value.position).sort((a, b) => a - b));
  assert.ok(JSON.stringify(summary).length < 30_000);
  assert.equal(calls.filter((call) => call.method === "thread/turns/list").length, 1);
  const page = await reader.listItems("thread", "t");
  assert.equal(page.items[0].position, 1);
  assert.equal(page.items.at(-1).position, source.length - 1);
});

test("an extreme primary count stays bounded while preserving first user, last reply and file cards", async () => {
  const source = [{ id: "user", type: "userMessage", content: [{ type: "text", text: "Start" }] },
    { id: "first-file", type: "fileChange", changes: [{ path: "a", diff: "+a", kind: "add" }] },
    ...Array.from({ length: 100 }, (_, index) => item(`agent-${index}`)),
    { id: "last-file", type: "fileChange", changes: [{ path: "b", diff: "+b", kind: "add" }] }, item("final", "Done")];
  const { reader } = fixture(() => ({ data: [turn("t", source)], nextCursor: null }));
  const result = (await reader.listTurns("thread")).turns[0];
  assert.equal(result.items.length, 24);
  assert.equal(result.itemsTruncated, true);
  for (const id of ["user", "first-file", "last-file", "final"]) assert.ok(result.items.some((value) => value.id === id));
  assert.equal(result.items.at(-1).id, "final");
  assert.equal(new Set(result.items.map((value) => value.id)).size, result.items.length);
});

test("uncached item pages leave position unknown instead of inventing an order", async () => {
  const { reader } = fixture(() => ({ data: [{ turnId: "t", item: item("a") }], nextCursor: null }));
  assert.equal((await reader.listItems("thread", "t")).items[0].position, undefined);
});

test("summary-local indices are never assigned to official full item pages", async () => {
  const ordered = [item("user"), item("first"), item("steer"), item("final")];
  const { reader } = fixture((method) => method === "thread/turns/list"
    ? { data: [turn("t", [ordered[0], ordered[3]])], nextCursor: null }
    : { data: ordered.map((value) => ({ turnId: "t", item: value })), nextCursor: null });
  assert.ok((await reader.listTurns("thread")).turns[0].items.every((value) => value.position === undefined));
  const page = await reader.listItems("thread", "t");
  assert.deepEqual(page.items.map((value) => value.id), ordered.map((value) => value.id));
  assert.ok(page.items.every((value) => value.position === undefined));
});

test("a sparse summary cannot overwrite positions learned from a complete turn", async () => {
  const ordered = [item("user"), item("first"), item("steer"), item("final")];
  const { reader } = fixture((method) => method === "thread/turns/list"
    ? { data: [turn("t", [ordered[0], ordered[3]])], nextCursor: null }
    : { data: ordered.map((value) => ({ turnId: "t", item: value })), nextCursor: null });
  reader.presentTurn({ ...turn("t", ordered), itemsView: "full" }, "", false, "thread");
  await reader.listTurns("thread");
  assert.deepEqual((await reader.listItems("thread", "t")).items.map((value) => value.position), [0, 1, 2, 3]);
});

test("legacy fallback adapts once at the entry and pages by identity", async () => {
  let legacyReads = 0;
  const bundle = { session: { cwd: "/tmp" }, threadSnapshot: { turns: ["t1", "t2", "t3"].map((id) => ({ id, status: "aborted",
    items: ["one", "two"].map((suffix) => ({ id: `${id}-${suffix}`, kind: "AgentMessage", text: "same", payload: {} })) })) } };
  const sessionManager = { getProvider: () => ({ id: "codex" }), historyService: { getHistoricalMessages: () => { legacyReads++; return bundle; } } };
  const { reader, calls } = fixture(() => { throw new Error("thread history requires paginated mode"); }, { thread: { historyMode: "legacy" }, sessionManager });
  const page = await reader.listTurns("thread", { limit: 2 });
  assert.deepEqual(page.turns.map((value) => value.id), ["t2", "t3"]);
  assert.equal(page.turns[0].status, "interrupted");
  assert.equal(page.turns[0].items[0].type, "agentMessage");
  const earlier = await reader.listTurns("thread", { cursor: page.olderCursor, limit: 2 });
  assert.deepEqual(earlier.turns.map((value) => value.id), ["t1"]);
  const first = await reader.listItems("thread", "t2", { limit: 1 });
  const second = await reader.listItems("thread", "t2", { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.items[0].id, "t2-two");
  assert.equal((await reader.getItem("thread", "t2", "t2-two")).item.text, "same");
  assert.equal(legacyReads, 5);
  assert.equal(calls.filter((value) => value.method === "thread/turns/list").length, 1);
});

test("legacy after reads new items, retains positions and respects cursor priority", async () => {
  const entries = ["one", "two"].map((id) => ({ id, kind: "AgentMessage", text: "same", payload: {} }));
  const bundle = { session: { cwd: "/tmp" }, threadSnapshot: { turns: [{ id: "t", items: entries }] } };
  const reader = new CodexHistoryReader({ sessionManager: { historyService: { getHistoricalMessages: () => bundle } } });
  const first = await reader.listItems("thread", "t", { limit: 1 });
  assert.equal(first.latestItemId, "one");
  const second = await reader.listItems("thread", "t", { cursor: first.nextCursor, after: "two", limit: 1 });
  assert.equal(second.latestItemId, "two");
  assert.equal(second.items[0].id, "two");
  assert.equal(second.items[0].position, 1);
  entries.push({ id: "three", kind: "AgentMessage", text: "new", payload: {} });
  const fresh = await reader.listItems("thread", "t", { after: "two" });
  assert.deepEqual(fresh.items.map((value) => value.id), ["three"]);
  assert.equal(fresh.items[0].position, 2);
  const idle = await reader.listItems("thread", "t", { after: fresh.latestItemId });
  assert.deepEqual(idle.items, []);
  assert.equal(idle.latestItemId, "three");
  await assert.rejects(reader.listItems("thread", "t", { after: "missing" }), (error) => error.statusCode === 409);
  await assert.rejects(reader.listItems("thread", "other", { after: "three" }), (error) => error.statusCode === 404);
});

test("real legacy patch events retain output maps and diffs through the history reader", async () => {
  const changes = {
    "added.txt": { type: "add", unified_diff: "@@ -0,0 +1 @@\n+added" },
    "deleted.txt": { type: "delete", unified_diff: "@@ -1 +0,0 @@\n-deleted" },
    "renamed.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new", move_path: "previous.txt" },
    "modified.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-before\n+after" }
  };
  for (const patchChanges of [changes, { changes }]) {
    const payloads = [
      { type: "task_started", turn_id: "t" }, { type: "user_message", turn_id: "t", message: "Apply the patch" },
      { type: "patch_apply_begin", turn_id: "t", call_id: "patch", changes: patchChanges },
      { type: "patch_apply_end", turn_id: "t", call_id: "patch", changes: patchChanges, status: "completed" },
      { type: "task_complete", turn_id: "t" }
    ];
    const records = payloads.map((payload, index) => createRawRecord({ id: `record-${index}`, threadId: "thread", turnId: "t", seq: index + 1,
      recordTs: "2026-10-16T00:00:00.000Z", raw: { type: "event_msg", payload } }));
    const snapshot = reduceCanonicalEvents(canonicalizeRawRecords(records, createCanonicalizerState()), { threadId: "thread" });
    const original = snapshot.turns[0].items.find((value) => value.kind === "FileChange");
    assert.ok(original);
    assert.equal(original.payload.changes, undefined);
    assert.deepEqual(original.payload.output, patchChanges);
    const sessionManager = { getProvider: () => ({ id: "codex" }), historyService: { getHistoricalMessages: () => ({
      session: { cwd: "/tmp" }, threadSnapshot: snapshot
    }) } };
    const { reader } = fixture(() => { throw new Error("thread history requires paginated mode"); }, { thread: { historyMode: "legacy" }, sessionManager });
    const summary = (await reader.listTurns("thread")).turns[0].items.find((value) => value.id === original.id);
    const page = (await reader.listItems("thread", "t")).items.find((value) => value.id === original.id);
    const detail = (await reader.getItem("thread", "t", original.id)).item;
    for (const presented of [summary, page, detail]) {
      assert.deepEqual(presented.output, patchChanges);
      assert.deepEqual(presented.presentation.fileChanges.map((value) => value.status), ["A", "D", "R", "M"]);
      assert.deepEqual(presented.presentation.fileChanges.map((value) => [value.additions, value.deletions]), [[1, 0], [0, 1], [1, 1], [1, 1]]);
      assert.equal(presented.presentation.fileChanges[2].previousPath, "previous.txt");
      for (const file of presented.presentation.fileChanges) assert.equal(file.diff, changes[file.path].unified_diff);
    }
    assert.deepEqual(original.payload.output, patchChanges);
  }
});

test("RPC failures are not disguised as stale legacy success", async () => {
  let read = false;
  const { reader } = fixture(() => { throw new Error("connection lost"); }, { thread: { historyMode: "legacy" }, sessionManager: {
    historyService: { getHistoricalMessages() { read = true; } }
  } });
  await assert.rejects(reader.listTurns("thread"), /connection lost/);
  assert.equal(read, false);
});

test("large inline images remain available through authenticated media with bounded history DTOs", async () => {
  const bytes = Buffer.alloc(500_000, 7);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  const encoded = bytes.toString("base64");
  const source = { id: "image", type: "imageGeneration", result: encoded, savedPath: null };
  const { reader, calls } = fixture((method, params) => {
    if (method === "thread/turns/list") return { data: [turn("t", [source])], nextCursor: null };
    return { data: params.sortDirection === "desc" ? [] : [{ turnId: "t", item: source }], nextCursor: null };
  });
  for (const response of [await reader.listTurns("thread"), await reader.listItems("thread", "t"), await reader.getItem("thread", "t", "image")]) {
    assert.ok(JSON.stringify(response).length < 3000);
    assert.equal(JSON.stringify(response).includes(encoded.slice(0, 100)), false);
  }
  const image = await reader.getImage("thread", "t", "image", 0);
  assert.equal(image.type, "image/png");
  assert.deepEqual(image.bytes, bytes);
  assert.ok(calls.every((call) => ["thread/read", "thread/turns/list", "thread/items/list"].includes(call.method)));
  assert.equal(source.result, encoded);
});

test("media indexing follows normalized unique images and does not fetch paths or remote URLs", async () => {
  const bytes = Buffer.from("GIF89a1234567890", "ascii");
  const inline = `data:image/gif;base64,${bytes.toString("base64")}`;
  const source = { id: "u", type: "userMessage", content: [
    { type: "localImage", path: "/tmp/a.png" }, { type: "localImage", path: "/tmp/./a.png" },
    { type: "image", url: inline }, { type: "image", url: inline }, { type: "image", url: "https://example.com/a.png" }
  ] };
  const { reader } = fixture((method, params) => ({ data: params.sortDirection === "desc" ? [] : [{ turnId: "t", item: source }], nextCursor: null }));
  const page = await reader.listItems("thread", "t");
  assert.equal(page.items[0].presentation.images.length, 3);
  assert.equal(page.items[0].presentation.images[1].url, "/api/v2/codex/threads/thread/turns/t/items/u/images/1");
  assert.deepEqual((await reader.getImage("thread", "t", "u", "1")).bytes, bytes);
  await assert.rejects(reader.getImage("thread", "t", "u", 0), (error) => error.statusCode === 404);
  await assert.rejects(reader.getImage("thread", "t", "u", 2), (error) => error.statusCode === 404);
  await assert.rejects(reader.getImage("thread", "t", "u", -1), (error) => error.statusCode === 400);
});

test("inline media rejects unsupported types, mismatched signatures and images above 20 MiB", async () => {
  let url = "data:image/svg+xml;base64,PHN2Zz4=";
  const { reader } = fixture((method, params) => ({ data: params.sortDirection === "desc" ? [] : [{ turnId: "t", item: {
    id: "u", type: "userMessage", content: [{ type: "image", url }]
  } }], nextCursor: null }));
  await assert.rejects(reader.getImage("thread", "t", "u", 0), (error) => error.statusCode === 404);
  url = "data:image/png;base64,PHN2Zz4=";
  await assert.rejects(reader.getImage("thread", "t", "u", 0), (error) => error.statusCode === 415);
  url = `data:image/png;base64,${"a".repeat(28_000_000)}`;
  await assert.rejects(reader.getImage("thread", "t", "u", 0), (error) => error.statusCode === 413);
});

test("raw JPEG generation base64 is not misclassified as an absolute path", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  const source = { id: "jpeg", type: "imageGeneration", result: bytes.toString("base64"), savedPath: null };
  const { reader } = fixture((method, params) => ({ data: params.sortDirection === "desc" ? [] : [{ turnId: "t", item: source }], nextCursor: null }));
  const image = await reader.getImage("thread", "t", "jpeg", 0);
  assert.equal(image.type, "image/jpeg");
  assert.deepEqual(image.bytes, bytes);
  assert.equal((await reader.listItems("thread", "t")).items[0].presentation.images[0].url,
    "/api/v2/codex/threads/thread/turns/t/items/jpeg/images/0");
});
