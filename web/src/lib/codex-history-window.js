export function createCodexHistoryWindow({ store, call, base, loadItems, errors, isDisposed }) {
  const { state } = store;
  let pending = null;
  const firstTurn = () => state.turns[state.turnOrder[0]];
  function hasOlderHistory() {
    const turn = firstTurn();
    return Boolean(turn && turn.itemsLatestRequested && !turn.itemsLatestLoaded || turn?.itemsEarlierHasMore || state.hasMore);
  }
  function loadOlder() {
    if (pending) return pending;
    if (isDisposed() || !hasOlderHistory()) return Promise.resolve(false);
    const errorToken = errors.begin("older");
    pending = (async () => {
      const turn = firstTurn();
      if (turn?.itemsLatestRequested && !turn.itemsLatestLoaded) {
        await loadItems(turn.id, { latest: true });
      } else if (turn?.itemsEarlierHasMore) {
        const cursor = turn.itemsEarlierCursor;
        const page = await loadItems(turn.id, { earlier: true });
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error("更早消息分页尚未就绪，请重试。");
      } else {
        const read = store.beginRead();
        const params = new URLSearchParams({ limit: "1", cursor: state.olderCursor || "" });
        const page = await call(`${base}/turns?${params}`);
        if (!Array.isArray(page?.turns) || page.threadId && page.threadId !== state.threadId) {
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
        await Promise.all(page.turns.map((older) => loadItems(older.id, { latest: true })));
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
