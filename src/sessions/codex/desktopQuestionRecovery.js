import { createHash } from "node:crypto";

const TURN_LIMIT = 5;
const ITEM_LIMIT = 30;
const MAX_THREADS = 128;
const MAX_BOUNDARIES = 128;
const eligible = (request) => request.state === "unknown" && ["desktopQuestion", "desktopSteer"].includes(request.executionRoute) && !request.turnId;

function cycle(boundaries) {
  return { turnCursor: null, turns: [], itemCursor: null, exhausted: false,
    remaining: boundaries ? new Set(boundaries) : null };
}

function nextCursor(page, field, current) {
  const cursor = page?.[field] || null;
  if (page?.hasMore && !cursor || cursor && (typeof cursor !== "string" || cursor.length > 4096 || cursor === current)) {
    throw new Error("Invalid desktop question recovery cursor");
  }
  return cursor;
}

/** Find uncertain native replies by clientId, including in a successor turn.
 * Each tick reads at most one turn page and one item page. Only IDs and cursors
 * survive the tick; completing a pass restarts at the newest turn next time.
 */
export class DesktopQuestionRecovery {
  #states = new Map();
  #closed = false;

  constructor({ reader, reconcileItems, isClosed = () => false }) {
    Object.assign(this, { reader, reconcileItems, isClosed });
  }

  recover(threadId, requests = []) {
    const candidates = requests.filter(eligible).map(({ id, expectedTurnId }) => ({ id, expectedTurnId }));
    if (!candidates.length || this.#closed || this.isClosed()) {
      this.forget(threadId);
      return Promise.resolve();
    }
    const signature = createHash("sha256").update(JSON.stringify(candidates
      .map(({ id, expectedTurnId }) => [id, expectedTurnId || null])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))))).digest("hex");
    let state = this.#states.get(threadId);
    if (state?.signature !== signature) {
      this.forget(threadId);
      const targets = new Set(candidates.map(({ expectedTurnId }) => expectedTurnId).filter(Boolean));
      // With missing or excessive boundaries, traverse the history rather than
      // storing an unbounded target set or stopping before an unknown boundary.
      const boundaries = targets.size && targets.size <= MAX_BOUNDARIES && candidates.every(({ expectedTurnId }) => expectedTurnId)
        ? [...targets] : null;
      state = { signature, boundaries, cycle: cycle(boundaries), promise: null, controller: null };
      this.#states.set(threadId, state);
    } else {
      this.#states.delete(threadId);
      this.#states.set(threadId, state);
    }
    while (this.#states.size > MAX_THREADS) this.forget(this.#states.keys().next().value);
    if (state.promise) return state.promise;
    const ids = new Set(candidates.map(({ id }) => id));
    const promise = this.#step(threadId, state, ids).finally(() => {
      if (state.promise === promise) state.promise = null;
    });
    state.promise = promise;
    return promise;
  }

  forget(threadId) {
    const state = this.#states.get(threadId);
    this.#states.delete(threadId);
    state?.controller?.abort();
  }

  shutdown() {
    this.#closed = true;
    for (const threadId of this.#states.keys()) this.forget(threadId);
  }

  async #step(threadId, state, ids) {
    const controller = new AbortController();
    state.controller = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref?.();
    const current = () => !this.#closed && !this.isClosed() && !controller.signal.aborted && this.#states.get(threadId) === state;
    const scan = state.cycle;
    try {
      if (!scan.turns.length) {
        const page = await this.reader.listTurns(threadId, { limit: TURN_LIMIT, signal: controller.signal,
          ...(scan.turnCursor ? { cursor: scan.turnCursor } : {}) });
        if (!current()) return;
        if (!Array.isArray(page?.turns) || page.turns.length > TURN_LIMIT || page.turns.some((turn) => !turn?.id)) {
          throw new Error("Invalid desktop question recovery turn page");
        }
        const cursor = nextCursor(page, "olderCursor", scan.turnCursor);
        // CodexHistoryReader normalizes each page to oldest-first. Consume it
        // newest-first while preserving its native older-page cursor.
        scan.turns = page.turns.map((turn) => turn.id).reverse();
        scan.turnCursor = cursor;
        scan.exhausted = !cursor;
        if (!scan.turns.length) {
          if (scan.exhausted) state.cycle = cycle(state.boundaries);
          return;
        }
      }
      const turnId = scan.turns[0];
      const page = await this.reader.listItems(threadId, turnId, { limit: ITEM_LIMIT, sortDirection: "desc",
        signal: controller.signal, ...(scan.itemCursor ? { cursor: scan.itemCursor } : {}) });
      if (!current()) return;
      if (!Array.isArray(page?.items) || page.items.length > ITEM_LIMIT) throw new Error("Invalid desktop question recovery item page");
      const cursor = nextCursor(page, "nextCursor", scan.itemCursor);
      const matches = page.items.filter((item) => item?.type === "userMessage" && typeof item.clientId === "string" && ids.has(item.clientId));
      if (matches.length) await this.reconcileItems(threadId, turnId, matches);
      if (!current()) return;
      scan.itemCursor = cursor;
      if (cursor) return;
      scan.turns.shift();
      scan.remaining?.delete(turnId);
      if (scan.remaining?.size === 0 || !scan.turns.length && scan.exhausted) state.cycle = cycle(state.boundaries);
    } catch {
      // Failed/partial reads are not evidence of delivery or rejection. Keep
      // the unread item/turn cursor for the next tick; never resend the reply.
    } finally {
      clearTimeout(timer);
      if (state.controller === controller) state.controller = null;
    }
  }
}
