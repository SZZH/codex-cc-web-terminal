import { normalizeThreadItem, summarizeProcessItems } from "./thread-item-renderers.js";

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

function createLiveOverlayItem(liveOverlay = {}) {
  const text = String(firstDefined(liveOverlay.text, liveOverlay.body, "")).trim();
  if (!text) {
    return null;
  }
  return {
    id: String(firstDefined(liveOverlay.id, `live-overlay-${liveOverlay.turnId || "turn"}`)),
    kind: "AgentMessage",
    status: firstDefined(liveOverlay.status, "inProgress"),
    text,
    message: text,
    content: [{ type: "output_text", text }],
    isLiveOverlay: true
  };
}

function appendLiveOverlay(items = [], turn = {}, liveOverlay = null) {
  if (!liveOverlay) {
    return items;
  }
  if (String(turn?.id || "") !== String(liveOverlay.turnId || "")) {
    return items;
  }
  if (
    items.some(
      (item) =>
        String(item?.id || "") === String(liveOverlay.id || "") ||
        (String(item?.kind || "").toLowerCase() === "agentmessage" && String(item?.text || "").trim() === String(liveOverlay.text || "").trim())
    )
  ) {
    return items;
  }
  const overlayItem = createLiveOverlayItem(liveOverlay);
  if (!overlayItem) {
    return items;
  }
  return [...items, overlayItem];
}

function createSegment(kind, items = [], turn = {}, index = 0) {
  return {
    id: `${turn?.id || "turn"}-segment-${index}-${kind}`,
    kind,
    items,
    processSummary: null,
    defaultCollapsed: false
  };
}

function isTerminalTurn(turn = {}) {
  const status = String(turn?.status || "").trim().toLowerCase();
  return Boolean(turn?.completedAt) || ["completed", "failed", "aborted"].includes(status);
}

function applySegmentCollapseDefaults(segments = [], turn = {}) {
  const hasPrimary = segments.some((segment) => segment.kind === "primary");
  return segments.map((segment, index) => {
    if (segment.kind !== "process") {
      return segment;
    }
    const hasPrimaryAfter = segments.slice(index + 1).some((candidate) => candidate.kind === "primary");
    const processSummary = summarizeProcessItems(segment.items);
    const hasDiagnosticDump = segment.items.some((item) => item.isDiagnosticDump);
    const defaultCollapsed =
      hasDiagnosticDump
        ? true
        : isTerminalTurn(turn)
        ? true
        : hasPrimary
          ? hasPrimaryAfter || segments.slice(0, index).some((candidate) => candidate.kind === "primary")
          : false;
    return {
      ...segment,
      processSummary,
      defaultCollapsed,
      hasDiagnosticDump
    };
  });
}

export function segmentTurnItems(items = [], turn = {}, options = {}) {
  const normalizedItems = asArray(items)
    .map((item) => normalizeThreadItem(item, options))
    .filter(Boolean);
  const segments = [];

  for (const item of normalizedItems) {
    const segmentKind = item.category === "user" ? "user" : item.category === "primary" ? "primary" : "process";
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
  const items = appendLiveOverlay(asArray(turn?.items), turn, options.liveOverlay);
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
    durationMs: Number(turn?.durationMs || 0),
    error: turn?.error || null,
    segments,
    hasPrimary: segments.some((segment) => segment.kind === "primary"),
    hasProcess: segments.some((segment) => segment.kind === "process"),
    hasFileChange,
    fileChanges
  };
}

export function buildThreadViewModel(snapshot = {}, options = {}) {
  const turns = asArray(snapshot?.turns).map((turn) => buildTurnViewModel(turn, options));
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
