import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestionAnswer, parseQuestionReplies, questionReplyText } from "../web/src/lib/codex-question-history.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { presentCodexChatSnapshot, presentCodexQueue } from "../web/src/lib/codex-chat-presentation.js";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";
import { pendingDesktopQuestions } from "../web/src/lib/codex-question-dock.js";

const question = { source: "desktop", delivery: "async", callId: "call_question",
  questions: [{ id: "0", title: "Which stage?", options: ["Planning", "Published"] }, { id: "1", title: "Any details?", options: [] }] };
function fixture(status = "inProgress") {
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "turn", status, items: [presentCodexItem({ id: question.callId, type: "agentMessage", delivery: "async",
    text: "Which stage?\nPlanning\nPublished", questions: question.questions.map(({ title, options }) => ({ title, options })) })] });
  const read = () => presentCodexChatSnapshot(store.state).turns[0].items.find((item) => item.id === question.callId).question;
  return { store, read };
}

test("floating questions survive timeline windowing and keep original answer indexes", () => {
  const { store } = fixture();
  store.state.turns.turn.itemsWindowIds = [];
  assert.equal(presentCodexChatSnapshot(store.state).turns[0].items.length, 0);
  assert.equal(pendingDesktopQuestions(store.state).length, 1);
  const skipped = buildQuestionAnswer(question, 0, "skip").replace('"answer":"skip"', '"answer":""');
  store.upsertItem("turn", { id: "answer", type: "userMessage", text: skipped });
  const pending = pendingDesktopQuestions(store.state)[0];
  assert.equal(pending.answers[0], "");
  assert.deepEqual(pending.questions.map((entry) => entry.id), ["0", "1"]);
  store.upsertRequest({ id: "answer-two", state: "accepted", input: { text: buildQuestionAnswer(question, 1, "Detail") } });
  assert.equal(pendingDesktopQuestions(store.state)[0].pendingResponse, true);
  store.upsertItem("turn", { id: "answer-2", type: "userMessage", text: buildQuestionAnswer(question, 1, "Detail") });
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
});

test("question answers use the native async question identity without losing user text", () => {
  const text = buildQuestionAnswer(question, 0, "Published\nMore detail");
  assert.deepEqual(parseQuestionReplies(text), [{ questionItemId: '["request_user_input_async","call_question",0]',
    question: "Which stage?", answer: "Published\nMore detail", callId: "call_question", index: 0 }]);
  assert.equal(questionReplyText(text), "回答：Published\nMore detail");
  assert.throws(() => buildQuestionAnswer({ ...question, truncated: true }, 0, "Published"), /不可用/);
  assert.throws(() => buildQuestionAnswer(question, 8, "Published"), /不可用/);
  assert.throws(() => buildQuestionAnswer(question, 0, " "), /不可用/);
});

test("only an exact validated reply envelope contributes answer history", () => {
  const valid = buildQuestionAnswer(question, 0, "Published");
  for (const value of ["A question?\n- one\n- two", `quoted\n${valid}`, `${valid}\ncomment`,
    valid.replace("request_user_input_async", "arbitrary_tool"), valid.replace("call_question", "../other"),
    valid.replace('"answer":', '"unexpected":1,"answer":'), "<send_user_message_question_reply>[]</send_user_message_question_reply>"]) {
    assert.equal(parseQuestionReplies(value), null);
    assert.equal(questionReplyText(value), value);
  }
});

test("answered async questions remain identified after their turn ends", () => {
  const { store, read } = fixture("completed");
  store.upsertTurn({ id: "reply-turn", status: "completed", items: [
    { id: "reply-0", type: "userMessage", text: buildQuestionAnswer(question, 0, "Published") },
    { id: "reply-1", type: "userMessage", content: [{ type: "inputText", text: buildQuestionAnswer(question, 1, "Details") }] }
  ] });
  assert.equal(read().status, "answered");
  assert.deepEqual(read().answers, { "0": "Published", "1": "Details" });
  const reply = presentCodexChatSnapshot(store.state).turns[1].items[0];
  assert.equal(reply.text, "回答：Published");
  assert.equal(reply.questionReplies[0].question, "Which stage?");
  assert.equal(reply.questionReplies[0].answer, "Published");
  assert.equal(reply.text.includes("send_user_message_question_reply"), false);
});

test("optimistic and confirmed answers retain the same quoted question without duplicate user messages", () => {
  const { store } = fixture();
  const text = buildQuestionAnswer(question, 0, "Published");
  store.upsertRequest({ id: "answer-request", mode: "steer", state: "accepted", turnId: "turn", input: { text } });
  let items = presentCodexChatSnapshot(store.state).turns[0].items.filter((item) => item.questionReplies);
  assert.equal(items.length, 1);
  assert.equal(items[0].questionReplies[0].question, "Which stage?");
  store.upsertItem("turn", { id: "official-answer", type: "userMessage", clientId: "answer-request", text });
  items = presentCodexChatSnapshot(store.state).turns[0].items.filter((item) => item.questionReplies);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "official-answer");
  assert.equal(items[0].questionReplies[0].answer, "Published");
});

test("completed questions keep their unanswered history but leave the floating reminder", () => {
  const { store, read } = fixture("completed");
  assert.equal(read().status, "pending");
  assert.equal(read().active, false);
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  store.upsertTurn({ id: "later", status: "completed", items: [{ id: "ordinary", type: "userMessage", text: "Published" }] });
  assert.equal(read().status, "pending");
  assert.deepEqual(read().answers, {});
});

test("pending answer receipts are shown as queued until official reply evidence arrives", () => {
  const { store, read } = fixture();
  store.upsertRequest({ id: "answer-0", state: "queued", input: { text: buildQuestionAnswer(question, 0, "Published") } });
  let current = read();
  assert.equal(current.status, "pending");
  assert.deepEqual(current.answers, {});
  assert.deepEqual(current.pendingResponses, { "0": "queued" });
  assert.equal(current.pendingResponse, false, "another unanswered question remains editable");
  assert.equal(presentCodexQueue(store.state)[0].text, "回答：Published");
  store.upsertRequest({ id: "answer-1", state: "unknown", input: { text: buildQuestionAnswer(question, 1, "Details") } });
  current = read();
  assert.equal(current.pendingResponse, true);
  store.upsertRequest({ id: "answer-0", state: "completed" });
  assert.equal(read().status, "pending", "queue acknowledgement or request completion is not native answer evidence");
  store.upsertTurn({ id: "replies", items: [
    { id: "official-0", type: "userMessage", text: buildQuestionAnswer(question, 0, "Published") },
    { id: "official-1", type: "steeringUserMessage", status: "accepted", text: buildQuestionAnswer(question, 1, "Details") }
  ] });
  assert.equal(read().status, "answered");
  assert.equal(read().pendingResponse, false);
});

test("rejected question answers do not lock retries and malformed assistant text cannot answer a question", () => {
  const { store, read } = fixture();
  const text = buildQuestionAnswer(question, 0, "Published");
  store.upsertRequest({ id: "rejected", state: "rejected", input: { text }, error: { message: "not accepted" } });
  store.upsertItem("turn", { id: "quoted", type: "agentMessage", text });
  assert.deepEqual(read().answers, {});
  assert.deepEqual(read().pendingResponses, {});
  assert.equal(read().status, "pending");
});

test("explicitly releasing a missing receipt unlocks the question without erasing its uncertain result", () => {
  const { store, read } = fixture();
  store.upsertRequest({ id: "missing-answer", state: "unknown", input: { text: buildQuestionAnswer(question, 0, "Published") },
    error: { code: "receipt_not_found", message: "Missing receipt" } });
  assert.deepEqual(read().pendingResponses, { "0": "unknown" });
  store.upsertRequest({ id: "missing-answer", state: "unknown", confirmationDismissed: true });
  assert.deepEqual(read().pendingResponses, {});
  assert.deepEqual(read().answers, {});
  assert.equal(read().status, "pending");
  assert.equal(store.state.requests["missing-answer"].state, "unknown");
  assert.equal(store.state.requests["missing-answer"].error.code, "receipt_not_found");
  store.upsertRequest({ id: "retried-answer", state: "sending", input: { text: buildQuestionAnswer(question, 0, "Published") } });
  assert.deepEqual(read().pendingResponses, { "0": "sending" });
  store.upsertItem("turn", { id: "late-answer", type: "steeringUserMessage", status: "accepted", text: buildQuestionAnswer(question, 0, "Published") });
  assert.deepEqual(read().answers, { "0": "Published" });
  assert.deepEqual(read().pendingResponses, {});
});

test("only the latest running turn can request attention and late old items cannot reopen it", () => {
  for (const status of ["completed", "failed", "interrupted", "aborted", "cancelled", "unknown"]) {
    const { store, read } = fixture();
    assert.equal(pendingDesktopQuestions(store.state).length, 1);
    store.upsertTurn({ id: "turn", status });
    assert.deepEqual(pendingDesktopQuestions(store.state), []);
    assert.equal(read().active, false);
    assert.deepEqual(read().answers, {});
  }
  const { store, read } = fixture();
  store.upsertTurn({ id: "next-turn", status: "inProgress", items: [] });
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  store.upsertItem("turn", { id: question.callId, presentation: { question } });
  assert.deepEqual(pendingDesktopQuestions(store.state), []);
  assert.equal(read().active, false);
});

test("accepted desktop steering input and single-object replies settle questions while unaccepted input does not", () => {
  const { store, read } = fixture();
  const text = buildQuestionAnswer(question, 0, "Published").replace('\n[{', '\n{').replace('}]\n</', '}\n</');
  assert.equal(parseQuestionReplies(text)?.length, 1);
  for (const status of [undefined, "pending", "inProgress", "rejected", "failed", "cancelled"]) {
    store.upsertItem("turn", { id: `unaccepted-${status}`, type: "steeringUserMessage", status, input: [{ type: "text", text }] });
    assert.deepEqual(read().answers, {});
  }
  // Old projections may have an empty text; the native input remains authoritative.
  store.upsertItem("turn", { id: "accepted", type: "steeringUserMessage", status: "accepted", presentation: { text: "" },
    input: [{ type: "text", text }] });
  assert.deepEqual(read().answers, { "0": "Published" });
  assert.equal(pendingDesktopQuestions(store.state).length, 1, "the second question is still unanswered");
  const item = presentCodexChatSnapshot(store.state).turns[0].items.find((item) => item.id === "accepted");
  assert.equal(item.kind, "UserMessage");
  assert.equal(item.questionReplies[0].answer, "Published");
});

test("ordinary steering keeps the server's cleaned text instead of exposing host context", () => {
  const { store } = fixture();
  store.upsertItem("turn", presentCodexItem({ id: "ordinary-steering", type: "steeringUserMessage", status: "accepted",
    input: [{ type: "text", text: '# In app browser (IAB):\n- The user has the in-app browser (IAB) open.\n- Current URL: https://example.test\n## My request for Codex:\n继续执行' }] }));
  const item = presentCodexChatSnapshot(store.state).turns[0].items.find((item) => item.id === "ordinary-steering");
  assert.equal(item.text, "继续执行");
  assert.equal(item.questionReplies, undefined);
});
