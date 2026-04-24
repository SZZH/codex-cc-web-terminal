import {
  ASSISTANT_LIVE_STATE,
  THREAD_ITEM_KIND,
  TURN_STATUS,
  classifyThreadItemKind,
  isPrimaryItemKind,
  isProcessItemKind
} from "./itemTaxonomy.js";
import {
  computeDurationMs,
  createAssistantState,
  createThreadItem,
  createThreadSnapshot,
  createTurn
} from "./types.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function turnTimestamp(event) {
  return event.eventTs ?? event.createdAt ?? null;
}

function itemId(prefix, turnId, event) {
  return `${prefix}:${turnId}:${event.payload?.callId ?? event.seq}`;
}

function isTerminalTurnStatus(status) {
  return status === TURN_STATUS.COMPLETED || status === TURN_STATUS.FAILED || status === TURN_STATUS.ABORTED;
}

function createEmptySnapshot(threadId, input = {}) {
  return createThreadSnapshot({
    threadId,
    metadata: input.metadata,
    updatedAt: input.updatedAt ?? null
  });
}

function findTurnIndex(snapshot, turnId) {
  return snapshot.turns.findIndex((turn) => turn.id === turnId);
}

function ensureTurn(snapshot, turnId, event) {
  let index = findTurnIndex(snapshot, turnId);
  if (index >= 0) {
    return snapshot.turns[index];
  }

  const turn = createTurn({
    id: turnId,
    startedAt: turnTimestamp(event),
    status: TURN_STATUS.IN_PROGRESS,
    assistant: createAssistantState()
  });
  snapshot.turns.push(turn);
  snapshot.activeTurnId = turn.id;
  return turn;
}

function resolveTurnId(snapshot, event) {
  if (event.turnId) {
    return event.turnId;
  }
  if (snapshot.activeTurnId) {
    return snapshot.activeTurnId;
  }
  return `turn:${event.seq}`;
}

function updateSnapshotMeta(snapshot, event) {
  snapshot.lastEventSeq = Math.max(snapshot.lastEventSeq, event.seq ?? 0);
  snapshot.version += 1;
  snapshot.updatedAt = turnTimestamp(event);
}

function setAssistantLive(turn, state, text, source) {
  turn.assistant.liveState = state;
  turn.assistant.liveText = text ?? null;
  turn.assistant.liveSource = source ?? null;
}

function mergeAssistantLiveText(previousText, nextText) {
  const previous = String(previousText || "");
  const next = String(nextText || "");
  if (!next) {
    return previous;
  }
  if (!previous) {
    return next || previous;
  }
  if (next === previous) {
    return next.length < 24 ? `${previous}${next}` : next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next) && next.length >= 24) {
    return previous;
  }
  return `${previous}${next}`;
}

function updateAssistantLiveFromSource(turn, text, source) {
  if (!text) {
    return;
  }

  if (source === "primary") {
    const mergedText = mergeAssistantLiveText(turn.assistant.pendingPrimaryText, text);
    turn.assistant.pendingPrimaryText = mergedText;
    setAssistantLive(turn, ASSISTANT_LIVE_STATE.LIVE_PRIMARY, mergedText, source);
    return;
  }

  const mergedText = mergeAssistantLiveText(turn.assistant.pendingFallbackText, text);
  turn.assistant.pendingFallbackText = mergedText;
  if (
    turn.assistant.liveState === ASSISTANT_LIVE_STATE.IDLE ||
    turn.assistant.liveState === ASSISTANT_LIVE_STATE.LIVE_FALLBACK
  ) {
    setAssistantLive(turn, ASSISTANT_LIVE_STATE.LIVE_FALLBACK, mergedText, source);
  }
}

function ensurePendingAssistantItem(turn, event) {
  if (turn.assistant.pendingMessageItemId) {
    const existing = turn.items.find((item) => item.id === turn.assistant.pendingMessageItemId);
    if (existing) {
      return existing;
    }
  }

  const created = createThreadItem({
    id: itemId("agent-message-live", turn.id, event),
    kind: THREAD_ITEM_KIND.AGENT_MESSAGE,
    createdAt: turnTimestamp(event),
    updatedAt: turnTimestamp(event),
    text: null,
    summary: null,
    source: "live",
    meta: {
      provisional: true
    }
  });
  turn.items.push(created);
  turn.assistant.pendingMessageItemId = created.id;
  return created;
}

function syncPendingAssistantItem(turn, event) {
  if (!turn.assistant.liveText) {
    return;
  }
  const item = ensurePendingAssistantItem(turn, event);
  item.text = turn.assistant.liveText;
  item.summary = turn.assistant.liveText;
  item.updatedAt = turnTimestamp(event);
  item.source = turn.assistant.liveSource;
  item.meta = {
    ...item.meta,
    provisional: true,
    liveState: turn.assistant.liveState
  };
}

function commitAssistantMessage(turn, event) {
  if (turn.assistant.committedMessages.length > 0) {
    turn.assistant.liveState = ASSISTANT_LIVE_STATE.COMMITTED;
    turn.assistant.liveText = null;
    turn.assistant.liveSource = null;
    return turn.assistant.committedMessages[0];
  }

  const text = turn.assistant.pendingPrimaryText ?? turn.assistant.pendingFallbackText ?? turn.assistant.liveText;
  if (!text) {
    turn.assistant.liveState = ASSISTANT_LIVE_STATE.COMMITTED;
    return null;
  }

  const source = turn.assistant.pendingPrimaryText ? "primary" : turn.assistant.pendingFallbackText ? "fallback" : turn.assistant.liveSource;
  const item = ensurePendingAssistantItem(turn, event);
  item.text = text;
  item.summary = text;
  item.updatedAt = turnTimestamp(event);
  item.source = source;
  item.meta = {
    ...item.meta,
    provisional: false,
    source
  };
  turn.assistant.committedMessages = [clone(item)];
  turn.assistant.pendingMessageItemId = item.id;
  turn.assistant.liveState = ASSISTANT_LIVE_STATE.COMMITTED;
  turn.assistant.liveText = null;
  turn.assistant.liveSource = null;
  return item;
}

function appendUserMessage(turn, event) {
  const text = event.payload?.text ?? "";
  turn.items.push(
    createThreadItem({
      id: itemId("user-message", turn.id, event),
      kind: THREAD_ITEM_KIND.USER_MESSAGE,
      createdAt: turnTimestamp(event),
      updatedAt: turnTimestamp(event),
      text,
      summary: text,
      payload: {
        content: clone(event.payload?.content ?? []),
        images: clone(event.payload?.images ?? []),
        local_images: clone(event.payload?.local_images ?? [])
      }
    })
  );
}

function upsertTurnItem(turn, itemKind, stableId, input) {
  const existingIndex = turn.items.findIndex((item) => item.id === stableId);
  if (existingIndex >= 0) {
    const current = turn.items[existingIndex];
    turn.items[existingIndex] = {
      ...current,
      ...input,
      kind: itemKind,
      id: stableId,
      payload: {
        ...current.payload,
        ...(input.payload ?? {})
      },
      meta: {
        ...current.meta,
        ...(input.meta ?? {})
      },
      updatedAt: input.updatedAt ?? current.updatedAt
    };
    return turn.items[existingIndex];
  }

  const created = createThreadItem({
    id: stableId,
    kind: itemKind,
    ...input
  });
  turn.items.push(created);
  return created;
}

function lastReasoningItem(turn) {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.kind === THREAD_ITEM_KIND.REASONING) {
      return item;
    }
    if (item.kind !== THREAD_ITEM_KIND.UNKNOWN && item.kind !== THREAD_ITEM_KIND.REASONING) {
      break;
    }
  }
  return null;
}

function appendReasoning(turn, event) {
  const summary = event.payload?.summary ?? "";
  const content = event.payload?.content ?? null;
  const existing = lastReasoningItem(turn);
  if (existing) {
    const summaries = Array.isArray(existing.payload?.summaries) ? existing.payload.summaries.slice() : [];
    const contents = Array.isArray(existing.payload?.contents) ? existing.payload.contents.slice() : [];
    if (summary) {
      summaries.push(summary);
    }
    if (content) {
      contents.push(content);
    }
    existing.payload = {
      ...existing.payload,
      summaries,
      contents
    };
    existing.summary = summaries.join("\n");
    existing.updatedAt = turnTimestamp(event);
    return existing;
  }

  const item = createThreadItem({
    id: itemId("reasoning", turn.id, event),
    kind: THREAD_ITEM_KIND.REASONING,
    createdAt: turnTimestamp(event),
    updatedAt: turnTimestamp(event),
    summary: summary || null,
    payload: {
      summaries: summary ? [summary] : [],
      contents: content ? [content] : []
    }
  });
  turn.items.push(item);
  return item;
}

function appendPlan(turn, event) {
  const text = event.payload?.text ?? event.payload?.summary ?? "";
  turn.items.push(
    createThreadItem({
      id: itemId("plan", turn.id, event),
      kind: THREAD_ITEM_KIND.PLAN,
      createdAt: turnTimestamp(event),
      updatedAt: turnTimestamp(event),
      text,
      summary: text,
      payload: clone(event.payload ?? {})
    })
  );
}

function upsertAssistantImages(turn, event) {
  const parts = Array.isArray(event.payload?.parts) ? event.payload.parts : [];
  const imageParts = parts.filter((part) => String(part?.type || "") === "image" && String(part?.url || "").trim());
  for (let index = 0; index < imageParts.length; index += 1) {
    const image = imageParts[index];
    const stableId = `${turn.id}:assistant-image:${index}`;
    upsertTurnItem(turn, THREAD_ITEM_KIND.IMAGE_VIEW, stableId, {
      createdAt: turnTimestamp(event),
      updatedAt: turnTimestamp(event),
      summary: String(image.alt || "image").trim() || "image",
      payload: {
        url: String(image.url || "").trim(),
        alt: String(image.alt || "image").trim() || "image"
      }
    });
  }
}

function upsertToolLifecycle(turn, event, kind, phase) {
  const callId = event.payload?.callId ?? `${turn.id}:${event.seq}`;
  const base = {
    createdAt: phase === "started" ? turnTimestamp(event) : null,
    updatedAt: turnTimestamp(event),
    summary: event.payload?.name ?? kind,
    status: phase === "started" ? "inProgress" : event.payload?.status ?? "completed",
    source: "canonical_event",
    payload: clone(event.payload ?? {})
  };
  return upsertTurnItem(turn, kind, itemId(kind, turn.id, { payload: { callId }, seq: event.seq }), base);
}

function applyTurnTerminalState(turn, status, event) {
  turn.status = status;
  turn.completedAt = turnTimestamp(event);
  turn.durationMs = computeDurationMs(turn.startedAt, turn.completedAt);
  turn.assistant.status = status;

  if (status === TURN_STATUS.COMPLETED) {
    commitAssistantMessage(turn, event);
    turn.assistant.liveState = ASSISTANT_LIVE_STATE.COMMITTED;
    return;
  }

  if (status === TURN_STATUS.FAILED) {
    turn.assistant.liveState = ASSISTANT_LIVE_STATE.FAILED;
    return;
  }

  if (status === TURN_STATUS.ABORTED) {
    turn.assistant.liveState = ASSISTANT_LIVE_STATE.ABORTED;
  }
}

export function applyCanonicalEvent(snapshotInput, event) {
  const snapshot = snapshotInput ? clone(snapshotInput) : createEmptySnapshot(event.threadId);
  const turnId = resolveTurnId(snapshot, event);
  let turn = null;

  updateSnapshotMeta(snapshot, event);

  switch (event.eventType) {
    case "thread_metadata_initialized":
      snapshot.metadata = {
        ...snapshot.metadata,
        ...clone(event.payload ?? {})
      };
      return snapshot;

    case "runtime_context_recorded":
      snapshot.runtime.latestTurnContext = clone(event.payload ?? null);
      return snapshot;

    case "usage_metrics_recorded":
      snapshot.metrics.latestUsage = clone(event.payload ?? null);
      return snapshot;

    case "turn_started":
      snapshot.activeTurnId = turnId;
      ensureTurn(snapshot, turnId, event);
      return snapshot;

    case "user_message_recorded":
      snapshot.activeTurnId = turnId;
      turn = ensureTurn(snapshot, turnId, event);
      appendUserMessage(turn, event);
      return snapshot;

    case "hook_prompt_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("hook-prompt", turn.id, event),
          kind: THREAD_ITEM_KIND.HOOK_PROMPT,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.payload?.text ?? null,
          text: event.payload?.text ?? null,
          payload: clone(event.payload ?? {})
        })
      );
      return snapshot;

    case "plan_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      appendPlan(turn, event);
      return snapshot;

    case "agent_message_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      upsertAssistantImages(turn, event);
      updateAssistantLiveFromSource(
        turn,
        event.payload?.text ?? "",
        event.payload?.source === "primary_output_text" || event.payload?.source === "primary" ? "primary" : "fallback"
      );
      syncPendingAssistantItem(turn, event);
      return snapshot;

    case "reasoning_summary_recorded":
    case "reasoning_raw_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      appendReasoning(turn, event);
      return snapshot;

    case "command_execution_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.COMMAND_EXECUTION, "started");
      return snapshot;
    case "command_execution_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.COMMAND_EXECUTION, "completed");
      return snapshot;

    case "file_change_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.FILE_CHANGE, "started");
      return snapshot;
    case "file_change_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.FILE_CHANGE, "completed");
      return snapshot;

    case "mcp_tool_call_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.MCP_TOOL_CALL, "started");
      return snapshot;
    case "mcp_tool_call_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.MCP_TOOL_CALL, "completed");
      return snapshot;

    case "dynamic_tool_call_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL, "started");
      return snapshot;
    case "dynamic_tool_call_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL, "completed");
      return snapshot;

    case "collab_tool_call_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL, "started");
      return snapshot;
    case "collab_tool_call_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL, "completed");
      return snapshot;

    case "web_search_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.WEB_SEARCH, "started");
      return snapshot;
    case "web_search_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.WEB_SEARCH, "completed");
      return snapshot;

    case "image_view_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("image-view", turn.id, event),
          kind: THREAD_ITEM_KIND.IMAGE_VIEW,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.payload?.summary ?? null,
          payload: clone(event.payload ?? {})
        })
      );
      return snapshot;

    case "image_generation_started":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.IMAGE_GENERATION, "started");
      return snapshot;
    case "image_generation_completed":
      turn = ensureTurn(snapshot, turnId, event);
      upsertToolLifecycle(turn, event, THREAD_ITEM_KIND.IMAGE_GENERATION, "completed");
      return snapshot;

    case "review_mode_entered":
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("review-enter", turn.id, event),
          kind: THREAD_ITEM_KIND.ENTERED_REVIEW_MODE,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.payload?.summary ?? "Entered review mode",
          payload: clone(event.payload ?? {})
        })
      );
      return snapshot;

    case "review_mode_exited":
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("review-exit", turn.id, event),
          kind: THREAD_ITEM_KIND.EXITED_REVIEW_MODE,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.payload?.summary ?? "Exited review mode",
          payload: clone(event.payload ?? {})
        })
      );
      return snapshot;

    case "context_compaction_recorded":
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("context-compaction", turn.id, event),
          kind: THREAD_ITEM_KIND.CONTEXT_COMPACTION,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.payload?.summary ?? null,
          payload: clone(event.payload ?? {})
        })
      );
      return snapshot;

    case "turn_completed":
      turn = ensureTurn(snapshot, turnId, event);
      applyTurnTerminalState(turn, TURN_STATUS.COMPLETED, event);
      if (snapshot.activeTurnId === turn.id) {
        snapshot.activeTurnId = null;
      }
      return snapshot;

    case "turn_failed":
      turn = ensureTurn(snapshot, turnId, event);
      turn.error = clone(event.payload?.error ?? event.payload ?? null);
      applyTurnTerminalState(turn, TURN_STATUS.FAILED, event);
      if (snapshot.activeTurnId === turn.id) {
        snapshot.activeTurnId = null;
      }
      return snapshot;

    case "turn_aborted":
      turn = ensureTurn(snapshot, turnId, event);
      applyTurnTerminalState(turn, TURN_STATUS.ABORTED, event);
      if (snapshot.activeTurnId === turn.id) {
        snapshot.activeTurnId = null;
      }
      return snapshot;

    default:
      turn = ensureTurn(snapshot, turnId, event);
      turn.items.push(
        createThreadItem({
          id: itemId("unknown", turn.id, event),
          kind: THREAD_ITEM_KIND.UNKNOWN,
          createdAt: turnTimestamp(event),
          updatedAt: turnTimestamp(event),
          summary: event.eventType,
          payload: clone(event.payload ?? {}),
          meta: { eventType: event.eventType }
        })
      );
      return snapshot;
  }
}

export function reduceCanonicalEvents(events = [], input = {}) {
  const initial = input.snapshot ? clone(input.snapshot) : createEmptySnapshot(input.threadId ?? events[0]?.threadId ?? "thread:unknown", input);
  return events.reduce((snapshot, event) => applyCanonicalEvent(snapshot, event), initial);
}

export function getActiveTurn(snapshot) {
  if (!snapshot?.activeTurnId) {
    return null;
  }
  return snapshot.turns.find((turn) => turn.id === snapshot.activeTurnId) ?? null;
}

export function getActiveTurnLiveOverlay(snapshot) {
  const turn = getActiveTurn(snapshot);
  if (!turn || !turn.assistant?.liveText) {
    return null;
  }

  return {
    turnId: turn.id,
    liveState: turn.assistant.liveState,
    text: turn.assistant.liveText,
    source: turn.assistant.liveSource,
    anchorItemId: turn.items.at(-1)?.id ?? null
  };
}

function buildProcessSummary(items = []) {
  const summary = {
    total: items.length,
    reasoningCount: 0,
    commandCount: 0,
    fileChangeCount: 0,
    toolCount: 0,
    collabCount: 0
  };

  for (const item of items) {
    switch (item.kind) {
      case THREAD_ITEM_KIND.REASONING:
        summary.reasoningCount += 1;
        break;
      case THREAD_ITEM_KIND.COMMAND_EXECUTION:
        summary.commandCount += 1;
        break;
      case THREAD_ITEM_KIND.FILE_CHANGE:
        summary.fileChangeCount += 1;
        break;
      case THREAD_ITEM_KIND.MCP_TOOL_CALL:
      case THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL:
      case THREAD_ITEM_KIND.WEB_SEARCH:
      case THREAD_ITEM_KIND.IMAGE_VIEW:
      case THREAD_ITEM_KIND.IMAGE_GENERATION:
      case THREAD_ITEM_KIND.ENTERED_REVIEW_MODE:
      case THREAD_ITEM_KIND.EXITED_REVIEW_MODE:
      case THREAD_ITEM_KIND.CONTEXT_COMPACTION:
      case THREAD_ITEM_KIND.UNKNOWN:
        summary.toolCount += 1;
        break;
      case THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL:
        summary.collabCount += 1;
        break;
      default:
        break;
    }
  }

  return summary;
}

export function projectTurnSegments(turn) {
  const segments = [];
  let current = null;

  for (const item of turn.items) {
    const kind = classifyThreadItemKind(item.kind);
    if (!current || current.kind !== kind) {
      current = { kind, items: [] };
      segments.push(current);
    }
    current.items.push(clone(item));
  }

  return segments.map((segment, index) => {
    if (segment.kind === "process") {
      const hasPrimaryAfter = segments.slice(index + 1).some((candidate) => candidate.kind === "primary");
      return {
        ...segment,
        collapsible: hasPrimaryAfter || isTerminalTurnStatus(turn.status),
        summary: buildProcessSummary(segment.items)
      };
    }
    return segment;
  });
}
