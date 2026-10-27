import { createQuestionHistory } from "./codex-question-history.js";

export const QUESTION_DOCK = Symbol("codex-question-dock");

// Attention survives timeline windowing, but ends with its running turn.
// History retains unanswered questions without keeping the reply panel open.
export function pendingDesktopQuestions(state) {
  if (!state) return [];
  const history = createQuestionHistory(state), seen = new Set(), questions = [];
  for (const turnId of state.turnOrder) {
    const turn = state.turns[turnId];
    if (!turn) continue;
    for (const item of Object.values({ ...turn.questionItems, ...turn.items })) {
      const source = item.presentation?.question;
      if (source?.source !== "desktop" || source.delivery !== "async" || !source.callId || seen.has(source.callId)) continue;
      seen.add(source.callId);
      const question = history(source, turn.status, turnId);
      if (question.active && question.status === "pending") questions.push({ ...question, turnId, itemId: item.id });
    }
  }
  return questions;
}

export function unansweredQuestionEntries(question) {
  return question.questions.filter((entry) => !Object.hasOwn(question.answers || {}, entry.id));
}
