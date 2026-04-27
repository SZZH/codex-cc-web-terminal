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

function applySegmentCollapseDefaults(segments = [], turn = {}) {
  const hasPrimary = segments.some((segment) => segment.kind === "primary");
  return segments.map((segment, index) => {
    if (segment.kind !== "process") {
      return segment;
    }
    const hasPrimaryAfter = segments.slice(index + 1).some((candidate) => candidate.kind === "primary");
    const processSummary = summarizeProcessItems(segment.items);
    const defaultCollapsed =
      String(turn?.status || "").trim() === "completed"
        ? true
        : hasPrimary
          ? hasPrimaryAfter || segments.slice(0, index).some((candidate) => candidate.kind === "primary")
          : false;
    return {
      ...segment,
      processSummary,
      defaultCollapsed
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
    hasFileChange
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
