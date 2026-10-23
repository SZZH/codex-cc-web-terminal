export function createCodexHistoryItems({ store, call, base, isDisposed, onItems }) {
  const { state } = store;
  const pending = new Map();

  function loadItems(turnId, { latest = false, earlier = false } = {}) {
    const key = `${turnId}:${earlier ? "earlier" : latest ? "latest" : "history"}`;
    if (pending.has(key)) return pending.get(key);
    const read = store.beginRead();
    const turn = state.turns[turnId];
    if (earlier && (!turn?.itemsEarlierHasMore || !turn.itemsEarlierCursor)) return Promise.resolve({ items: [], hasMore: false });
    if (latest) turn.itemsLatestRequested = true;
    const reset = latest && (!turn?.itemsLatestLoaded || !turn.itemsLatestTail);
    const cursor = earlier ? turn.itemsEarlierCursor : latest ? reset ? "" : turn.itemsLatestNextCursor || ""
      : turn?.nextCursor || turn?.itemsNextCursor || "";
    const anchor = latest ? reset ? "" : turn.itemsLatestTail
      : turn?.itemsPageLoaded ? turn.itemsPageTail : "";
    const query = new URLSearchParams(cursor ? { cursor } : anchor ? { after: anchor } : { cursor: "" });
    // Backward reads are user initiated; keep initial and live reads lightweight.
    query.set("limit", earlier ? "90" : "30");
    if (reset || earlier) query.set("sortDirection", "desc");
    const operation = call(`${base}/turns/${encodeURIComponent(turnId)}/items?${query}`)
      .then((page) => {
        if (!Array.isArray(page.items)) throw new Error("执行过程暂时无法读取。");
        if (earlier && page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) {
          throw new Error("更早消息分页尚未就绪，请重试。");
        }
        if (!isDisposed()) {
          if (earlier) store.applyEarlierItemsPage(turnId, page, read);
          else if (latest) store.applyLatestItemsPage(turnId, page, read, { reset });
          else store.applyItemsPage(turnId, page, read);
          onItems(turnId);
        }
        return latest ? { ...page, latestWindow: reset } : page;
      }).finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  }

  return { loadItems };
}
