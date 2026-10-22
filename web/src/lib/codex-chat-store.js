import { createCodexInteractionState } from "./codex-interactions/state.js";
import { includeWindowItems, mergeItemOrder, mergeOrder } from "./codex-chat-item-order.js";
import { prepareInitialHistory } from "./codex-initial-history.js";
import { mergeCodexSubagentActivity } from "./codex-subagent-activity.js";

const TERMINAL = new Set(["completed", "failed", "interrupted", "rejected", "aborted", "cancelled", "removed"]);
export const isCodexTerminal = (value) => TERMINAL.has(String(value || "").toLowerCase());
export const isCodexRequestUnresolved = (request) => !isCodexTerminal(request?.state);
export const isCodexRequestDismissedMissing = (receipt) => receipt?.state === "unknown" &&
  receipt.confirmationDismissed === true && receipt.error?.code === "receipt_not_found";
export const hasCodexRequestExecution = (request) => request?.executionConfirmed === true || Boolean(request?.turnId &&
  ["accepted", "running", "completed", "failed", "interrupted", "aborted"].includes(request.state));
export function activeCodexTurnId(state) {
  const latestTurnId = state.turnOrder.at(-1);
  if (["inProgress", "running"].includes(state.turns[latestTurnId]?.status)) return latestTurnId;
  const receipt = [...state.requestOrder].reverse().map((id) => state.requests[id]).find((request) =>
    ["accepted", "running"].includes(request.state) && request.turnId && !isCodexTerminal(state.turns[request.turnId]?.status) &&
    (!state.turns[request.turnId] || request.turnId === latestTurnId));
  return receipt?.turnId || "";
}
const copy = (value) => JSON.parse(JSON.stringify(value));

function mergeRequest(previous, request, threadId) {
  // Optimistic timestamps use browser time; only compare confirmed server receipts.
  const localOnly = request.localOnly === true;
  const previousLocal = previous?.localOnly === true || previous?.state === "sending";
  if (previous && !previousLocal && localOnly) return previous;
  const observedExecution = previous?.state === "removed" && !localOnly && hasCodexRequestExecution(request);
  if (isCodexTerminal(previous?.state) && !isCodexTerminal(request.state) && !(previousLocal && !localOnly)
    && !observedExecution) return previous;
  if (!previousLocal && !localOnly && previous?.updatedAt && request.updatedAt &&
    new Date(request.updatedAt) < new Date(previous.updatedAt)) return previous;
  const confirmationDismissed = previous?.confirmationDismissed && request.state === "unknown" && request.updatedAt &&
    request.updatedAt !== previous.updatedAt ? false : previous?.confirmationDismissed;
  const merged = { ...previous, ...copy(request) };
  // The desktop transport can briefly queue even while idle. Keep the original
  // placement; only receipts without a local decision infer it from their state.
  const initialPlacement = (previous?.initialPlacement || request.initialPlacement) ||
    (merged.mode !== "steer" && ["received", "queued"].includes(merged.state) ? "composer" : undefined);
  return { ...merged, ...(initialPlacement ? { initialPlacement } : {}),
    ...(hasCodexRequestExecution(previous) || hasCodexRequestExecution(merged) ? { executionConfirmed: true } : {}),
    ...(previous?.restoredToDraft ? { restoredToDraft: true } : {}),
    ...(previous?.localOnly !== undefined || request.localOnly !== undefined ? { localOnly } : {}),
    confirmationDismissed: request.confirmationDismissed ?? confirmationDismissed, threadId };
}

function savedAttachment(item) {
  return {
    id: item.id, uploadedId: item.uploadedId || "", kind: item.kind, name: item.name,
    url: item.uploadedId ? item.url || "" : "", status: item.uploadedId ? "uploaded" : "failed",
    error: item.uploadedId ? "" : "图片尚未上传，请重新选择图片。"
  };
}

export function createCodexChatStore(threadId, { storage = null, reactive = (value) => value } = {}) {
  if (!threadId) throw new Error("threadId is required");
  const storageKey = `codex-chat-v2:${threadId}`;
  const revisions = new Map();
  const itemBirthRevisions = new Map();
  const liveItemBirthRevisions = new Map();
  const windowReadRevisions = new Map();
  const latestItemHeads = new Map();
  const historyTurnIds = new Set();
  let socketGeneration = 0;
  let epochGeneration = 0;
  const interactions = createCodexInteractionState(threadId, { reactive });
  const state = reactive({
    threadId, thread: null, turns: {}, turnOrder: [], requests: {}, requestOrder: [], submittedRequestIds: [],
    draft: { text: "", attachments: [] }, epoch: "", seq: 0, revision: 0, presentationRevision: 0,
    connection: "offline", olderCursor: null, hasMore: false, initialized: false,
    loading: false, submitting: false, interrupting: false, error: "", historyReadError: "", persistenceError: "",
    requestListReady: false, requestListError: "", interactionState: interactions.state
  });
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || "null");
    if (saved?.threadId === threadId) {
      state.draft = { text: String(saved.draft?.text || ""), attachments: (saved.draft?.attachments || []).map(savedAttachment) };
      for (const request of saved.requests || []) {
        if (!request.id || request.threadId !== threadId) continue;
        state.requests[request.id] = mergeRequest(undefined,
          request.state === "sending" ? { ...request, state: "unknown", localOnly: true } : request, threadId);
        state.requestOrder.push(request.id);
      }
    }
  } catch (error) { state.persistenceError = `无法读取本地草稿：${error.message}`; }

  function touch(key, { presentation = true } = {}) {
    state.revision += 1;
    if (presentation) state.presentationRevision = state.revision;
    if (key) revisions.set(key, state.revision);
  }
  function persist({ required = false, receiptId, preserveDraft = false } = {}) {
    try {
      if (!storage) throw new Error("浏览器本地存储不可用");
      const raw = storage.getItem?.(storageKey);
      const saved = raw == null ? { threadId, draft: { text: "", attachments: [] }, requests: [] } : JSON.parse(raw);
      if (saved?.threadId !== threadId || typeof saved.draft?.text !== "string" || !Array.isArray(saved.draft?.attachments) ||
        !Array.isArray(saved.requests) || saved.requests.some((request) => !request?.id || request.threadId !== threadId)) {
        throw new Error("已保存的草稿或回执格式无效，未覆盖原记录。");
      }
      // Merge only the changed receipt so another context's newer draft and receipts survive.
      const requests = [...saved.requests];
      if (receiptId && state.requests[receiptId]) {
        const index = requests.findIndex((request) => request.id === receiptId);
        const receipt = mergeRequest(requests[index], state.requests[receiptId], threadId);
        if (index < 0) requests.push(receipt); else requests[index] = receipt;
      }
      const recent = requests.filter((request) => !isCodexRequestUnresolved(request)).slice(-40);
      storage.setItem(storageKey, JSON.stringify({ ...saved, threadId,
        draft: preserveDraft ? saved.draft : { text: state.draft.text, attachments: state.draft.attachments.map(savedAttachment) },
        requests: [...requests.filter(isCodexRequestUnresolved), ...recent]
      }));
      state.persistenceError = "";
      return true;
    } catch (error) {
      state.persistenceError = `草稿或发送回执保存失败：${error.message}`;
      if (required) throw new Error(state.persistenceError);
      return false;
    }
  }
  function beginRead() { return { revision: state.revision, epochGeneration }; }
  function canApply(key, read) {
    return !read || (read.epochGeneration === epochGeneration && (revisions.get(key) || 0) <= read.revision);
  }
  function setDraft(draft) { state.draft = { ...state.draft, ...draft }; touch(undefined, { presentation: false }); persist(); }
  function upsertThread(thread, read) {
    if (!thread || thread.id !== threadId) return;
    const metadataCurrent = canApply("thread", read);
    const capabilitiesCurrent = Object.hasOwn(thread, "capabilities") && canApply("thread:capabilities", read);
    if (!metadataCurrent && !capabilitiesCurrent) return;
    const { capabilities, ...metadata } = copy(thread);
    // A newer status/name event must not discard independently read capabilities.
    // Both fields still reject reads from a previous subscription epoch.
    state.thread = { ...state.thread, ...(metadataCurrent ? metadata : {}),
      ...(capabilitiesCurrent ? { capabilities } : {}) };
    touch(metadataCurrent ? "thread" : "thread:capabilities");
    if (capabilitiesCurrent) revisions.set("thread:capabilities", state.revision);
  }
  function upsertItem(turnId, item, read) {
    if (!turnId || !item?.id) return;
    if (!state.turns[turnId]) upsertTurn({ id: turnId }, read);
    const turn = state.turns[turnId];
    if (!turn) return;
    if (!canApply(`item:${turnId}:${item.id}`, read)) return;
    const previous = turn.items[item.id];
    if (previous && isCodexTerminal(previous.status) && item.status && !isCodexTerminal(item.status)) return;
    // A summary must not erase an explicitly loaded full detail or completed text.
    if (previous && ((previous.detailsLoaded && (isCodexTerminal(previous.status) || isCodexTerminal(turn.status))) ||
      (isCodexTerminal(previous.status) && !previous.hasDetails)) && item.hasDetails && !item.detailsLoaded) return;
    turn.items[item.id] = { ...previous, ...copy(item) };
    const activity = mergeCodexSubagentActivity(previous?.presentation?.activity, item.presentation?.activity);
    if (activity) turn.items[item.id].presentation = { ...turn.items[item.id].presentation, activity };
    if (!previous) {
      itemBirthRevisions.set(`${turnId}:${item.id}`, state.revision + 1);
    }
    if (!turn.itemOrder.includes(item.id)) turn.itemOrder.push(item.id);
    if (!read) {
      const birthRevision = itemBirthRevisions.get(`${turnId}:${item.id}`);
      if (birthRevision != null) liveItemBirthRevisions.set(`${turnId}:${item.id}`, birthRevision);
      if (turn.itemsLatestLoaded && birthRevision > windowReadRevisions.get(turnId)) includeWindowItems(turn, [item.id]);
    }
    touch(`item:${turnId}:${item.id}`);
  }
  function upsertTurn(turn, read) {
    if (!turn?.id) return;
    if (read && read.epochGeneration !== epochGeneration) return;
    const { items, ...metadata } = turn;
    const previous = state.turns[turn.id];
    const originalOrder = [...(previous?.itemOrder || [])];
    if (!previous || canApply(`turn:${turn.id}`, read)) {
      const next = { ...previous, ...copy(metadata), items: previous?.items || {}, itemOrder: previous?.itemOrder || [] };
      const correctUnconfirmedHistory = ["interrupted", "aborted", "cancelled"].includes(previous?.status) &&
        !previous.completedAt && previous.statusConfirmed !== true && ["rollout", "unconfirmed-history"].includes(metadata.statusSource);
      if (isCodexTerminal(previous?.status) && metadata.status && !isCodexTerminal(metadata.status) && !correctUnconfirmedHistory) {
        next.status = previous.status;
        next.statusConfirmed = previous.statusConfirmed;
        next.completedAt = previous.completedAt;
      }
      state.turns[turn.id] = next;
      if (!state.turnOrder.includes(turn.id)) state.turnOrder.push(turn.id);
      touch(`turn:${turn.id}`);
    }
    for (const item of items || []) upsertItem(turn.id, item, read);
    if (items?.length) applyHistoryItemOrder(turn.id, items.map((item) => item.id), {
      headId: items[0].type === "userMessage" ? items[0].id : undefined
    }, originalOrder);
  }
  function applyHistoryItemOrder(turnId, ids, options = {}, originalOrder) {
    const turn = state.turns[turnId];
    if (options.authoritative) {
      turn.historyItemOrder = mergeItemOrder(turn.historyItemOrder || [], ids, options);
      turn.itemOrder = [...turn.historyItemOrder, ...turn.itemOrder.filter((id) => !turn.historyItemOrder.includes(id))];
    } else {
      // Keep live chronology while adding sparse history, without claiming single WS items are history.
      const known = new Set([...(turn.historyItemOrder || []), ...ids]);
      // Newly upserted summary IDs have no established position yet.
      turn.itemOrder = mergeItemOrder(originalOrder || turn.itemOrder, ids, options);
      turn.historyItemOrder = turn.itemOrder.filter((id) => known.has(id));
    }
    if (turn.itemsLatestLoaded) includeWindowItems(turn, []);
  }
  function applyTurnsPage(page, read = beginRead(), { older = false } = {}) {
    if (page?.threadId && page.threadId !== threadId) return;
    if (read.epochGeneration !== epochGeneration) return;
    const originalOrder = [...state.turnOrder];
    const beforeId = older ? undefined : originalOrder.find((id) => !historyTurnIds.has(id));
    for (const turn of page.turns || []) upsertTurn(turn, read);
    state.turnOrder = mergeOrder(originalOrder, (page.turns || []).map((turn) => turn.id), { older, beforeId });
    for (const turn of page.turns || []) historyTurnIds.add(turn.id);
    if (older || !state.initialized) {
      state.olderCursor = page.olderCursor ?? null; state.hasMore = Boolean(page.hasMore);
    }
    state.initialized = true; touch();
  }
  function applyItemsPage(turnId, page, read = beginRead()) {
    if (read.epochGeneration !== epochGeneration || (page.threadId && page.threadId !== threadId) || (page.turnId && page.turnId !== turnId)) return;
    const pageKey = `items-page:${turnId}`;
    const currentPage = canApply(pageKey, read);
    for (const item of page.items || []) {
      upsertItem(turnId, item, read);
      itemBirthRevisions.delete(`${turnId}:${item.id}`);
    }
    const turn = state.turns[turnId];
    if (turn) {
      const ids = (page.items || []).map((item) => item.id);
      applyHistoryItemOrder(turnId, ids, { authoritative: currentPage, afterId: turn.itemsPageTail,
        beforeId: !turn.itemsPageLoaded ? turn.itemsWindowIds?.[0] : undefined });
      if (currentPage) {
        if (turn.itemsLatestLoaded) includeWindowItems(turn, ids);
        turn.confirmedItemIds = [...new Set([...(turn.confirmedItemIds || []), ...ids])];
        turn.itemsPageTail = page.latestItemId || ids.at(-1) || turn.itemsPageTail;
        turn.nextCursor = page.nextCursor ?? null; turn.hasMore = Boolean(page.hasMore);
        turn.itemsPageLoaded = true;
        turn.hasMoreItems = Boolean(page.hasMore); turn.itemsHasMore = Boolean(page.hasMore);
        turn.itemsNextCursor = page.nextCursor ?? null; touch(pageKey);
        const latestKey = `latest-items-page:${turnId}`;
        const tail = page.latestItemId || ids.at(-1);
        if (!page.hasMore && tail && turn.itemsLatestLoaded && canApply(latestKey, read)) {
          turn.itemsLatestTail = tail;
          turn.itemsLatestNextCursor = null;
          turn.itemsLatestHasMore = false;
          turn.itemsLatestHasEarlier = false;
          turn.itemsEarlierCursor = null;
          turn.itemsEarlierHasMore = false;
          touch(`earlier-items-page:${turnId}`);
          touch(latestKey);
        }
      }
    }
  }
  function applyLatestItemsPage(turnId, page, read = beginRead(), { reset = false } = {}) {
    if (read.epochGeneration !== epochGeneration || (page.threadId && page.threadId !== threadId) || (page.turnId && page.turnId !== turnId)) return;
    const pageKey = `latest-items-page:${turnId}`;
    const currentPage = canApply(pageKey, read);
    const previous = state.turns[turnId];
    const windowLoaded = Boolean(previous?.itemsLatestLoaded);
    const originalOrder = [...(previous?.itemOrder || [])];
    const originalHistory = [...(previous?.historyItemOrder || [])];
    const ids = [...new Set((page.items || []).map((item) => item.id).filter(Boolean))];
    const incoming = new Set(ids);
    const confirmed = new Set(previous?.confirmedItemIds || []);
    // A newer summary or WS item can arrive while the descending snapshot is in flight.
    const newerId = originalOrder.find((id) => !incoming.has(id) && !confirmed.has(id) &&
      (itemBirthRevisions.get(`${turnId}:${id}`) || 0) > read.revision);
    const firstPosition = (page.items || []).find((item) => Number.isSafeInteger(item.position) && item.position >= 0)?.position;
    const positionedId = firstPosition == null ? undefined : originalOrder.find((id) => !incoming.has(id) &&
      Number.isSafeInteger(previous.items[id]?.position) && previous.items[id].position > firstPosition);
    const beforeId = !currentPage ? latestItemHeads.get(turnId) || positionedId || newerId
      : reset ? positionedId || newerId : undefined;
    const afterId = currentPage && !reset ? previous?.itemsLatestTail : undefined;
    for (const item of page.items || []) {
      upsertItem(turnId, item, read);
      itemBirthRevisions.delete(`${turnId}:${item.id}`);
    }
    const turn = state.turns[turnId];
    if (!turn) return;
    const ordering = { authoritative: currentPage, afterId, beforeId };
    turn.historyItemOrder = mergeItemOrder(originalHistory, ids, ordering);
    // Keep unconfirmed steer/WS items in place until an overlapping official slice orders them.
    turn.itemOrder = mergeItemOrder(originalOrder, ids, ordering);
    if (!currentPage) return;
    turn.confirmedItemIds = [...new Set([...(turn.confirmedItemIds || []),
      ...(page.items || []).filter((item) => item.id && item.type).map((item) => item.id)])];
    turn.itemsLatestLoaded = true;
    turn.itemsLatestTail = page.latestItemId || ids.at(-1) || turn.itemsLatestTail;
    turn.itemsLatestNextCursor = reset ? null : page.nextCursor ?? null;
    turn.itemsLatestHasMore = !reset && Boolean(page.hasMore);
    if (reset) {
      const earlierKey = `earlier-items-page:${turnId}`;
      if (canApply(earlierKey, read)) {
        turn.itemsLatestHasEarlier = Boolean(page.hasMore);
        turn.itemsEarlierCursor = page.nextCursor ?? null;
        turn.itemsEarlierHasMore = Boolean(page.hasMore);
        touch(earlierKey);
      }
      const liveIds = originalOrder.filter((id) => (liveItemBirthRevisions.get(`${turnId}:${id}`) || 0) > read.revision);
      includeWindowItems(turn, [...ids, ...liveIds], { reset: !windowLoaded });
      if (!windowLoaded) windowReadRevisions.set(turnId, read.revision);
      if (ids.length) latestItemHeads.set(turnId, ids[0]);
    } else includeWindowItems(turn, ids);
    touch(pageKey);
  }
  function applyEarlierItemsPage(turnId, page, read = beginRead()) {
    if (read.epochGeneration !== epochGeneration || (page.threadId && page.threadId !== threadId) || (page.turnId && page.turnId !== turnId)) return;
    const pageKey = `earlier-items-page:${turnId}`;
    const currentPage = canApply(pageKey, read);
    const turn = state.turns[turnId];
    if (!turn?.itemsLatestLoaded) return;
    const ids = [...new Set((page.items || []).map((item) => item.id).filter(Boolean))];
    const originalOrder = [...turn.itemOrder];
    const originalHistory = [...(turn.historyItemOrder || [])];
    const beforeId = turn.itemsWindowIds?.[0];
    for (const item of page.items || []) {
      upsertItem(turnId, item, read);
      itemBirthRevisions.delete(`${turnId}:${item.id}`);
    }
    const ordering = { authoritative: currentPage, beforeId };
    turn.historyItemOrder = mergeItemOrder(originalHistory, ids, ordering);
    turn.itemOrder = mergeItemOrder(originalOrder, ids, ordering);
    if (!currentPage) return;
    turn.confirmedItemIds = [...new Set([...(turn.confirmedItemIds || []),
      ...(page.items || []).filter((item) => item.id && item.type).map((item) => item.id)])];
    includeWindowItems(turn, ids);
    turn.itemsEarlierCursor = page.nextCursor ?? null;
    turn.itemsEarlierHasMore = Boolean(page.hasMore);
    turn.itemsLatestHasEarlier = Boolean(page.hasMore);
    touch(pageKey);
  }
  function applyInitialHistory(payload, read = beginRead()) {
    const { turnsPage, itemsPage, summary } = prepareInitialHistory(payload, threadId);
    if (read.epochGeneration !== epochGeneration) return false;
    applyTurnsPage(turnsPage, read);
    if (itemsPage) {
      const currentPage = canApply(`latest-items-page:${itemsPage.turnId}`, read);
      applyLatestItemsPage(itemsPage.turnId, itemsPage, read, { reset: true });
      // Non-overlapping summaries remain available to state projection, outside the visible window.
      upsertTurn(summary, read);
      if (currentPage) {
        const turn = state.turns[itemsPage.turnId];
        turn.itemsLatestRequested = true;
        turn.itemsLatestHydratedStatus = turnsPage.turns[0].status;
      }
    }
    return true;
  }
  function upsertRequest(request, read, { persistReceipt = true, preserveDraft = false } = {}) {
    if (!request?.id || (request.threadId && request.threadId !== threadId) || !canApply(`request:${request.id}`, read)) return;
    const previous = state.requests[request.id];
    const next = mergeRequest(previous, request, threadId);
    if (next === previous) return;
    state.requests[request.id] = next;
    if (!state.requestOrder.includes(request.id)) state.requestOrder.push(request.id);
    touch(`request:${request.id}`); if (persistReceipt) persist({ receiptId: request.id, preserveDraft });
  }
  function queueRequest(request, { preserveDraft = false } = {}) {
    const draft = state.draft;
    const previous = state.requests[request.id];
    upsertRequest({ ...request, localOnly: true }, undefined, { persistReceipt: false });
    if (!preserveDraft) state.draft = { text: "", attachments: [] };
    try { persist({ required: true, receiptId: request.id }); }
    catch (error) {
      state.draft = draft;
      if (!previous) { delete state.requests[request.id]; state.requestOrder = state.requestOrder.filter((id) => id !== request.id); }
      throw error;
    }
    if (!state.submittedRequestIds.includes(request.id)) state.submittedRequestIds.push(request.id);
  }
  function beginSocket() { socketGeneration += 1; return socketGeneration; }
  function applyEvent(event, generation) {
    if (generation !== socketGeneration || event?.threadId !== threadId || event.schemaVersion !== 2) return { ignored: true };
    if (event.epoch !== state.epoch) {
      if (event.type !== "sync.required") return { ignored: true, reconnect: true };
      // The first handshake establishes a baseline; only a known epoch change invalidates reads.
      if (state.epoch) epochGeneration += 1;
      state.epoch = event.epoch; state.seq = 0;
    }
    const seq = Number(event.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) return { ignored: true };
    if (event.type !== "sync.required" && seq <= state.seq) return { ignored: true };
    const gap = seq > state.seq + 1;
    state.seq = Math.max(state.seq, seq);
    const payload = event.payload || {};
    // Polling includes the preceding turn. It may update a loaded turn, but must
    // not append unseen history after the latest turn or widen the lazy window.
    const metadataTurnId = event.type === "turn.metadata" && state.turns[payload.turn?.id] ? payload.turn.id : "";
    if (event.type === "item.upsert") upsertItem(payload.turnId, payload.item);
    if (event.type === "turn.upsert") upsertTurn({ ...payload.turn, statusConfirmed: payload.turn?.statusConfirmed ?? true });
    if (metadataTurnId) {
      const { items, ...metadata } = payload.turn;
      upsertTurn(metadata);
    }
    if (event.type === "request.updated") upsertRequest(payload.request);
    if (event.type === "interaction.updated") interactions.applyUpdate(payload);
    if (event.type === "thread.updated" || event.type === "sync.required") upsertThread(payload.thread);
    if (event.type === "sync.required" && payload.request) upsertRequest(payload.request);
    if (event.type === "item.delta" && ["text", "summary", "aggregatedOutput"].includes(payload.field)) {
      const item = state.turns[payload.turnId]?.items[payload.itemId];
      if (!item || isCodexTerminal(item.status) || isCodexTerminal(state.turns[payload.turnId]?.status)) return { sync: !item || gap };
      const previous = Array.isArray(item[payload.field]) ? item[payload.field].join("\n") : String(item[payload.field] || "");
      const text = `${previous}${payload.text || ""}`;
      upsertItem(payload.turnId, { ...item, [payload.field]: text,
        presentation: { ...item.presentation, text: payload.field === "text" ? text : `${item.presentation?.text || ""}${payload.text || ""}` } });
    }
    touch();
    return { metadataTurnId, sync: gap || ["sync.required", "history.changed"].includes(event.type) ||
      (event.type === "turn.upsert" && isCodexTerminal(payload.turn?.status)) ||
      (event.type === "request.updated" && isCodexTerminal(payload.request?.state)) };
  }
  return { state, storageKey, beginRead, setDraft, persist, upsertThread, upsertTurn, upsertItem,
    applyTurnsPage, applyItemsPage, applyLatestItemsPage, applyEarlierItemsPage, applyInitialHistory,
    upsertRequest, queueRequest, beginSocket, applyEvent, interactions };
}
