import fs from "node:fs";
import path from "node:path";

const RUNNING = new Set(["inProgress", "running"]);
const TERMINAL = new Set(["completed", "failed", "interrupted", "aborted", "cancelled"]);
const caches = new WeakMap();
const rolloutObservations = new Map();
const MAX_ACTIVITY_TAIL_BYTES = 256 * 1024;

function unconfirmedInterruption(turn) {
  return ["interrupted", "aborted", "cancelled"].includes(turn?.status) && !latestActivityTimestamp(turn.completedAt);
}

function rolloutActivity(thread, config) {
  if (typeof thread?.path !== "string" || !thread.path.endsWith(".jsonl")) return null;
  let descriptor;
  try {
    const file = fs.realpathSync(thread.path);
    const roots = [config.codexSessionsDir, config.codexArchivedSessionsDir].filter(Boolean).map((root) => {
      try { return fs.realpathSync(root); } catch { return null; }
    }).filter(Boolean);
    if (!roots.some((root) => { const relative = path.relative(root, file); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); })) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (rolloutObservations.get(file)?.signature === signature) return rolloutObservations.get(file).turns;
    const length = Math.min(stat.size, MAX_ACTIVITY_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, bytes, 0, length, stat.size - length);
    const lines = bytes.toString("utf8").split("\n");
    if (stat.size > length) lines.shift();
    const turns = new Map();
    let currentTurn = "";
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const payload = row.payload || {};
      const type = row.type === "event_msg" ? payload.type : row.type;
      const timestamp = latestActivityTimestamp(row.timestamp);
      const id = payload.turn_id || payload.turnId || (row.type === "response_item" ? currentTurn : "");
      if (!id || !timestamp) continue;
      const previous = turns.get(id) || {};
      if (type === "task_started") { previous.startedAt = timestamp; previous.lastActivityAt = timestamp; currentTurn = id; }
      else if (["task_complete", "turn_aborted"].includes(type)) {
        previous.status = type === "task_complete" ? "completed" : "interrupted";
        previous.completedAt = timestamp;
        if (currentTurn === id) currentTurn = "";
      } else if (["item_completed", "token_usage_record", "response_item"].includes(type)) previous.lastActivityAt = timestamp;
      else continue;
      turns.set(id, previous);
      while (turns.size > 64) turns.delete(turns.keys().next().value);
    }
    rolloutObservations.delete(file); rolloutObservations.set(file, { signature, turns });
    while (rolloutObservations.size > 64) rolloutObservations.delete(rolloutObservations.keys().next().value);
    return turns;
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** A different runtime's unfinished rollout is not an actual interruption. */
export function observeCodexTurnStatus(thread, turn, { config = {}, now = Date.now(), freshnessMs = 90000 } = {}) {
  if (!unconfirmedInterruption(turn) || ["active", "idle"].includes(thread?.status?.type || thread?.status)) return turn;
  const observed = rolloutActivity(thread, config)?.get(turn.id);
  const observedAt = observed?.completedAt || observed?.lastActivityAt || null;
  const age = observedAt ? now - Date.parse(observedAt) : Infinity;
  const status = observed?.status || (age >= -5000 && age <= freshnessMs ? "inProgress" : "unknown");
  return { ...turn, historyStatus: turn.status, status, statusConfirmed: status !== "unknown",
    statusSource: observed ? "rollout" : "unconfirmed-history", statusObservedAt: observedAt,
    ...(observed?.completedAt ? { completedAt: observed.completedAt } : {}) };
}

export function latestActivityTimestamp(...values) {
  const times = values.flat().map((value) => {
    if (value == null || value === "") return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
  }).filter((value) => Number.isFinite(value) && value > 0 && value <= 8.64e15);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function threadIdentity(session) {
  return String(session.resumeSessionId || session.threadId || String(session.id || "").replace(/^history:codex:/, ""));
}

function turnActivity(turn) {
  if (!turn) return "idle";
  if (RUNNING.has(turn.status)) return "running";
  // A separate app-server reconstructs an unfinished desktop turn as interrupted
  // without completedAt. That is not evidence that its actual owner is idle.
  if (["completed", "failed"].includes(turn.status) || TERMINAL.has(turn.status) && latestActivityTimestamp(turn.completedAt)) return "idle";
  return "unknown";
}

async function readLatestOfficialActivity(bridge, threadId, config) {
  if (!bridge.connected || !bridge.initialized) throw new Error("Activity connection unavailable");
  // Do not use CodexHistoryReader here: its legacy fallback materializes JSONL
  // history. An unsupported paginated RPC must remain unknown for this list.
  const page = await bridge.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" });
  if (!Array.isArray(page?.data) || page.data.length > 1) throw new Error("Invalid activity page");
  let thread;
  if (page.data.some(unconfirmedInterruption)) {
    try { const response = await bridge.request("thread/read", { threadId, includeTurns: false }); if (response.thread?.id === threadId) thread = response.thread; } catch { /* Keep unconfirmed history unknown. */ }
  }
  return { threadId, turns: page.data.map((turn) => {
    const { id, status, startedAt, completedAt } = observeCodexTurnStatus(thread, turn, { config });
    return { id, status, startedAt, completedAt };
  }) };
}

/** Latest-turn reads only; listing never waits for RPCs or resumes a thread. */
export class SessionActivityCache {
  constructor(reader, { now = Date.now, concurrency = 2, maxQueued = 64, runningIntervalMs = 5000, runningFreshnessMs = 30000 } = {}) {
    this.reader = reader;
    this.now = now;
    this.concurrency = Math.max(1, Math.min(2, concurrency));
    this.maxQueued = maxQueued;
    this.runningIntervalMs = runningIntervalMs;
    this.runningFreshnessMs = runningFreshnessMs;
    this.entries = new Map();
    this.queue = [];
    this.active = 0;
  }

  observe(threadId, signature) {
    let entry = this.entries.get(threadId);
    if (!entry) {
      entry = { threadId, signature, activityState: "unknown", lastActivityAt: null,
        checkedAt: null, confirmedRunningAt: null, nextCheckAt: 0, attempts: 0, pending: false };
      this.entries.set(threadId, entry);
    } else if (entry.signature !== signature) {
      // Catalog metadata can advance while its single activity reader is pending.
      entry.signature = signature;
      entry.nextCheckAt = 0;
      entry.attempts = 0;
      if (entry.activityState !== "running") entry.activityState = "unknown";
    }
    if (entry.activityState === "running" && this.now() - entry.confirmedRunningAt > this.runningFreshnessMs) {
      entry.activityState = "unknown";
      entry.nextCheckAt = 0;
    }
    return entry;
  }

  prune(threadIds) {
    for (const id of this.entries.keys()) if (!threadIds.has(id)) this.entries.delete(id);
    this.queue = this.queue.filter((entry) => this.entries.get(entry.threadId) === entry);
  }

  refresh(entries) {
    for (const entry of entries) {
      if (this.queue.length >= this.maxQueued) break;
      if (entry.pending || entry.nextCheckAt > this.now()) continue;
      entry.pending = true;
      this.queue.push(entry);
    }
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      if (this.entries.get(entry.threadId) !== entry) continue;
      this.active += 1;
      const signature = entry.signature;
      Promise.resolve().then(() => this.reader.listTurns(entry.threadId, { limit: 1 })).then((page) => {
        if (this.entries.get(entry.threadId) !== entry) return;
        if (!Array.isArray(page?.turns) || page.threadId && page.threadId !== entry.threadId) throw new Error("Invalid activity response");
        const turn = page.turns.at(-1);
        const activityState = turnActivity(turn);
        // Advancing metadata does not erase positive execution evidence, but an
        // old completion cannot prove that a newly updated thread stayed idle.
        if (signature !== entry.signature && activityState !== "running") return;
        entry.activityState = activityState;
        entry.confirmedRunningAt = entry.activityState === "running" ? this.now() : null;
        entry.lastActivityAt = latestActivityTimestamp(entry.lastActivityAt, turn?.startedAt);
        entry.attempts = entry.activityState === "unknown" ? entry.attempts + 1 : 0;
      }).catch(() => {
        if (this.entries.get(entry.threadId) !== entry) return;
        entry.activityState = "unknown";
        entry.confirmedRunningAt = null;
        entry.attempts += 1;
      }).finally(() => {
        if (this.entries.get(entry.threadId) === entry) {
          entry.pending = false;
          if (signature === entry.signature) {
            entry.checkedAt = this.now();
            entry.nextCheckAt = entry.activityState === "idle" ? Infinity : this.now() +
              (entry.activityState === "running" ? this.runningIntervalMs : Math.min(300000, 5000 * 2 ** Math.min(entry.attempts - 1, 6)));
          } else this.refresh([entry]);
        }
        this.active -= 1;
        this.pump();
      });
    }
  }
}

function liveActivity(sessionManager, session, threadId) {
  const live = sessionManager?.get?.(session.id) || sessionManager?.findLiveSessionByThreadId?.(threadId, { providerId: session.provider || "codex" });
  if (!live) return null;
  let activityState = "unknown";
  if (live.status === "exited") activityState = "idle";
  else if (live.turnRunning === true && live.currentTurnId) activityState = "running";
  else if (live.turnRunning === false) activityState = "idle";
  else if (live.currentTurnId && live.conversationState?.activeTurnId === live.currentTurnId && live.conversationState.status === "running") activityState = "running";
  return { activityState, lastActivityAt: latestActivityTimestamp(live.createdAt,
    live.conversationState?.turns?.map((turn) => turn.startedAt) || []) };
}

export function withSessionActivity(snapshot, { sessionManager, codexThreads } = {}) {
  const sessions = [...(snapshot.sessions || []), ...(snapshot.projectGroups || []).flatMap((group) => group.sessions || [])];
  const rows = new Map((sessionManager?.codexSidebarService?.lastThreads || []).map((row) => [String(row.id), row]));
  let cache;
  if (typeof codexThreads?.bridge?.request === "function") {
    cache = caches.get(codexThreads);
    if (!cache) {
      cache = new SessionActivityCache({ listTurns: (threadId) => readLatestOfficialActivity(codexThreads.bridge, threadId, codexThreads.config) });
      caches.set(codexThreads, cache);
    }
  }
  const activity = new Map();
  const observed = new Map();
  for (const session of sessions) {
    const provider = session.provider || "codex";
    const threadId = threadIdentity(session);
    const key = `${provider}:${threadId}`;
    if (activity.has(key)) continue;
    const row = provider === "codex" ? rows.get(threadId) : null;
    const persistedAt = latestActivityTimestamp(row?.recency_at_ms || row?.recency_at)
      || latestActivityTimestamp(row?.updated_at_ms || row?.updated_at)
      || latestActivityTimestamp(session.updatedAt, session.createdAt);
    const local = provider === "codex" ? codexThreads?.getThreadActivity?.(threadId) : null;
    const live = liveActivity(sessionManager, session, threadId);
    let evidence = local || live;
    if (!evidence && cache && provider === "codex" && threadId) {
      const signature = [row?.updated_at_ms || row?.updated_at || session.updatedAt,
        row?.recency_at_ms || row?.recency_at || "", session.createdAt,
        Boolean(codexThreads.bridge.connected && codexThreads.bridge.initialized)].join(":");
      evidence = cache.observe(threadId, signature);
      observed.set(threadId, { entry: evidence, persistedAt });
    }
    activity.set(key, { activityState: evidence?.activityState || "unknown",
      lastActivityAt: latestActivityTimestamp(persistedAt, evidence?.lastActivityAt) });
  }
  if (cache) {
    cache.prune(new Set(observed.keys()));
    cache.refresh([...observed.values()].sort((a, b) => Number(b.entry.activityState === "running") - Number(a.entry.activityState === "running")
      || String(b.persistedAt || "").localeCompare(String(a.persistedAt || ""))).map(({ entry }) => entry));
  }
  const decorate = (session) => ({ ...session, ...activity.get(`${session.provider || "codex"}:${threadIdentity(session)}`) });
  return { ...snapshot, sessions: (snapshot.sessions || []).map(decorate),
    projectGroups: (snapshot.projectGroups || []).map((group) => ({ ...group, sessions: (group.sessions || []).map(decorate) })) };
}
