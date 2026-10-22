import { isCodexRequestDismissedMissing } from "./codex-chat-store.js";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
const CALL_ID = /^call_[A-Za-z0-9_-]{1,500}$/;
const pendingStates = new Set(["sending", "received", "dispatching", "queued", "accepted", "running", "unknown", "completed"]);
const key = (callId, index) => JSON.stringify([callId, index]);

export function parseQuestionReplies(value) {
  if (typeof value !== "string" || value.length > 100_000) return null;
  const text = value.trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return null;
  try {
    const rows = JSON.parse(text.slice(OPEN.length, -CLOSE.length).trim());
    if (!Array.isArray(rows) || !rows.length || rows.length > 32) return null;
    return rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).some((name) => !["questionItemId", "question", "answer"].includes(name)) ||
        typeof row.questionItemId !== "string" || typeof row.question !== "string" || typeof row.answer !== "string") throw new Error();
      const identity = JSON.parse(row.questionItemId);
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== "request_user_input_async" ||
        typeof identity[1] !== "string" || !CALL_ID.test(identity[1]) || !Number.isSafeInteger(identity[2]) || identity[2] < 0 || identity[2] >= 32) throw new Error();
      return { ...row, callId: identity[1], index: identity[2] };
    });
  } catch { return null; }
}

export function buildQuestionAnswer(question, index, answer) {
  const entry = question?.questions?.[index];
  if (question?.source !== "desktop" || question.delivery !== "async" || !CALL_ID.test(question.callId || "") ||
    question.truncated || !Number.isSafeInteger(index) || index < 0 || index >= 32 || entry?.id !== String(index) ||
    typeof entry.title !== "string" || !entry.title.trim() || typeof answer !== "string" || !answer.trim() || answer.length > 10_000) {
    throw new Error("问题或回答已不可用，请重新读取会话。");
  }
  return `${OPEN}\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", question.callId, index]),
    question: entry.title, answer: answer.trim() }])}\n${CLOSE}`;
}

export function questionReplyText(text) {
  const replies = parseQuestionReplies(text);
  return replies ? replies.map((reply) => reply.answer ? `回答：${reply.answer}` : "已跳过问题").join("\n\n") : text;
}

function userText(item) {
  if (typeof item.presentation?.text === "string") return item.presentation.text;
  if (typeof item.text === "string") return item.text;
  return Array.isArray(item.content) ? item.content.filter((part) => ["text", "inputText", "input_text"].includes(part.type))
    .map((part) => part.text || "").join("\n\n") : "";
}

export function createQuestionHistory(state) {
  const answered = new Map(), pending = new Map();
  for (const turn of Object.values(state.turns)) for (const item of Object.values(turn.items)) {
    if (!["userMessage", "steeringUserMessage"].includes(item.type) || ["failed", "rejected", "cancelled"].includes(item.status)) continue;
    for (const reply of parseQuestionReplies(userText(item)) || []) answered.set(key(reply.callId, reply.index), reply.answer);
  }
  for (const id of state.requestOrder) {
    const receipt = state.requests[id];
    if (!pendingStates.has(receipt?.state) || isCodexRequestDismissedMissing(receipt)) continue;
    for (const reply of parseQuestionReplies(receipt.input?.text) || []) pending.set(key(reply.callId, reply.index), receipt.state);
  }
  return (question, turnStatus) => {
    if (!question) return undefined;
    const answers = {}, pendingResponses = {};
    for (const entry of question.questions) {
      const id = key(question.callId, Number(entry.id));
      if (answered.has(id)) answers[entry.id] = answered.get(id);
      else if (pending.has(id)) pendingResponses[entry.id] = pending.get(id);
    }
    const remaining = question.questions.filter((entry) => !Object.hasOwn(answers, entry.id));
    const pendingResponse = remaining.length > 0 && remaining.every((entry) => Object.hasOwn(pendingResponses, entry.id));
    return { ...question, answers, pendingResponses, pendingResponse,
      responseState: remaining.map((entry) => pendingResponses[entry.id]).find(Boolean) || "",
      status: remaining.length === 0 ? "answered" : "pending" };
  };
}
