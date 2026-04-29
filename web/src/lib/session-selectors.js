import { computed } from "vue";

import { cacheKey, parseHistoryRouteSessionId } from "./session-list.js";
import { buildDisplayedThreadSnapshot } from "./thread-display-state.js";
import { getProviderModelOptions } from "./composer.js";
import { workspaceName } from "./session-helpers.js";

export function createSessionSelectors({ state, route, sessionCache, composerOptions, providerCatalog }) {
  const routeHistoryTarget = computed(() => {
    if (route.name !== "chat") {
      return null;
    }
    return parseHistoryRouteSessionId(route.params.sessionId);
  });

  const routeThreadId = computed(() => String(routeHistoryTarget.value?.resumeSessionId || "").trim());
  const expectedThreadId = computed(() => {
    const target = routeHistoryTarget.value;
    if (!target || target.provider !== "codex") {
      return "";
    }
    return target.resumeSessionId;
  });

  const interactiveThreadId = computed(() =>
    String(state.liveView.sessionMeta?.resumeSessionId || state.threadView.threadId || "").trim()
  );

  const activeThreadId = computed(() => routeThreadId.value || state.threadView.threadId || interactiveThreadId.value);

  const displayedSessionMeta = computed(() => {
    const preferredThreadSnapshot = state.threadView.authoritativeSnapshot || state.threadView.persistedSnapshot || null;
    if (state.liveView.sessionMeta) {
      return state.liveView.sessionMeta;
    }
    if (state.threadView.meta) {
      return state.threadView.meta;
    }
    if (routeHistoryTarget.value) {
      return {
        id: state.threadView.sessionId || `history:${routeHistoryTarget.value.provider}:${routeHistoryTarget.value.resumeSessionId}`,
        kind: "thread",
        status: "saved",
        provider: routeHistoryTarget.value.provider || "codex",
        providerLabel: "Codex",
        resumeSessionId: routeHistoryTarget.value.resumeSessionId || state.threadView.threadId || "",
        cwd: preferredThreadSnapshot?.metadata?.cwd || "",
        displayTitle: String(preferredThreadSnapshot?.metadata?.name || "").trim() || "会话",
        displayPreview: String(preferredThreadSnapshot?.metadata?.preview || "").trim() || ""
      };
    }
    return null;
  });

  const displayedThreadSnapshot = computed(() => {
    const preferAuthoritativeSnapshot = Boolean(
      state.threadView.authoritativeSnapshot || state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta
    );
    return buildDisplayedThreadSnapshot({
      persistedSnapshot: state.threadView.persistedSnapshot,
      authoritativeSnapshot: state.threadView.authoritativeSnapshot,
      liveConversation: state.liveView.conversation,
      runtimeMessages: state.liveView.messages,
      threadId: activeThreadId.value,
      liveSessionMeta: state.liveView.sessionMeta,
      threadMeta: state.threadView.meta,
      preferAuthoritativeSnapshot,
      includeLiveConversation: false,
      includeRuntimeDraft: true
    });
  });

  const displayedLiveOverlay = computed(() => state.liveView.liveOverlay);

  const activeSessionTitle = computed(() => {
    if (displayedSessionMeta.value) {
      const cached = sessionCache[cacheKey(displayedSessionMeta.value)] || {};
      return (
        cached.title ||
        displayedSessionMeta.value.displayTitle ||
        displayedSessionMeta.value.name ||
        String(displayedThreadSnapshot.value?.metadata?.name || "").trim() ||
        "会话"
      );
    }
    return String(displayedThreadSnapshot.value?.metadata?.name || "").trim() || "会话";
  });

  const activeWorkspaceName = computed(() =>
    workspaceName(displayedSessionMeta.value?.cwd || displayedThreadSnapshot.value?.metadata?.cwd || "")
  );
  const activeWorkspaceCwd = computed(() =>
    String(displayedSessionMeta.value?.cwd || displayedThreadSnapshot.value?.metadata?.cwd || "").trim()
  );
  const activeProviderId = computed(() => {
    return String(displayedSessionMeta.value?.provider || state.defaultProvider || "codex").trim().toLowerCase() || "codex";
  });
  const availableModels = computed(() =>
    getProviderModelOptions(
      providerCatalog.value,
      activeProviderId.value,
      composerOptions.value.model || displayedSessionMeta.value?.model || ""
    )
  );
  const activeAssistantName = computed(() => displayedSessionMeta.value?.providerLabel || "Codex");
  const threadMismatch = computed(() => Boolean(expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value));
  const canRenderChatView = computed(() => {
    if (route.name !== "chat") {
      return false;
    }
    if (routeHistoryTarget.value) {
      return Boolean(displayedThreadSnapshot.value);
    }
    return Boolean(displayedSessionMeta.value || displayedThreadSnapshot.value);
  });

  return {
    routeHistoryTarget,
    routeThreadId,
    expectedThreadId,
    interactiveThreadId,
    activeThreadId,
    displayedSessionMeta,
    displayedThreadSnapshot,
    displayedLiveOverlay,
    activeSessionTitle,
    activeWorkspaceName,
    activeWorkspaceCwd,
    activeProviderId,
    availableModels,
    activeAssistantName,
    threadMismatch,
    canRenderChatView
  };
}
