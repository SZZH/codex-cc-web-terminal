import fs from "node:fs";
import path from "node:path";

const MAX_ROLLOUT_BYTES = 1024 * 1024;
const MAX_ROLLOUT_ITEMS = 512;
const MAX_ROLLOUT_FILES = 32;
const MAX_PARENT_TURNS = 256;
const MAX_ACTIVITY_TURNS = 64;
const key = (value) => String(value || "").replace(/[_-]/g, "").toLowerCase();
const text = (value) => typeof value === "string" ? value.slice(0, 512) : "";
const terminal = (state) => ["completed", "failed", "interrupted"].includes(state);

function timestamp(...values) {
  for (const value of values) {
    if (!["string", "number"].includes(typeof value) || value === "") continue;
    const number = Number(value);
    const milliseconds = Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
    if (Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15) return new Date(milliseconds).toISOString();
  }
  return null;
}

function state(value) {
  const normalized = key(value?.type || value?.status || value);
  if (["failed", "error", "errored"].includes(normalized)) return "failed";
  if (["interrupted", "aborted", "cancelled", "canceled", "shutdown"].includes(normalized)) return "interrupted";
  if (["completed", "complete", "done", "success", "succeeded"].includes(normalized)) return "completed";
  return "unknown";
}

export function isSubagentActivity(item) {
  return key(item?.type) === "subagentactivity";
}

/** Native activity timestamps describe events; a start event's completion is not the child's completion. */
export function presentSubagentActivity(item) {
  if (!isSubagentActivity(item)) return null;
  const kind = key(item.kind);
  let event = ["started", "spawned", "interacted", "resumed"].includes(kind) ? "started" : state(kind);
  let activityState = event === "started" ? "running" : event;
  if (event === "completed") {
    const completionState = state(item.agentStatus || item.agentState || item.agent_state || item.status);
    if (["failed", "interrupted"].includes(completionState)) activityState = event = completionState;
    else if (item.error || item.result?.error) activityState = event = "failed";
  }
  const agentThreadId = text(item.agentThreadId || item.agent_thread_id);
  const agentPath = text(item.agentPath || item.agent_path);
  const at = timestamp(item.timestamp, item.createdAt, item.created_at);
  return { agentThreadId, agentPath, label: text(item.agentName || item.agent_name) || agentPath.split("/").filter(Boolean).at(-1) || agentThreadId || "Subagent",
    event, state: activityState,
    startedAt: event === "started" ? timestamp(item.startedAt, item.started_at, item.startedAtMs, item.started_at_ms, at) : null,
    completedAt: terminal(event) ? timestamp(item.completedAt, item.completed_at, item.completedAtMs, item.completed_at_ms, at) : null,
    durationMs: null, startedItemId: event === "started" ? text(item.id) || null : null };
}

function duration(activity) {
  const elapsed = Date.parse(activity.completedAt) - Date.parse(activity.startedAt);
  return { ...activity, durationMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null };
}

function mergeActivity(previous, current) {
  const activity = { ...previous, ...current,
    agentThreadId: current.agentThreadId || previous?.agentThreadId || "",
    agentPath: current.agentPath || previous?.agentPath || "",
    startedAt: current.startedAt || previous?.startedAt || null,
    completedAt: current.completedAt || previous?.completedAt || null };
  if (current.event === "completed" && ["failed", "interrupted"].includes(previous?.state)) activity.event = activity.state = previous.state;
  return activity;
}

function equalActivity(left, right) {
  return left && Object.keys(right).every((field) => left[field] === right[field]);
}

function prefixMatches(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((id, index) => id === right[index]);
}

function pairActivities(entries) {
  const activities = new Map();
  const running = new Map();
  for (const { id, activity } of entries) {
    const identity = activity.agentThreadId || activity.agentPath;
    const current = { ...activity };
    if (identity && current.event === "started") {
      const previous = activities.get(running.get(identity));
      if (previous) activities.set(running.get(identity), { ...previous, state: "unknown" });
      running.set(identity, id);
    } else if (identity && terminal(current.event)) {
      const startedItemId = running.get(identity);
      const started = activities.get(startedItemId);
      if (started) {
        Object.assign(current, { startedItemId, startedAt: started.startedAt });
        activities.set(startedItemId, duration({ ...started, state: current.state, completedAt: current.completedAt }));
        running.delete(identity);
      }
    }
    activities.set(id, duration(current));
  }
  return activities;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Read only official native activity records from a fixed-size rollout tail. */
export class SubagentActivityReader {
  constructor(config = {}) {
    this.config = config;
    this.files = new Map();
    this.parentTurns = new Map();
    this.turnItems = new Map();
    this.turnPages = new Map();
    this.activityIndexes = new Map();
  }

  observeItems(items, { threadId, turnId, entries = [], page } = {}) {
    if (!threadId || !turnId) return;
    const scope = `${threadId}:${turnId}`;
    const observed = this.turnItems.get(scope) || new Map();
    let changed = false;
    const timings = new Map(entries.filter((entry) => entry?.item?.id && (!entry.turnId || entry.turnId === turnId) &&
      (!entry.threadId || entry.threadId === threadId)).map((entry) => [entry.item.id, entry]));
    for (const item of items) {
      if (!isSubagentActivity(item)) continue;
      const activity = presentSubagentActivity(item);
      const wrapper = timings.get(item.id);
      if (activity.event === "started") activity.startedAt ||= timestamp(wrapper?.startedAtMs, wrapper?.started_at_ms);
      else if (terminal(activity.event)) activity.completedAt ||= timestamp(wrapper?.completedAtMs, wrapper?.completed_at_ms);
      const previous = observed.get(item.id);
      const merged = mergeActivity(previous?.activity, activity);
      if (equalActivity(previous?.activity, merged)) continue;
      observed.set(item.id, { id: item.id, activity: merged });
      changed = true;
      while (observed.size > MAX_ROLLOUT_ITEMS) observed.delete(observed.keys().next().value);
    }
    this.turnItems.delete(scope);
    this.turnItems.set(scope, observed);
    if (page?.sortDirection === "asc") {
      const pages = this.turnPages.get(scope) || new Map();
      const cursorKey = JSON.stringify(page.cursor || null);
      const previous = pages.get(cursorKey);
      const itemIds = items.map((item) => item.id);
      const samePrefix = previous && prefixMatches(previous.itemIds, itemIds);
      // Detail reads share history cursors; a shorter matching prefix must not erase a full page.
      const keepLonger = samePrefix && previous.itemIds.length > itemIds.length;
      const samePage = samePrefix && previous.itemIds.length === itemIds.length && previous.nextCursor === page.nextCursor;
      if (!keepLonger && !samePage) {
        if (previous && !samePrefix) pages.clear();
        pages.delete(cursorKey);
        pages.set(cursorKey, { cursor: page.cursor, nextCursor: page.nextCursor, lastItemId: items.at(-1)?.id, itemIds,
          ids: items.filter(isSubagentActivity).map((item) => item.id) });
        changed = true;
      }
      while (pages.size > 128) pages.delete(pages.keys().next().value);
      this.turnPages.set(scope, pages);
    }
    if (changed) this.activityIndexes.delete(scope);
    while (this.turnItems.size > MAX_ACTIVITY_TURNS) {
      const oldest = this.turnItems.keys().next().value;
      this.turnItems.delete(oldest);
      this.turnPages.delete(oldest);
      this.activityIndexes.delete(oldest);
    }
  }

  indexedActivities(scope) {
    if (this.activityIndexes.has(scope)) return this.activityIndexes.get(scope);
    const items = this.turnItems.get(scope);
    const pages = [...(this.turnPages.get(scope)?.values() || [])];
    const activities = new Map();
    const lengths = new Map();
    for (const first of pages) {
      const sequence = [];
      const visited = new Set();
      let page = first;
      while (page && !visited.has(page)) {
        visited.add(page);
        if (page.ids.some((id) => !items?.has(id))) break;
        for (const id of page.ids) if (!sequence.some((entry) => entry.id === id)) sequence.push(items.get(id));
        page = pages.find((candidate) => !visited.has(candidate) &&
          (page.nextCursor && candidate.cursor === page.nextCursor ||
            page.lastItemId && candidate.cursor?.type === "item" && candidate.cursor.itemId === page.lastItemId));
      }
      for (const [id, activity] of pairActivities(sequence)) {
        if ((lengths.get(id) || 0) >= sequence.length) continue;
        lengths.set(id, sequence.length);
        activities.set(id, activity);
      }
    }
    this.activityIndexes.set(scope, activities);
    while (this.activityIndexes.size > MAX_ACTIVITY_TURNS) this.activityIndexes.delete(this.activityIndexes.keys().next().value);
    return activities;
  }

  rollout(thread) {
    if (typeof thread?.path !== "string" || !thread.path.endsWith(".jsonl")) return [];
    let descriptor;
    try {
      const file = fs.realpathSync(thread.path);
      const roots = [this.config.codexSessionsDir, this.config.codexArchivedSessionsDir].filter(Boolean).flatMap((root) => {
        try { return [fs.realpathSync(root)]; } catch { return []; }
      });
      if (!roots.some((root) => inside(root, file))) return [];
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || fs.realpathSync(thread.path) !== file) return [];
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.files.get(file);
      if (cached?.signature === signature && cached.threadId === thread.id) return cached.entries;
      const length = Math.min(stat.size, MAX_ROLLOUT_BYTES);
      const bytes = Buffer.alloc(length);
      const read = fs.readSync(descriptor, bytes, 0, length, stat.size - length);
      const lines = bytes.subarray(0, read).toString("utf8").split("\n");
      if (stat.size > length) lines.shift();
      const entries = new Map();
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const payload = row.payload;
        if (row.type !== "event_msg" || !["item_started", "item_completed"].includes(payload?.type) ||
            payload.thread_id !== thread.id || !payload.turn_id || !isSubagentActivity(payload.item) || !payload.item.id) continue;
        const activity = presentSubagentActivity(payload.item);
        if (activity.event === "started") activity.startedAt ||= timestamp(payload.started_at_ms, row.timestamp);
        else if (terminal(activity.event)) activity.completedAt ||= timestamp(payload.completed_at_ms, row.timestamp);
        entries.set(`${payload.turn_id}:${payload.item.id}`, { id: text(payload.item.id), turnId: text(payload.turn_id), activity });
        if (entries.size > MAX_ROLLOUT_ITEMS) entries.delete(entries.keys().next().value);
      }
      const observations = [...entries.values()];
      this.files.delete(file);
      this.files.set(file, { signature, threadId: thread.id, entries: observations });
      while (this.files.size > MAX_ROLLOUT_FILES) this.files.delete(this.files.keys().next().value);
      return observations;
    } catch { return []; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  forItems(items, { thread, turnId, turnStatus, contiguous = true } = {}) {
    const scope = thread?.id && turnId ? `${thread.id}:${turnId}` : null;
    if (scope && turnStatus != null) {
      this.parentTurns.delete(scope);
      this.parentTurns.set(scope, turnStatus);
      while (this.parentTurns.size > MAX_PARENT_TURNS) this.parentTurns.delete(this.parentTurns.keys().next().value);
    }
    const parentStatus = turnStatus ?? this.parentTurns.get(scope);
    const native = items.filter(isSubagentActivity).map((item) => ({ id: item.id, activity: presentSubagentActivity(item) }));
    if (!native.length) return new Map();
    this.observeItems(items, { threadId: thread?.id, turnId });
    const indexed = scope ? [...(this.turnItems.get(scope)?.values() || [])] : native;
    const direct = new Map(indexed.map((entry) => [entry.id, entry.activity]));
    const observed = this.rollout(thread).filter((entry) => entry.turnId === turnId).map((entry) => {
      const official = direct.get(entry.id);
      if (!official) return entry;
      return { ...entry, activity: mergeActivity(entry.activity, official) };
    });
    const rollout = pairActivities(observed);
    const page = contiguous ? pairActivities(native.map((entry) => ({ ...entry, activity: direct.get(entry.id) || entry.activity }))) : direct;
    const paginated = scope ? this.indexedActivities(scope) : new Map();
    return new Map(native.map(({ id, activity }) => {
      const inPage = paginated.get(id) || page.get(id);
      const inRollout = rollout.get(id);
      const preferPage = inPage.startedItemId && terminal(inPage.state) &&
        (paginated.has(id) || activity.event === "started" && inRollout?.state === "running" || !inRollout?.startedItemId);
      const paired = inRollout && !preferPage ? inRollout : inPage;
      const other = paired === inRollout ? inPage : inRollout;
      const sameLifecycle = paired.startedItemId && paired.startedItemId === other?.startedItemId && paired.state === other.state;
      const result = duration({ ...activity, ...paired,
        startedAt: paired.startedAt || (sameLifecycle ? other.startedAt : null),
        completedAt: paired.completedAt || (sameLifecycle ? other.completedAt : null) });
      if (result.state === "completed" && ["failed", "interrupted"].includes(inRollout?.state)) {
        result.state = inRollout.state;
        if (result.event !== "started") result.event = inRollout.event;
      }
      // An incomplete historical start is not evidence that the child is still running.
      if (result.state === "running" && (!result.startedAt || terminal(state(parentStatus)))) result.state = "unknown";
      return [id, result];
    }));
  }
}
