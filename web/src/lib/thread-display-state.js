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

function mapConversationTurnToThreadTurn(turn = {}) {
  const items = [];
  const userText = String(turn?.user?.text || "").trim();
  if (userText) {
    items.push({
      id: `${turn.id || "turn"}-user`,
      kind: "UserMessage",
      text: userText,
      status: "completed"
    });
  }

  const assistantText = collectAssistantBodyText(turn);
  if (assistantText) {
    items.push({
      id: `${turn.id || "turn"}-assistant`,
      kind: "AgentMessage",
      text: assistantText,
      status: String(turn?.assistant?.status || "completed")
    });
  }

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
      status: turnStatusRank(incoming?.status) > turnStatusRank(existing?.status) ? incoming?.status : existing?.status
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

export function buildDisplayedThreadSnapshot({
  persistedSnapshot = null,
  authoritativeSnapshot = null,
  liveConversation = null,
  runtimeMessages = [],
  threadId = "",
  liveSessionMeta = null,
  threadMeta = null
} = {}) {
  const resolvedThreadId = String(threadId || liveSessionMeta?.resumeSessionId || threadMeta?.resumeSessionId || "").trim();
  const resolvedMeta = threadMeta || liveSessionMeta || null;
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

  if (liveConversation && Array.isArray(liveConversation.turns) && liveConversation.turns.length) {
    snapshot = mergeLiveConversationIntoSnapshot(snapshot, liveConversation, liveSessionMeta || { resumeSessionId: resolvedThreadId }, {
      preserveExistingTurns: Boolean(authoritativeSnapshot)
    });
  }

  if (runtimeMessages && runtimeMessages.length) {
    snapshot = appendRuntimeDraftTurn(snapshot, runtimeMessages, {
      threadId: resolvedThreadId,
      liveSessionMeta: liveSessionMeta || { resumeSessionId: resolvedThreadId }
    });
  }

  return snapshot;
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
