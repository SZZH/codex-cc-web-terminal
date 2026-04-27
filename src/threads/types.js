import {
  ASSISTANT_LIVE_STATE,
  THREAD_ITEM_KIND,
  TURN_STATUS
} from "./itemTaxonomy.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createRawThreadRecord(input = {}) {
  const {
    id = null,
    threadId = null,
    turnId = null,
    source = "unknown",
    recordType = "unknown",
    recordSubtype = "unknown",
    raw = {},
    recordTs = null,
    ingestedAt = recordTs ?? null,
    seq = 0
  } = input;

  return {
    id,
    threadId,
    turnId,
    source,
    recordType,
    recordSubtype,
    raw: clone(raw),
    recordTs,
    ingestedAt,
    seq
  };
}

export function createCanonicalEvent(input = {}) {
  const {
    id = null,
    threadId,
    turnId = null,
    seq = 0,
    eventType,
    payload = {},
    eventTs = null,
    sourceRecordId = null,
    createdAt = eventTs ?? null
  } = input;

  if (!threadId) {
    throw new Error("createCanonicalEvent requires threadId");
  }
  if (!eventType) {
    throw new Error("createCanonicalEvent requires eventType");
  }

  return {
    id,
    threadId,
    turnId,
    seq,
    eventType,
    payload: clone(payload),
    eventTs,
    sourceRecordId,
    createdAt
  };
}

export function createThreadMetadata(input = {}) {
  return {
    name: input.name ?? null,
    preview: input.preview ?? null,
    model: input.model ?? null,
    cwd: input.cwd ?? null,
    source: input.source ?? null,
    archivedAt: input.archivedAt ?? null,
    extra: clone(input.extra ?? {})
  };
}

export function createAssistantState(input = {}) {
  return {
    liveState: input.liveState ?? ASSISTANT_LIVE_STATE.IDLE,
    liveText: input.liveText ?? null,
    liveSource: input.liveSource ?? null,
    committedMessages: clone(input.committedMessages ?? []),
    pendingMessageItemId: input.pendingMessageItemId ?? null,
    pendingPrimaryText: input.pendingPrimaryText ?? null,
    pendingFallbackText: input.pendingFallbackText ?? null,
    status: input.status ?? TURN_STATUS.IN_PROGRESS
  };
}

export function createTurn(input = {}) {
  const startedAt = input.startedAt ?? null;
  const completedAt = input.completedAt ?? null;

  return {
    id: input.id,
    items: clone(input.items ?? []),
    status: input.status ?? TURN_STATUS.IN_PROGRESS,
    error: clone(input.error ?? null),
    startedAt,
    completedAt,
    durationMs: input.durationMs ?? computeDurationMs(startedAt, completedAt),
    assistant: createAssistantState(input.assistant)
  };
}

export function createThreadSnapshot(input = {}) {
  return {
    threadId: input.threadId,
    metadata: createThreadMetadata(input.metadata),
    turns: clone(input.turns ?? []),
    runtime: {
      latestTurnContext: clone(input.runtime?.latestTurnContext ?? null)
    },
    metrics: {
      latestUsage: clone(input.metrics?.latestUsage ?? null)
    },
    version: input.version ?? 0,
    lastEventSeq: input.lastEventSeq ?? 0,
    updatedAt: input.updatedAt ?? null,
    activeTurnId: input.activeTurnId ?? null
  };
}

export function createThreadItem(input = {}) {
  return {
    id: input.id,
    kind: input.kind ?? THREAD_ITEM_KIND.UNKNOWN,
    status: input.status ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? input.createdAt ?? null,
    source: input.source ?? null,
    summary: input.summary ?? null,
    text: input.text ?? null,
    payload: clone(input.payload ?? {}),
    meta: clone(input.meta ?? {})
  };
}

export function computeDurationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) {
    return null;
  }
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (Number.isNaN(started) || Number.isNaN(completed)) {
    return null;
  }
  return Math.max(0, completed - started);
}
