import { createCodexInitialHistory } from "./codex-initial-history.js";

export function createCodexReadRefresh({ store, call, base, isDisposed, onTurns,
  serverRequest, onSettled, reconcileDismissedRequests, refreshInteractions = () => {}, onMetadataRead = () => {},
  supportsInitialHistory, checkInitialHistorySupport, onInitialItems }) {
  const { state } = store;
  const initial = createCodexInitialHistory({ store, call, base, isDisposed,
    supportsInitialHistory, checkInitialHistorySupport, onItems: onInitialItems });
  let refreshPromise = null;
  let metadataPromise = null;
  let refreshAgain = false;
  let backgroundScheduled = false;
  let requestListRevision = 0;
  const failures = { metadata: "", turns: "" };
  const revisions = { metadata: 0, turns: 0 };

  function publishFailure(domain, revision, message) {
    if (isDisposed() || revisions[domain] !== revision) return;
    failures[domain] = message;
    state.historyReadError = Object.values(failures).filter(Boolean).join("\n");
  }

  async function readHistory(domain, operation) {
    if (isDisposed()) return;
    const revision = ++revisions[domain];
    try {
      await operation();
      publishFailure(domain, revision, "");
    } catch (error) {
      publishFailure(domain, revision, error?.message || String(error));
      throw error;
    }
  }

  function needsRecovery(domain) { return !isDisposed() && (domain ? Boolean(failures[domain]) : Object.values(failures).some(Boolean)); }

  function refreshMetadata(read = store.beginRead()) {
    if (isDisposed()) return Promise.resolve();
    if (metadataPromise) return metadataPromise;
    onMetadataRead();
    const operation = readHistory("metadata", async () => {
      const payload = await call(base);
      if (payload?.thread?.id !== state.threadId) throw new Error("会话信息响应格式无效，请重试连接。");
      if (!isDisposed()) store.upsertThread(payload.thread, read);
    }).finally(() => {
      if (metadataPromise === operation) metadataPromise = null;
    });
    metadataPromise = operation;
    return operation;
  }

  function refreshLatestTurns(read = store.beginRead()) {
    return readHistory("turns", async () => {
      if (initial.available() && await initial.read(read)) return;
      if (isDisposed()) return;
      const page = await call(`${base}/turns?limit=1`);
      if (!Array.isArray(page?.turns) || page.threadId && page.threadId !== state.threadId) {
        throw new Error("历史消息响应格式无效，请重试连接。");
      }
      if (!isDisposed()) { store.applyTurnsPage(page, read); void onTurns(page.turns || []); }
    });
  }

  async function readRequestList(read) {
    const revision = ++requestListRevision;
    try {
      const payload = await call(`${base}/requests`);
      if (isDisposed()) return null;
      if (!Array.isArray(payload?.requests)) throw new Error("会话回执列表格式无效，请重试连接。");
      const receipts = payload.requests;
      for (const receipt of receipts) store.upsertRequest(serverRequest(receipt), read);
      state.requestListReady = true;
      if (requestListRevision === revision) state.requestListError = "";
      return receipts;
    } catch (error) {
      if (!isDisposed() && requestListRevision === revision) state.requestListError = error?.message || String(error);
      throw error;
    }
  }

  async function refreshLatest({ reconcileDismissed = true } = {}) {
    if (isDisposed()) return;
    if (refreshPromise) {
      refreshAgain = true;
      await refreshPromise;
      if (reconcileDismissed) await reconcileDismissedRequests();
      return;
    }
    refreshPromise = (async () => {
      for (let batch = 0; batch < 2; batch += 1) {
        refreshAgain = false;
        const read = store.beginRead();
        void refreshInteractions();
        await Promise.allSettled([
          refreshMetadata(read),
          refreshLatestTurns(read),
          readRequestList(read)
        ]);
        if (!refreshAgain || isDisposed()) break;
      }
    })();
    try { await refreshPromise; }
    finally {
      refreshPromise = null;
      onSettled();
      if (refreshAgain && !isDisposed()) scheduleBackgroundRefresh();
    }
    if (reconcileDismissed) await reconcileDismissedRequests();
  }

  function scheduleBackgroundRefresh() {
    if (backgroundScheduled) return;
    backgroundScheduled = true;
    queueMicrotask(() => {
      backgroundScheduled = false;
      if (isDisposed() || refreshPromise) return;
      // Continuous notifications must not keep initial loading or sending locked.
      void refreshLatest({ reconcileDismissed: false }).catch(() => {});
    });
  }

  return { refreshLatest, refreshMetadata, refreshLatestTurns, readRequestList, needsRecovery, dispose: initial.dispose };
}
