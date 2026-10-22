import { activeCodexTurnId, isCodexTerminal } from "./codex-chat-store.js";

export function createCodexItemHydration({ store, loadItems, isDisposed, syncVisibleDetails,
  loadDetail, schedulePoll, scheduleDetailRetry, yieldPage }) {
  const { state } = store;
  const itemSyncs = new Map();
  const expandedTurns = new Set();
  const visibleTurns = new Set();
  const reconcileTurns = new Set();
  const fullReadRequests = new Set();
  const forcedFullReads = new Set();
  const itemFailures = new Set();
  const itemWaiters = [];
  const priorityBoosts = new Set();
  const yieldWaiters = new Set();
  let activeItemReads = 0;
  let priorityBypasses = 0;

  function latestTurnId() { return activeCodexTurnId(state) || state.turnOrder.at(-1) || ""; }
  function needsFinalization(turnId) {
    const turn = state.turns[turnId];
    return isCodexTerminal(turn?.status) && [turn.itemsHydratedStatus, turn.itemsLatestHydratedStatus]
      .some((status) => status && !isCodexTerminal(status));
  }
  function isRelevant(turnId) {
    return visibleTurns.has(turnId) || expandedTurns.has(turnId) || turnId === latestTurnId() || turnId === state.turnOrder.at(-1) ||
      ["inProgress", "running"].includes(state.turns[turnId]?.status) || Boolean(needsFinalization(turnId));
  }
  function needsItemHydration(turnId) {
    const turn = state.turns[turnId];
    return turn && (turnId === latestTurnId() || !turn.itemsPageLoaded || turn.hasMore || itemFailures.has(turnId) ||
      !isCodexTerminal(turn.status) || turn.itemsHydratedStatus !== turn.status);
  }
  function needsLatestHydration(turnId) {
    const turn = state.turns[turnId];
    if (turnId !== latestTurnId() && isCodexTerminal(turn?.status) && turn.itemsPageLoaded && !turn.hasMore &&
      turn.itemsHydratedStatus === turn.status) return false;
    return turn && (turnId === latestTurnId() || !turn.itemsLatestLoaded || itemFailures.has(turnId) ||
      !isCodexTerminal(turn.status) || turn.itemsLatestHydratedStatus !== turn.status);
  }
  function hydrateSummaryTurns(turns) {
    if (isDisposed()) return Promise.resolve([]);
    for (const turn of turns) if (state.turns[turn.id]) state.turns[turn.id].itemsLatestRequested = true;
    const ids = turns.map((turn) => turn.id).filter(isRelevant);
    for (const id of ids) void syncVisibleDetails(id);
    // Start newest content first; each page shares the same two read slots.
    return Promise.all(ids.reverse().filter(needsLatestHydration)
      .map((id) => syncItems(id, { automatic: true })));
  }
  function hydrateVisibleTurns(turns) {
    if (isDisposed()) return Promise.resolve([]);
    for (const turn of turns) visibleTurns.add(turn.id);
    return hydrateSummaryTurns(turns);
  }
  function setTurnVisibility(turnId, visible) {
    if (isDisposed()) return Promise.resolve([]);
    if (visible) return hydrateVisibleTurns([{ id: turnId }]);
    visibleTurns.delete(turnId);
    if (!isRelevant(turnId)) itemFailures.delete(turnId);
    scheduleDetailRetry();
    return Promise.resolve([]);
  }
  function acquireItemRead(turnId) {
    if (isDisposed()) return Promise.resolve(false);
    if (activeItemReads < 2 && !itemWaiters.length) {
      priorityBoosts.delete(turnId); activeItemReads += 1; return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      itemWaiters.push({ turnId, resolve, priority: priorityBoosts.has(turnId) ? 2 : turnId === latestTurnId() ? 1 : 0 });
      drainItemReads();
    });
  }
  function drainItemReads() {
    while (!isDisposed() && activeItemReads < 2 && itemWaiters.length) {
      let selected = 0;
      for (let index = 1; index < itemWaiters.length; index += 1) {
        if (itemWaiters[index].priority > itemWaiters[selected].priority) selected = index;
      }
      // After two priority bypasses, serve the oldest page regardless of its rank.
      if (priorityBypasses >= 2) selected = 0;
      const [waiter] = itemWaiters.splice(selected, 1);
      priorityBypasses = selected === 0 ? 0 : priorityBypasses + 1;
      priorityBoosts.delete(waiter.turnId);
      activeItemReads += 1; waiter.resolve(true);
    }
  }
  function releaseItemRead() {
    activeItemReads -= 1;
    drainItemReads();
  }
  async function yieldBetweenPages() {
    if (isDisposed()) return false;
    let cancel;
    const cancellation = new Promise((resolve) => { cancel = () => resolve(false); yieldWaiters.add(cancel); });
    try { return await Promise.race([Promise.resolve(yieldPage()).then(() => true), cancellation]); }
    finally { yieldWaiters.delete(cancel); }
  }
  function syncLatestItems(options) {
    const turnId = latestTurnId();
    return turnId ? syncItems(turnId, { automatic: true, ...options }) : Promise.resolve();
  }
  function syncItems(turnId, { reconcile = false, automatic = false, full = false } = {}) {
    if (isDisposed() || !state.turns[turnId]) return Promise.resolve();
    if (reconcile) reconcileTurns.add(turnId);
    if (!automatic || full) fullReadRequests.add(turnId);
    if (!automatic) forcedFullReads.add(turnId);
    if (itemSyncs.has(turnId)) return itemSyncs.get(turnId);
    const turn = state.turns[turnId];
    turn.itemsLoading = true; turn.itemsError = "";
    const operation = (async () => {
      let readFull = false;
      try {
        const seenCursors = new Set();
        let page, readStatus, forceFull = forcedFullReads.delete(turnId);
        readFull = fullReadRequests.delete(turnId);
        do {
          const acquired = await acquireItemRead(turnId);
          if (!acquired) return;
          try {
            if (isDisposed() || (automatic || page) && !isRelevant(turnId)) return;
            forceFull = forcedFullReads.delete(turnId) || forceFull;
            readFull = fullReadRequests.delete(turnId) || readFull;
            readStatus = state.turns[turnId]?.status;
            page = await loadItems(turnId, { latest: !readFull });
          } finally { releaseItemRead(); }
          if (isDisposed()) return;
          const moreForward = page.hasMore && !page.latestWindow;
          if (moreForward) {
            if (!page.nextCursor || seenCursors.has(page.nextCursor)) throw new Error("执行过程分页尚未就绪，将自动重试。");
            seenCursors.add(page.nextCursor);
            if ((!readFull || forceFull || expandedTurns.has(turnId)) && !await yieldBetweenPages()) return;
          }
        } while (!isDisposed() && isRelevant(turnId) && (!readFull || forceFull || expandedTurns.has(turnId)) && (page.hasMore && !page.latestWindow ||
          (!readFull && fullReadRequests.has(turnId)) || state.turns[turnId]?.status !== readStatus));
        if ((!page.hasMore || page.latestWindow) && needsFinalization(turnId)) await syncVisibleDetails(turnId);
        if (isDisposed()) return;
        itemFailures.delete(turnId);
        if (reconcileTurns.delete(turnId)) {
          const currentTurn = state.turns[turnId];
          const itemId = (readFull ? currentTurn?.itemsPageTail : currentTurn?.itemsLatestTail) || currentTurn?.itemOrder.at(-1);
          if (itemId) await loadDetail(turnId, itemId, { automatic: true });
        }
        // Keep a just-finished older turn relevant until its final detail has
        // reconciled; marking it hydrated first would skip this last read.
        if (!isDisposed() && (!page.hasMore || page.latestWindow)) {
          if (readFull) state.turns[turnId].itemsHydratedStatus = readStatus;
          else state.turns[turnId].itemsLatestHydratedStatus = readStatus;
        }
      } catch (error) {
        if (isDisposed()) return;
        if (isRelevant(turnId)) itemFailures.add(turnId);
        state.turns[turnId].itemsError = error.message;
      } finally {
        const upgrade = !readFull && fullReadRequests.has(turnId) &&
          (forcedFullReads.has(turnId) || expandedTurns.has(turnId));
        const forced = forcedFullReads.has(turnId);
        itemSyncs.delete(turnId); priorityBoosts.delete(turnId); fullReadRequests.delete(turnId); forcedFullReads.delete(turnId);
        if (!isDisposed()) { state.turns[turnId].itemsLoading = false; schedulePoll(); }
        if (upgrade && !isDisposed() && (forced || isRelevant(turnId))) return syncItems(turnId, { automatic: !forced, full: true });
      }
    })();
    itemSyncs.set(turnId, operation); return operation;
  }
  async function setProcessExpanded(turnId, expanded) {
    if (isDisposed()) return;
    if (expanded) {
      expandedTurns.add(turnId);
      if (needsLatestHydration(turnId)) {
        priorityBoosts.add(turnId);
        const waiter = itemWaiters.find((entry) => entry.turnId === turnId);
        if (waiter) waiter.priority = 2;
        await syncItems(turnId, { automatic: true });
      }
      if (!isDisposed() && expandedTurns.has(turnId)) return syncVisibleDetails(turnId);
      return;
    }
    expandedTurns.delete(turnId);
    fullReadRequests.delete(turnId);
    priorityBoosts.delete(turnId);
    const waiter = itemWaiters.find((entry) => entry.turnId === turnId);
    if (waiter) waiter.priority = turnId === latestTurnId() ? 1 : 0;
    if (!isRelevant(turnId)) itemFailures.delete(turnId);
    scheduleDetailRetry();
  }
  function retryFailures() {
    if (isDisposed()) return Promise.resolve([]);
    return Promise.allSettled([...itemFailures].filter(isRelevant).map((id) => syncItems(id, { automatic: true })));
  }
  function dispose() {
    for (const waiter of itemWaiters.splice(0)) waiter.resolve(false);
    for (const cancel of yieldWaiters) cancel();
    yieldWaiters.clear(); priorityBoosts.clear(); itemSyncs.clear();
    expandedTurns.clear(); visibleTurns.clear(); reconcileTurns.clear(); fullReadRequests.clear(); forcedFullReads.clear(); itemFailures.clear();
  }
  return { hydrateSummaryTurns, hydrateVisibleTurns, setTurnVisibility, isRelevant, syncItems, syncLatestItems, setProcessExpanded, retryFailures, dispose,
    isExpanded: (turnId) => expandedTurns.has(turnId), hasFailures: () => itemFailures.size > 0 };
}
