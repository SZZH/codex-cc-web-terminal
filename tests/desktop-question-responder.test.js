import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";

const body = { clientRequestId: "answer-request-1", expectedTurnId: "turn-1", index: 0, answer: "茶" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-question-"));
  const sends = [], starts = [], rpc = [];
  const owner = { clientId: "desktop-owner", supportsUntrustedAppInput: true };
  const bridge = new EventEmitter();
  bridge.request = async (...args) => { rpc.push(args); throw new Error("Must not use independent app-server writes"); };
  const reader = {
    getThread: async (id) => ({ id }),
    rawItem: async () => ({ item: { type: "agentMessage", id: "call_question", delivery: "async", questions: [{ title: "你今天更想喝什么？", options: ["茶", "水"] }] } }),
    listTurns: async () => ({ turns: [{ id: "turn-1", status: "inProgress", items: [] }] }),
    listItems: async () => ({ items: [] }), ...options.reader
  };
  const desktopClient = { discover: async () => owner, shutdown() {},
    startQuestion: async (...args) => { starts.push(args); return { turnId: "new-turn" }; },
    steer: async (...args) => { sends.push(args); return options.steer ? options.steer(...args) : { turnId: "turn-1" }; }, ...options.client };
  const service = new CodexThreadService({ config: { dataDir }, bridge, reader, desktopClient,
    sessionManager: {}, recoveryMs: 60_000 });
  t.after(() => { service.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, sends, starts, rpc, reader, owner, desktopClient, dataDir,
    respond: (patch = {}, callId = "call_question") => service.desktopQuestions.respond("thread-1", callId, { ...body, ...patch }) };
}

test("desktop replies use authoritative question text, immediate owner delivery and durable receipt", async (t) => {
  const f = fixture(t);
  const received = await f.respond();
  assert.equal(received.executionRoute, "desktopQuestion");
  await tick();
  const receipt = f.service.requests.get("thread-1", body.clientRequestId);
  assert.equal(receipt.state, "accepted");
  assert.equal(receipt.turnId, "turn-1");
  assert.equal(f.rpc.length, 0);
  assert.equal(f.sends.length, 1);
  const [threadId, params] = f.sends[0];
  assert.equal(threadId, "thread-1");
  assert.equal(params.clientUserMessageId, body.clientRequestId);
  assert.equal(params.owner, f.owner);
  assert.equal(params.input[0].text, '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","question":"你今天更想喝什么？","answer":"茶"}]\n</send_user_message_question_reply>');
  assert.equal(f.service.active.has("thread-1"), false, "answering never claims desktop turn ownership");
});

test("concurrent same-ID retries send once and a different answer or ID cannot duplicate a question", async (t) => {
  const f = fixture(t);
  await Promise.all([f.respond(), f.respond(), f.respond()]);
  await tick();
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.respond({ answer: "水" }), { code: "question_answer_conflict" });
  await assert.rejects(f.respond({ clientRequestId: "answer-request-2" }), { code: "question_answer_conflict" });
  assert.equal(f.sends.length, 1);
});

test("invalid, expired, non-question, previously answered or unavailable targets never send", async (t) => {
  for (const patch of [{ answer: " " }, { index: 42 }, { input: "injected" }, { expectedTurnId: "" }]) {
    const f = fixture(t);
    await assert.rejects(f.respond(patch), { code: "invalid_question_answer" });
    assert.equal(f.sends.length, 0);
  }
  for (const options of [
    { reader: { listTurns: async () => ({ turns: [{ id: "turn-1", status: "unknown" }] }) } },
    { reader: { rawItem: async () => ({ item: { id: "call_question", type: "agentMessage", text: "ordinary prose" } }) } },
    { client: { discover: async () => null } },
    { client: { discover: async () => ({ clientId: "owner", supportsUntrustedAppInput: false }) } },
    { reader: { listItems: async () => ({ items: [{ type: "userMessage", text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","answer":"水"}]\n</send_user_message_question_reply>' }] }) } }
  ]) {
    const f = fixture(t, options);
    await assert.rejects(f.respond());
    assert.equal(f.sends.length, 0);
    assert.equal(f.service.requests.list("thread-1").length, 0);
  }
});

test("unknown delivery stays locked across retries and reconciles by exact official client identity", async (t) => {
  const f = fixture(t, { steer: async () => { throw Object.assign(new Error("connection lost"), { uncertain: true }); } });
  await f.respond(); await tick();
  assert.equal(f.service.requests.get("thread-1", body.clientRequestId).state, "unknown");
  await f.respond();
  assert.equal(f.sends.length, 1);
  f.service.reconcileItems("thread-1", "turn-1", [{ id: "official-answer", type: "userMessage", clientId: body.clientRequestId }]);
  assert.equal(f.service.requests.get("thread-1", body.clientRequestId).state, "running");
});

test("desktop answers older than the latest page still prevent duplicate submission", async (t) => {
  const calls = [];
  const f = fixture(t, { reader: { listItems: async (threadId, turnId, options) => {
    calls.push(options);
    return options.cursor ? { items: [{ type: "userMessage", text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","answer":"水"}]\n</send_user_message_question_reply>' }], hasMore: false }
      : { items: [], hasMore: true, nextCursor: "answer-page" };
  } } });
  await assert.rejects(f.respond(), { code: "question_already_answered" });
  assert.equal(calls[0].after, "call_question");
  assert.equal(calls[1].cursor, "answer-page");
  assert.equal(f.sends.length, 0);
});

test("incomplete question history never silently allows a duplicate answer", async (t) => {
  const f = fixture(t, { reader: { listItems: async () => ({ items: [], hasMore: true, nextCursor: "repeat" }) } });
  await assert.rejects(f.respond(), { code: "question_history_incomplete" });
  assert.equal(f.sends.length, 0);
});

test("truncated answer previews are checked against complete native history", async (t) => {
  const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: '["request_user_input_async","call_question",0]',
    question: "你今天更想喝什么？", answer: '"'.repeat(9_000) }])}\n</send_user_message_question_reply>`;
  const raw = { id: "old-answer", type: "userMessage", content: [{ type: "text", text }] };
  const preview = presentCodexItem(raw);
  assert.equal(preview.truncated, true);
  const f = fixture(t, { reader: { listItems: async () => ({ items: [preview], hasMore: false }) } });
  const read = f.reader.rawItem;
  f.reader.rawItem = async (threadId, turnId, itemId, options) => itemId === "old-answer" ? { item: raw } : read(threadId, turnId, itemId, options);
  await assert.rejects(f.respond(), { code: "question_already_answered" });
  assert.equal(f.sends.length, 0);
});

test("an accepted desktop question does not block subsequent ordinary messages from entering desktop queue", async (t) => {
  const f = fixture(t);
  f.reader.getThread = async (id) => ({ id, status: { type: "active" } });
  await f.respond(); await tick();
  const queued = [];
  f.service.queuedWriter.enqueue = async (...args) => { queued.push(args); return { id: "native-queue-id" }; };
  f.service.submit("thread-1", { clientRequestId: "ordinary-message", mode: "queue", input: { text: "a follow-up" } });
  await tick(); await tick();
  assert.equal(queued.length, 1);
  assert.equal(f.service.requests.get("thread-1", "ordinary-message").state, "queued");
});

test("definite rejection allows an explicit new attempt while preserving the failed answer", async (t) => {
  let attempt = 0;
  const f = fixture(t, { steer: async () => { if (!attempt++) throw new Error("no owner"); return { turnId: "turn-1" }; } });
  await f.respond(); await tick();
  assert.equal(f.service.requests.get("thread-1", body.clientRequestId).state, "rejected");
  await f.respond({ clientRequestId: "answer-request-2" }); await tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.service.requests.get("thread-1", "answer-request-2").state, "accepted");
});

test("desktop owner turn changes are reported using the returned actual turn, without claiming old-turn success", async (t) => {
  const f = fixture(t, { steer: async () => ({ turnId: "turn-2" }) });
  await f.respond(); await tick();
  const receipt = f.service.requests.get("thread-1", body.clientRequestId);
  assert.equal(receipt.expectedTurnId, "turn-1");
  assert.equal(receipt.turnId, "turn-2");
});

test("an unanswered question in a completed turn starts a native continuation instead of entering the queue", async (t) => {
  const f = fixture(t, { reader: { listTurns: async () => ({ turns: [{ id: "turn-1", status: "completed" }], hasMore: false }) } });
  await f.respond(); await tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.starts.length, 1);
  assert.equal(f.rpc.length, 0);
  const receipt = f.service.requests.get("thread-1", body.clientRequestId);
  assert.equal(receipt.state, "accepted");
  assert.equal(receipt.turnId, "new-turn");
});

test("a question answered in a later turn is not re-submitted from an old card", async (t) => {
  const f = fixture(t, { reader: {
    listTurns: async () => ({ turns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "completed" }], hasMore: false }),
    listItems: async (_, turnId) => ({ items: turnId === "turn-2" ? [{ type: "userMessage", text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","answer":"水"}]\n</send_user_message_question_reply>' }] : [], hasMore: false })
  } });
  await assert.rejects(f.respond(), { code: "question_already_answered" });
  assert.equal(f.sends.length + f.starts.length, 0);
});

test("a new turn appearing after the answer-history check invalidates the scanned range", async (t) => {
  let reads = 0;
  const f = fixture(t, { reader: { listTurns: async () => ({ turns: [{ id: ++reads === 1 ? "turn-1" : "answered-later", status: "completed" }], hasMore: false }) } });
  await assert.rejects(f.respond(), { code: "question_history_changed" });
  assert.equal(f.sends.length + f.starts.length, 0);
});

test("metadata capability depends on verified desktop support and discovery failure does not break history", async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.getThread("thread-1")).capabilities.desktopQuestionAnswers, true);
  f.desktopClient.discover = async () => { throw new Error("desktop closed"); };
  const thread = await f.service.getThread("thread-1");
  assert.equal(thread.id, "thread-1");
  assert.equal(thread.capabilities.desktopQuestionAnswers, false);
});

test("an interrupted pre-dispatch journal cannot leak into normal turn/steer on service recovery", async (t) => {
  const f = fixture(t);
  f.service.requests.receive("thread-1", { clientRequestId: body.clientRequestId, input: { text: "answer", attachments: [] },
    mode: "steer", expectedTurnId: "turn-1", questionReply: { callId: "call_question", index: 0, answer: "茶", expectedTurnId: "turn-1" } });
  await f.service.dispatchSteer("thread-1", body.clientRequestId);
  assert.equal(f.service.requests.get("thread-1", body.clientRequestId).state, "rejected");
  assert.equal(f.rpc.length, 0);
  assert.equal(f.sends.length, 0);
});
