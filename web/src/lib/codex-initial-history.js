const invalid = () => new Error("首屏历史响应格式无效，请重试连接。");
const validItems = (items) => Array.isArray(items) && items.every((item) => typeof item?.id === "string" && item.id) &&
  new Set(items.map((item) => item.id)).size === items.length;
const validCursor = (page, key) => typeof page?.hasMore === "boolean" &&
  (page[key] == null || typeof page[key] === "string") && (!page.hasMore || Boolean(page[key]));

export function prepareInitialHistory(payload, threadId) {
  const { turnsPage, itemsPage } = payload || {};
  if (turnsPage?.threadId !== threadId || !Array.isArray(turnsPage.turns) || turnsPage.turns.length > 1 ||
    !validCursor(turnsPage, "olderCursor")) throw invalid();
  const turn = turnsPage.turns[0];
  if (turnsPage.turns.length === 0) {
    if (itemsPage !== null || turnsPage.hasMore) throw invalid();
    return { turnsPage, itemsPage, summary: null };
  }
  if (typeof turn?.id !== "string" || !turn.id || !validItems(turn.items || []) ||
    itemsPage?.threadId !== threadId || itemsPage.turnId !== turn.id || !validItems(itemsPage.items) ||
    itemsPage.items.length > 30 || !validCursor(itemsPage, "nextCursor") ||
    (itemsPage.latestItemId != null && typeof itemsPage.latestItemId !== "string") ||
    (itemsPage.items.length && itemsPage.latestItemId !== itemsPage.items.at(-1).id)) throw invalid();
  const fullIds = new Set(itemsPage.items.map((item) => item.id));
  return {
    turnsPage: { ...turnsPage, turns: [{ ...turn, items: [] }] },
    itemsPage,
    // Apply full content before sparse summaries without advancing the read token.
    summary: { id: turn.id, items: (turn.items || []).filter((item) => !fullIds.has(item.id)) }
  };
}

export function createCodexInitialHistory({ store, call, base, isDisposed,
  supportsInitialHistory = () => false, checkInitialHistorySupport, onItems = () => {} }) {
  let pending = null, controller = null, disabled = false;
  function available() { return !disabled && !store.state.initialized && supportsInitialHistory(); }
  function read(token) {
    if (pending) return pending;
    if (!available() || isDisposed()) return Promise.resolve(false);
    controller = new AbortController();
    const signal = controller.signal;
    pending = (async () => {
      let payload;
      try { payload = await call(`${base}/initial-history`, { signal }); }
      catch (error) {
        if (isDisposed() || signal.aborted) throw error;
        if (error.status !== 404 || !checkInitialHistorySupport) throw error;
        const supported = await checkInitialHistorySupport({ signal });
        if (isDisposed() || signal.aborted) return true;
        if (supported !== false) throw error;
        disabled = true;
        return false;
      }
      if (!isDisposed() && !signal.aborted && store.applyInitialHistory(payload, token)) {
        if (payload.itemsPage) void onItems(payload.itemsPage.turnId);
      }
      return true;
    })().finally(() => { pending = null; controller = null; });
    return pending;
  }
  return { available, read, dispose() { controller?.abort(); } };
}
