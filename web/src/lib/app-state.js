import { createConversationState } from "./conversation-timeline.js";

export function createLiveViewState() {
  return {
    sessionId: "",
    liveSessionId: "",
    sessionMeta: null,
    messages: [],
    conversation: createConversationState(),
    liveOverlay: null,
    hasConversationSnapshot: false,
    hasConversationDelta: false,
    backgroundAgents: [],
    socket: null,
    activeInputStream: false,
    interruptInFlight: false,
    muteSocketLifecycleStatus: false,
    streamBuffer: "",
    openToken: 0,
    replayGuardActive: false,
    replayGuardPrompt: "",
    replayGuardUntil: 0
  };
}

export function createThreadViewState() {
  return {
    sessionId: "",
    meta: null,
    threadId: "",
    persistedSnapshot: null,
    authoritativeSnapshot: null,
    openToken: 0
  };
}

export function resetLiveViewState(target) {
  Object.assign(target, createLiveViewState());
}

export function resetThreadViewState(target) {
  Object.assign(target, createThreadViewState());
}
