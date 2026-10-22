import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRenderer, h, nextTick } from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { activityDuration, formatActivityDuration } from "../web/src/lib/activity-time.js";
import { presentCodexChatItem } from "../web/src/lib/codex-chat-presentation.js";
import { buildThreadViewModel } from "../web/src/lib/thread-view-model.js";
import { normalizeThreadItem, summarizeProcessItems } from "../web/src/lib/thread-item-renderers.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

const start = "2026-10-17T00:00:00Z";
const activity = (overrides = {}) => ({ event: "started", state: "running", agentThreadId: "child", agentPath: "/root/check_files",
  label: "check_files", startedAt: start, completedAt: null, durationMs: null, startedItemId: "begin", ...overrides });
const item = (id, details) => presentCodexChatItem({ id, type: "subAgentActivity", kind: "interacted", presentation: { activity: details } });

test("elapsed time uses lifecycle timestamps, freezes at completion, and never guesses missing timing", () => {
  assert.equal(activityDuration(activity(), Date.parse(start) + 125000), 125000);
  assert.equal(formatActivityDuration(274393), "4分34秒");
  assert.equal(formatActivityDuration(3661000), "1小时1分1秒");
  assert.equal(activityDuration(activity({ state: "completed", durationMs: 0 })), 0);
  assert.equal(activityDuration(activity({ state: "completed", completedAt: "2026-10-17T00:04:34.393Z" })), 274393);
  assert.equal(activityDuration(activity({ state: "unknown" })), null);
  assert.equal(activityDuration(activity({ startedAt: null })), null);
  assert.equal(activityDuration(activity({ state: "completed", completedAt: "2026-10-16T23:59:59Z" })), null);
  assert.equal(formatActivityDuration(null), "");
});

test("native child activity remains independently visible and only matching completion rows are suppressed", () => {
  const native = { id: "begin", type: "subAgentActivity", kind: "interacted", presentation: { activity: activity() } };
  assert.equal(normalizeThreadItem(native).kind, "subagentactivity");
  assert.equal(normalizeThreadItem(native).category, "activity");
  const complete = activity({ state: "completed", durationMs: 274393, completedAt: "2026-10-17T00:04:34.393Z" });
  const items = [{ id: "command", kind: "CommandExecution", text: "output" }, item("begin", complete),
    { id: "answer", kind: "AgentMessage", text: "done" }, item("end", { ...complete, event: "completed" }),
    item("unpaired", activity({ event: "completed", state: "completed", startedItemId: "not-loaded", startedAt: null }))];
  const model = buildThreadViewModel({ turns: [{ id: "turn", status: "completed", items }] });
  assert.deepEqual(model.turns[0].segments.map((segment) => segment.kind), ["process", "activity", "primary", "activity"]);
  assert.deepEqual(model.turns[0].segments.flatMap((segment) => segment.items.map((entry) => entry.id)), ["command", "begin", "answer", "unpaired"]);
  assert.equal(model.turns[0].segments[1].items[0].activity.durationMs, 274393);
});

test("compact tool summaries identify file reads and all commands without opening their output", () => {
  const commands = [
    { id: "read-1", kind: "CommandExecution", payload: { commandActions: [{ type: "read", path: "/work/file.js" }] } },
    { id: "read-2", kind: "CommandExecution", payload: { commandActions: [{ type: "read", path: "/work/file.js" }] } },
    { id: "run", kind: "CommandExecution", text: "test result" },
    { id: "tool", kind: "McpToolCall", status: "inProgress", text: "result" }
  ].map((entry) => normalizeThreadItem(entry));
  const summary = summarizeProcessItems(commands);
  assert.equal(summary.compactLabel, "读取了 1 个文件 · 运行了 1 条命令 · 调用了 1 个工具");
  assert.equal(summary.running, true);
  const model = buildThreadViewModel({ turns: [{ id: "turn", status: "inProgress", items: commands.map((entry) => entry.raw) }] });
  assert.equal(model.turns[0].segments[0].defaultCollapsed, true);
});

test("a separately arriving completion updates the original activity row before deduplication", () => {
  const store = createCodexChatStore({ threadId: "thread" });
  store.upsertItem("turn", { id: "begin", type: "subAgentActivity", presentation: { activity: activity() } });
  store.upsertItem("turn", { id: "end", type: "subAgentActivity", presentation: { activity: activity({ event: "completed", state: "completed", durationMs: 274393 }) } });
  const model = buildThreadViewModel(presentCodexChatSnapshot(store.state));
  const entries = model.turns[0].segments.flatMap((segment) => segment.items);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "begin");
  assert.equal(entries[0].activity.state, "completed");
  assert.equal(entries[0].activity.durationMs, 274393);
  assert.equal(store.state.turns.turn.items.begin.presentation.activity.state, "running");
  store.upsertItem("turn", { id: "begin", type: "subAgentActivity", presentation: { activity: activity({ state: "completed", durationMs: 274393, completedAt: "2026-10-17T00:04:34.393Z" }) } });
  store.upsertItem("turn", { id: "end", type: "subAgentActivity", presentation: { activity: activity({ event: "completed", state: "completed", startedAt: null }) } });
  const updated = buildThreadViewModel(presentCodexChatSnapshot(store.state)).turns[0].segments[0].items[0];
  assert.equal(updated.activity.durationMs, 274393);
  assert.equal(updated.activity.completedAt, "2026-10-17T00:04:34.393Z");
});

test("process identity stays anchored to its items when older segments are inserted during hydration", () => {
  const a = { id: "command-a", kind: "CommandExecution", text: "output A" };
  const b = { id: "command-b", kind: "CommandExecution", text: "output B" };
  const before = buildThreadViewModel({ turns: [{ id: "turn", items: [b] }] });
  const after = buildThreadViewModel({ turns: [{ id: "turn", items: [a, { id: "progress", kind: "AgentMessage", text: "progress" }, b] }] });
  assert.equal(before.turns[0].segments[0].id, after.turns[0].segments[2].id);
  assert.notEqual(before.turns[0].segments[0].id, after.turns[0].segments[0].id);
});

test("file summaries count changed paths instead of file-change events", () => {
  const entries = [normalizeThreadItem({ id: "files", kind: "FileChange", payload: { changes: { "a.js": {}, "b.js": {}, "c.js": {} } } })];
  assert.equal(summarizeProcessItems(entries).compactLabel, "修改了 3 个文件");
});

test("history tools without an explicit execution status do not appear to run forever", () => {
  const search = normalizeThreadItem(presentCodexChatItem({ id: "search", type: "webSearch", query: "query", presentation: { text: "query" } }));
  assert.equal(search.status, "");
  assert.equal(search.statusLabel, "");
  assert.equal(summarizeProcessItems([search]).running, false);
  const live = normalizeThreadItem(presentCodexChatItem({ id: "live", type: "commandExecution", status: "inProgress", presentation: { text: "running" } }));
  assert.equal(live.statusLabel, "执行中");
  assert.equal(summarizeProcessItems([live]).running, true);
});

function renderer() {
  return createRenderer({ createElement: (type) => ({ type, props: {}, children: [] }), createText: (text) => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent, nextSibling: () => null,
    insert: (node, parent) => { node.parent = parent; parent.children.push(node); }, remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, before, after) => { node.props[key] = after; } });
}
const elements = (root, match) => [...(match(root) ? [root] : []), ...(root.children || []).flatMap((node) => elements(node, match))];
async function component() {
  const file = new URL("../web/src/components/thread-item/ThreadSubagentActivity.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: "subagent-activity-test", inlineTemplate: true }).content.replace(/from\s+["']([^"']+)["']/g,
    (_, name) => `from ${JSON.stringify(name === "vue" ? import.meta.resolve("vue") : new URL(name, file).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

test("a mounted child activity ticks locally, freezes on completion, and releases its timer on unmount", async () => {
  const originalNow = Date.now, originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let clock = Date.parse(start), next = 0;
  const timers = new Map();
  Date.now = () => clock;
  globalThis.setInterval = (callback) => { timers.set(++next, callback); return next; };
  globalThis.clearInterval = (id) => timers.delete(id);
  const { render } = renderer(), root = { children: [] };
  try {
    const Activity = await component();
    render(h(Activity, { item: { activity: activity() } }), root); await nextTick();
    assert.equal(timers.size, 1);
    clock += 125000; [...timers.values()][0](); await nextTick();
    assert.equal(elements(root, (node) => node.props?.class === "subagent-activity-duration")[0].text, "2分5秒");
    assert.equal(elements(root, (node) => node.type === "a")[0].props.href, "#/chat/history:codex:child");
    render(h(Activity, { item: { activity: activity({ state: "completed", durationMs: 274393 }) } }), root); await nextTick();
    assert.equal(timers.size, 0);
    assert.equal(elements(root, (node) => node.props?.class === "subagent-activity-duration")[0].text, "4分34秒");
    render(h(Activity, { item: { activity: activity({ startedAt: null }) } }), root); await nextTick();
    assert.equal(timers.size, 0);
    assert.equal(elements(root, (node) => node.props?.class === "subagent-activity-duration").length, 0);
    render(h(Activity, { item: { activity: activity() } }), root); await nextTick();
    assert.equal(timers.size, 1);
    render(null, root); assert.equal(timers.size, 0);
  } finally { render(null, root); Date.now = originalNow; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});
