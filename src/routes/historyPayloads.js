import { deriveConversationStateFromThreadSnapshot } from "../threads/legacyConversation.js";

function historyContextKey(provider, resumeSessionId) {
  return `${String(provider || "codex").trim()}:${String(resumeSessionId || "").trim()}`;
}

function buildConversationSnapshot(conversation, session, resumeSessionId) {
  if (!conversation) {
    return null;
  }
  return {
    type: "conversation.snapshot",
    session,
    sessionId: conversation.sessionId || session?.id || "",
    threadId: conversation.threadId || resumeSessionId,
    conversation,
    turns: conversation.turns || [],
    backgroundAgents: conversation.backgroundAgents || []
  };
}

function normalizeComparableText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseTurnTimestamp(turn) {
  const candidates = [
    turn?.startedAt,
    turn?.completedAt,
    turn?.user?.ts,
    turn?.assistant?.startedAt,
    turn?.assistant?.finishedAt,
    ...(Array.isArray(turn?.items)
      ? turn.items.flatMap((item) => [item?.createdAt, item?.updatedAt, item?.ts])
      : [])
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate || ""));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function timestampsClose(left, right, toleranceMs = 60_000) {
  if (!left || !right) {
    return false;
  }
  return Math.abs(left - right) <= toleranceMs;
}

function extractTurnUserText(turn = {}) {
  if (turn?.user?.text) {
    return normalizeComparableText(turn.user.text);
  }
  if (Array.isArray(turn?.items)) {
    const userItem = turn.items.find((item) => String(item?.kind || "").trim() === "UserMessage");
    return normalizeComparableText(userItem?.text || userItem?.summary || "");
  }
  return "";
}

function extractTurnAssistantText(turn = {}) {
  if (turn?.assistant) {
    const body = Array.isArray(turn.assistant.body) ? turn.assistant.body : [];
    return normalizeComparableText(
      body
        .map((item) => String(item?.text || item?.summary || item?.payload?.text || "").trim())
        .filter(Boolean)
        .join("\n\n")
    );
  }
  if (Array.isArray(turn?.items)) {
    return normalizeComparableText(
      turn.items
        .filter((item) => String(item?.kind || "").trim() === "AgentMessage")
        .map((item) => String(item?.text || item?.summary || "").trim())
        .filter(Boolean)
        .join("\n\n")
    );
  }
  return "";
}

function extractTurnProcessCount(turn = {}) {
  if (turn?.assistant) {
    return Array.isArray(turn.assistant.process) ? turn.assistant.process.length : 0;
  }
  if (Array.isArray(turn?.items)) {
    return turn.items.filter((item) => !["UserMessage", "AgentMessage"].includes(String(item?.kind || "").trim())).length;
  }
  return 0;
}

function hasTurnMeaningfulAssistantContent(turn = {}) {
  return Boolean(extractTurnAssistantText(turn)) || extractTurnProcessCount(turn) > 0;
}

function areEquivalentItems(existingItem = {}, incomingItem = {}) {
  const existingKind = String(existingItem?.kind || "").trim();
  const incomingKind = String(incomingItem?.kind || "").trim();
  if (!existingKind || !incomingKind || existingKind !== incomingKind) {
    return false;
  }
  const existingText = normalizeComparableText(existingItem?.text || existingItem?.summary || "");
  const incomingText = normalizeComparableText(incomingItem?.text || incomingItem?.summary || "");
  if (!existingText || !incomingText || existingText !== incomingText) {
    return false;
  }
  return true;
}

function areEquivalentTurns(existingTurn = {}, incomingTurn = {}) {
  const existingId = String(existingTurn?.id || "").trim();
  const incomingId = String(incomingTurn?.id || "").trim();
  if (existingId && incomingId && existingId === incomingId) {
    return true;
  }

  const existingUserText = extractTurnUserText(existingTurn);
  const incomingUserText = extractTurnUserText(incomingTurn);
  if (!existingUserText || !incomingUserText || existingUserText !== incomingUserText) {
    return false;
  }

  const existingTime = parseTurnTimestamp(existingTurn);
  const incomingTime = parseTurnTimestamp(incomingTurn);
  if (timestampsClose(existingTime, incomingTime)) {
    return true;
  }

  const existingAssistantText = extractTurnAssistantText(existingTurn);
  const incomingAssistantText = extractTurnAssistantText(incomingTurn);
  if (existingAssistantText && incomingAssistantText) {
    return existingAssistantText === incomingAssistantText;
  }

  return false;
}

function mergeById(existingItems = [], incomingItems = [], { areEquivalent = null, mergeItems = null } = {}) {
  const merged = Array.isArray(existingItems) ? [...existingItems] : [];
  for (const incoming of Array.isArray(incomingItems) ? incomingItems : []) {
    const id = String(incoming?.id || "").trim();
    if (!id) {
      merged.push(incoming);
      continue;
    }
    const index = merged.findIndex((item) => String(item?.id || "").trim() === id);
    if (index >= 0) {
      merged[index] = typeof mergeItems === "function"
        ? mergeItems(merged[index], incoming)
        : {
            ...merged[index],
            ...incoming
          };
      continue;
    }
    if (typeof areEquivalent === "function") {
      const equivalentIndex = merged.findIndex((item) => areEquivalent(item, incoming));
      if (equivalentIndex >= 0) {
        merged[equivalentIndex] = typeof mergeItems === "function"
          ? mergeItems(merged[equivalentIndex], incoming)
          : {
              ...merged[equivalentIndex],
              ...incoming
            };
        continue;
      }
    }
    merged.push(incoming);
  }
  return merged;
}

function mergeConversationTurns(existingTurn = {}, incomingTurn = {}) {
  const existingAssistant = existingTurn?.assistant || {};
  const incomingAssistant = incomingTurn?.assistant || {};
  return {
    ...existingTurn,
    ...incomingTurn,
    id: String(existingTurn?.id || incomingTurn?.id || "").trim(),
    user: existingTurn?.user || incomingTurn?.user || null,
    assistant: {
      ...existingAssistant,
      ...incomingAssistant,
      body: mergeById(existingAssistant.body, incomingAssistant.body),
      process: mergeById(existingAssistant.process, incomingAssistant.process)
    }
  };
}

function mergeThreadTurns(existingTurn = {}, incomingTurn = {}) {
  const merged = {
    ...existingTurn,
    ...incomingTurn,
    id: String(existingTurn?.id || incomingTurn?.id || "").trim(),
    items: mergeById(existingTurn?.items, incomingTurn?.items, {
      areEquivalent: areEquivalentItems
    })
  };
  const existingHasContent = hasTurnMeaningfulAssistantContent(existingTurn);
  const incomingHasContent = hasTurnMeaningfulAssistantContent(incomingTurn);
  if (existingHasContent && !incomingHasContent) {
    merged.status = existingTurn?.status || incomingTurn?.status;
    merged.completedAt = existingTurn?.completedAt || incomingTurn?.completedAt || "";
    merged.startedAt = existingTurn?.startedAt || incomingTurn?.startedAt || "";
  }
  return merged;
}

function mergeThreadSnapshot(baseSnapshot, liveSnapshot) {
  if (!baseSnapshot) {
    return liveSnapshot || null;
  }
  if (!liveSnapshot) {
    return baseSnapshot;
  }
  return {
    ...baseSnapshot,
    ...liveSnapshot,
    threadId: liveSnapshot.threadId || baseSnapshot.threadId || "",
    turns: mergeById(baseSnapshot.turns, liveSnapshot.turns, {
      areEquivalent: areEquivalentTurns,
      mergeItems: mergeThreadTurns
    })
  };
}

function mergeConversation(baseConversation, liveConversation) {
  if (!baseConversation) {
    return liveConversation || null;
  }
  if (!liveConversation) {
    return baseConversation;
  }
  return {
    ...baseConversation,
    ...liveConversation,
    threadId: liveConversation.threadId || baseConversation.threadId || "",
    turns: mergeById(baseConversation.turns, liveConversation.turns, {
      areEquivalent: areEquivalentTurns,
      mergeItems: mergeConversationTurns
    }),
    backgroundAgents:
      (Array.isArray(liveConversation.backgroundAgents) && liveConversation.backgroundAgents.length
        ? liveConversation.backgroundAgents
        : baseConversation.backgroundAgents) || []
  };
}

function createSyntheticThreadSession(provider, resumeSessionId) {
  return {
    id: `history:${provider}:${resumeSessionId}`,
    provider,
    resumeSessionId,
    kind: "thread",
    status: "saved"
  };
}

function deriveConversationFallback(threadSnapshot, session, resumeSessionId) {
  if (!threadSnapshot || typeof threadSnapshot !== "object") {
    return null;
  }
  return deriveConversationStateFromThreadSnapshot(threadSnapshot, {
    sessionId: String(session?.id || ""),
    threadId: String(resumeSessionId || threadSnapshot.threadId || ""),
    status: "completed"
  });
}

export function createHistoryPayloadResolver(sessionManager) {
  const historyContextCache = new Map();

  function getHistoryContext(provider, resumeSessionId) {
    const cacheKey = historyContextKey(provider, resumeSessionId);
    if (historyContextCache.has(cacheKey)) {
      return historyContextCache.get(cacheKey);
    }

    let historicalPayload = null;
    let historicalError = null;
    try {
      historicalPayload = sessionManager.getHistoricalMessages(provider, resumeSessionId);
    } catch (err) {
      historicalError = err;
    }

    const snapshotBundle = sessionManager.getThreadSnapshotBundle(provider, resumeSessionId) || {};
    const continuation =
      sessionManager.getThreadContinuationRuntime?.(provider, resumeSessionId) ||
      sessionManager.getLiveHistoryContinuation?.(provider, resumeSessionId) ||
      null;
    const bundle = {
      ...snapshotBundle,
      session: snapshotBundle.session || continuation?.session || null,
      threadSnapshot: snapshotBundle.threadSnapshot || continuation?.threadSnapshot || null,
      conversation: snapshotBundle.conversation || continuation?.conversation || null,
      continuation: continuation || null,
      thread: {
        snapshot: snapshotBundle.threadSnapshot || continuation?.threadSnapshot || null,
        continuation: continuation || null
      },
      liveOverlay: continuation?.liveOverlay || snapshotBundle.liveOverlay || null
    };

    const context = {
      provider,
      resumeSessionId,
      bundle,
      continuation,
      historicalPayload,
      historicalError
    };
    historyContextCache.set(cacheKey, context);
    return context;
  }

  function getThreadBundle(provider, resumeSessionId) {
    return getAuthoritativeBundle(provider, resumeSessionId);
  }

  function getThreadConversationPayload(provider, resumeSessionId) {
    const bundle = getAuthoritativeBundle(provider, resumeSessionId);
    return {
      ...(bundle.conversationSnapshot || bundle.conversation || {}),
      session: bundle.session || null,
      threadSnapshot: bundle.threadSnapshot || null,
      continuation: bundle.continuation || null,
      thread: bundle.thread,
      liveOverlay: bundle.liveOverlay || null
    };
  }

  function getAuthoritativeBundle(provider, resumeSessionId) {
    const { bundle, continuation, historicalPayload, historicalError } = getHistoryContext(provider, resumeSessionId);
    if (historicalPayload) {
      const authoritativeSession = continuation
        ? continuation.session || historicalPayload.session || bundle.session || null
        : historicalPayload.session || bundle.session || null;
      const authoritativeSnapshot = continuation
        ? mergeThreadSnapshot(historicalPayload?.threadSnapshot || bundle.threadSnapshot || null, continuation.threadSnapshot)
        : historicalPayload?.threadSnapshot || bundle.threadSnapshot || null;
      const mergedConversation = continuation
        ? mergeConversation(historicalPayload?.conversation || bundle.conversation || null, continuation.conversation)
        : historicalPayload?.conversation || bundle.conversation || null;
      const authoritativeConversation =
        mergedConversation ||
        deriveConversationFallback(authoritativeSnapshot, authoritativeSession, resumeSessionId);
      const authoritativeTurns =
        (Array.isArray(authoritativeConversation?.turns) && authoritativeConversation.turns.length
          ? authoritativeConversation.turns
          : null) ||
        historicalPayload?.turns ||
        [];
      const authoritativeBackgroundAgents =
        (Array.isArray(authoritativeConversation?.backgroundAgents) && authoritativeConversation.backgroundAgents.length
          ? authoritativeConversation.backgroundAgents
          : null) ||
        historicalPayload?.backgroundAgents ||
        [];
      return {
        ...historicalPayload,
        session: authoritativeSession,
        turns: authoritativeTurns,
        backgroundAgents: authoritativeBackgroundAgents,
        conversation: authoritativeConversation,
        conversationSnapshot:
          (continuation
            ? buildConversationSnapshot(authoritativeConversation, authoritativeSession, resumeSessionId)
            : historicalPayload?.conversationSnapshot) ||
          buildConversationSnapshot(authoritativeConversation, authoritativeSession, resumeSessionId),
        threadSnapshot: authoritativeSnapshot,
        continuation: bundle.continuation || null,
        thread: bundle.thread,
        liveOverlay: historicalPayload?.liveOverlay || bundle.liveOverlay || null
      };
    }

    if (continuation) {
      const session = bundle.session || createSyntheticThreadSession(provider, resumeSessionId);
      const conversation =
        bundle.conversation ||
        deriveConversationFallback(bundle.threadSnapshot || continuation.threadSnapshot || null, session, resumeSessionId);
      return {
        session,
        messages: [],
        turns: conversation?.turns || [],
        backgroundAgents: conversation?.backgroundAgents || [],
        conversation,
        conversationSnapshot: buildConversationSnapshot(conversation, session, resumeSessionId),
        threadSnapshot: bundle.threadSnapshot || null,
        continuation: bundle.continuation || null,
        thread: bundle.thread,
        liveOverlay: bundle.liveOverlay || null
      };
    }

    throw historicalError || new Error(`Historical session not found: ${provider}/${resumeSessionId}`);
  }

  function getThreadMessagesPayload(provider, resumeSessionId) {
    return getAuthoritativeBundle(provider, resumeSessionId);
  }

  function getContinuationPayload(provider, resumeSessionId) {
    const continuation = getHistoryContext(provider, resumeSessionId).continuation;
    return {
      continuation: continuation || null,
      hasLiveContinuation: Boolean(continuation)
    };
  }

  return {
    getThreadBundle,
    getThreadConversationPayload,
    getThreadMessagesPayload,
    getContinuationPayload
  };
}
