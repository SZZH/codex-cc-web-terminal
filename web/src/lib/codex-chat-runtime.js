import { activeCodexTurnId, isCodexRequestUnresolved, isCodexTerminal,
  isCodexRequestDismissedMissing as isDismissedMissing } from "./codex-chat-store.js";
import { isEmptyCodexReasoning } from "./codex-chat-presentation.js";
import { createCodexReadRequests } from "./codex-read-requests.js";
import { createCodexHistoryItems } from "./codex-history-items.js";
import { createCodexHistoryWindow } from "./codex-history-window.js";
import { createCodexReadRefresh } from "./codex-read-refresh.js";
import { createCodexItemHydration } from "./codex-item-hydration.js";
import { createCodexRuntimeErrors } from "./codex-runtime-errors.js";
import { createCodexInteractionRuntime } from "./codex-interactions/runtime.js";
import { createCodexConnection } from "./codex-connection.js";
import { createQuestionHistory } from "./codex-question-history.js";

export function createCodexChatRuntime({ store, request, createSocket,
  location = globalThis.location, newId = () => globalThis.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  timeoutMs, pollMs = 2000, maxPolls = Infinity, visibility = globalThis.document, now = Date.now, onForeground = () => {},
  supportsInitialHistory, checkInitialHistorySupport,
  yieldPage = () => new Promise((resolve) => setTimeout(resolve, 0)),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const { state } = store;
  const base = `/api/v2/codex/threads/${encodeURIComponent(state.threadId)}`;
  const readRequests = createCodexReadRequests({ request, timeoutMs, setTimer, clearTimer });
  const call = readRequests.call;
  let disposed = false;
  const errors = createCodexRuntimeErrors({ state, isDisposed: () => disposed });
  let pageHidden = Boolean(visibility?.hidden);
  let pollingTimer = null;
  let submitPromise = null;
  let pollCount = 0;
  let idlePolls = 0;
  let requestSignature = "";
  let polling = false;
  let nextCapabilityReadAt = 0;
  let questionRevision = -1, unansweredDesktopQuestion = false;
  const requestChecks = new Map();
  const requestReads = { active: Promise.resolve(), dismissed: Promise.resolve() };
  const detailLoads = new Map();
  const detailChecks = new Map();
  const detailWaiters = [];
  let visibleDetailItems = null;
  let activeDetailReads = 0;
  let detailRetryTimer = null;
  const promotions = new Map();
  const cancellations = new Map();
  const interactions = createCodexInteractionRuntime({ store: store.interactions, base, call,
    isDisposed: () => disposed, onSettled: () => schedulePoll() });
  const { loadItems } = createCodexHistoryItems({ store, call, base, isDisposed: () => disposed,
    onItems: (turnId) => { void syncVisibleDetails(turnId); } });
  const { loadOlder, hasOlderHistory } = createCodexHistoryWindow({ store, call, base, loadItems, errors, isDisposed: () => disposed });
  const hydration = createCodexItemHydration({ store, loadItems, isDisposed: () => disposed,
    syncVisibleDetails, loadDetail, schedulePoll, scheduleDetailRetry, yieldPage });
  const { hydrateSummaryTurns, syncItems, syncLatestItems, setProcessExpanded, setTurnVisibility } = hydration;
  const { refreshLatest, refreshMetadata, refreshLatestTurns, readRequestList, needsRecovery: needsHistoryRecovery,
    dispose: disposeReads } = createCodexReadRefresh({
    store, call, base, isDisposed: () => disposed, onTurns: hydrateSummaryTurns,
    serverRequest, onSettled: schedulePoll, reconcileDismissedRequests, refreshInteractions: interactions.refresh,
    supportsInitialHistory, checkInitialHistorySupport, onInitialItems: syncVisibleDetails,
    onMetadataRead: () => { nextCapabilityReadAt = now() + 10_000; }
  });

  function serverRequest(receipt) {
    return { ...receipt, error: receipt.error ?? null, confirmationDismissed: false, localOnly: false };
  }

  const connection = createCodexConnection({ store, createSocket, location, errors,
    isDisposed: () => disposed, setTimer, clearTimer, now,
    onOpen() {
      void interactions.refresh();
      if (!state.loading) void reconcileDismissedRequests();
    },
    onMessage(message, generation, disconnect) {
      const eventToken = errors.begin("events");
      try {
        const event = JSON.parse(message.data);
        if (["request.updated", "sync.required"].includes(event.type) && event.payload?.request) {
          event.payload.request = serverRequest(event.payload.request);
        }
        const result = store.applyEvent(event, generation);
        if (result.reconnect) { disconnect(); return; }
        if (result.sync) void refreshLatest().then(() => syncLatestItems({ reconcile: true }));
        if (result.metadataTurnId && state.turns[result.metadataTurnId]?.itemsLatestLoaded) {
          void syncItems(result.metadataTurnId, { automatic: true,
            reconcile: isCodexTerminal(state.turns[result.metadataTurnId].status) });
        }
        if (!result.ignored) { errors.succeed(eventToken); void syncVisibleDetails(); }
        schedulePoll();
      } catch (error) { errors.fail(eventToken, error); }
    }
  });

  function unresolved() { return state.requestOrder.map((id) => state.requests[id]).filter(isCodexRequestUnresolved); }
  // Manual unlock keeps the uncertainty, but lifecycle/user events probe missing receipts.
  function reconcileDismissedRequests() {
    return Promise.allSettled(unresolved().filter(isDismissedMissing).map((receipt) => checkRequest(receipt.id)));
  }
  function needsTurnStatusRead() {
    const status = state.turns[state.turnOrder.at(-1)]?.status;
    return status === "unknown" || state.connection !== "connected" && ["inProgress", "running"].includes(status);
  }
  function needsQuestionCapability() {
    if (state.thread?.capabilities?.desktopQuestionAnswers === true) return false;
    if (questionRevision !== state.presentationRevision) {
      questionRevision = state.presentationRevision;
      const present = createQuestionHistory(state);
      unansweredDesktopQuestion = Object.values(state.turns).some((turn) => Object.values(turn.items).some((item) => {
        const question = item.presentation?.question;
        if (question?.source !== "desktop" || question.delivery !== "async" || question.truncated || question.canRespond === false ||
          !Array.isArray(question.questions) || !question.questions.length) return false;
        const current = present(question);
        return current.status === "pending" && !current.pendingResponse;
      }));
    }
    return unansweredDesktopQuestion;
  }
  function needsControlCapability() {
    if (needsQuestionCapability()) return true;
    const turnId = activeCodexTurnId(state);
    return Boolean(turnId && state.thread?.capabilities?.desktopInterrupt !== true &&
      !state.requestOrder.some((id) => {
        const receipt = state.requests[id];
        return receipt.turnId === turnId && ["accepted", "running"].includes(receipt.state) &&
          !["desktopQueue", "desktopQuestion", "desktopSettings", "desktopSteer"].includes(receipt.executionRoute);
      }));
  }
  function needsFullHistoryRecovery() { return needsHistoryRecovery("turns") || needsHistoryRecovery("metadata") && !needsControlCapability(); }
  function needsRegularPolling() { return needsFullHistoryRecovery() || interactions.needsRecovery() || unresolved().some((receipt) => !isDismissedMissing(receipt)) || activeCodexTurnId(state) || needsTurnStatusRead() || hydration.hasFailures(); }
  async function refreshControlCapability() {
    if (disposed || !needsControlCapability() || now() < nextCapabilityReadAt) return;
    try { await refreshMetadata(); } catch { /* Metadata failure stays visible and uses the same bounded retry. */ }
  }
  function schedulePoll() {
    if (disposed) return;
    const regular = needsRegularPolling();
    if (!regular && !needsControlCapability()) { clearTimer(pollingTimer); pollingTimer = null; return; }
    if (polling || pollingTimer || pollCount >= maxPolls) return;
    const interval = regular ? Math.min(10000, pollMs * 2 ** Math.min(idlePolls, 3)) : Math.max(1, nextCapabilityReadAt - now());
    const delay = visibility?.hidden ? Math.max(30000, pollMs, interval) : interval;
    pollingTimer = setTimer(async () => {
      pollingTimer = null; pollCount += 1;
      if (needsRegularPolling()) await pollRequests({ reconcileDismissed: false });
      else await refreshControlCapability();
      schedulePoll();
    }, delay);
  }
  async function pollRequests({ reconcileDismissed = true } = {}) {
    if (disposed) return;
    if (polling) { if (reconcileDismissed) await reconcileDismissedRequests(); return; }
    const errorToken = errors.begin("poll");
    polling = true;
    let receiptListRead = false;
    try {
      void interactions.refresh();
      const recoveringHistory = needsFullHistoryRecovery();
      if (recoveringHistory) await refreshLatest({ reconcileDismissed: false });
      else await refreshControlCapability();
      if (disposed) return;
      const receipts = await readRequestList(store.beginRead());
      receiptListRead = true;
      if (disposed) return;
      const signature = JSON.stringify(receipts.map(({ id, state, turnId, updatedAt }) => [id, state, turnId, updatedAt]));
      const changed = signature !== requestSignature;
      requestSignature = signature;
      idlePolls = changed ? 0 : idlePolls + 1;
      const known = new Set(receipts.map((receipt) => receipt.id));
      await Promise.allSettled(unresolved().filter((receipt) => !known.has(receipt.id) &&
        !isDismissedMissing(receipt)).map((receipt) => checkRequest(receipt.id)));
      if (changed && !recoveringHistory) await refreshLatest({ reconcileDismissed: false });
      else if (!recoveringHistory && needsTurnStatusRead()) await refreshLatestTurns().catch(() => {});
      await syncLatestItems({ reconcile: changed || state.connection !== "connected" });
      await hydration.retryFailures();
      errors.succeed(errorToken);
    } catch (error) { idlePolls += 1; if (receiptListRead) errors.fail(errorToken, error); }
    finally { polling = false; schedulePoll(); }
    if (reconcileDismissed) await reconcileDismissedRequests();
  }
  function visibilityChanged() {
    const fromHidden = pageHidden;
    pageHidden = Boolean(visibility?.hidden);
    if (pageHidden || disposed) return;
    if (fromHidden) { onForeground(); nextCapabilityReadAt = 0; }
    connection.resume({ fromHidden });
    clearTimer(pollingTimer); pollingTimer = null; idlePolls = 0;
    void pollRequests().finally(schedulePoll);
  }
  visibility?.addEventListener?.("visibilitychange", visibilityChanged);
  function checkRequest(id) {
    if (disposed) return Promise.resolve(null);
    if (requestChecks.has(id)) return requestChecks.get(id);
    // Each lane reads one receipt; missing unlocked sends cannot hold up active sends.
    const lane = isDismissedMissing(state.requests[id] || {}) ? "dismissed" : "active";
    const operation = requestReads[lane].then(async () => {
      if (disposed) return null;
      const errorToken = errors.begin("confirmation", id);
      const read = store.beginRead();
      try {
        const payload = await call(`${base}/requests/${encodeURIComponent(id)}`);
        if (!disposed) store.upsertRequest(serverRequest(payload.request), read);
        errors.succeed(errorToken);
        return payload.request;
      } catch (error) {
        if (!disposed) {
          const current = state.requests[id];
          if (current && !isCodexTerminal(current.state) &&
            (current.localOnly === true || ["sending", "unknown"].includes(current.state))) store.upsertRequest({ ...current, state: "unknown",
            error: { ...(error.status === 404 || isDismissedMissing(current) ? { code: "receipt_not_found" } : {}),
              message: error.status === 404
                ? current.confirmationDismissed
                  ? "已手动解除发送锁定。原消息状态仍会核对；再次发送相同内容可能重复。"
                  : "服务器尚无这条发送记录。请核对其他客户端后，手动解除发送锁定。"
                : `连接暂时不可用，正在自动核对发送状态：${error.message}` } }, read);
        }
        if (error.status === 404) errors.succeed(errorToken);
        return null;
      } finally { schedulePoll(); }
    });
    requestReads[lane] = operation.catch(() => {});
    const tracked = operation.finally(() => requestChecks.delete(id));
    requestChecks.set(id, tracked);
    return tracked;
  }
  async function open() {
    state.loading = true;
    connection.connect();
    try {
      await refreshLatest({ reconcileDismissed: false });
      await Promise.allSettled(unresolved().filter((receipt) => receipt.state === "unknown").map((receipt) => checkRequest(receipt.id)));
      schedulePoll();
    } finally { state.loading = false; }
  }
  function detailVersion(turnId, item) { return `${item?.status || ""}:${state.turns[turnId]?.status || ""}`; }
  function detailVisible(turnId, item) {
    if (!item || isEmptyCodexReasoning(item) || !hydration.isRelevant(turnId)) return false;
    const turn = state.turns[turnId];
    if (turn?.itemsLatestRequested && !turn.itemsLatestLoaded ||
      Array.isArray(turn?.itemsWindowIds) && !turn.itemsWindowIds.includes(item.id)) return false;
    if (["userMessage", "agentMessage", "plan", "fileChange", "imageView"].includes(item.type)) return true;
    return visibleDetailItems ? visibleDetailItems.has(`${turnId}:${item.id}`) : hydration.isExpanded(turnId);
  }
  function needsDetail(turnId, item) {
    return item?.hasDetails && detailVisible(turnId, item) &&
      (!item.detailsLoaded || item.detailsLoadedState !== detailVersion(turnId, item));
  }
  function setDetailVisibility(items) {
    visibleDetailItems = new Set(items.map(({ turnId, itemId }) => `${turnId}:${itemId}`));
    return syncVisibleDetails();
  }
  function syncVisibleDetails(turnId) {
    if (disposed) return Promise.resolve();
    const turns = turnId ? [state.turns[turnId]].filter(Boolean) : Object.values(state.turns);
    const tasks = turns.flatMap((turn) => turn.itemOrder.filter((id) => needsDetail(turn.id, turn.items[id]))
      .map((id) => loadDetail(turn.id, id, { automatic: true })));
    scheduleDetailRetry();
    return Promise.all(tasks);
  }
  function scheduleDetailRetry() {
    clearTimer(detailRetryTimer); detailRetryTimer = null;
    if (disposed) return;
    const retries = [...detailChecks.values()].filter((check) => {
      const item = state.turns[check.turnId]?.items[check.itemId];
      return check.nextAt && Number.isFinite(check.nextAt) && !detailLoads.has(`${check.turnId}:${check.itemId}`) &&
        detailVisible(check.turnId, item) && (!item.detailsLoaded || item.detailsLoadedState !== detailVersion(check.turnId, item));
    });
    if (!retries.length) return;
    const nextAt = Math.min(...retries.map((check) => check.nextAt));
    const delay = visibility?.hidden ? Math.max(30000, nextAt - now()) : Math.max(10, nextAt - now());
    detailRetryTimer = setTimer(() => {
      detailRetryTimer = null;
      for (const check of retries) if (check.nextAt <= now()) void loadDetail(check.turnId, check.itemId, { automatic: true });
      scheduleDetailRetry();
    }, delay);
  }
  function acquireDetailRead() {
    if (disposed) return Promise.resolve(false);
    if (activeDetailReads < 2) { activeDetailReads += 1; return Promise.resolve(true); }
    return new Promise((resolve) => detailWaiters.push(resolve));
  }
  function releaseDetailRead() {
    activeDetailReads -= 1;
    const next = detailWaiters.shift();
    if (next) { activeDetailReads += 1; next(!disposed); }
  }
  function loadDetail(turnId, itemId, { automatic = false } = {}) {
    const key = `${turnId}:${itemId}`;
    if (detailLoads.has(key)) return detailLoads.get(key);
    const item = state.turns[turnId]?.items[itemId];
    let version = detailVersion(turnId, item);
    const check = detailChecks.get(key);
    if (automatic && (!detailVisible(turnId, item) || (item.detailsLoaded && item.detailsLoadedState === version) ||
      (check?.version === version && check.nextAt > now()))) return Promise.resolve(item);
    const operation = (async () => {
      const acquired = await acquireDetailRead();
      try {
        if (!acquired || disposed || (automatic && !detailVisible(turnId, state.turns[turnId]?.items[itemId]))) return;
        const current = state.turns[turnId]?.items[itemId];
        version = detailVersion(turnId, current);
        if (current) current.detailLoading = true;
        const read = store.beginRead();
        const payload = await call(`${base}/turns/${encodeURIComponent(turnId)}/items/${encodeURIComponent(itemId)}`);
        if (disposed) return;
        if (payload.item?.id !== itemId) throw new Error("详情响应与当前条目不一致。");
        store.upsertItem(turnId, { ...payload.item, truncated: Boolean(payload.item.truncated),
          truncatedFields: Array.isArray(payload.item.truncatedFields) ? payload.item.truncatedFields : [],
          detailsLoaded: true, detailsLoadedState: version, detailError: "", detailRetryable: false }, read);
        const applied = state.turns[turnId]?.items[itemId]?.detailsLoadedState === version;
        detailChecks.set(key, { turnId, itemId, version, attempts: 0, nextAt: applied ? 0 : now() + 1000 });
        return payload.item;
      } catch (error) {
        if (disposed) return;
        const retryable = !error.status || [408, 429].includes(error.status) || error.status >= 500;
        const attempts = (detailChecks.get(key)?.attempts || 0) + 1;
        detailChecks.set(key, { turnId, itemId, version, attempts,
          nextAt: retryable ? now() + Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5)) : Infinity });
        const current = state.turns[turnId]?.items[itemId];
        if (current) { current.detailError = error.message; current.detailRetryable = retryable; }
      } finally {
        const current = state.turns[turnId]?.items[itemId];
        if (current) current.detailLoading = false;
        if (acquired) releaseDetailRead();
        detailLoads.delete(key); scheduleDetailRetry();
      }
    })();
    detailLoads.set(key, operation); return operation;
  }

  function submit({ input, options, mode = "queue", expectedTurnId, preserveDraft = false, questionReply } = {}) {
    if (submitPromise) return submitPromise;
    if (unresolved().some((receipt) => receipt.state === "unknown" && !isDismissedMissing(receipt))) return Promise.reject(new Error("上一条发送状态尚未确认，正在自动核对，请稍后再发送。"));
    if (!["queue", "steer"].includes(mode)) return Promise.reject(new Error("不支持的消息发送方式。"));
    if (mode === "steer" && (!expectedTurnId || !questionReply && expectedTurnId !== activeCodexTurnId(state))) return Promise.reject(new Error("当前生成轮次已变化，请确认后重新引导。"));
    if (!String(input?.text || "").trim() && !input?.attachments?.length) return Promise.resolve(null);
    const errorToken = errors.begin("submit");
    state.submitting = true;
    submitPromise = (async () => {
      const id = newId();
      const createdAt = new Date().toISOString();
      const previewImages = preserveDraft ? [] : state.draft.attachments.filter((item) => item.kind === "image" && item.url)
        .map((item) => ({ url: item.url, alt: item.name }));
      const receipt = { id, threadId: state.threadId, state: "sending", localOnly: true, mode, ...(mode === "steer" ? { expectedTurnId } : {}),
        ...(questionReply ? { executionRoute: "desktopQuestion" } : {}),
        initialPlacement: mode === "queue" && activeCodexTurnId(state) ? "composer" : "timeline",
        ...(mode === "steer" ? { steerAfterItemId: state.turns[expectedTurnId]?.itemOrder.at(-1) || "", steerQueuedAt: Date.now() } : {}),
        input, options, previewImages, createdAt, updatedAt: createdAt };
      store.queueRequest(receipt, { preserveDraft });
      try {
        const payload = await call(questionReply ? `${base}/questions/${encodeURIComponent(questionReply.callId)}/respond` : `${base}/requests`, {
          method: "POST", body: JSON.stringify(questionReply
            ? { clientRequestId: id, expectedTurnId, index: questionReply.index, answer: questionReply.answer }
            : { clientRequestId: id, mode, ...(mode === "steer" ? { expectedTurnId } : {}), input, options }) });
        store.upsertRequest(serverRequest(payload.request), undefined, { preserveDraft: disposed });
        pollCount = 0; idlePolls = 0; schedulePoll();
        return payload.request;
      } catch (error) {
        // A gateway failure or request timeout can arrive after the server accepted the input.
        const rejected = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408;
        store.upsertRequest({ ...receipt, state: rejected ? "rejected" : "unknown", error: { message: error.message } },
          undefined, { preserveDraft: disposed });
        if (!rejected) { await checkRequest(id); pollCount = 0; schedulePoll(); }
        return state.requests[id];
      }
    })().then((receipt) => { errors.succeed(errorToken); return receipt; })
      .catch((error) => { errors.fail(errorToken, error); throw error; }).finally(() => {
      state.submitting = false; submitPromise = null;
    });
    return submitPromise;
  }
  async function interrupt() {
    if (state.interrupting) return;
    const expectedTurnId = activeCodexTurnId(state);
    const errorToken = errors.begin("interrupt");
    state.interrupting = true;
    try {
      const result = await call(`${base}/interrupt`, { method: "POST", body: JSON.stringify({ expectedTurnId }) });
      await refreshLatest();
      if (result?.goalPauseError) throw new Error(`当前回复已停止，但持续目标暂停失败：${result.goalPauseError}`);
      errors.succeed(errorToken);
    } catch (error) {
      errors.fail(errorToken, error);
      if (error.code === "interrupt_unconfirmed") await refreshLatest();
    }
    finally { state.interrupting = false; }
  }
  function promoteQueuedRequest(id) {
    if (promotions.has(id)) return promotions.get(id);
    const receipt = state.requests[id];
    const expectedTurnId = activeCodexTurnId(state);
    if (!(receipt?.state === "received" || receipt?.state === "queued" && receipt.executionRoute === "desktopQueue") || receipt.mode === "steer" || !expectedTurnId) return Promise.resolve(null);
    if (unresolved().some((request) => request.state === "unknown" && !isDismissedMissing(request))) return Promise.resolve(null);
    const errorToken = errors.begin("promote", id);
    store.upsertRequest({ ...receipt, steerAfterItemId: state.turns[expectedTurnId]?.itemOrder.at(-1) || "", steerQueuedAt: Date.now() });
    const read = store.beginRead();
    const operation = (async () => {
      try {
        const payload = await call(`${base}/requests/${encodeURIComponent(id)}/steer`, {
          method: "POST", body: JSON.stringify({ expectedTurnId })
        });
        if (!disposed) store.upsertRequest(payload.request, read);
        errors.succeed(errorToken);
        return payload.request;
      } catch (error) {
        // The original receipt remains authoritative: never submit another copy of its input.
        errors.fail(errorToken, error);
        const receipt = await checkRequest(id);
        if (receipt?.mode === "steer") errors.succeed(errorToken);
        return receipt;
      } finally { pollCount = 0; idlePolls = 0; schedulePoll(); }
    })().finally(() => promotions.delete(id));
    promotions.set(id, operation);
    return operation;
  }
  function cancelQueuedRequest(id) {
    if (cancellations.has(id)) return cancellations.get(id);
    if (state.requests[id]?.state !== "queued") return Promise.resolve(null);
    const errorToken = errors.begin("cancel", id);
    const operation = (async () => {
      try {
        const payload = await call(`${base}/requests/${encodeURIComponent(id)}/cancel`, {
          method: "POST", body: JSON.stringify({})
        });
        if (!disposed) store.upsertRequest(payload.request);
        errors.succeed(errorToken);
        return payload.request;
      } catch (error) {
        errors.fail(errorToken, error);
        const receipt = await checkRequest(id);
        if (receipt?.state === "cancelled") errors.succeed(errorToken);
        return receipt;
      } finally { pollCount = 0; idlePolls = 0; schedulePoll(); }
    })().finally(() => cancellations.delete(id));
    cancellations.set(id, operation);
    return operation;
  }
  function restoreRequest(id) {
    const receipt = state.requests[id];
    if (!receipt || receipt.executionRoute === "desktopQuestion" || !isCodexTerminal(receipt.state)) return false;
    const errorToken = errors.begin("restore");
    if (state.draft.text || state.draft.attachments.length) { errors.fail(errorToken, "请先处理当前草稿，再恢复失败消息。"); return false; }
    store.setDraft({ text: receipt.input?.text || "", attachments: (receipt.input?.attachments || []).map((item) => ({
      id: item.id, uploadedId: item.id, kind: "image", status: "uploaded", name: "已上传图片",
      url: `/api/attachments/images/${encodeURIComponent(item.id)}`
    })) });
    store.upsertRequest({ ...receipt, restoredToDraft: true });
    errors.succeed(errorToken);
    return true;
  }
  async function dismissUnknownReceipt(id) {
    const receipt = state.requests[id];
    if (receipt?.state !== "unknown" || receipt.confirmationDismissed || receipt.error?.code !== "receipt_not_found") return false;
    const errorToken = errors.begin("confirmation", id);
    const read = store.beginRead();
    try {
      const payload = await call(`${base}/requests/${encodeURIComponent(id)}`);
      if (!disposed) store.upsertRequest({ ...payload.request, error: payload.request.error ?? null, confirmationDismissed: false }, read);
      errors.succeed(errorToken);
      return false;
    } catch (error) {
      if (error.status !== 404 || disposed) { errors.fail(errorToken, error); return false; }
      errors.succeed(errorToken);
      const current = state.requests[id];
      if (current?.state !== "unknown" || current.confirmationDismissed) return false;
      store.upsertRequest({ ...current, confirmationDismissed: true,
        error: { code: "receipt_not_found", message: "已手动解除发送锁定。原消息状态仍会核对；再次发送相同内容可能重复。" } }, read);
      schedulePoll();
      return state.requests[id]?.confirmationDismissed === true;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; store.beginSocket(); connection.dispose();
    errors.dispose();
    interactions.dispose();
    disposeReads();
    readRequests.dispose();
    visibility?.removeEventListener?.("visibilitychange", visibilityChanged);
    clearTimer(pollingTimer); clearTimer(detailRetryTimer); store.persist();
    hydration.dispose();
    for (const waiter of detailWaiters.splice(0)) waiter(false);
  }
  return { open, refreshLatest, loadOlder, hasOlderHistory, loadItems, syncItems, loadDetail, setProcessExpanded, setDetailVisibility, setTurnVisibility,
    pollRequests, submit, checkRequest, interrupt, promoteQueuedRequest, cancelQueuedRequest, restoreRequest,
    dismissUnknownReceipt, interactions, dispose };
}
