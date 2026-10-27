import { parseQuestionReplies, questionUserText } from "./codex-question-history.js";

const active = (turn) => ["inProgress", "running"].includes(turn?.status);
const replyCandidate = (item) => ["userMessage", "steeringUserMessage"].includes(item.type) &&
  !["failed", "rejected", "cancelled"].includes(item.status);

// The timeline is a window, not an index of outstanding questions. Walk the
// current turn independently, retaining only question/answer evidence. Reads
// are serial and bounded; after the first pass only new items are requested.
export function createCodexQuestionSync({ store, call, base, isDisposed,
  yieldPage = () => new Promise((resolve) => setTimeout(resolve, 0)), onSettled = () => {} }) {
  let scan = null;
  const { state } = store;
  function current(value) {
    return !isDisposed() && scan === value && !value.controller.signal.aborted &&
      value.epoch === state.epoch && state.turnOrder.at(-1) === value.turnId && active(state.turns[value.turnId]);
  }
  function publish(value, ready, error = "") {
    if (!current(value)) return;
    state.questionSyncError = error ? `提问状态核对失败，正在重试：${error}` : "";
    store.updateQuestionHistory(value.turnId, { questionSync: { ready, error }, questionItems: value.items });
  }
  async function evidence(item, value) {
    if (item.presentation?.question?.source === "desktop" && item.presentation.question.delivery === "async") {
      return { id: item.id, type: item.type, presentation: { question: item.presentation.question } };
    }
    if (!replyCandidate(item)) return null;
    let text = questionUserText(item) || (item.type === "steeringUserMessage" && Array.isArray(item.input) ? item.input
      .filter((part) => ["text", "inputText", "input_text"].includes(part?.type)).map((part) => part.text || "").join("\n\n") : "");
    // Only an envelope needs its full text. Ordinary long messages and tool
    // output must not trigger detail hydration during question reconciliation.
    if ((item.truncated || item.hasDetails) && text.trimStart().startsWith("<send_user_message_question_reply>")) {
      const page = await call(`${base}/turns/${encodeURIComponent(value.turnId)}/items/${encodeURIComponent(item.id)}`,
        { signal: value.controller.signal });
      if (page?.item?.id !== item.id || !replyCandidate(page.item)) throw new Error("问题回答记录尚未读取完整。");
      text = questionUserText(page.item);
      if (!parseQuestionReplies(text) && (page.item.truncated || page.item.hasDetails)) throw new Error("问题回答记录尚未读取完整。");
    }
    return parseQuestionReplies(text) ? { id: item.id, type: item.type, status: item.status, text } : null;
  }
  function remember(value, item) {
    value.items[item.id] = item;
    value.pending.delete(item.id);
    if (item.type === "steeringUserMessage" && item.status !== "accepted") value.pending.add(item.id);
  }
  async function recheckPending(value) {
    // Steering status can change in place behind the tail anchor. Revisit only
    // unresolved answer IDs, rotating at most four exact reads per refresh.
    for (const id of [...value.pending].slice(0, 4)) {
      const page = await call(`${base}/turns/${encodeURIComponent(value.turnId)}/items/${encodeURIComponent(id)}`,
        { signal: value.controller.signal });
      if (!current(value)) return;
      if (page?.item?.id !== id) throw new Error("问题回答记录尚未读取完整。");
      const item = await evidence(page.item, value);
      if (!current(value)) return;
      if (item) remember(value, item);
      else { value.pending.delete(id); delete value.items[id]; }
    }
  }
  async function read(value) {
    try {
      await recheckPending(value);
      if (!current(value)) return;
      do {
        const query = new URLSearchParams({ limit: "90", ...(value.cursor ? { cursor: value.cursor }
          : value.tail ? { after: value.tail } : {}) });
        const page = await call(`${base}/turns/${encodeURIComponent(value.turnId)}/items?${query}`,
          { signal: value.controller.signal });
        if (!current(value)) return;
        if (page?.threadId !== state.threadId || page.turnId !== value.turnId || !Array.isArray(page.items) ||
          page.items.length > 90 || page.items.some((item) => typeof item?.id !== "string" || !item.id) ||
          new Set(page.items.map((item) => item.id)).size !== page.items.length ||
          typeof page.hasMore !== "boolean" || page.hasMore && (typeof page.nextCursor !== "string" || !page.nextCursor || value.cursors.has(page.nextCursor)) ||
          value.tail && page.items.some((item) => item.id === value.tail) ||
          page.items.length && page.latestItemId !== page.items.at(-1).id) throw new Error("问题状态分页响应无效。");
        const updates = [];
        for (const item of page.items) {
          const entry = await evidence(item, value);
          if (!current(value)) return;
          if (entry) updates.push(entry);
        }
        for (const item of updates) remember(value, item);
        value.tail = page.latestItemId || value.tail;
        value.cursor = page.hasMore ? page.nextCursor : "";
        if (value.cursor) value.cursors.add(value.cursor);
        value.ready = !value.cursor;
        if (!value.cursor) value.cursors.clear();
        publish(value, value.ready);
        if (value.cursor) await yieldPage();
      } while (value.cursor && current(value));
    } catch (error) {
      // Preserve the last successful cursor. Incomplete history never proves
      // that a question is unanswered, and a failed read never resends input.
      publish(value, value.ready, error.message || String(error));
    } finally { onSettled(); }
  }
  function refresh() {
    const turnId = state.turnOrder.at(-1), turn = state.turns[turnId];
    if (scan && (scan.turnId !== turnId || scan.epoch !== state.epoch || !active(turn))) {
      scan.controller.abort(); scan = null;
    }
    if (isDisposed()) return Promise.resolve();
    if (!active(turn)) { state.questionSyncError = ""; return Promise.resolve(); }
    if (!scan) {
      scan = { turnId, epoch: state.epoch, controller: new AbortController(), items: {},
        cursor: "", tail: "", cursors: new Set(), pending: new Set(), ready: false, promise: null };
      publish(scan, false);
    }
    if (scan.promise) return scan.promise;
    const value = scan;
    const promise = read(value).finally(() => { if (value.promise === promise) value.promise = null; });
    value.promise = promise;
    return promise;
  }
  return { refresh, dispose() { scan?.controller.abort(); scan = null; } };
}
