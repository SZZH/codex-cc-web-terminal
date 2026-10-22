import { normalizeThreadItem, summarizeProcessItems } from "./thread-item-renderers.js";
import { activityDuration } from "./activity-time.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function normalizeChangePath(filePath = "") {
  const text = String(filePath || "").trim();
  if (!text) {
    return "";
  }
  const marker = "/codex-cc-web-terminal/";
  const index = text.lastIndexOf(marker);
  if (index >= 0) {
    return text.slice(index + marker.length);
  }
  return text;
}

function summarizeDiff(diff = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function resolveHistoricalChanges(payload = {}) {
  const candidates = [
    payload?.changes,
    payload?.output?.changes,
    payload?.result?.changes,
    payload?.output,
    payload?.result
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || null;
}

function buildHistoricalFileChanges(items = []) {
  const fileMap = new Map();
  for (const item of items) {
    const kind = String(item?.kind || "").trim().toLowerCase();
    if (kind !== "filechange") {
      continue;
    }
    const changes = resolveHistoricalChanges(item?.payload || {});
    if (!changes || typeof changes !== "object") {
      continue;
    }
    for (const [filePath, change] of Object.entries(changes)) {
      const diff = String(change?.unified_diff || "").trim();
      const stats = summarizeDiff(diff);
      if (Number.isFinite(change?.additions)) stats.additions = Math.max(0, change.additions);
      if (Number.isFinite(change?.deletions)) stats.deletions = Math.max(0, change.deletions);
      const path = normalizeChangePath(filePath);
      const existing = fileMap.get(path);
      if (existing) {
        existing.additions += stats.additions;
        existing.deletions += stats.deletions;
        existing.diff = [existing.diff, diff].filter(Boolean).join("\n\n");
        existing.status = String(change?.type || existing.status || "update");
        continue;
      }
      fileMap.set(path, {
        path,
        previousPath: normalizeChangePath(change?.move_path || ""),
        status: String(change?.type || "update"),
        additions: stats.additions,
        deletions: stats.deletions,
        diff
      });
    }
  }
  return [...fileMap.values()];
}

function createSegment(kind, items = [], turn = {}, index = 0) {
  return {
    id: `${turn?.id || "turn"}-segment-${encodeURIComponent(items[0]?.id || index)}-${kind}`,
    kind,
    items,
    visibleItems: items,
    processSummary: null,
    defaultCollapsed: false
  };
}

function applySegmentCollapseDefaults(segments = []) {
  return segments.map((segment) => {
    if (segment.kind !== "process") {
      return segment;
    }
    const processSummary = summarizeProcessItems(segment.items);
    const hasDiagnosticDump = segment.items.some((item) => item.isDiagnosticDump);
    const visibleItems = segment.items.filter((item) => !item.isNoisyProcess);
    return {
      ...segment,
      visibleItems,
      processSummary,
      defaultCollapsed: true,
      hasDiagnosticDump
    };
  });
}

export function segmentTurnItems(items = [], turn = {}, options = {}) {
  const normalizedItems = asArray(items)
    .map((item) => normalizeThreadItem(item, options))
    .filter(Boolean);
  const activityStarts = new Map(normalizedItems.filter((item) => item.activity?.event === "started").map((item) => [item.id, item]));
  const mergedCompletions = new Set();
  for (const item of normalizedItems) {
    const started = activityStarts.get(item.activity?.startedItemId);
    if (!started || item === started || !["completed", "failed", "interrupted"].includes(item.activity?.state)) continue;
    if (started.activity.agentThreadId && item.activity.agentThreadId && started.activity.agentThreadId !== item.activity.agentThreadId) continue;
    started.activity = { ...started.activity, ...item.activity, event: "started", label: started.activity.label || item.activity.label,
      startedAt: started.activity.startedAt || item.activity.startedAt,
      completedAt: item.activity.completedAt || started.activity.completedAt,
      durationMs: item.activity.durationMs ?? started.activity.durationMs, startedItemId: started.id };
    mergedCompletions.add(item.id);
  }
  const segments = [];

  for (const item of normalizedItems) {
    if (mergedCompletions.has(item.id)) continue;
    const segmentKind = ["user", "primary", "activity"].includes(item.category) ? item.category : "process";
    const previous = segments[segments.length - 1];
    const canMerge =
      previous &&
      previous.kind === segmentKind &&
      segmentKind !== "user";

    if (canMerge) {
      previous.items.push(item);
      continue;
    }
    segments.push(createSegment(segmentKind, [item], turn, segments.length));
  }

  return applySegmentCollapseDefaults(segments, turn);
}

export function buildTurnViewModel(turn = {}, options = {}) {
  const items = asArray(turn?.items);
  const segments = segmentTurnItems(items, turn, options);
  const fileChanges = buildHistoricalFileChanges(items);
  const hasFileChange = segments.some((segment) =>
    segment.items.some((item) => String(item?.kind || "").trim().toLowerCase() === "filechange")
  );
  return {
    id: String(turn?.id || ""),
    status: String(turn?.status || "inProgress"),
    startedAt: firstDefined(turn?.startedAt, ""),
    completedAt: firstDefined(turn?.completedAt, ""),
    durationMs: Number(turn?.durationMs || 0) || activityDuration({ state: "completed", startedAt: turn.startedAt, completedAt: turn.completedAt }) || 0,
    error: turn?.error || null,
    segments,
    hasPrimary: segments.some((segment) => segment.kind === "primary"),
    hasProcess: segments.some((segment) => segment.kind === "process"),
    hasFileChange,
    fileChanges
  };
}

function buildThread(snapshot, options, buildTurn) {
  const turns = asArray(snapshot?.turns).map((turn) => buildTurn(turn, options));
  const latestFileChangeTurn = [...turns]
    .reverse()
    .find((turn) => turn.hasFileChange);
  return {
    threadId: String(firstDefined(snapshot?.threadId, "")),
    version: Number(snapshot?.version || 0),
    updatedAt: firstDefined(snapshot?.updatedAt, ""),
    turns,
    latestFileChangeTurnId: String(latestFileChangeTurn?.id || ""),
    isEmpty: turns.length === 0
  };
}

export function buildThreadViewModel(snapshot = {}, options = {}) {
  return buildThread(snapshot, options, buildTurnViewModel);
}

export function createThreadViewModelBuilder() {
  // Presented turns retain their identity only while all display inputs are unchanged.
  let cache = new WeakMap();
  let previousOptions = {};
  let previousTurns = new Map(), previousThreadId;
  let expansionAnchors = new WeakMap();
  return (snapshot = {}, options = {}) => {
    const keys = Object.keys(options);
    if (keys.length !== Object.keys(previousOptions).length || keys.some((key) => !Object.is(options[key], previousOptions[key]))) {
      cache = new WeakMap();
      previousTurns.clear();
      expansionAnchors = new WeakMap();
      previousOptions = { ...options };
    }
    if (previousThreadId !== snapshot.threadId) { previousTurns.clear(); previousThreadId = snapshot.threadId; }
    const model = buildThread(snapshot, options, (turn) => {
      if (!cache.has(turn)) {
        const view = buildTurnViewModel(turn, options);
        const previous = previousTurns.get(view.id);
        const retained = new Set();
        for (const segment of view.segments.filter((segment) => segment.kind === "process")) {
          const ids = new Set(segment.items.map((item) => item.id));
          const anchor = previous?.segments.find((candidate) => candidate.kind === "process" && !retained.has(candidate.id)
            && ids.has(expansionAnchors.get(candidate) || candidate.items[0]?.id));
          expansionAnchors.set(segment, anchor && (expansionAnchors.get(anchor) || anchor.items[0]?.id) || segment.items[0]?.id);
          if (anchor) { segment.id = anchor.id; retained.add(anchor.id); }
        }
        cache.set(turn, view);
      }
      return cache.get(turn);
    });
    previousTurns = new Map(model.turns.map((turn) => [turn.id, turn]));
    return model;
  };
}
