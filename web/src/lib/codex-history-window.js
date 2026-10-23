export function createCodexHistoryWindow({ store, call, base, loadItems, errors, isDisposed }) {
  const { state } = store;
  let pending = null;
  const historyTurns = () => state.turnOrder.map((id) => state.turns[id]).filter(Boolean).reverse();
  const missingItems = () => historyTurns().filter((turn) => turn.itemsLatestRequested && !turn.itemsLatestLoaded);
  const earlierItems = () => historyTurns().find((turn) => turn.itemsEarlierHasMore);
  function hasOlderHistory() {
    return Boolean(missingItems().length || earlierItems() || state.hasMore);
  }
  async function loadTurnItems(turns) {
    for (let index = 0; index < turns.length && !isDisposed(); index += 2) {
      const results = await Promise.allSettled(turns.slice(index, index + 2)
        .map((turn) => loadItems(turn.id, { latest: true })));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  }
  function loadOlder() {
    if (pending) return pending;
    if (isDisposed() || !hasOlderHistory()) return Promise.resolve(false);
    const errorToken = errors.begin("older");
    pending = (async () => {
      const missing = missingItems();
      const turn = earlierItems();
      if (missing.length) {
        await loadTurnItems(missing);
      } else if (turn) {
        const cursor = turn.itemsEarlierCursor;
        const page = await loadItems(turn.id, { earlier: true });
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error("更早消息分页尚未就绪，请重试。");
      } else {
        const read = store.beginRead();
        const params = new URLSearchParams({ limit: "3", cursor: state.olderCursor || "" });
        const page = await call(`${base}/turns?${params}`);
        if (!Array.isArray(page?.turns) || page.turns.length > 3 || page.threadId && page.threadId !== state.threadId) {
          throw new Error("历史消息响应格式无效，请重试连接。");
        }
        if (page.hasMore && (!page.olderCursor || page.olderCursor === state.olderCursor)) {
          throw new Error("更早消息分页尚未就绪，请重试。");
        }
        if (isDisposed()) return false;
        store.applyTurnsPage(page, read, { older: true });
        for (const older of page.turns) {
          if (state.turns[older.id]) state.turns[older.id].itemsLatestRequested = true;
        }
        await loadTurnItems([...page.turns].reverse());
      }
      if (isDisposed()) return false;
      errors.succeed(errorToken);
      return true;
    })().catch((error) => { errors.fail(errorToken, error); return false; })
      .finally(() => { pending = null; });
    return pending;
  }
  return { hasOlderHistory, loadOlder };
}
