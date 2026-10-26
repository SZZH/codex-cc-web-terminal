import { isRenderableImageUrl, normalizeImageUrl } from "./image-url.js";
import { hasCodexRequestExecution, isCodexRequestDismissedMissing } from "./codex-chat-store.js";
import { createQuestionHistory, parseQuestionReplies, questionReplyText } from "./codex-question-history.js";
import { createCodexSubagentActivityProjector } from "./codex-subagent-activity.js";

const KINDS = { userMessage: "UserMessage", agentMessage: "AgentMessage", reasoning: "Reasoning",
  commandExecution: "CommandExecution", fileChange: "FileChange", mcpToolCall: "McpToolCall",
  dynamicToolCall: "DynamicToolCall", collabAgentToolCall: "CollabAgentToolCall", subAgentActivity: "SubAgentActivity", webSearch: "WebSearch",
  imageView: "ImageView", imageGeneration: "ImageGeneration", plan: "Plan" };
const REQUEST_LABELS = { sending: "发送中", received: "等待执行", dispatching: "发送中",
  queued: "等待执行", accepted: "正在生成", running: "正在生成", completed: "已完成", cancelled: "已撤回", failed: "发送失败",
  interrupted: "已中断", rejected: "请求被拒绝", unknown: "正在确认发送状态", superseded: "执行已结束，结果未确认" };
const UNCONFIRMED_STATES = new Set(["sending", "received", "dispatching", "queued", "accepted", "running", "unknown"]);
export const codexRequestLabel = (request) => {
  const label = request?.initialPlacement === "timeline" && ["received", "queued"].includes(request.state)
    ? "发送中" : REQUEST_LABELS[request?.state] || request?.state || "";
  return request?.mode === "steer" ? `引导中 · ${label}` : label;
};
export const codexRequestError = (request) => request?.error?.code === "thread_in_use"
  ? "此前的消息尚未发出。可恢复到输入框，在网页重新发送；原文和附件已保留。"
  : request?.error?.message || request?.error || "";
export function codexSubmissionFeedbackRequest(state, lastSubmittedRequestId) {
  const blocking = state?.requestOrder.map((id) => state.requests[id]).find((request) =>
    request?.state === "unknown" && !isCodexRequestDismissedMissing(request));
  if (blocking) return blocking;
  const local = state?.requests[lastSubmittedRequestId];
  return ["failed", "rejected"].includes(local?.state) || isCodexRequestDismissedMissing(local) ? local : null;
}
const displayStatus = (status) => ["interrupted", "cancelled", "aborted"].includes(status) ? "aborted"
  : status === "rejected" ? "failed" : status || "inProgress";
function timestamp(value) {
  if (value == null || value === "") return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(value);
}

function normalizeImages(images = []) {
  const seen = new Set();
  return images.flatMap((image) => {
    const url = normalizeImageUrl(image.url || (image.id ? `/api/attachments/images/${encodeURIComponent(image.id)}` : ""));
    if (!isRenderableImageUrl(url) || seen.has(url)) return [];
    seen.add(url); return [{ ...image, url }];
  });
}

function reasoningText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(reasoningText).join("\n");
  return typeof value?.text === "string" ? value.text : "";
}
export function isEmptyCodexReasoning(item) {
  return String(item?.type || item?.kind || "").toLowerCase() === "reasoning" &&
    ![item.presentation?.text, item.text, item.summary, item.content].map(reasoningText).join("").trim();
}

function queuePlacement(state) {
  const officialItems = Object.values(state.turns).flatMap((turn) => Object.values(turn.items))
    .filter((item) => ["userMessage", "steeringUserMessage"].includes(item.type));
  const itemIds = new Set(officialItems.map((item) => item.id));
  const clientIds = new Set(officialItems.map((item) => item.clientId).filter(Boolean));
  const waiting = [], hiddenIds = new Set();
  for (const id of state.requestOrder) {
    const request = state.requests[id];
    if (!request || request.mode === "steer" || hasCodexRequestExecution(request) ||
      itemIds.has(request.userItemId) || clientIds.has(id)) continue;
    if (request.state === "removed") { hiddenIds.add(id); continue; }
    const inComposer = request.initialPlacement === "composer" || !request.initialPlacement &&
      ["received", "queued", "cancelled"].includes(request.state);
    if (!inComposer) continue;
    if (request.state === "cancelled" || request.restoredToDraft && ["failed", "rejected"].includes(request.state)) hiddenIds.add(id);
    else waiting.push(request);
  }
  return { waiting, hiddenIds };
}

export function presentCodexQueue(state) {
  return queuePlacement(state).waiting.map((request) => ({
    id: request.id, text: questionReplyText(request.input?.text || ""), state: request.state,
    images: normalizeImages(request.previewImages || request.input?.attachments), request
  }));
}

// This DTO is only a renderer adapter. The store never consumes it.
export function presentCodexChatItem(item, activity = item.presentation?.activity) {
  const presentation = item.presentation || {};
  const status = item.status ? displayStatus(item.status) : "";
  const content = Array.isArray(item.content) ? item.content : [];
  const rawText = item.type === "reasoning"
    ? presentation.text || item.text || [reasoningText(item.summary), reasoningText(item.content)].filter(Boolean).join("\n")
    : presentation.text ?? item.text ?? content.filter((part) => ["text", "inputText", "input_text"].includes(part.type)).map((part) => part.text || "").join("\n\n");
  const text = ["userMessage", "steeringUserMessage"].includes(item.type) ? questionReplyText(rawText) : rawText;
  const questionReplies = ["userMessage", "steeringUserMessage"].includes(item.type) ? parseQuestionReplies(rawText) : null;
  const question = presentation.question;
  const changes = Object.fromEntries((presentation.fileChanges || []).map((file) => [file.path,
    { type: file.status, unified_diff: file.diff || "", move_path: file.previousPath || "",
      additions: file.additions, deletions: file.deletions }]));
  return { id: item.id, kind: KINDS[item.type] || item.type || "Unknown", phase: item.phase,
    hasDetails: item.hasDetails, detailsLoaded: item.detailsLoaded, truncated: item.truncated,
    detailLoading: item.detailLoading, detailError: item.detailError, detailRetryable: item.detailRetryable,
    hidden: isEmptyCodexReasoning(item),
    status, text, ...(question ? { question } : {}), ...(questionReplies ? { questionReplies } : {}),
    images: normalizeImages(presentation.images), activity,
    payload: { status, phase: item.phase, command: item.command, query: item.query,
      text, images: normalizeImages(presentation.images), activity, commandActions: item.commandActions,
      tool: item.tool, ...(Object.keys(changes).length ? { changes } : {}) } };
}

export function presentCodexChatSnapshot(state, presentItem = presentCodexChatItem) {
  const { waiting, hiddenIds } = queuePlacement(state);
  const queuedIds = new Set([...waiting.map((request) => request.id), ...hiddenIds]);
  const questionHistory = createQuestionHistory(state);
  const turns = state.turnOrder.map((id) => state.turns[id]).filter(Boolean).map((turn) => {
    const projectActivity = createCodexSubagentActivityProjector(Object.values(turn.items));
    const visibleIds = turn.itemsLatestRequested && !turn.itemsLatestLoaded
      ? turn.itemOrder.filter((id) => turn.liveItemIds?.includes(id))
      : Array.isArray(turn.itemsWindowIds) ? turn.itemsWindowIds : turn.itemOrder;
    return { ...turn, status: displayStatus(turn.status), items: visibleIds.map((id) => {
        const source = turn.items[id];
        const item = presentItem(source, projectActivity(source));
        return item?.question ? { ...item, question: questionHistory(item.question, turn.status) } : item;
      }).filter(Boolean) };
  });
  const knownItems = new Map(turns.flatMap((turn) => turn.items.map((item) => [item.id, item])));
  const knownClients = new Map();
  const officialUserIds = new Set(), officialClientIds = new Set();
  const anchoredSteers = [];
  for (const turn of Object.values(state.turns)) for (const item of Object.values(turn.items)) {
    if (["userMessage", "steeringUserMessage"].includes(item.type)) {
      officialUserIds.add(item.id);
      if (item.clientId) officialClientIds.add(item.clientId);
    }
    const displayed = knownItems.get(item.id);
    if (displayed && item.clientId) knownClients.set(item.clientId, displayed);
  }
  for (const id of state.requestOrder) {
    if (queuedIds.has(id)) continue;
    const request = state.requests[id];
    if ((officialClientIds.has(id) || officialUserIds.has(request.userItemId)) &&
      !knownClients.has(id) && !knownItems.has(request.userItemId)) continue;
    // A settled receipt outside the loaded history window must not reinsert old input.
    const submittedHere = state.submittedRequestIds?.includes(id);
    if (!submittedHere && ["completed", "superseded"].includes(request.state) && request.turnId &&
      (state.turns[request.turnId]?.itemsLatestRequested || state.turns[request.turnId]?.itemsLatestLoaded) &&
      !knownItems.has(request.userItemId) && !knownClients.has(id)) continue;
    const requestTurn = state.turns[request.turnId];
    const hiddenInput = requestTurn?.itemsLatestRequested && !request.error &&
      Object.values(requestTurn.items).some((item) => item.id === request.userItemId || item.clientId === id);
    if (!submittedHere && hiddenInput && !knownItems.has(request.userItemId) && !knownClients.has(id)) continue;
    const officialItem = knownClients.get(id) || knownItems.get(request.userItemId);
    const officialTurn = (officialItem && turns.find((turn) => turn.items.includes(officialItem))) ||
      turns.find((turn) => turn.id === (request.turnId || (request.mode === "steer" ? request.expectedTurnId : "")));
    if (officialItem) {
      officialItem.request = { ...request, state: UNCONFIRMED_STATES.has(request.state)
        ? officialTurn?.status === "completed" ? "completed" : "running" : request.state };
      if (request.mode === "steer" && Object.hasOwn(request, "steerAfterItemId") && officialTurn
        && !state.turns[officialTurn.id].confirmedItemIds?.includes(officialItem.id)) {
        officialTurn.items = officialTurn.items.filter((item) => item.id !== officialItem.id);
        anchoredSteers.push({ turn: officialTurn, item: officialItem, request });
      }
      continue;
    }
    if (["completed", "superseded"].includes(request.state) && request.turnId && !state.turns[request.turnId]) continue;
    const replyText = questionReplyText(request.input?.text || "");
    const questionReplies = parseQuestionReplies(request.input?.text || "");
    const item = { id: `request:${id}`, kind: "UserMessage", text: replyText, request: { ...request },
      ...(questionReplies ? { questionReplies } : {}),
      images: normalizeImages(request.previewImages || request.input?.attachments),
      payload: { text: replyText, images: normalizeImages(request.previewImages || request.input?.attachments) } };
    if (officialTurn && request.mode === "steer" && Object.hasOwn(request, "steerAfterItemId")) anchoredSteers.push({ turn: officialTurn, item, request });
    else if (officialTurn && request.mode === "steer") officialTurn.items.push(item);
    else if (officialTurn) officialTurn.items.unshift(item);
    else {
      const pending = { id: `request:${id}`, status: displayStatus(request.state), startedAt: request.createdAt, items: [item] };
      const next = turns.findIndex((turn) => timestamp(turn.startedAt) > timestamp(request.createdAt));
      turns.splice(next < 0 ? turns.length : next, 0, pending);
    }
  }
  const anchorTails = new Map();
  for (const { turn, item, request } of anchoredSteers.sort((a, b) => (a.request.steerQueuedAt || 0) - (b.request.steerQueuedAt || 0))) {
    const key = `${turn.id}:${request.steerAfterItemId}`;
    const anchor = anchorTails.get(key) || request.steerAfterItemId;
    const index = turn.items.findIndex((entry) => entry.id === anchor);
    // An explicitly captured empty anchor precedes new output, after the original input if known.
    const finalReply = turn.items.findLastIndex((entry) => entry.kind === "AgentMessage");
    // A freshly loaded sparse summary can omit the saved anchor but already include the final reply.
    const insertion = index >= 0 ? index + 1 : anchor
      ? finalReply >= 0 && ["accepted", "running", "completed"].includes(request.state) ? finalReply : turn.items.length
      : turn.items.findIndex((entry) => entry.kind !== "UserMessage");
    turn.items.splice(insertion < 0 ? turn.items.length : insertion, 0, item);
    anchorTails.set(key, item.id);
  }
  // Keep even hidden item identities until steer anchors have been resolved.
  return { threadId: state.threadId, version: state.presentationRevision ?? state.revision,
    turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => !item.hidden) })) };
}

function sameFields(left, right, excluded = "") {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key === excluded || Object.is(left[key], right[key]));
}

export function createCodexChatPresenter() {
  const itemCache = new WeakMap();
  let previousState, previous;
  return (state) => {
    const snapshot = presentCodexChatSnapshot(state, (item, activity) => {
      const cached = itemCache.get(item);
      // Runtime detail loading/error flags can change without replacing the store item.
      const source = { ...item };
      const sameActivity = cached?.activity === activity || cached?.activity && activity && sameFields(cached.activity, activity);
      const value = cached && sameActivity && sameFields(cached.source, source) ? cached.value : presentCodexChatItem(item, activity);
      itemCache.set(item, { source, activity, value });
      // Receipt association and steer placement mutate only this snapshot's adapters.
      return { ...value };
    });
    const previousTurns = new Map(previousState === state ? previous.turns.map((turn) => [turn.id, turn]) : []);
    snapshot.turns = snapshot.turns.map((turn) => {
      const prior = previousTurns.get(turn.id);
      if (!prior) return turn;
      const previousItems = new Map(prior.items.map((item) => [item.id, item]));
      turn.items = turn.items.map((item) => {
        const old = previousItems.get(item.id);
        const sameRequest = old?.request && item.request ? sameFields(old.request, item.request) : old?.request === item.request;
        return old && sameRequest && sameFields(old, item, "request") ? old : item;
      });
      return sameFields(prior, turn, "items") && prior.items.length === turn.items.length &&
        prior.items.every((item, index) => item === turn.items[index]) ? prior : turn;
    });
    previousState = state;
    previous = snapshot;
    return snapshot;
  };
}
