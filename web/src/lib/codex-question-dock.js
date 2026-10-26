import { createQuestionHistory } from "./codex-question-history.js";

export const QUESTION_DOCK = Symbol("codex-question-dock");

// Attention must survive timeline windowing. Reuse the same answer/receipt
// projection as history; never infer an answer from a finished assistant turn.
export function pendingDesktopQuestions(state) {
  if (!state) return [];
  const history = createQuestionHistory(state), seen = new Set(), questions = [];
  for (const turnId of state.turnOrder) {
    const turn = state.turns[turnId];
    if (!turn) continue;
    for (const item of Object.values(turn.items)) {
      const source = item.presentation?.question;
      if (source?.source !== "desktop" || source.delivery !== "async" || !source.callId || seen.has(source.callId)) continue;
      seen.add(source.callId);
      const question = history(source, turn.status);
      if (question.status === "pending") questions.push({ ...question, turnId, itemId: item.id });
    }
  }
  return questions;
}

export function unansweredQuestionEntries(question) {
  return question.questions.filter((entry) => !Object.hasOwn(question.answers || {}, entry.id));
}
