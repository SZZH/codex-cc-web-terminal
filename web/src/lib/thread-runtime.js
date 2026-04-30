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
  function buildAssistantState(turn = {}) {
    return {
      body: Array.isArray(turn?.assistant?.body) ? [...turn.assistant.body] : [],
      process: Array.isArray(turn?.assistant?.process) ? [...turn.assistant.process] : [],
      status: String(turn?.assistant?.status || "running"),
      startedAt: String(turn?.assistant?.startedAt || turn?.user?.ts || ""),
      finishedAt: String(turn?.assistant?.finishedAt || "")
    };
  }

  function appendMessageEventToConversation(conversation, messageEvent = null) {
    const current = createConversationState(conversation);
    const turnId = String(messageEvent?.turnId || "").trim();
    const text = String(messageEvent?.text || "").trim();
    if (!turnId || !text) {
      return current;
    }

    const messageId = String(messageEvent?.messageId || "").trim();
      const phase = String(messageEvent?.phase || "streaming").trim().toLowerCase();
      const ts = String(messageEvent?.ts || "").trim();
      const turns = current.turns.map((turn) => {
      if (String(turn?.id || "").trim() !== turnId) {
        return turn;
      }

      const assistant = buildAssistantState(turn);
      const existingIndex = assistant.body.findIndex(
        (item) => (messageId && String(item?.id || "").trim() === messageId) || (!messageId && String(item?.kind || "").trim().toLowerCase() === "markdown")
      );
      const previousText = existingIndex >= 0 ? String(assistant.body[existingIndex]?.text || "") : "";
      const nextText = phase === "final"
        ? text
        : text.startsWith(previousText)
          ? text
          : `${previousText}${text}`;
      const bodyItem = {
        id: messageId || assistant.body[existingIndex]?.id || `message-${turnId}-${assistant.body.length + 1}`,
        kind: "markdown",
        text: nextText,
        payload: {},
        ts
      };

      if (existingIndex >= 0) {
        assistant.body[existingIndex] = {
          ...assistant.body[existingIndex],
          ...bodyItem
        };
      } else {
        assistant.body.push(bodyItem);
      }

      assistant.status = phase === "final" ? "completed" : "running";
      if (phase === "final") {
        assistant.finishedAt = ts || assistant.finishedAt || "";
      }

      return {
        ...turn,
        assistant
      };
    });

    return createConversationState({
      ...current,
      turns,
      updatedAt: ts || current.updatedAt || ""
    });
  }

  function appendOverlayPartsToConversation(conversation, overlay = null) {
    const current = createConversationState(conversation);
    const turnId = String(overlay?.turnId || "").trim();
    const parts = Array.isArray(overlay?.parts) ? overlay.parts : [];
    if (!turnId || !parts.length) {
      return current;
    }

    const turns = current.turns.map((turn) => {
      if (String(turn?.id || "").trim() !== turnId) {
        return turn;
      }

      const assistant = buildAssistantState(turn);

      for (const part of parts) {
        const partType = String(part?.type || "").trim().toLowerCase();
        if (partType === "text") {
          const text = String(part?.text || "").trim();
          if (!text) {
            continue;
          }
          const lastBody = assistant.body[assistant.body.length - 1];
          if (lastBody && String(lastBody.kind || "").trim().toLowerCase() === "markdown") {
            if (String(lastBody.text || "").trim() !== text) {
              lastBody.text = text;
            }
            lastBody.ts = String(overlay?.timestamp || lastBody.ts || "");
          } else {
            assistant.body.push({
              id: `overlay-body-${turnId}-${assistant.body.length + 1}`,
              kind: "markdown",
              text,
              payload: {},
              ts: String(overlay?.timestamp || "")
            });
          }
          continue;
        }

        const summary = String(part?.summary || "").trim();
        if (!summary) {
          continue;
        }
        const exists = assistant.process.some(
          (item) =>
            String(item?.summary || "").trim() === summary &&
            String(item?.type || "").trim() === String(part?.rawType || partType || "event").trim()
        );
        if (exists) {
          continue;
        }
        assistant.process.push({
          id: `overlay-process-${turnId}-${assistant.process.length + 1}`,
          type: String(part?.rawType || partType || "event"),
          title: summary,
          summary,
          content: summary,
          payload: part?.payload || {},
          phase: String(overlay?.phase || "completed"),
          ts: String(overlay?.timestamp || "")
        });
      }

      if (String(overlay?.phase || "").trim().toLowerCase() === "final" && assistant.body.length) {
        assistant.status = "completed";
        assistant.finishedAt = String(overlay?.timestamp || assistant.finishedAt || "");
      }

      return {
        ...turn,
        assistant
      };
    });

    return createConversationState({
      ...current,
      turns,
      updatedAt: String(overlay?.timestamp || current.updatedAt || "")
    });
  }

  function appendProcessEventToConversation(conversation, processEvent = null) {
    const current = createConversationState(conversation);
    const turnId = String(processEvent?.turnId || "").trim();
    const summary = String(processEvent?.summary || "").trim();
    if (!turnId || !summary) {
      return current;
    }

    const turns = current.turns.map((turn) => {
      if (String(turn?.id || "").trim() !== turnId) {
        return turn;
      }
      const assistant = buildAssistantState(turn);
      const processId = String(processEvent?.processId || "").trim();
      const existingIndex = assistant.process.findIndex(
        (item) =>
          (processId && String(item?.id || "").trim() === processId) ||
          (
            !processId &&
            String(item?.summary || "").trim() === summary &&
            String(item?.type || "").trim() === String(processEvent?.processType || "").trim()
          )
      );
      if (existingIndex >= 0) {
        assistant.process[existingIndex] = {
          ...assistant.process[existingIndex],
          type: String(processEvent?.processType || assistant.process[existingIndex]?.type || "event"),
          title: summary,
          summary,
          content: summary,
          payload: processEvent?.payload || assistant.process[existingIndex]?.payload || {},
          phase: String(processEvent?.phase || assistant.process[existingIndex]?.phase || "completed"),
          ts: String(processEvent?.ts || assistant.process[existingIndex]?.ts || "")
        };
      } else {
        assistant.process.push({
          id: processId || `process-${turnId}-${assistant.process.length + 1}`,
          type: String(processEvent?.processType || "event"),
          title: summary,
          summary,
          content: summary,
          payload: processEvent?.payload || {},
          phase: String(processEvent?.phase || "completed"),
          ts: String(processEvent?.ts || "")
        });        
      }
      return {
        ...turn,
        assistant
      };
    });

    return createConversationState({
      ...current,
      turns,
      updatedAt: String(processEvent?.ts || current.updatedAt || "")
    });
  }

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
    const hasExplicitActiveTurnId =
      patchConversation && Object.prototype.hasOwnProperty.call(patchConversation, "activeTurnId");
    return createConversationState({
      ...current,
      ...patch,
      turns: mergeConversationTurns(current.turns, patch.turns),
      backgroundAgents: patch.backgroundAgents?.length ? patch.backgroundAgents : current.backgroundAgents,
      activeTurnId: hasExplicitActiveTurnId ? String(patchConversation.activeTurnId || "") : String(patch.activeTurnId || current.activeTurnId || "")
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
    mergeConversationPatch,
    appendMessageEventToConversation,
    appendOverlayPartsToConversation,
    appendProcessEventToConversation
  };
}
