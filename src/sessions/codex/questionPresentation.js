const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 16;
const MAX_TOTAL_TEXT = 16_000;

/** Desktop questions carry explicit native fields; ordinary assistant prose is never inferred. */
export function presentDesktopQuestion(item) {
  if (item?.type !== "agentMessage" || item.delivery !== "async" ||
    typeof item.id !== "string" || !/^call_[A-Za-z0-9_-]{1,500}$/.test(item.id) ||
    !Array.isArray(item.questions) || !item.questions.length) return null;
  let remaining = MAX_TOTAL_TEXT, truncated = item.questions.length > MAX_QUESTIONS;
  const bounded = (value, limit) => {
    const text = value.replace(/\u0000/g, "").trim();
    const size = Math.min(limit, remaining);
    if (text.length > size) truncated = true;
    remaining -= Math.min(text.length, size);
    return text.slice(0, size);
  };
  const questions = [];
  for (const [index, question] of item.questions.slice(0, MAX_QUESTIONS).entries()) {
    const offered = question?.options === undefined ? [] : question.options;
    if (!question || typeof question.title !== "string" || !question.title.trim() ||
      !Array.isArray(offered) || offered.slice(0, MAX_OPTIONS).some((option) => typeof option !== "string")) return null;
    const title = bounded(question.title, 4_000);
    if (!title) { truncated = true; break; }
    if (offered.length > MAX_OPTIONS) truncated = true;
    const options = offered.slice(0, MAX_OPTIONS).map((option) => bounded(option, 1_000)).filter(Boolean);
    questions.push({ id: String(index), title, options });
  }
  return questions.length ? { questions, delivery: "async", source: "desktop", callId: item.id, truncated } : null;
}
