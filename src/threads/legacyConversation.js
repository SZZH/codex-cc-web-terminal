import { createConversationState, normalizeConversationStatus } from "../sessions/conversation/state.js";
import { THREAD_ITEM_KIND, TURN_STATUS } from "./itemTaxonomy.js";
import { createThreadItem, createThreadSnapshot, createTurn } from "./types.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toIso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function mapTurnStatus(status) {
  if (status === TURN_STATUS.COMPLETED) {
    return "completed";
  }
  if (status === TURN_STATUS.FAILED) {
    return "failed";
  }
  if (status === TURN_STATUS.ABORTED) {
    return "interrupted";
  }
  return "running";
}

function mapBodyBlock(item) {
  if (item.kind === THREAD_ITEM_KIND.IMAGE_VIEW || item.kind === THREAD_ITEM_KIND.IMAGE_GENERATION) {
    return {
      id: String(item.id || ""),
      kind: "image",
      text: "",
      payload: clone(item.payload || {}),
      ts: toIso(item.updatedAt || item.createdAt)
    };
  }
  return {
    id: String(item.id || ""),
    kind: "markdown",
    text: String(item.text || item.summary || ""),
    payload: clone(item.payload || {}),
    ts: toIso(item.updatedAt || item.createdAt)
  };
}

function mapProcessEvent(item) {
  return {
    id: String(item.id || ""),
    type: "system",
    title: String(item.summary || item.kind || "过程事件"),
    summary: String(item.summary || item.text || ""),
    content: String(item.text || item.summary || ""),
    payload: clone(item.payload || {}),
    phase: String(item.status || (item.meta?.provisional ? "streaming" : "completed") || "completed"),
    ts: toIso(item.updatedAt || item.createdAt)
  };
}

function deriveBackgroundAgents(snapshot) {
  const byId = new Map();
  for (const turn of Array.isArray(snapshot?.turns) ? snapshot.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item.kind !== THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL) {
        continue;
      }
      const payload = item.payload || {};
      const agentId = String(payload.agentId || payload.agentPath || item.id || "").trim();
      if (!agentId) {
        continue;
      }
      const existing = byId.get(agentId) || {
        agentId,
        agentPath: String(payload.agentPath || "").trim(),
        nickname: String(payload.agentNickname || "").trim(),
        role: String(payload.agentRole || "").trim(),
        status: "running",
        startedAt: toIso(item.createdAt),
        updatedAt: toIso(item.updatedAt || item.createdAt),
        relatedTurnIds: []
      };
      existing.status = String(payload.status || item.status || existing.status || "running");
      existing.updatedAt = toIso(item.updatedAt || item.createdAt) || existing.updatedAt;
      existing.relatedTurnIds = Array.from(new Set([...(existing.relatedTurnIds || []), String(turn.id || "")].filter(Boolean)));
      byId.set(agentId, existing);
    }
  }
  return [...byId.values()];
}

function deriveConversationStatus(snapshot, fallback = "idle") {
  if (snapshot?.activeTurnId) {
    return "running";
  }
  const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
  if (!turns.length) {
    return normalizeConversationStatus(fallback, "idle");
  }
  const statuses = turns.map((turn) => mapTurnStatus(turn?.status));
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "running")) {
    return "running";
  }
  if (statuses.some((status) => status === "interrupted")) {
    return "interrupted";
  }
  return "completed";
}

export function deriveConversationStateFromThreadSnapshot(snapshot, { sessionId = "", threadId = "", status = "" } = {}) {
  const turns = (Array.isArray(snapshot?.turns) ? snapshot.turns : []).map((turn) => {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const userItem = items.find((item) => item.kind === THREAD_ITEM_KIND.USER_MESSAGE) || null;
    const body = items
      .filter((item) => item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE || item.kind === THREAD_ITEM_KIND.PLAN || item.kind === THREAD_ITEM_KIND.IMAGE_VIEW || item.kind === THREAD_ITEM_KIND.IMAGE_GENERATION)
      .filter((item) => String(item.text || item.summary || item.payload?.url || "").trim())
      .map(mapBodyBlock);
    const process = items
      .filter(
        (item) =>
          ![
            THREAD_ITEM_KIND.USER_MESSAGE,
            THREAD_ITEM_KIND.AGENT_MESSAGE,
            THREAD_ITEM_KIND.PLAN
          ].includes(item.kind)
      )
      .map(mapProcessEvent);

    return {
      id: String(turn?.id || ""),
      sessionId: String(sessionId || ""),
      threadId: String(threadId || snapshot?.threadId || ""),
      user: userItem
        ? {
            id: String(userItem.id || ""),
            text: String(userItem.text || userItem.summary || ""),
            ts: toIso(userItem.updatedAt || userItem.createdAt),
            content: clone(userItem.payload?.content || []),
            images: clone(userItem.payload?.images || []),
            local_images: clone(userItem.payload?.local_images || [])
          }
        : null,
      assistant: {
        body,
        process,
        status: mapTurnStatus(turn?.status),
        error: clone(turn?.error || null),
        startedAt: toIso(turn?.startedAt),
        finishedAt: toIso(turn?.completedAt)
      }
    };
  });

  return createConversationState({
    sessionId: String(sessionId || ""),
    threadId: String(threadId || snapshot?.threadId || ""),
    version: Math.max(0, Number(snapshot?.version || 0)),
    status: deriveConversationStatus(snapshot, status),
    updatedAt: snapshot?.updatedAt || "",
    turns,
    backgroundAgents: deriveBackgroundAgents(snapshot),
    activeTurnId: String(snapshot?.activeTurnId || "")
  });
}

function mapConversationBodyItem(block = {}) {
  if (String(block.kind || "").trim().toLowerCase() === "image") {
    return createThreadItem({
      id: String(block.id || `body:${Math.random().toString(16).slice(2)}`),
      kind: THREAD_ITEM_KIND.IMAGE_VIEW,
      createdAt: toIso(block.ts),
      updatedAt: toIso(block.ts),
      summary: String(block.payload?.alt || "image"),
      payload: clone(block.payload || {})
    });
  }
  return createThreadItem({
    id: String(block.id || `body:${Math.random().toString(16).slice(2)}`),
    kind: THREAD_ITEM_KIND.AGENT_MESSAGE,
    createdAt: toIso(block.ts),
    updatedAt: toIso(block.ts),
    text: String(block.text || ""),
    summary: String(block.text || ""),
    payload: clone(block.payload || {})
  });
}

function mapConversationProcessItem(event = {}) {
  return createThreadItem({
    id: String(event.id || `process:${Math.random().toString(16).slice(2)}`),
    kind: THREAD_ITEM_KIND.REASONING,
    createdAt: toIso(event.ts),
    updatedAt: toIso(event.ts),
    text: String(event.content || ""),
    summary: String(event.summary || event.title || ""),
    payload: clone(event.payload || {}),
    status: String(event.phase || "")
  });
}

export function deriveThreadSnapshotFromConversationState(conversationState, { threadId = "", metadata = {}, baseSnapshot = null } = {}) {
  const conversation = createConversationState(conversationState || {});
  const snapshot = createThreadSnapshot({
    ...(baseSnapshot || {}),
    threadId: String(threadId || conversation.threadId || baseSnapshot?.threadId || ""),
    metadata: {
      ...(baseSnapshot?.metadata || {}),
      ...(metadata || {})
    },
    version: Math.max(Number(baseSnapshot?.version || 0), Number(conversation.version || 0)),
    updatedAt: conversation.updatedAt || baseSnapshot?.updatedAt || "",
    activeTurnId: String(conversation.activeTurnId || baseSnapshot?.activeTurnId || "")
  });

  snapshot.turns = (Array.isArray(conversation.turns) ? conversation.turns : []).map((turn) => {
    const createdAt = toIso(turn?.assistant?.startedAt || turn?.user?.ts);
    const updatedAt = toIso(turn?.assistant?.finishedAt || turn?.assistant?.startedAt || turn?.user?.ts);
    const items = [];
    if (turn?.user?.text) {
      items.push(
        createThreadItem({
          id: String(turn.user.id || `user:${turn.id}`),
          kind: THREAD_ITEM_KIND.USER_MESSAGE,
          createdAt: toIso(turn.user.ts),
          updatedAt: toIso(turn.user.ts),
          text: String(turn.user.text || ""),
          summary: String(turn.user.text || ""),
          payload: {
            content: clone(turn.user.content || []),
            images: clone(turn.user.images || []),
            local_images: clone(turn.user.local_images || [])
          }
        })
      );
    }
    for (const event of Array.isArray(turn?.assistant?.process) ? turn.assistant.process : []) {
      items.push(mapConversationProcessItem(event));
    }
    for (const block of Array.isArray(turn?.assistant?.body) ? turn.assistant.body : []) {
      items.push(mapConversationBodyItem(block));
    }
    return createTurn({
      id: String(turn?.id || ""),
      items,
      status:
        turn?.assistant?.status === "failed"
          ? TURN_STATUS.FAILED
          : turn?.assistant?.status === "interrupted"
            ? TURN_STATUS.ABORTED
            : turn?.assistant?.status === "completed"
              ? TURN_STATUS.COMPLETED
              : TURN_STATUS.IN_PROGRESS,
      error: clone(turn?.assistant?.error || null),
      startedAt: createdAt || null,
      completedAt: updatedAt || null
    });
  });

  return snapshot;
}
