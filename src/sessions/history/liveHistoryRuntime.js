export function buildThreadSnapshotBundle(historyService, provider, resumeSessionId) {
  let historical = null;
  try {
    historical = historyService.getHistoricalMessages(provider, resumeSessionId);
  } catch {
    historical = null;
  }

  return {
    session: historical?.session || null,
    threadSnapshot: historical?.threadSnapshot || null,
    liveOverlay: historical?.liveOverlay || null,
    conversation: historical?.conversation || null,
    conversationSnapshot: historical?.conversationSnapshot || null
  };
}

function findLatestLiveSession(sessions = [], providerId = "", resumeSessionId = "") {
  return [...sessions]
    .filter(
      (session) =>
        session?.provider === providerId &&
        session?.status !== "exited" &&
        String(session?.resumeSessionId || "").trim() === resumeSessionId
    )
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")))[0] || null;
}

export function buildLiveHistoryContinuation({
  sessions,
  provider,
  resumeSessionId,
  historyService,
  ensureThreadSnapshot,
  ensureConversationState,
  buildThreadProjection,
  deriveThreadSnapshotFromConversationState,
  syncProjectedThreadState,
  serialize
}) {
  const targetResumeId = String(resumeSessionId || "").trim();
  if (!targetResumeId) {
    return null;
  }

  const liveSession = findLatestLiveSession(sessions, provider.id, targetResumeId);
  if (!liveSession) {
    return null;
  }

  let baseSnapshot = null;
  try {
    baseSnapshot = historyService.getHistoricalMessages(provider, targetResumeId)?.threadSnapshot || null;
  } catch {
    baseSnapshot = null;
  }

  const currentSnapshot = ensureThreadSnapshot(liveSession);
  const currentConversation = ensureConversationState(liveSession);
  buildThreadProjection(liveSession);
  const mergedSnapshot =
    (currentSnapshot?.turns?.length || 0) >= (currentConversation?.turns?.length || 0)
      ? currentSnapshot
      : deriveThreadSnapshotFromConversationState(currentConversation, {
          threadId: targetResumeId,
          metadata: currentSnapshot?.metadata || baseSnapshot?.metadata || {},
          baseSnapshot: baseSnapshot || currentSnapshot || null
        });
  liveSession.threadSnapshot = mergedSnapshot;
  syncProjectedThreadState(liveSession, { previousSnapshot: mergedSnapshot });
  return {
    session: serialize(liveSession),
    conversation: currentConversation,
    threadSnapshot: mergedSnapshot,
    liveOverlay: liveSession.liveOverlay || null
  };
}
