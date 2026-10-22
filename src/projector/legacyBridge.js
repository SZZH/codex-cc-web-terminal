import { createThreadProjector } from "./threadProjector.js";
import { TURN_STATUSES } from "./snapshot.js";
import { THREAD_ITEM_KIND, TURN_STATUS, ASSISTANT_LIVE_STATE } from "../threads/itemTaxonomy.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sanitizeMetadataExtra(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry == null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      sanitized[key] = entry;
    }
  }
  return sanitized;
}

function mapTurnStatus(status) {
  if (status === TURN_STATUSES.COMPLETED) {
    return TURN_STATUS.COMPLETED;
  }
  if (status === TURN_STATUSES.FAILED) {
    return TURN_STATUS.FAILED;
  }
  if (status === TURN_STATUSES.INTERRUPTED) {
    return TURN_STATUS.ABORTED;
  }
  return TURN_STATUS.IN_PROGRESS;
}

function mapLiveState(overlay) {
  if (!overlay?.turnId) {
    return ASSISTANT_LIVE_STATE.IDLE;
  }
  if (overlay.status === TURN_STATUSES.FAILED) {
    return ASSISTANT_LIVE_STATE.FAILED;
  }
  if (overlay.status === TURN_STATUSES.INTERRUPTED) {
    return ASSISTANT_LIVE_STATE.ABORTED;
  }
  return overlay.message?.text ? ASSISTANT_LIVE_STATE.LIVE_PRIMARY : ASSISTANT_LIVE_STATE.IDLE;
}

function mapItem(item) {
  if (item.kind === "UserMessage") {
    return {
      id: item.id,
      kind: THREAD_ITEM_KIND.USER_MESSAGE,
      status: null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.completedAt ?? item.createdAt ?? null,
      source: null,
      summary: item.text ?? "",
      text: item.text ?? "",
      payload: clone(item.payload || {}),
      meta: {}
    };
  }

  if (item.kind === "AgentMessage") {
    return {
      id: item.id,
      kind: THREAD_ITEM_KIND.AGENT_MESSAGE,
      status: null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.completedAt ?? item.createdAt ?? null,
      source: "primary",
      summary: item.text ?? "",
      text: item.text ?? "",
      payload: {},
      meta: {}
    };
  }

  if (item.kind === "Reasoning") {
    return {
      id: item.id,
      kind: THREAD_ITEM_KIND.REASONING,
      status: null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.completedAt ?? item.createdAt ?? null,
      source: "projector",
      summary: item.text ?? "",
      text: item.text ?? "",
      payload: {},
      meta: {}
    };
  }

  if (item.kind === "ToolCall") {
    const kindMap = {
      command: THREAD_ITEM_KIND.COMMAND_EXECUTION,
      file_change: THREAD_ITEM_KIND.FILE_CHANGE,
      mcp: THREAD_ITEM_KIND.MCP_TOOL_CALL,
      collab: THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL,
      dynamic: THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL
    };
    return {
      id: item.id,
      kind: kindMap[item.toolKind] || THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL,
      status: item.status ?? null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? item.createdAt ?? null,
      source: "projector",
      summary: item.summary ?? "",
      text: item.summary ?? "",
      payload: {
        callId: item.callId,
        name: item.toolName
      },
      meta: {}
    };
  }

  return {
    id: item.id,
    kind: THREAD_ITEM_KIND.UNKNOWN,
    status: null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
    source: "projector",
    summary: item.text ?? item.label ?? item.id,
    text: item.text ?? "",
    payload: clone(item.metadata || {}),
    meta: {}
  };
}

function overlayToLegacyLiveOverlay(overlay) {
  if (!overlay?.turnId) {
    return null;
  }
  return {
    turnId: overlay.turnId,
    liveState: mapLiveState(overlay),
    text: overlay.message?.text ?? overlay.reasoning?.text ?? "",
    source: overlay.message?.text ? "primary" : "fallback",
    anchorItemId: overlay.message?.text ? `message:${overlay.turnId}` : overlay.reasoning?.text ? `reasoning:${overlay.turnId}` : null
  };
}

function buildAssistantState(turn, overlay) {
  const activeOverlay = overlay?.turnId === turn.id ? overlay : null;
  const hasCommittedMessage = Array.isArray(turn.items) && turn.items.some((item) => item.kind === "AgentMessage");
  return {
    liveState: activeOverlay
      ? mapLiveState(activeOverlay)
      : turn.status === TURN_STATUSES.FAILED
        ? ASSISTANT_LIVE_STATE.FAILED
        : turn.status === TURN_STATUSES.INTERRUPTED
          ? ASSISTANT_LIVE_STATE.ABORTED
          : hasCommittedMessage
            ? ASSISTANT_LIVE_STATE.COMMITTED
            : ASSISTANT_LIVE_STATE.IDLE,
    liveText: activeOverlay?.message?.text ?? null,
    liveSource: activeOverlay?.message?.text ? "primary" : null,
    committedMessages: [],
    pendingMessageItemId: activeOverlay?.message?.text ? `message:${turn.id}` : null,
    pendingPrimaryText: activeOverlay?.message?.text ?? null,
    pendingFallbackText: activeOverlay?.reasoning?.text ?? null,
    status: mapTurnStatus(turn.status)
  };
}

function overlayItems(turn, overlay) {
  if (!overlay || overlay.turnId !== turn.id) {
    return [];
  }
  const items = [];
  if (overlay.message?.text) {
    items.push({
      kind: "AgentMessage",
      id: `message:${turn.id}`,
      text: overlay.message.text,
      createdAt: turn.startedAt ?? null,
      completedAt: null
    });
  }
  if (overlay.reasoning?.text) {
    items.push({
      kind: "Reasoning",
      id: `reasoning:${turn.id}`,
      text: overlay.reasoning.text,
      createdAt: turn.startedAt ?? null,
      completedAt: null
    });
  }
  for (const tool of overlay.tools || []) {
    items.push(tool);
  }
  for (const artifact of overlay.artifacts || []) {
    items.push(artifact);
  }
  return items;
}

export function projectorSnapshotToLegacyThread(snapshot, overlay = null, previous = null) {
  const legacyTurns = (snapshot?.turns || []).map((turn) => {
    const items = [...(turn.items || [])];
    for (const item of overlayItems(turn, overlay)) {
      const index = items.findIndex((existing) => existing.id && existing.id === item.id);
      if (index >= 0) items[index] = { ...items[index], ...item };
      else items.push(item);
    }
    const turnItems = items.map(mapItem);
    return {
      id: turn.id,
      items: turnItems,
      status: mapTurnStatus(turn.status),
      error: clone(turn.error || null),
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      durationMs: null,
      assistant: buildAssistantState(turn, overlay)
    };
  });

  return {
    threadId: snapshot?.threadId ?? previous?.threadId ?? "",
    metadata: {
      name: snapshot?.metadata?.extra?.name ?? snapshot?.metadata?.title ?? previous?.metadata?.name ?? null,
      preview: previous?.metadata?.preview ?? null,
      model: previous?.metadata?.model ?? null,
      cwd: snapshot?.metadata?.cwd ?? previous?.metadata?.cwd ?? null,
      source: snapshot?.metadata?.providerSet?.[0] ?? previous?.metadata?.source ?? null,
      archivedAt: previous?.metadata?.archivedAt ?? null,
      extra: {
        ...sanitizeMetadataExtra(previous?.metadata?.extra),
        ...sanitizeMetadataExtra(snapshot?.metadata?.extra)
      }
    },
    turns: legacyTurns,
    runtime: clone(previous?.runtime || { latestTurnContext: null }),
    metrics: clone(previous?.metrics || { latestUsage: null }),
    version: Number(snapshot?.version || 0),
    lastEventSeq: Number(snapshot?.lastSeq || previous?.lastEventSeq || 0),
    updatedAt: snapshot?.updatedAt ?? previous?.updatedAt ?? null,
    activeTurnId: snapshot?.activeTurnId ?? null
  };
}

function legacyTurnToProjectorItems(turn) {
  const items = [];
  for (const item of turn?.items || []) {
    if (item.kind === THREAD_ITEM_KIND.USER_MESSAGE) {
      items.push({
        kind: "UserMessage",
        id: item.id,
        text: item.text ?? item.summary ?? "",
        payload: clone(item.payload || {}),
        createdAt: item.createdAt ?? null,
        completedAt: item.updatedAt ?? item.createdAt ?? null
      });
    } else if (item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE) {
      items.push({
        kind: "AgentMessage",
        id: item.id,
        text: item.text ?? item.summary ?? "",
        createdAt: item.createdAt ?? null,
        completedAt: item.updatedAt ?? item.createdAt ?? null
      });
    } else if (item.kind === THREAD_ITEM_KIND.REASONING) {
      items.push({
        kind: "Reasoning",
        id: item.id,
        text: item.text ?? item.summary ?? "",
        createdAt: item.createdAt ?? null,
        completedAt: item.updatedAt ?? item.createdAt ?? null
      });
    } else if (
      [
        THREAD_ITEM_KIND.COMMAND_EXECUTION,
        THREAD_ITEM_KIND.FILE_CHANGE,
        THREAD_ITEM_KIND.MCP_TOOL_CALL,
        THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL,
        THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL
      ].includes(item.kind)
    ) {
      const toolKindMap = {
        [THREAD_ITEM_KIND.COMMAND_EXECUTION]: "command",
        [THREAD_ITEM_KIND.FILE_CHANGE]: "file_change",
        [THREAD_ITEM_KIND.MCP_TOOL_CALL]: "mcp",
        [THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL]: "dynamic",
        [THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL]: "collab"
      };
      items.push({
        kind: "ToolCall",
        id: item.id,
        callId: item.payload?.callId ?? item.id,
        toolName: item.payload?.name ?? "unknown",
        toolKind: toolKindMap[item.kind] || "dynamic",
        status: item.status ?? "completed",
        summary: item.summary ?? item.text ?? "",
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? item.createdAt ?? null
      });
    }
  }
  return items;
}

export function legacyThreadToProjectorSnapshot(snapshot) {
  const legacyMetadata = snapshot?.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : {};
  const legacyExtra = sanitizeMetadataExtra(legacyMetadata.extra);
  return {
    threadId: snapshot?.threadId ?? "",
    version: Number(snapshot?.version || 0),
    lastSeq: Number(snapshot?.lastEventSeq || 0),
    updatedAt: snapshot?.updatedAt ?? null,
    activeTurnId: snapshot?.activeTurnId ?? null,
    metadata: {
      title: legacyMetadata.name ?? "",
      cwd: legacyMetadata.cwd,
      providerSet: legacyMetadata.source ? [legacyMetadata.source] : [],
      tags: [],
      extra: {
        ...legacyExtra
      }
    },
    turns: (snapshot?.turns || []).map((turn) => ({
      id: turn.id,
      status:
        turn.status === TURN_STATUS.COMPLETED
          ? TURN_STATUSES.COMPLETED
          : turn.status === TURN_STATUS.FAILED
            ? TURN_STATUSES.FAILED
            : turn.status === TURN_STATUS.ABORTED
              ? TURN_STATUSES.INTERRUPTED
              : TURN_STATUSES.RUNNING,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      error: clone(turn.error || turn.assistant?.error || null),
      items: legacyTurnToProjectorItems(turn)
    })),
    backgroundAgents: clone(snapshot?.backgroundAgents || [])
  };
}

export function createLegacyThreadProjection(input = {}) {
  const projector = createThreadProjector({
    threadId: input.threadId ?? input.snapshot?.threadId ?? "",
    metadata: input.snapshot?.metadata,
    snapshot: input.snapshot ? legacyThreadToProjectorSnapshot(input.snapshot) : undefined
  });

  if (input.snapshot) {
    projector.applyEvent({
      id: `seed:${input.snapshot.threadId || "thread"}`,
      seq: Number(input.snapshot.lastEventSeq || 0),
      provider: String(input.snapshot.metadata?.source || "unknown"),
      providerThreadId: String(input.snapshot.threadId || ""),
      threadId: String(input.snapshot.threadId || ""),
      turnId: null,
      ts: input.snapshot.updatedAt || new Date().toISOString(),
      kind: "thread.snapshot",
      payload: {
        snapshot: legacyThreadToProjectorSnapshot(input.snapshot)
      }
    });
  }

  return {
    projector,
    getLegacyState(previous = input.snapshot || null) {
      const snapshot = projector.getSnapshot();
      const overlay = projector.getOverlay();
      return {
        projectorSnapshot: snapshot,
        threadSnapshot: projectorSnapshotToLegacyThread(snapshot, overlay, previous),
        liveOverlay: overlayToLegacyLiveOverlay(overlay)
      };
    }
  };
}
