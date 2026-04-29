function clonePlain(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function collectAssistantBodyText(turn = {}) {
  const body = Array.isArray(turn?.assistant?.body) ? turn.assistant.body : [];
  return body
    .map((part) => String(part?.text || part?.payload?.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function mapAssistantProcessEventToThreadItem(turn = {}, event = {}, index = 0) {
  const type = String(event?.type || "Reasoning").trim();
  const normalizedType = type.toLowerCase();
  let kind = "DynamicToolCall";
  if (normalizedType.includes("reason")) {
    kind = "Reasoning";
  } else if (normalizedType.includes("command")) {
    kind = "CommandExecution";
  } else if (normalizedType.includes("file")) {
    kind = "FileChange";
  } else if (normalizedType.includes("mcp")) {
    kind = "McpToolCall";
  } else if (normalizedType.includes("subagent")) {
    kind = "CollabAgentToolCall";
  }
  return {
    id: String(event?.id || `${turn.id || "turn"}-process-${index + 1}`),
    kind,
    status: String(event?.phase || turn?.assistant?.status || "completed"),
    text: String(event?.content || event?.summary || event?.title || "").trim(),
    summary: String(event?.summary || event?.title || "").trim(),
    payload: JSON.parse(JSON.stringify(event?.payload || {})),
    timestamp: String(event?.ts || "").trim()
  };
}

function parseItemTimestamp(item = {}) {
  const candidates = [item?.timestamp, item?.ts, item?.payload?.timestamp, item?.payload?.ts];
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate || ""));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function mapConversationTurnToThreadTurn(turn = {}) {
  const orderedItems = [];
  const userText = String(turn?.user?.text || "").trim();
  const userPayload = {
    content: Array.isArray(turn?.user?.content) ? JSON.parse(JSON.stringify(turn.user.content)) : [],
    images: Array.isArray(turn?.user?.images) ? JSON.parse(JSON.stringify(turn.user.images)) : [],
    local_images: Array.isArray(turn?.user?.local_images) ? JSON.parse(JSON.stringify(turn.user.local_images)) : []
  };
  if (userText || userPayload.content.length || userPayload.images.length || userPayload.local_images.length) {
    orderedItems.push({
      id: `${turn.id || "turn"}-user`,
      kind: "UserMessage",
      text: userText,
      status: "completed",
      payload: userPayload,
      timestamp: String(turn?.user?.ts || "").trim()
    });
  }

  const assistantProcess = Array.isArray(turn?.assistant?.process) ? turn.assistant.process : [];
  for (const [index, event] of assistantProcess.entries()) {
    orderedItems.push(mapAssistantProcessEventToThreadItem(turn, event, index));
  }

  const assistantBody = Array.isArray(turn?.assistant?.body) ? turn.assistant.body : [];
  let assistantText = "";
  let assistantTextIndex = 0;
  for (const block of assistantBody) {
    const blockKind = String(block?.kind || "markdown").trim().toLowerCase();
    if (blockKind === "image" && String(block?.payload?.url || "").trim()) {
      orderedItems.push({
        id: String(block?.id || `${turn.id || "turn"}-assistant-image-${orderedItems.length}`),
        kind: "ImageView",
        status: String(turn?.assistant?.status || "completed"),
        payload: JSON.parse(JSON.stringify(block?.payload || {})),
        summary: String(block?.payload?.alt || "image"),
        timestamp: String(block?.ts || "").trim()
      });
      continue;
    }
    const text = String(block?.text || "").trim();
    if (!text) {
      continue;
    }
    assistantText = assistantText ? `${assistantText}\n\n${text}` : text;
    assistantTextIndex += 1;
  }
  if (assistantText) {
    orderedItems.push({
      id: `${turn.id || "turn"}-assistant-${assistantTextIndex || "body"}`,
      kind: "AgentMessage",
      text: assistantText,
      status: String(turn?.assistant?.status || "completed"),
      timestamp: String(assistantBody[assistantBody.length - 1]?.ts || "").trim()
    });
  }

  const items = orderedItems
    .map((item, index) => ({ ...item, __index: index, __ts: parseItemTimestamp(item) }))
    .sort((left, right) => {
      if (left.__ts && right.__ts && left.__ts !== right.__ts) {
        return left.__ts - right.__ts;
      }
      if (left.__ts && !right.__ts) {
        return -1;
      }
      if (!left.__ts && right.__ts) {
        return 1;
      }
      return left.__index - right.__index;
    })
    .map(({ __index, __ts, ...item }) => item);

  return {
    id: String(turn?.id || ""),
    status: String(turn?.assistant?.status || "inProgress"),
    startedAt: String(turn?.assistant?.startedAt || turn?.user?.ts || ""),
    completedAt: String(turn?.assistant?.finishedAt || ""),
    durationMs: Number(turn?.assistant?.durationMs || 0),
    error: turn?.assistant?.error || null,
    items
  };
}

function normalizeComparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractTurnUserText(turn = {}) {
  return normalizeComparableText(
    turn?.user?.text ||
      (Array.isArray(turn?.items) ? turn.items.find((item) => String(item?.kind || "") === "UserMessage")?.text : "")
  );
}

function extractTurnAssistantText(turn = {}) {
  if (turn?.assistant) {
    return normalizeComparableText(collectAssistantBodyText(turn));
  }
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return normalizeComparableText(items.find((item) => String(item?.kind || "") === "AgentMessage")?.text || "");
}

function timestampsClose(left, right, toleranceMs = 10_000) {
  const leftMs = Date.parse(String(left || ""));
  const rightMs = Date.parse(String(right || ""));
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= toleranceMs;
}

function areEquivalentTurns(existingTurn = {}, incomingTurn = {}) {
  const existingUserText = extractTurnUserText(existingTurn);
  const incomingUserText = extractTurnUserText(incomingTurn);
  if (!existingUserText || !incomingUserText || existingUserText !== incomingUserText) {
    return false;
  }

  const existingAssistantText = extractTurnAssistantText(existingTurn);
  const incomingAssistantText = extractTurnAssistantText(incomingTurn);
  if (existingAssistantText && incomingAssistantText && existingAssistantText !== incomingAssistantText) {
    return false;
  }

  const existingStartedAt = String(existingTurn?.startedAt || "").trim();
  const incomingStartedAt = String(incomingTurn?.startedAt || "").trim();
  if (existingStartedAt && incomingStartedAt) {
    return timestampsClose(existingStartedAt, incomingStartedAt);
  }

  return true;
}

function normalizeTurnStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) {
    return "inprogress";
  }
  return status;
}

function turnStatusRank(value) {
  const status = normalizeTurnStatus(value);
  if (status === "failed" || status === "aborted" || status === "interrupted") {
    return 4;
  }
  if (status === "completed") {
    return 3;
  }
  if (status === "running" || status === "inprogress") {
    return 2;
  }
  return 1;
}

function mergeTurnItems(existingItems = [], incomingItems = []) {
  const nextItems = [...(Array.isArray(existingItems) ? existingItems : [])];
  for (const incoming of Array.isArray(incomingItems) ? incomingItems : []) {
    const kind = String(incoming?.kind || "").trim();
    if (!kind) {
      continue;
    }
    const existingIndex = nextItems.findIndex((item) => String(item?.kind || "").trim() === kind);
    if (existingIndex < 0) {
      nextItems.push(incoming);
      continue;
    }
    const existing = nextItems[existingIndex] || {};
    const existingText = String(existing?.text || "").trim();
    const incomingText = String(incoming?.text || "").trim();
    const shouldReplaceText = !existingText || (incomingText && incomingText.length > existingText.length);
    nextItems[existingIndex] = {
      ...existing,
      ...(shouldReplaceText ? incoming : {}),
      id: String(existing?.id || incoming?.id || ""),
      kind: existing?.kind || incoming?.kind,
      text: shouldReplaceText ? incomingText || existingText : existingText || incomingText,
      status: turnStatusRank(incoming?.status) > turnStatusRank(existing?.status) ? incoming?.status : existing?.status,
      payload: {
        ...(existing?.payload || {}),
        ...(incoming?.payload || {})
      },
      meta: {
        ...(existing?.meta || {}),
        ...(incoming?.meta || {})
      },
      summary: String(incoming?.summary || existing?.summary || "").trim() || null
    };
  }
  return nextItems;
}

function mergeThreadTurns(existingTurn = {}, incomingTurn = {}) {
  const mergedStatus =
    turnStatusRank(incomingTurn?.status) > turnStatusRank(existingTurn?.status)
      ? incomingTurn?.status
      : existingTurn?.status;
  return {
    ...existingTurn,
    ...incomingTurn,
    id: String(existingTurn?.id || incomingTurn?.id || ""),
    status: mergedStatus || incomingTurn?.status || existingTurn?.status || "inProgress",
    startedAt: existingTurn?.startedAt || incomingTurn?.startedAt || "",
    completedAt: existingTurn?.completedAt || incomingTurn?.completedAt || "",
    durationMs: Math.max(Number(existingTurn?.durationMs || 0), Number(incomingTurn?.durationMs || 0)),
    error: existingTurn?.error || incomingTurn?.error || null,
    items: mergeTurnItems(existingTurn?.items, incomingTurn?.items)
  };
}

export function mergeAuthoritativeThreadSnapshotPatch({
  persistedSnapshot = null,
  authoritativeSnapshot = null,
  incomingSnapshot = null
} = {}) {
  if (!incomingSnapshot || typeof incomingSnapshot !== "object") {
    return clonePlain(authoritativeSnapshot) || clonePlain(persistedSnapshot) || null;
  }

  const baseSnapshot =
    clonePlain(authoritativeSnapshot) ||
    clonePlain(persistedSnapshot) || {
      threadId: String(incomingSnapshot.threadId || "").trim(),
      metadata: {},
      turns: [],
      version: 0,
      updatedAt: ""
    };

  const nextTurns = [...(Array.isArray(baseSnapshot.turns) ? baseSnapshot.turns : [])];
  for (const incomingTurn of Array.isArray(incomingSnapshot.turns) ? incomingSnapshot.turns : []) {
    const turnId = String(incomingTurn?.id || "").trim();
    if (!turnId) {
      continue;
    }
    const existingIndex = nextTurns.findIndex((turn) => String(turn?.id || "").trim() === turnId);
    if (existingIndex >= 0) {
      nextTurns[existingIndex] = mergeThreadTurns(nextTurns[existingIndex], incomingTurn);
      continue;
    }
    const equivalentIndex = nextTurns.findIndex((turn) => areEquivalentTurns(turn, incomingTurn));
    if (equivalentIndex >= 0) {
      nextTurns[equivalentIndex] = mergeThreadTurns(nextTurns[equivalentIndex], incomingTurn);
      continue;
    }
    nextTurns.push(incomingTurn);
  }

  return {
    ...baseSnapshot,
    ...incomingSnapshot,
    threadId: String(incomingSnapshot.threadId || baseSnapshot.threadId || "").trim(),
    metadata: {
      ...(baseSnapshot.metadata || {}),
      ...(incomingSnapshot.metadata || {})
    },
    turns: nextTurns,
    version: Math.max(Number(baseSnapshot.version || 0), Number(incomingSnapshot.version || 0)),
    updatedAt: String(incomingSnapshot.updatedAt || baseSnapshot.updatedAt || "")
  };
}

function buildRuntimeDraftTurnFromMessages(messages = [], { threadId = "", liveSessionMeta = null } = {}) {
  const tail = Array.isArray(messages) ? messages : [];
  if (!tail.length) {
    return null;
  }
  const draftMessages = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message) {
      continue;
    }
    const source = String(message.source || "").trim();
    const isRuntimeMessage = source !== "turn" && source !== "snapshot" && source !== "history";
    if (!isRuntimeMessage && !message.streaming) {
      break;
    }
    draftMessages.unshift(message);
  }
  if (!draftMessages.length) {
    return null;
  }

  const userMessage = [...draftMessages].reverse().find((message) => message.role === "user");
  if (!userMessage?.text) {
    return null;
  }
  const assistantMessages = draftMessages.filter(
    (message) => message.role === "assistant" && String(message.text || "").trim()
  );
  const assistantText = assistantMessages
    .map((message) => String(message.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const stableThreadId = String(threadId || liveSessionMeta?.resumeSessionId || liveSessionMeta?.id || "thread").trim();
  const turnId = `runtime-draft:${stableThreadId}`;
  const items = [
    {
      id: `${turnId}:user`,
      kind: "UserMessage",
      text: String(userMessage.text || "").trim(),
      status: "completed"
    }
  ];
  if (assistantText) {
    items.push({
      id: `${turnId}:assistant`,
      kind: "AgentMessage",
      text: assistantText,
      status: assistantMessages.some((message) => message.streaming) ? "inProgress" : "completed",
      source: "runtime-draft"
    });
  }
  return {
    id: turnId,
    status: assistantText
      ? assistantMessages.some((message) => message.streaming)
        ? "inProgress"
        : "completed"
      : "inProgress",
    startedAt: String(userMessage.timestamp || new Date().toISOString()),
    completedAt: "",
    durationMs: 0,
    error: null,
    items
  };
}

function mergeLiveConversationIntoSnapshot(snapshot, conversation, liveSessionMeta, { preserveExistingTurns = false } = {}) {
  const baseSnapshot = clonePlain(snapshot) || {
    threadId: String(liveSessionMeta?.resumeSessionId || ""),
    metadata: {},
    turns: [],
    version: 0,
    updatedAt: ""
  };
  const liveTurns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  if (!liveTurns.length) {
    return baseSnapshot;
  }

  const nextTurns = [...(Array.isArray(baseSnapshot.turns) ? baseSnapshot.turns : [])];
  for (const liveTurn of liveTurns) {
    const mappedTurn = mapConversationTurnToThreadTurn(liveTurn);
    if (!mappedTurn.id) {
      continue;
    }
    const existingIndex = nextTurns.findIndex((turn) => String(turn?.id || "") === mappedTurn.id);
    if (existingIndex >= 0) {
      if (preserveExistingTurns && extractTurnAssistantText(nextTurns[existingIndex])) {
        continue;
      }
      nextTurns[existingIndex] = mergeThreadTurns(nextTurns[existingIndex], mappedTurn);
      continue;
    }
    const equivalentIndex = nextTurns.findIndex((turn) => areEquivalentTurns(turn, mappedTurn));
    if (equivalentIndex >= 0) {
      if (preserveExistingTurns && extractTurnAssistantText(nextTurns[equivalentIndex])) {
        continue;
      }
      nextTurns[equivalentIndex] = mergeThreadTurns(nextTurns[equivalentIndex], mappedTurn);
      continue;
    }
    nextTurns.push(mappedTurn);
  }

  return {
    ...baseSnapshot,
    threadId: String(baseSnapshot.threadId || liveSessionMeta?.resumeSessionId || ""),
    turns: nextTurns,
    version: Number(baseSnapshot.version || 0),
    updatedAt: new Date().toISOString()
  };
}

function appendRuntimeDraftTurn(snapshot, messages, context = {}) {
  const draftTurn = buildRuntimeDraftTurnFromMessages(messages, context);
  if (!draftTurn) {
    return snapshot;
  }
  const baseSnapshot = clonePlain(snapshot) || {
    threadId: String(context.threadId || context.liveSessionMeta?.resumeSessionId || ""),
    metadata: {},
    turns: [],
    version: 0,
    updatedAt: ""
  };
  const nextTurns = [...(Array.isArray(baseSnapshot.turns) ? baseSnapshot.turns : [])];
  const sameDraftContent = nextTurns.find((turn) => {
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    const userText = String(turnItems.find((item) => item?.kind === "UserMessage")?.text || "").trim();
    const draftUserText = String(draftTurn.items.find((item) => item?.kind === "UserMessage")?.text || "").trim();
    const turnStatus = String(turn?.status || "").trim().toLowerCase();
    return draftUserText && userText === draftUserText && (turnStatus === "inprogress" || turnStatus === "running");
  });
  if (sameDraftContent) {
    const assistantDraftItem = draftTurn.items.find((item) => item?.kind === "AgentMessage");
    if (assistantDraftItem?.text) {
      const turnItems = Array.isArray(sameDraftContent.items) ? [...sameDraftContent.items] : [];
      const assistantIndex = turnItems.findIndex((item) => item?.kind === "AgentMessage");
      if (assistantIndex >= 0) {
        turnItems[assistantIndex] = {
          ...turnItems[assistantIndex],
          text: assistantDraftItem.text,
          source: assistantDraftItem.source || turnItems[assistantIndex].source || null,
          status: assistantDraftItem.status || turnItems[assistantIndex].status || "inProgress"
        };
      } else {
        turnItems.push(assistantDraftItem);
      }
      sameDraftContent.items = turnItems;
      sameDraftContent.status = draftTurn.status || sameDraftContent.status;
    }
    return baseSnapshot;
  }
  const sameTypedTurn = nextTurns.find((turn) => {
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    const userText = String(turnItems.find((item) => item?.kind === "UserMessage")?.text || "").trim();
    const draftUserText = String(draftTurn.items.find((item) => item?.kind === "UserMessage")?.text || "").trim();
    return Boolean(draftUserText && userText === draftUserText);
  });
  if (sameTypedTurn) {
    return baseSnapshot;
  }
  const existingIndex = nextTurns.findIndex((turn) => String(turn?.id || "") === draftTurn.id);
  if (existingIndex >= 0) {
    nextTurns[existingIndex] = draftTurn;
  } else {
    nextTurns.push(draftTurn);
  }
  return {
    ...baseSnapshot,
    threadId: String(baseSnapshot.threadId || context.threadId || context.liveSessionMeta?.resumeSessionId || ""),
    turns: nextTurns,
    updatedAt: new Date().toISOString()
  };
}

function isTerminalUserOnlyTurn(turn = {}) {
  const status = String(turn?.status || "").trim().toLowerCase();
  if (!["completed", "failed", "aborted", "interrupted"].includes(status)) {
    return false;
  }
  const items = Array.isArray(turn?.items) ? turn.items : [];
  if (items.length !== 1) {
    return false;
  }
  return String(items[0]?.kind || "").trim() === "UserMessage";
}

export function buildDisplayedThreadSnapshot({
  persistedSnapshot = null,
  authoritativeSnapshot = null,
  liveConversation = null,
  runtimeMessages = [],
  threadId = "",
  liveSessionMeta = null,
  threadMeta = null,
  preferAuthoritativeSnapshot = false,
  includeLiveConversation = true,
  includeRuntimeDraft = true
} = {}) {
  const resolvedThreadId = String(threadId || liveSessionMeta?.resumeSessionId || threadMeta?.resumeSessionId || "").trim();
  const resolvedMeta = threadMeta || liveSessionMeta || null;
  const hasAuthoritativeSnapshot = Boolean(authoritativeSnapshot && typeof authoritativeSnapshot === "object");
  let snapshot =
    clonePlain(authoritativeSnapshot) ||
    clonePlain(persistedSnapshot) ||
    (resolvedThreadId
      ? {
          threadId: resolvedThreadId,
          metadata: {
            name: String(resolvedMeta?.displayTitle || resolvedMeta?.name || "").trim(),
            preview: String(resolvedMeta?.displayPreview || resolvedMeta?.inputPreview || "").trim(),
            cwd: String(resolvedMeta?.cwd || "").trim(),
            source: String(resolvedMeta?.provider || "").trim()
          },
          turns: [],
          version: 0,
          updatedAt: ""
        }
      : null);

  const canMergeLiveConversation = includeLiveConversation;
  if (canMergeLiveConversation && liveConversation && Array.isArray(liveConversation.turns) && liveConversation.turns.length) {
    snapshot = mergeLiveConversationIntoSnapshot(snapshot, liveConversation, liveSessionMeta || { resumeSessionId: resolvedThreadId }, {
      preserveExistingTurns: hasAuthoritativeSnapshot
    });
  }

  if (includeRuntimeDraft && runtimeMessages && runtimeMessages.length) {
    snapshot = appendRuntimeDraftTurn(snapshot, runtimeMessages, {
      threadId: resolvedThreadId,
      liveSessionMeta: liveSessionMeta || { resumeSessionId: resolvedThreadId }
    });
  }

  if (snapshot && Array.isArray(snapshot.turns)) {
    snapshot.turns = snapshot.turns.filter((turn) => !isTerminalUserOnlyTurn(turn));
  }

  return snapshot;
}

export function buildAuthoritativeThreadSnapshot({
  persistedSnapshot = null,
  authoritativeSnapshot = null,
  liveConversation = null,
  threadId = "",
  liveSessionMeta = null,
  threadMeta = null
} = {}) {
  return buildDisplayedThreadSnapshot({
    persistedSnapshot,
    authoritativeSnapshot,
    liveConversation,
    runtimeMessages: [],
    threadId,
    liveSessionMeta,
    threadMeta,
    preferAuthoritativeSnapshot: false,
    includeLiveConversation: true,
    includeRuntimeDraft: false
  });
}

export function shouldSyncPersistedThread({
  routeThreadId = "",
  threadMeta = null,
  liveSessionId = "",
  liveSessionMeta = null,
  hasAuthoritativeLiveData = false
} = {}) {
  const targetThreadId = String(routeThreadId || threadMeta?.resumeSessionId || "").trim();
  if (!targetThreadId) {
    return false;
  }
  if (!String(liveSessionId || "").trim()) {
    return true;
  }
  const liveThreadId = String(liveSessionMeta?.resumeSessionId || "").trim();
  if (!liveThreadId) {
    return true;
  }
  if (liveThreadId !== targetThreadId) {
    return true;
  }
  return !hasAuthoritativeLiveData;
}
