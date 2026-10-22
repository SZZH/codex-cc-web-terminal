import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createAppServerHistoryPayloadResolver } from "../src/sessions/history/appServerHistory.js";
import { handleHistoryRoute } from "../src/routes/history.js";
import { createThreadSnapshot, createTurn, createThreadItem, deriveConversationStateFromThreadSnapshot } from "../src/threads/index.js";
import { createThreadRuntimeController } from "../web/src/lib/thread-runtime.js";

function fixture(t, { mode = "paginated", rolloutExists = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-paginated-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.sqlite");
  const rolloutPath = path.join(root, "rollout.jsonl");
  if (rolloutExists) fs.writeFileSync(rolloutPath, "{}\n");
  execFileSync("sqlite3", [dbPath, `create table threads (id text primary key, history_mode text, rollout_path text, title text,
    cwd text, updated_at integer, updated_at_ms integer, created_at integer, archived integer);
    insert into threads values ('a','${mode}','${rolloutPath}','DB title','${root}',100,100000,50,0);
    insert into threads values ('b','paginated','${rolloutPath}','B title','${root}',100,100000,50,0);`]);
  const calls = [];
  const manager = {
    config: { codexStateDbPath: dbPath }, sessions: new Map(),
    appServerBridge: {
      async ensureReady() { calls.push({ method: "ensureReady" }); },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/read") return { thread: { id: params.threadId, historyMode: "paginated", cwd: root,
          name: `Thread ${params.threadId}`, createdAt: 50, updatedAt: 100, status: { type: "idle" }, turns: [] } };
        if (method === "thread/turns/list") return { data: [turn(`${params.threadId}-1`)], nextCursor: null };
        assert.fail(`unexpected mutating request ${method}`);
      }
    },
    getHistoricalMessages() { throw new Error("local rollout is missing"); },
    getThreadSnapshotBundle() { return {}; },
    getThreadContinuationRuntime() { return null; }
  };
  return { manager, calls, dbPath, root };
}

function turn(id, items = null, status = "completed") {
  return { id, status, startedAt: 60, completedAt: 65, items: items || [
    { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: `question ${id}` }] },
    { id: `${id}-assistant`, type: "agentMessage", text: `answer ${id}`, phase: "final_answer" }
  ] };
}

async function payload(manager, id = "a") {
  const resolver = await createAppServerHistoryPayloadResolver(manager, "codex", id);
  return resolver.getThreadMessagesPayload("codex", id);
}

test("paginated history follows every cursor in ascending full-item pages", async (t) => {
  const { manager, calls } = fixture(t);
  const original = manager.appServerBridge.request;
  manager.appServerBridge.request = async (method, params) => {
    if (method === "thread/read") return original(method, params);
    calls.push({ method, params });
    if (!params.cursor) return { data: Array.from({ length: 50 }, (_, index) => turn(`turn-${index}`)), nextCursor: "page-2" };
    assert.equal(params.cursor, "page-2");
    return { data: [turn("turn-50"), turn("turn-51")], nextCursor: null, backwardsCursor: "ignored" };
  };
  const result = await payload(manager);
  assert.equal(result.turns.length, 52);
  assert.deepEqual(result.turns.map((value) => value.id), Array.from({ length: 52 }, (_, index) => `turn-${index}`));
  assert.equal(result.threadSnapshot.threadId, "a");
  assert.equal(result.turns[0].user.text, "question turn-0");
  assert.equal(result.turns[51].assistant.body[0].text, "answer turn-51");
  const pages = calls.filter((call) => call.method === "thread/turns/list");
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].params, { threadId: "a", limit: 50, itemsView: "full", sortDirection: "asc" });
  assert.deepEqual(calls.find((call) => call.method === "thread/read").params, { threadId: "a", includeTurns: false });
});

test("typed user images, generated images and process items survive canonical projection", async (t) => {
  const { manager } = fixture(t);
  const original = manager.appServerBridge.request;
  manager.appServerBridge.request = async (method, params) => method === "thread/read" ? original(method, params) : { data: [turn("images", [
    { id: "user-images", type: "userMessage", content: [{ type: "text", text: "inspect images" }, { type: "image", url: "https://example.com/image.png" }, { type: "localImage", path: "/tmp/image.png" }] },
    { id: "reason", type: "reasoning", summary: ["reason summary"], content: ["reason detail"] },
    { id: "command", type: "commandExecution", command: "ls", aggregatedOutput: "files", cwd: "/tmp", status: "completed", exitCode: 0 },
    { id: "mcp", type: "mcpToolCall", server: "docs", tool: "read", arguments: {}, result: { content: ["docs result"] }, status: "completed" },
    { id: "generated", type: "imageGeneration", result: "aGVsbG8=", status: "completed" },
    { id: "viewed", type: "imageView", path: "/tmp/result.png" },
    { id: "answer", type: "agentMessage", text: "done" }
  ])], nextCursor: null };
  const result = await payload(manager);
  const projected = result.turns[0];
  assert.equal(projected.user.text, "inspect images");
  assert.deepEqual(projected.user.content.filter((part) => part.type === "input_image").map((part) => part.image_url), ["https://example.com/image.png", "/tmp/image.png"]);
  assert.deepEqual(projected.assistant.body.filter((part) => part.kind === "image").map((part) => part.payload.url), ["data:image/png;base64,aGVsbG8=", "/tmp/result.png"]);
  assert.ok(projected.assistant.process.some((part) => part.summary === "ls" && part.content === "files"));
  assert.ok(projected.assistant.process.some((part) => part.content.includes("reason detail")));
  assert.ok(projected.assistant.process.some((part) => part.content.includes("docs result")));
  assert.equal(result.threadSnapshot.turns[0].items.find((item) => item.id === "command").kind, "CommandExecution");
});

test("same-thread continuation merges into paginated history without dropping earlier turns", async (t) => {
  const { manager } = fixture(t);
  const snapshot = createThreadSnapshot({ threadId: "a", activeTurnId: "a-2", turns: [createTurn({ id: "a-2", items: [
    createThreadItem({ id: "live-user", kind: "UserMessage", text: "next question" }),
    createThreadItem({ id: "live-answer", kind: "AgentMessage", text: "live answer" })
  ] })] });
  const conversation = deriveConversationStateFromThreadSnapshot(snapshot, { threadId: "a", sessionId: "live-a" });
  manager.getThreadContinuationRuntime = () => ({ session: { id: "live-a", provider: "codex", resumeSessionId: "a" }, threadSnapshot: snapshot, conversation });
  const result = await payload(manager);
  assert.deepEqual(result.turns.map((value) => value.id), ["a-1", "a-2"]);
  assert.equal(result.turns[1].assistant.body[0].text, "live answer");
  assert.equal(result.continuation.session.id, "live-a");
});

test("legacy rollout files retain the synchronous reader and never call RPC", async (t) => {
  const { manager, calls } = fixture(t, { mode: "legacy", rolloutExists: true });
  const legacy = { session: { id: "history:codex:a" }, messages: [{ role: "user", text: "legacy" }], turns: [] };
  manager.getHistoricalMessages = () => legacy;
  const result = await payload(manager);
  assert.equal(result.messages[0].text, "legacy");
  assert.deepEqual(calls, []);
});

test("missing legacy rollout uses read-only app-server history", async (t) => {
  const { manager, calls } = fixture(t, { mode: "legacy" });
  assert.equal((await payload(manager)).turns.length, 1);
  assert.ok(calls.some((call) => call.method === "thread/turns/list"));
  assert.equal(calls.some((call) => /resume|start/.test(call.method)), false);
});

test("paginated mode uses RPC even when a rollout file remains on disk", async (t) => {
  const { manager, calls } = fixture(t, { rolloutExists: true });
  manager.getHistoricalMessages = () => assert.fail("paginated history must not read a stale rollout");
  assert.equal((await payload(manager)).turns[0].id, "a-1");
  assert.ok(calls.some((call) => call.method === "thread/read"));
});

test("read errors are explicit and do not poison a later successful retry", async (t) => {
  const { manager, calls } = fixture(t);
  const original = manager.appServerBridge.request;
  let fail = true;
  manager.appServerBridge.request = async (method, params) => {
    if (method === "thread/turns/list" && fail) throw new Error("page unavailable");
    return original(method, params);
  };
  await assert.rejects(payload(manager), /page unavailable/);
  fail = false;
  assert.equal((await payload(manager)).turns.length, 1);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 2);
});

test("malformed partial pages and cursor loops fail instead of returning empty history", async (t) => {
  for (const page of [{ data: null }, { data: [{ ...turn("partial"), itemsView: "summary" }], nextCursor: null }, { data: [], nextCursor: "same" }]) {
    const { manager } = fixture(t);
    const original = manager.appServerBridge.request;
    manager.appServerBridge.request = async (method, params) => method === "thread/read" ? original(method, params) : page;
    await assert.rejects(payload(manager), /Invalid history page|Incomplete history turn|Repeated history cursor/);
  }
});

test("cache reuses idle history but invalidates on database updates and running continuations", async (t) => {
  const { manager, calls, dbPath } = fixture(t);
  await payload(manager); await payload(manager);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 1);
  execFileSync("sqlite3", [dbPath, "update threads set updated_at_ms=100001 where id='a'"]);
  await payload(manager);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 2);
  manager.sessions.set("live", { resumeSessionId: "a", turnRunning: true });
  await payload(manager); await payload(manager);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 4);
});

test("active app-server turns never freeze in the idle cache", async (t) => {
  const { manager, calls } = fixture(t);
  const original = manager.appServerBridge.request;
  manager.appServerBridge.request = async (method, params) => method === "thread/read" ? original(method, params) : { data: [turn("running", null, "inProgress")], nextCursor: null };
  await payload(manager); await payload(manager);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 2);
});

test("same-turn item growth is accepted by frontend snapshot guards with an unchanged turn-count version", async (t) => {
  const { manager } = fixture(t);
  const original = manager.appServerBridge.request;
  let text = "partial";
  manager.appServerBridge.request = async (method, params) => method === "thread/read" ? original(method, params) : {
    data: [turn("same-turn", [{ id: "answer", type: "agentMessage", text }], "inProgress")], nextCursor: null
  };
  const before = await payload(manager);
  text = "partial plus the next streamed text";
  const after = await payload(manager);
  assert.equal(before.threadSnapshot.version, after.threadSnapshot.version);
  const state = { liveView: { conversation: before.conversation }, threadView: { threadId: "a", persistedSnapshot: before.threadSnapshot } };
  const frontend = createThreadRuntimeController({ state });
  assert.equal(frontend.shouldApplyIncomingConversation(after.conversation), true);
  frontend.setThreadSnapshot(after.threadSnapshot);
  assert.equal(state.threadView.persistedSnapshot.turns[0].items[0].text, text);
});

test("paginated user wrappers and assistant directives use the existing canonical text rules", async (t) => {
  const { manager } = fixture(t);
  const original = manager.appServerBridge.request;
  manager.appServerBridge.request = async (method, params) => method === "thread/read" ? original(method, params) : {
    data: [turn("canonical", [
      { id: "wrapped-user", type: "userMessage", content: [{ type: "text", text: "# In app browser (IAB):\nCurrent URL: local\n\n## My request for Codex:\n执行" }] },
      { id: "answer", type: "agentMessage", text: 'Done\n::git-commit{message="internal directive"}' }
    ])], nextCursor: null
  };
  const result = await payload(manager);
  assert.equal(result.turns[0].user.text, "执行");
  assert.equal(result.turns[0].assistant.body[0].text, "Done");
});

test("concurrent requests merge only identical thread metadata signatures", async (t) => {
  const { manager, dbPath, calls } = fixture(t);
  const original = manager.appServerBridge.request;
  let unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  manager.appServerBridge.request = async (method, params) => {
    if (method === "thread/read") { const result = await original(method, params); await barrier; return result; }
    return original(method, params);
  };
  const first = payload(manager, "a");
  const same = payload(manager, "a");
  const other = payload(manager, "b");
  execFileSync("sqlite3", [dbPath, "update threads set updated_at_ms=100002 where id='a'"]);
  const changed = payload(manager, "a");
  unblock();
  const results = await Promise.all([first, same, other, changed]);
  assert.deepEqual(results.map((value) => value.threadSnapshot.threadId), ["a", "a", "b", "a"]);
  assert.equal(calls.filter((call) => call.method === "thread/read" && call.params.threadId === "a").length, 2);
  assert.equal(calls.filter((call) => call.method === "thread/read" && call.params.threadId === "b").length, 1);
});

test("history HTTP route awaits paginated payload and propagates read failure", async (t) => {
  const { manager } = fixture(t);
  const runtime = { sessionManager: manager, requireAuthorized: () => true, json: (ctx, status, body) => { ctx.status = status; ctx.body = body; } };
  const ctx = { path: "/api/history-messages", method: "GET", url: "/api/history-messages?provider=codex&resumeSessionId=a" };
  assert.equal(await handleHistoryRoute(ctx, runtime), true);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.turns[0].id, "a-1");
  manager.appServerBridge.request = async () => { throw new Error("read failure"); };
  const failed = { path: "/api/threads/codex/b/conversation", method: "GET", url: "/api/threads/codex/b/conversation" };
  await handleHistoryRoute(failed, runtime);
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error, "read failure");
});
