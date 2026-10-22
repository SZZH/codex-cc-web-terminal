import { presentCodexItem, readCodexItemImage } from "./itemPresentation.js";
import { observeCodexTurnStatus } from "../history/sessionActivity.js";
import { isSubagentActivity, SubagentActivityReader } from "./subagentActivity.js";
import { throwIfReadAborted, waitForHistoryRead } from "./readCancellation.js";
import { CodexMetadataReads } from "./metadataReads.js";

const MAX_TURNS = 20;
const MAX_ITEMS = 30;
const MAX_PRIMARY_ITEMS = 24;
const MAX_PROCESS_ITEMS = 12;
const MAX_ACTIVITY_ITEMS = 24;
const PRIMARY_TYPES = new Set(["userMessage", "agentMessage", "plan", "imageView", "imageGeneration", "fileChange"]);

function itemType(item) {
  const kind = String(item?.kind || "unknown");
  return item?.type || kind[0].toLowerCase() + kind.slice(1);
}

function primaryItem(item) {
  if (PRIMARY_TYPES.has(itemType(item))) return true;
  // A tool can emit an image too; its card must not disappear among process summaries.
  return [item.content, item.output, item.contentItems, item.result?.content, item.payload?.content]
    .some((parts) => Array.isArray(parts) && parts.some((part) => /^(?:input_|output_|local)?image$/i.test(part?.type || "")));
}

function summarySelection(items) {
  const primary = [];
  const process = [];
  const activity = [];
  items.forEach((item, position) => (isSubagentActivity(item) ? activity : primaryItem(item) ? primary : process).push({ item, position }));
  let selected = primary;
  if (primary.length > MAX_PRIMARY_ITEMS) {
    const keep = new Map();
    const add = (entry) => { if (entry && keep.size < MAX_PRIMARY_ITEMS) keep.set(entry.position, entry); };
    for (const types of [["userMessage"], ["agentMessage"], ["fileChange"], ["plan"], ["imageView", "imageGeneration"]]) {
      add(primary.find((entry) => types.includes(itemType(entry.item))));
      add(primary.findLast((entry) => types.includes(itemType(entry.item))));
    }
    for (let index = primary.length - 1; index >= 0 && keep.size < MAX_PRIMARY_ITEMS; index -= 1) add(primary[index]);
    selected = [...keep.values()];
  }
  const briefProcess = process.length <= MAX_PROCESS_ITEMS ? process : [...process.slice(0, MAX_PROCESS_ITEMS / 2), ...process.slice(-MAX_PROCESS_ITEMS / 2)];
  const briefActivity = activity.length <= MAX_ACTIVITY_ITEMS ? activity : [...activity.slice(0, MAX_ACTIVITY_ITEMS / 2), ...activity.slice(-MAX_ACTIVITY_ITEMS / 2)];
  return [...selected, ...[...briefProcess, ...briefActivity].map((entry) => ({ ...entry, compact: true }))].sort((left, right) => left.position - right.position);
}

function fail(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function pageLimit(limit, fallback, maximum) {
  if (limit == null || limit === "") return fallback;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1) throw fail("Invalid history page limit", 400);
  return Math.min(value, maximum);
}

function requiredId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw fail(`Invalid ${label}`, 400);
  return value;
}

function cursorValue(cursor) {
  if (cursor == null || cursor === "") return undefined;
  if (typeof cursor !== "string" || cursor.length > 4096) throw fail("Invalid history cursor", 400);
  return cursor;
}

function legacyCursor(kind, threadId, anchor, turnId = "") {
  return `legacy:${Buffer.from(JSON.stringify({ kind, threadId, turnId, anchor })).toString("base64url")}`;
}

function legacyAnchor(cursor, kind, threadId, turnId = "") {
  if (!cursor) return null;
  try {
    if (!cursor.startsWith("legacy:")) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor.slice(7), "base64url").toString());
    if (decoded.kind !== kind || decoded.threadId !== threadId || decoded.turnId !== turnId || typeof decoded.anchor !== "string") throw new Error();
    return decoded.anchor;
  } catch { throw fail("Invalid legacy history cursor", 400); }
}

function unsupportedLegacy(error) {
  return error?.code === -32601 || /method not found|(?:legacy|non.paginated).*(?:not support|unsupported)|(?:not support|unsupported).*(?:legacy|non.paginated)|(?:requires?|only).*paginated|paginated.*(?:required|only)|history.*not paginated/i.test(String(error?.message || ""));
}

function legacyItem(item) {
  if (item.type) return item;
  const kind = String(item.kind || "unknown");
  const type = kind[0].toLowerCase() + kind.slice(1);
  const payload = item.payload || {};
  return { ...payload, id: item.id, type, status: item.status, phase: item.phase ?? payload.phase,
    ...(type === "userMessage" ? { content: payload.content, text: item.text ?? payload.text ?? payload.message ?? "", images: payload.images, local_images: payload.local_images }
      : { text: item.text ?? payload.text ?? "" }) };
}

function entryItem(entry, turnId) {
  if (entry?.turnId && entry.turnId !== turnId) throw fail("App-server returned an item from a different turn");
  const item = entry?.item || entry;
  if (!item?.id || !item?.type) throw fail("App-server returned an invalid history item");
  return item;
}

/** A read-only, bounded adapter; no resume, execution or full-history RPCs. */
export class CodexHistoryReader {
  constructor({ bridge, config = {}, sessionManager } = {}) {
    this.bridge = bridge;
    this.config = config;
    this.sessionManager = sessionManager;
    this.metadata = new Map();
    this.metadataReads = new CodexMetadataReads({
      load: (threadId, options) => this.readThreadMetadata(threadId, options),
      publish: (thread) => this.remember(thread)
    });
    this.legacyThreads = new Set();
    this.itemPositions = new Map();
    this.subagentActivity = new SubagentActivityReader(config);
  }

  async rpc(method, params, { signal } = {}) {
    throwIfReadAborted(signal);
    if (!this.bridge) throw fail("Codex app-server is unavailable", 503);
    await waitForHistoryRead(() => this.bridge.ensureReady?.(), signal);
    return waitForHistoryRead(() => signal ? this.bridge.request(method, params, { signal }) : this.bridge.request(method, params), signal);
  }

  remember(thread) {
    this.metadataReads.invalidate(thread.id);
    this.metadata.delete(thread.id);
    this.metadata.set(thread.id, { thread, at: Date.now() });
    while (this.metadata.size > 64) {
      const id = this.metadata.keys().next().value;
      this.metadata.delete(id);
      this.legacyThreads.delete(id);
      this.itemPositions.delete(id);
    }
    return thread;
  }

  async getThread(threadId, { signal } = {}) {
    throwIfReadAborted(signal);
    requiredId(threadId, "thread ID");
    return this.metadataReads.read(threadId, { signal });
  }

  async readThreadMetadata(threadId, { signal }) {
    if (!this.bridge && this.sessionManager?.historyService) {
      const thread = this.legacyThread(this.legacyBundle(threadId, { signal }), threadId);
      throwIfReadAborted(signal);
      return thread;
    }
    const response = await this.rpc("thread/read", { threadId, includeTurns: false }, { signal });
    throwIfReadAborted(signal);
    if (response?.thread?.id !== threadId) throw fail("App-server returned a different history thread");
    // includeTurns:false is explicit, but never relay accidental full hydration from an older server.
    const thread = { ...response.thread, turns: [] };
    throwIfReadAborted(signal);
    return thread;
  }

  async threadMetadata(threadId, { signal } = {}) {
    throwIfReadAborted(signal);
    const cached = this.metadata.get(threadId);
    return cached && Date.now() - cached.at < 2000 ? cached.thread : this.getThread(threadId, { signal });
  }

  legacyBundle(threadId, { signal } = {}) {
    throwIfReadAborted(signal);
    const manager = this.sessionManager;
    if (!manager?.historyService?.getHistoricalMessages) throw fail("Legacy history adapter is unavailable", 503);
    const provider = manager.getProvider?.("codex") || manager.providers?.get?.("codex") || { id: "codex" };
    const bundle = manager.historyService.getHistoricalMessages(provider, threadId);
    throwIfReadAborted(signal);
    if (!bundle || !Array.isArray(bundle.threadSnapshot?.turns)) throw fail("Legacy history has no recoverable item identities");
    this.legacyThreads.add(threadId);
    return bundle;
  }

  legacyThread(bundle, threadId) {
    const session = bundle.session || {};
    return { id: threadId, name: session.name || "", cwd: session.cwd || this.config.defaultCwd || "",
      model: session.model || null, status: { type: "notLoaded" }, historyMode: "legacy", turns: [],
      createdAt: session.createdAt, updatedAt: session.updatedAt };
  }

  async withHistory(threadId, official, legacy, { signal } = {}) {
    const thread = await waitForHistoryRead(() => this.threadMetadata(threadId, { signal }), signal);
    throwIfReadAborted(signal);
    const readLegacy = () => legacy(this.legacyBundle(threadId, { signal }), thread);
    if (this.legacyThreads.has(threadId)) return waitForHistoryRead(readLegacy, signal);
    try { return await waitForHistoryRead(() => official(thread), signal); }
    catch (error) {
      throwIfReadAborted(signal);
      if (thread.historyMode !== "legacy" || !unsupportedLegacy(error)) throw error;
      return waitForHistoryRead(readLegacy, signal);
    }
  }

  presentTurn(turn, cwd, legacy = false, threadId, thread, signal) {
    throwIfReadAborted(signal);
    if (!turn?.id || !Array.isArray(turn.items)) throw fail("Invalid history turn");
    const selected = summarySelection(turn.items);
    const fullPositions = legacy || !["summary", "notLoaded"].includes(turn.itemsView);
    const activities = this.subagentActivity.forItems(turn.items, { thread, turnId: turn.id, turnStatus: turn.status, contiguous: fullPositions });
    throwIfReadAborted(signal);
    const items = selected.map(({ item, position, compact }) => {
      throwIfReadAborted(signal);
      const presented = presentCodexItem(legacy ? legacyItem(item) : item, { cwd, threadId, turnId: turn.id, compact, activity: activities.get(item.id) });
      if (fullPositions) return { ...presented, position };
      // A summary index is not an absolute item position and must not leak into full item pages.
      delete presented.position;
      return presented;
    });
    throwIfReadAborted(signal);
    if (fullPositions) this.rememberPositions(threadId, turn.id, items);
    // Legacy snapshots contain redundant assistant state. Adapt only once at this boundary.
    const result = legacy ? { id: turn.id, status: turn.status === "aborted" ? "interrupted" : turn.status,
      startedAt: turn.startedAt, completedAt: turn.completedAt, error: turn.error, itemsView: "summary" } : { ...turn };
    const itemsTruncated = turn.items.length > items.length;
    return { ...result, items, itemsTruncated, hasMoreItems: legacy || turn.itemsView !== "full" || itemsTruncated };
  }

  rememberPositions(threadId, turnId, items) {
    if (!threadId) return;
    const turns = this.itemPositions.get(threadId) || new Map();
    turns.delete(turnId);
    turns.set(turnId, new Map(items.map((item) => [item.id, item.position])));
    while (turns.size > 64) turns.delete(turns.keys().next().value);
    this.itemPositions.delete(threadId);
    this.itemPositions.set(threadId, turns);
    while (this.itemPositions.size > 64) this.itemPositions.delete(this.itemPositions.keys().next().value);
  }

  positioned(item, threadId, turnId, fallback) {
    const position = fallback ?? this.itemPositions.get(threadId)?.get(turnId)?.get(item.id);
    return position == null ? item : { ...item, position };
  }

  async listTurns(threadId, { cursor, limit, signal } = {}) {
    throwIfReadAborted(signal);
    requiredId(threadId, "thread ID");
    cursor = cursorValue(cursor);
    limit = pageLimit(limit, 10, MAX_TURNS);
    return this.withHistory(threadId, async (thread) => {
      let page;
      try {
        page = await this.rpc("thread/turns/list", { threadId, limit, sortDirection: "desc", itemsView: "summary", ...(cursor ? { cursor } : {}) }, { signal });
      } catch (error) {
        throwIfReadAborted(signal);
        // Official empty threads have metadata, but no materialized history before their first input.
        if (!cursor && error?.rpcError === true && error.message ===
          `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
          return { threadId, turns: [], olderCursor: null, hasMore: false };
        }
        throw error;
      }
      throwIfReadAborted(signal);
      if (!Array.isArray(page?.data) || page.data.length > limit) throw fail("Invalid turn history page");
      const olderCursor = cursorValue(page.nextCursor) || null;
      if (olderCursor && olderCursor === cursor) throw fail("Repeated turn history cursor");
      return { threadId, turns: [...page.data].reverse().map((turn) => this.presentTurn(
        observeCodexTurnStatus(thread, turn, { config: this.config }), thread.cwd, false, threadId, thread, signal)), olderCursor, hasMore: Boolean(olderCursor) };
    }, (bundle, thread) => {
      const turns = bundle.threadSnapshot.turns;
      const anchor = legacyAnchor(cursor, "turns", threadId);
      const end = anchor == null ? turns.length : turns.findIndex((turn) => turn.id === anchor);
      if (end < 0) throw fail("Legacy turn cursor is no longer available", 409);
      const start = Math.max(0, end - limit);
      const selected = turns.slice(start, end);
      throwIfReadAborted(signal);
      return { threadId, turns: selected.map((turn) => this.presentTurn(turn, thread.cwd, true, threadId, undefined, signal)),
        olderCursor: start > 0 ? legacyCursor("turns", threadId, selected[0].id) : null, hasMore: start > 0 };
    }, { signal });
  }

  async officialItems(threadId, turnId, { cursor, limit, sortDirection = "asc", signal }) {
    const page = await this.rpc("thread/items/list", { threadId, turnId, limit, sortDirection, ...(cursor ? { cursor } : {}) }, { signal });
    throwIfReadAborted(signal);
    if (!Array.isArray(page?.data) || page.data.length > limit) throw fail("Invalid item history page");
    const items = page.data.map((entry) => entryItem(entry, turnId));
    if (cursor?.type === "item" && items.some((item) => item.id === cursor.itemId)) throw fail("App-server repeated an exclusive item anchor");
    const nextCursor = cursorValue(page.nextCursor) || null;
    if (nextCursor && nextCursor === cursor) throw fail("Repeated item history cursor");
    throwIfReadAborted(signal);
    this.subagentActivity.observeItems(items, { threadId, turnId, entries: page.data, page: { cursor, sortDirection, nextCursor } });
    throwIfReadAborted(signal);
    return { items, nextCursor };
  }

  legacyItems(bundle, turnId) {
    const turn = bundle.threadSnapshot.turns.find((entry) => entry.id === turnId);
    if (!turn) throw fail("History turn not found", 404);
    return turn.items || [];
  }

  async listItems(threadId, turnId, { cursor, limit, after, sortDirection = "asc", signal } = {}) {
    throwIfReadAborted(signal);
    requiredId(threadId, "thread ID");
    requiredId(turnId, "turn ID");
    if (!["asc", "desc"].includes(sortDirection)) throw fail("Invalid item sort direction", 400);
    cursor = cursorValue(cursor);
    after = after == null || after === "" ? undefined : requiredId(after, "item anchor");
    limit = pageLimit(limit, 20, MAX_ITEMS);
    return this.withHistory(threadId, async (thread) => {
      const page = await this.officialItems(threadId, turnId, { cursor: cursor || (after ? { type: "item", itemId: after } : undefined), limit, sortDirection, signal });
      throwIfReadAborted(signal);
      const selected = sortDirection === "desc" ? [...page.items].reverse() : page.items;
      const activities = this.subagentActivity.forItems(selected, { thread, turnId });
      throwIfReadAborted(signal);
      return { threadId, turnId, items: selected.map((item) => {
        throwIfReadAborted(signal);
        return this.positioned(presentCodexItem(item, { cwd: thread.cwd, threadId, turnId, compact: !primaryItem(item), activity: activities.get(item.id) }), threadId, turnId);
      }),
        nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor), latestItemId: selected.at(-1)?.id || after || null };
    }, (bundle, thread) => {
      const items = this.legacyItems(bundle, turnId);
      const anchor = cursor ? legacyAnchor(cursor, "items", threadId, turnId) : after;
      const index = anchor == null ? sortDirection === "desc" ? items.length : -1 : items.findIndex((item) => item.id === anchor);
      if (anchor != null && index < 0) throw fail("Legacy item cursor is no longer available", 409);
      const start = sortDirection === "desc" ? Math.max(0, index - limit) : index + 1;
      const selected = items.slice(start, sortDirection === "desc" ? index : start + limit);
      const hasMore = sortDirection === "desc" ? start > 0 : start + selected.length < items.length;
      return { threadId, turnId, items: selected.map((item, offset) => {
        throwIfReadAborted(signal);
        return this.positioned(presentCodexItem(legacyItem(item), { cwd: thread.cwd, threadId, turnId, compact: !primaryItem(item) }), threadId, turnId, start + offset);
      }),
        nextCursor: hasMore ? legacyCursor("items", threadId, sortDirection === "desc" ? selected[0].id : selected.at(-1).id, turnId) : null,
        hasMore, latestItemId: selected.at(-1)?.id || after || null };
    }, { signal });
  }

  async rawItem(threadId, turnId, itemId, { signal } = {}) {
    throwIfReadAborted(signal);
    requiredId(threadId, "thread ID");
    requiredId(turnId, "turn ID");
    requiredId(itemId, "item ID");
    return this.withHistory(threadId, async (thread) => {
      // Item anchors are exclusive. Read at most its predecessor and then exactly the target.
      const before = await this.officialItems(threadId, turnId, { cursor: { type: "item", itemId }, limit: 1, sortDirection: "desc", signal });
      throwIfReadAborted(signal);
      const predecessor = before.items[0];
      const page = await this.officialItems(threadId, turnId, { limit: 1, signal,
        ...(predecessor ? { cursor: { type: "item", itemId: predecessor.id } } : {}) });
      throwIfReadAborted(signal);
      const item = page.items[0];
      if (item?.id !== itemId) throw fail("History item not found", 404);
      return { item, thread };
    }, (bundle, thread) => {
      const item = this.legacyItems(bundle, turnId).find((entry) => entry.id === itemId);
      if (!item) throw fail("History item not found", 404);
      return { item: legacyItem(item), thread };
    }, { signal });
  }

  async getItem(threadId, turnId, itemId, { signal } = {}) {
    const { item, thread } = await waitForHistoryRead(() => this.rawItem(threadId, turnId, itemId, { signal }), signal);
    throwIfReadAborted(signal);
    const activities = this.subagentActivity.forItems([item], { thread, turnId });
    throwIfReadAborted(signal);
    const result = { item: this.positioned(presentCodexItem(item, { detail: true, cwd: thread.cwd, threadId, turnId, activity: activities.get(item.id) }), threadId, turnId) };
    throwIfReadAborted(signal);
    return result;
  }

  async getImage(threadId, turnId, itemId, index, { signal } = {}) {
    throwIfReadAborted(signal);
    if (!/^(?:0|[1-9]\d*)$/.test(String(index)) || Number(index) >= 200) throw fail("Invalid history image index", 400);
    const { item, thread } = await waitForHistoryRead(() => this.rawItem(threadId, turnId, itemId, { signal }), signal);
    throwIfReadAborted(signal);
    const image = readCodexItemImage(item, Number(index), { cwd: thread.cwd });
    throwIfReadAborted(signal);
    return image;
  }
}
