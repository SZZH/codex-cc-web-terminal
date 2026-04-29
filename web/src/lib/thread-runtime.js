import {
  buildAuthoritativeThreadSnapshot,
  mergeAuthoritativeThreadSnapshotPatch
} from "./thread-display-state.js";
import {
  buildTimelineMessagesFromConversation,
  compareConversationContent,
  createConversationState,
  reconcileTimelineWithSnapshotBuffer
} from "./conversation-timeline.js";

export function createThreadRuntimeController({
  state,
  setMessages,
  setStatus,
  syncThreadViewFromInteraction
} = {}) {
  function getPreferredThreadSnapshot() {
    return state.threadView.authoritativeSnapshot || state.threadView.persistedSnapshot || null;
  }

  function clearAuthoritativeThreadSnapshot() {
    state.threadView.authoritativeSnapshot = null;
  }

  function setBackgroundAgents(backgroundAgents = []) {
    state.liveView.backgroundAgents = Array.isArray(backgroundAgents) ? backgroundAgents : [];
  }

  function setLiveOverlay(liveOverlay = null) {
    state.liveView.liveOverlay = liveOverlay && typeof liveOverlay === "object" ? liveOverlay : null;
  }

  function setLiveThreadSnapshot(snapshot = null, liveOverlay = null, { partial = false } = {}) {
    state.threadView.authoritativeSnapshot =
      snapshot && typeof snapshot === "object"
        ? partial
          ? mergeAuthoritativeThreadSnapshotPatch({
              persistedSnapshot: state.threadView.persistedSnapshot,
              authoritativeSnapshot: state.threadView.authoritativeSnapshot,
              incomingSnapshot: snapshot
            })
          : snapshot
        : null;
    state.threadView.threadId = String(
      state.threadView.authoritativeSnapshot?.threadId ||
        snapshot?.threadId ||
        state.threadView.threadId ||
        state.threadView.persistedSnapshot?.threadId ||
        ""
    ).trim();
    setLiveOverlay(liveOverlay);
    syncThreadViewFromInteraction?.();
  }

  function resolveAuthoritativeLiveThreadSnapshot({ threadSnapshot = null, conversation = null, fallbackThreadId = "" } = {}) {
    if (threadSnapshot && typeof threadSnapshot === "object") {
      return threadSnapshot;
    }
    if (!conversation || typeof conversation !== "object") {
      return state.threadView.authoritativeSnapshot || state.threadView.persistedSnapshot || null;
    }
    return buildAuthoritativeThreadSnapshot({
      persistedSnapshot: state.threadView.persistedSnapshot,
      authoritativeSnapshot: state.threadView.authoritativeSnapshot,
      liveConversation: conversation,
      threadId:
        String(
          fallbackThreadId ||
            conversation?.threadId ||
            state.liveView.sessionMeta?.resumeSessionId ||
            state.threadView.threadId ||
            ""
        ).trim(),
      liveSessionMeta: state.liveView.sessionMeta,
      threadMeta: state.threadView.meta
    });
  }

  function payloadOwnsKey(payload, key) {
    return Boolean(payload && Object.prototype.hasOwnProperty.call(payload, key));
  }

  function resolvePayloadValue(payload, key, fallback = null) {
    if (payloadOwnsKey(payload, key)) {
      return payload[key] ?? null;
    }
    return fallback;
  }

  function setThreadSnapshot(snapshot = null) {
    state.threadView.persistedSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
    state.threadView.threadId = String(snapshot?.threadId || state.threadView.authoritativeSnapshot?.threadId || "").trim();
    syncThreadViewFromInteraction?.();
  }

  function collectConversationFallbackMessages(messages = []) {
    return (Array.isArray(messages) ? messages : []).filter((message) => message?.source === "draft" || message?.streaming);
  }

  function shouldApplyIncomingConversation(nextConversation, { force = false } = {}) {
    if (force) {
      return true;
    }
    const current = createConversationState(state.liveView.conversation);
    const incoming = createConversationState(nextConversation);
    if (incoming.sessionId && current.sessionId && incoming.sessionId !== current.sessionId) {
      return true;
    }

    const currentVersion = Number(current.version || 0);
    const incomingVersion = Number(incoming.version || 0);
    const contentComparison = compareConversationContent(incoming, current);
    if (incomingVersion < currentVersion) {
      return false;
    }
    if (
      incomingVersion > currentVersion &&
      contentComparison < 0 &&
      String(incoming.threadId || "") === String(current.threadId || "") &&
      String(incoming.activeTurnId || "") &&
      String(incoming.activeTurnId || "") === String(current.activeTurnId || "")
    ) {
      return false;
    }
    if (incomingVersion === currentVersion && incoming.turns.length < current.turns.length) {
      return false;
    }
    if (incomingVersion === currentVersion && contentComparison < 0) {
      return false;
    }
    return true;
  }

  function setConversation(conversation, { fallbackMessages = [], buffer = "", force = false } = {}) {
    const nextConversation = createConversationState(conversation);
    if (!shouldApplyIncomingConversation(nextConversation, { force })) {
      return false;
    }
    state.liveView.conversation = nextConversation;
    setBackgroundAgents(state.liveView.conversation.backgroundAgents);
    let nextMessages = buildTimelineMessagesFromConversation(state.liveView.conversation, fallbackMessages);
    if (!state.liveView.conversation.turns.length && buffer) {
      nextMessages = reconcileTimelineWithSnapshotBuffer(nextMessages, buffer);
    }
    setMessages(nextMessages);
    syncThreadViewFromInteraction?.();
    return true;
  }

  function mergeConversationTurns(existingTurns = [], incomingTurns = []) {
    const collectAssistantText = (assistant = null) =>
      (Array.isArray(assistant?.body) ? assistant.body : [])
        .map((part) => String(part?.text || "").trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();

    const mergeAssistant = (existingAssistant = null, incomingAssistant = null) => {
      if (!existingAssistant) {
        return incomingAssistant || null;
      }
      if (!incomingAssistant) {
        return existingAssistant;
      }

      const existingText = collectAssistantText(existingAssistant);
      const incomingText = collectAssistantText(incomingAssistant);
      const keepExistingBody = existingText.length > incomingText.length;

      return {
        ...existingAssistant,
        ...incomingAssistant,
        body: keepExistingBody
          ? existingAssistant.body || []
          : incomingAssistant.body || existingAssistant.body || [],
        process:
          Array.isArray(incomingAssistant.process) && incomingAssistant.process.length
            ? incomingAssistant.process
            : existingAssistant.process || [],
        status:
          String(incomingAssistant.status || "").trim().toLowerCase() === "completed" ||
          String(existingAssistant.status || "").trim().toLowerCase() !== "completed"
            ? incomingAssistant.status || existingAssistant.status || ""
            : existingAssistant.status || incomingAssistant.status || "",
        startedAt: existingAssistant.startedAt || incomingAssistant.startedAt || "",
        finishedAt: incomingAssistant.finishedAt || existingAssistant.finishedAt || ""
      };
    };

    const nextTurns = Array.isArray(existingTurns) ? [...existingTurns] : [];
    for (const incomingTurn of Array.isArray(incomingTurns) ? incomingTurns : []) {
      const turnId = String(incomingTurn?.id || "").trim();
      if (!turnId) {
        continue;
      }
      const existingIndex = nextTurns.findIndex((turn) => String(turn?.id || "").trim() === turnId);
      if (existingIndex >= 0) {
        nextTurns[existingIndex] = {
          ...nextTurns[existingIndex],
          ...incomingTurn,
          user: incomingTurn?.user || nextTurns[existingIndex]?.user || null,
          assistant: mergeAssistant(nextTurns[existingIndex]?.assistant || null, incomingTurn?.assistant || null)
        };
        continue;
      }
      nextTurns.push(incomingTurn);
    }
    return nextTurns;
  }

  function mergeConversationPatch(currentConversation, patchConversation) {
    const current = createConversationState(currentConversation);
    const patch = createConversationState(patchConversation);
    return createConversationState({
      ...current,
      ...patch,
      turns: mergeConversationTurns(current.turns, patch.turns),
      backgroundAgents: patch.backgroundAgents?.length ? patch.backgroundAgents : current.backgroundAgents,
      activeTurnId: String(patch.activeTurnId || current.activeTurnId || "")
    });
  }

  return {
    getPreferredThreadSnapshot,
    clearAuthoritativeThreadSnapshot,
    setBackgroundAgents,
    setLiveOverlay,
    setLiveThreadSnapshot,
    resolveAuthoritativeLiveThreadSnapshot,
    payloadOwnsKey,
    resolvePayloadValue,
    setThreadSnapshot,
    collectConversationFallbackMessages,
    shouldApplyIncomingConversation,
    setConversation,
    mergeConversationTurns,
    mergeConversationPatch
  };
}
