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

function mergeById(existingItems = [], incomingItems = []) {
  const merged = Array.isArray(existingItems) ? [...existingItems] : [];
  for (const incoming of Array.isArray(incomingItems) ? incomingItems : []) {
    const id = String(incoming?.id || "").trim();
    if (!id) {
      merged.push(incoming);
      continue;
    }
    const index = merged.findIndex((item) => String(item?.id || "").trim() === id);
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        ...incoming
      };
      continue;
    }
    merged.push(incoming);
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
    turns: mergeById(baseSnapshot.turns, liveSnapshot.turns)
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
    turns: mergeById(baseConversation.turns, liveConversation.turns),
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
