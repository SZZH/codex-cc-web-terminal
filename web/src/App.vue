<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  AUTH_EXPIRED_EVENT,
  request,
  requestAuthSession,
  requestHistoryMessages,
  patchThreadComposerState,
  requestSessionById,
  requestSessionInput,
  requestThreadComposerState,
  requestThreadInput,
  requestWorkspaceGit,
  requestWorkspaceGitBranchCreate,
  requestWorkspaceGitCheckout
} from "./lib/api.js";
import {
  buildConversationStateFromPayload,
  createConversationState
} from "./lib/conversation-timeline.js";
import { resolveInitialAuthBootstrap } from "./lib/auth-bootstrap.js";
import { createLiveViewState, createThreadViewState, resetLiveViewState, resetThreadViewState } from "./lib/app-state.js";
import { createComposerRuntimeController } from "./lib/composer-runtime.js";
import { cacheKey, createGroupedSessionsComputed, decorateSession } from "./lib/session-list.js";
import { createLiveSessionRuntimeController } from "./lib/live-session-runtime.js";
import { createSessionSelectors } from "./lib/session-selectors.js";
import { createSessionRuntimeController } from "./lib/session-runtime.js";
import { createThreadRuntimeController } from "./lib/thread-runtime.js";
import { createMessage, formatRelativeTime, normalizeLine, wait } from "./lib/session-helpers.js";
import {
  buildInputRequest,
  canSendComposerMessage,
  collectAttachmentLimitError,
  createAttachmentRecord,
  createComposerOptions,
  createWorkspaceGitState,
  hasOnlyFileAttachments,
  validateGitBranchName
} from "./lib/composer.js";

const ChatView = defineAsyncComponent(() => import("./components/ChatView.vue"));
const LoginView = defineAsyncComponent(() => import("./components/LoginView.vue"));
const SessionListView = defineAsyncComponent(() => import("./components/SessionListView.vue"));

const composerDraft = ref("");
const composerOptions = ref(createComposerOptions());
const workspaceGitState = ref(createWorkspaceGitState());
const router = useRouter();
const route = useRoute();
const historyApiAvailable = ref(null);
const sessionCache = reactive({});
const pendingHydrations = new Map();
const TOKEN_STORAGE_KEY = "codex-web-terminal.saved-token";
const GIT_DIRTY_ERROR_MESSAGE = "当前工作区有未提交改动，无法直接切换分支。";
let autoLoginTried = false;
let replaySuppressionLines = new Set();
let submitFallbackTimer = null;

const LIVE_BOOTSTRAP_LINE_PATTERNS = [
  /^[╭╰│─]+$/,
  /^>_?\s*OpenAI Codex/i,
  /^model:\s/i,
  /^directory:\s/i,
  /^Tip:\s/i,
  /^⚠\s*Skipped loading/i,
  /^\[Image #\d+\]/i,
  /^›\s?/,
  /^\[[;?0-9a-zA-Z]+\]$/,
  /\/model to change/i,
  /Use the OpenAI docs MCP/i,
  /available skills/i,
  /dangerously-bypass-approv/i,
  /approvals-and-sandbox/i
];

const state = reactive({
  ready: false,
  isAuthenticated: false,
  loading: false,
  accessToken: "",
  rememberToken: true,
  statusText: "",
  providerCatalog: [],
  codexDefaults: {
    model: "",
    reasoningEffort: "medium",
    permissionMode: "default"
  },
  defaultProvider: "codex",
  sessions: [],
  projectGroups: [],
  routeSessionId: "",
  liveView: createLiveViewState(),
  threadView: createThreadViewState(),
  pendingSessionId: "",
  lastSubmitText: "",
  lastSubmitAt: 0,
  backendHttpOrigin: "",
  backendWsOrigin: "",
  authExpiredHandler: null
});

function resetLiveView() {
  resetLiveViewState(state.liveView);
}

function resetThreadView() {
  resetThreadViewState(state.threadView);
}

function syncThreadViewFromInteraction() {
  // liveOverlay should be cleared only by authoritative socket/state updates.
}

const groupedSessions = createGroupedSessionsComputed(state);
const selectors = createSessionSelectors({
  state,
  route,
  sessionCache,
  composerOptions,
  providerCatalog: computed(() => state.providerCatalog)
});
const {
  routeHistoryTarget,
  expectedThreadId,
  interactiveThreadId,
  activeThreadId,
  displayedSessionMeta,
  displayedThreadSnapshot,
  activeSessionTitle,
  activeWorkspaceName,
  activeWorkspaceCwd,
  activeProviderId,
  availableModels,
  activeAssistantName,
  threadMismatch,
  canRenderChatView
} = selectors;
function isDisplayedThreadRunning(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  if (String(snapshot.status || "").trim().toLowerCase() === "running") {
    return true;
  }
  if (String(snapshot.activeTurnId || "").trim()) {
    return true;
  }
  return (Array.isArray(snapshot.turns) ? snapshot.turns : []).some((turn) => {
    const status = String(turn?.status || turn?.assistant?.status || "").trim().toLowerCase();
    return status === "running" || status === "inprogress" || status === "in_progress";
  });
}
const canSend = computed(() => {
  if (state.loading || !Boolean(activeThreadId.value || displayedSessionMeta.value)) {
    return false;
  }
  if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
    return false;
  }
  if (isDisplayedThreadRunning(displayedThreadSnapshot.value)) {
    return false;
  }
  return canSendComposerMessage(composerDraft.value, composerOptions.value.attachments || []);
});
const canInterrupt = computed(() => {
  if (!state.liveView.liveSessionId) {
    return false;
  }
  if (state.liveView.activeInputStream || state.liveView.interruptInFlight) {
    return true;
  }
  if (state.loading) {
    return true;
  }
  if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
    return true;
  }
  if (isDisplayedThreadRunning(displayedThreadSnapshot.value)) {
    return true;
  }
  if (String(state.liveView.streamBuffer || "").trim()) {
    return true;
  }
  const lastMessage = state.liveView.messages[state.liveView.messages.length - 1];
  return Boolean(lastMessage?.role === "assistant" && lastMessage?.streaming);
});

function setStatus(message = "") {
  state.statusText = message;
}

const threadRuntime = createThreadRuntimeController({
  state,
  setMessages,
  setStatus,
  syncThreadViewFromInteraction
});

const {
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
} = threadRuntime;

async function requestConversationSnapshotBySessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return null;
  }
  return request(`/api/sessions/${encodeURIComponent(id)}/conversation`);
}

async function requestConversationSnapshotByThread(provider, threadId) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    return null;
  }
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/conversation`);
}

function clearSubmitFallbackTimer() {
  if (submitFallbackTimer) {
    window.clearTimeout(submitFallbackTimer);
    submitFallbackTimer = null;
  }
}

function toFriendlyLoginError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) {
    return "登录失败，请重试。";
  }
  if (/unauthorized/i.test(message)) {
    return "token 不正确，请检查后重试。";
  }
  if (/client address is not allowed/i.test(message)) {
    return "当前访问地址未被允许，请确认网络方式是否正确。";
  }
  return message;
}

function detectSystemFailureText(value) {
  const text = normalizeLine(value || "");
  if (!text) {
    return "";
  }

  if (/missing optional dependency\s+@openai\/codex-/i.test(text)) {
    return "Codex CLI 启动失败：本机缺少必要依赖，请检查安装环境。";
  }
  if (/\bzsh:\s*command not found\b/i.test(text) || /command not found/i.test(text)) {
    return "Codex CLI 启动失败：命令不可用，请检查本机安装与 PATH。";
  }
  if (/cannot find module|module_not_found/i.test(text)) {
    return "Codex CLI 启动失败：运行依赖缺失，请检查本机安装。";
  }
  if (/permission denied/i.test(text)) {
    return "Codex CLI 启动失败：权限不足，请检查当前环境权限。";
  }
  return "";
}

function isDisposableAssistantFragment(value) {
  const text = normalizeLine(value || "");
  if (!text) {
    return true;
  }
  return /^[=~`._-]{1,8}$/.test(text);
}

function getSavedToken() {
  if (typeof window === "undefined") {
    return "";
  }
  return String(window.localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
}

function saveTokenPreference(token) {
  if (typeof window === "undefined") {
    return;
  }
  if (state.rememberToken && token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function forceBackToLogin(statusMessage = "登录状态已失效，请重新登录。") {
  clearSubmitFallbackTimer();
  closeSocket();
  finalizeAssistantStream();
  state.loading = false;
  state.isAuthenticated = false;
  state.sessions = [];
  state.routeSessionId = "";
  state.pendingSessionId = "";
  resetComposerDraftState({ keepOptions: false });
  resetLiveView();
  resetThreadView();
  setStatus(statusMessage);
  const savedToken = getSavedToken();
  state.accessToken = savedToken;
  state.rememberToken = Boolean(savedToken);
  if (route.name !== "login") {
    const redirect = route.fullPath || "/sessions";
    await router.replace({ name: "login", query: { redirect } });
  }
}

function setMessages(messages) {
  state.liveView.messages = messages.filter(
    (message) => message?.text || (message?.partType === "image" && String(message?.payload?.url || "").trim())
  );
  rebuildReplaySuppressionLines(state.liveView.messages);
  syncThreadViewFromInteraction();
}

function buildSubmissionText(text) {
  const fragments = [];
  const trimmedText = String(text || "").trim();
  if (trimmedText) {
    fragments.push(trimmedText);
  }
  return fragments.join("\n\n").trim();
}

const composerRuntime = createComposerRuntimeController({
  state,
  composerDraft,
  composerOptions,
  workspaceGitState,
  patchThreadComposerState,
  requestThreadComposerState,
  requestWorkspaceGit,
  requestWorkspaceGitCheckout,
  requestWorkspaceGitBranchCreate,
  wait,
  setStatus,
  createComposerOptions,
  createWorkspaceGitState,
  collectAttachmentLimitError,
  createAttachmentRecord,
  hasOnlyFileAttachments,
  validateGitBranchName,
  getActiveThreadId: () => activeThreadId.value,
  getExpectedThreadId: () => expectedThreadId.value,
  getActiveProviderId: () => activeProviderId.value,
  getActiveWorkspaceCwd: () => activeWorkspaceCwd.value,
  getCanInterrupt: () => canInterrupt.value,
  getLoading: () => state.loading,
  getGitDirtyErrorMessage: () => GIT_DIRTY_ERROR_MESSAGE
});

const {
  resetComposerDraftState,
  updateComposerOptions,
  handleComposerOptionsChange,
  applyComposerStatePayload,
  applyHistoricalComposerValues,
  syncComposerStateForThread,
  refreshWorkspaceGit,
  addAttachments,
  removeAttachment,
  retryAttachment,
  switchGitBranch,
  createGitBranch
} = composerRuntime;

const liveSessionRuntime = createLiveSessionRuntimeController({
  state,
  setStatus,
  setMessages,
  waitForSocketOpen,
  threadRuntime,
  liveBootstrapLinePatterns: LIVE_BOOTSTRAP_LINE_PATTERNS,
  decorateSession,
  stopHistorySyncLoop: () => stopHistorySyncLoop()
});

const {
  rebuildReplaySuppressionLines,
  finalizeAssistantStream,
  discardPendingAssistantStream,
  appendNormalizedParts,
  clearPendingReplyStatus,
  settleAuthoritativeInputState
} = liveSessionRuntime;

function bumpActiveSessionOpenToken() {
  if (state.liveView.liveSessionId) {
    state.liveView.openToken += 1;
    return;
  }
  state.threadView.openToken += 1;
}

function resolveWsUrl(sessionId) {
  const wsBase = String(state.backendWsOrigin || "").trim();
  if (wsBase) {
    return `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }
  const protocol = toWsProtocol(window.location.protocol);
  return `${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

const sessionRuntime = createSessionRuntimeController({
  state,
  route,
  router,
  composerOptions,
  sessionCache,
  pendingHydrations,
  historyApiAvailable,
  request,
  requestHistoryMessages,
  requestSessionById,
  requestThreadComposerState,
  setStatus,
  wait,
  getActiveThreadId: () => activeThreadId.value,
  getExpectedThreadId: () => expectedThreadId.value,
  getInteractiveThreadId: () => interactiveThreadId.value,
  getRouteHistoryTarget: () => routeHistoryTarget.value,
  getPreferredThreadSnapshot,
  resetComposerDraftState,
  resetLiveView,
  resetThreadView,
  closeSocket,
  finalizeAssistantStream,
  discardPendingAssistantStream,
  clearAuthoritativeThreadSnapshot,
  setConversation,
  setThreadSnapshot,
  setLiveOverlay,
  attachLiveSocket,
  syncComposerStateForThread,
  applyHistoricalComposerValues
});

const {
  bootstrapWorkspace,
  hydrateSession,
  refreshSessions,
  stopHistorySyncLoop,
  startHistorySyncLoop,
  syncActiveThreadSession,
  openSessionItem,
  createSessionInGroup,
  ensureLiveSession,
  backToList,
  syncRouteSession
} = sessionRuntime;

async function backToSessionList() {
  clearSubmitFallbackTimer();
  await backToList();
}

async function handleLogin({ silent = false, auto = false } = {}) {
  const token = state.accessToken.trim();
  try {
    state.loading = true;
    if (!token) {
      throw new Error("请输入 token");
    }

    await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    saveTokenPreference(token);
    state.isAuthenticated = true;
    state.accessToken = "";
    setStatus("");
    await bootstrapWorkspace();
    if (route.name === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
    }
  } catch (error) {
    if (auto) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
      state.rememberToken = false;
      state.accessToken = "";
      setStatus("已保存的 token 已失效，请重新输入一次。");
      return;
    }
    if (!silent) {
      setStatus(toFriendlyLoginError(error));
    }
  } finally {
    state.loading = false;
  }
}

function closeSocket({ silent = false } = {}) {
  clearSubmitFallbackTimer();
  if (state.liveView.socket) {
    state.liveView.muteSocketLifecycleStatus = Boolean(silent);
    state.liveView.socket.close();
    state.liveView.socket = null;
    return;
  }
  state.liveView.muteSocketLifecycleStatus = false;
}

function waitForSocketOpen(socket, timeoutMs = 20000) {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("会话连接还没准备好，请重试一次"));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    }

    function handleOpen() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error("会话连接失败，请重试一次"));
    }

    function handleClose() {
      cleanup();
      reject(new Error("会话连接已关闭，请重试一次"));
    }

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
  });
}

function handleLivePayload(payload) {
  return liveSessionRuntime.handleLivePayload(payload, {
    activeThreadId: activeThreadId.value,
    detectSystemFailureText,
    isDisposableAssistantFragment
  });
}

function attachLiveSocket(sessionId) {
  return liveSessionRuntime.attachLiveSocket(sessionId, {
    closeSocket,
    resolveWsUrl,
    detectSystemFailureText,
    isDisposableAssistantFragment
  });
}

async function submitInput() {
  if (!canSend.value || state.loading) {
    return;
  }
  const draftText = String(composerDraft.value || "");
  const submissionText = buildSubmissionText(draftText);
  const requestBody = buildInputRequest({
    text: submissionText,
    composerOptions: composerOptions.value
  });
  const sendableImages = requestBody.attachments || [];
  const attachmentsSnapshot = [...composerOptions.value.attachments];

  if (!submissionText && !sendableImages.length) {
    if (hasOnlyFileAttachments(composerOptions.value.attachments)) {
      setStatus("当前版本文件附件仅保存选择状态，暂不随消息发送。");
    }
    return;
  }
  const now = Date.now();
  const submissionFingerprint = JSON.stringify({
    text: submissionText,
    attachments: sendableImages.map((attachment) => attachment.name)
  });
  if (submissionFingerprint === state.lastSubmitText && now - Number(state.lastSubmitAt || 0) < 2500) {
    return;
  }
  state.lastSubmitText = submissionFingerprint;
  state.lastSubmitAt = now;
  const optimisticUserMessage = submissionText
    ? createMessage("user", submissionText, new Date().toISOString(), {
        source: "draft",
        partType: "text",
        payload: {}
      })
    : null;

  try {
    state.loading = true;
    setStatus("正在发送…");
    closeSocket({ silent: true });
    if (expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value) {
      throw new Error(
        `会话线程不一致：当前=${activeThreadId.value}，目标=${expectedThreadId.value}。请返回列表后重新打开该会话。`
      );
    }
    const nextMessages = optimisticUserMessage ? [...state.liveView.messages, optimisticUserMessage] : [...state.liveView.messages];
    rebuildReplaySuppressionLines(nextMessages);
    setMessages(nextMessages);
    resetComposerDraftState();
    const liveSessionId = await ensureLiveSession();
    const targetThreadId = String(
      expectedThreadId.value ||
        activeThreadId.value ||
        state.liveView.sessionMeta?.resumeSessionId ||
        state.threadView.threadId ||
        ""
    ).trim();
    const targetProvider = String(
      state.liveView.sessionMeta?.provider ||
        state.threadView.meta?.provider ||
        routeHistoryTarget.value?.provider ||
        "codex"
    ).trim().toLowerCase() || "codex";
    if (expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value) {
      throw new Error(
        `会话线程不一致：当前=${activeThreadId.value}，目标=${expectedThreadId.value}。已取消发送，避免写入错误会话。`
      );
    }
    finalizeAssistantStream();
    clearSubmitFallbackTimer();
    if (state.liveView.replayGuardActive) {
      state.liveView.replayGuardPrompt = submissionText;
    }
    setStatus("等待 Codex 回复…");
    if (targetThreadId) {
      await requestThreadInput(
        targetProvider,
        targetThreadId,
        requestBody
      );
    } else {
      await requestSessionInput(
        liveSessionId,
        requestBody
      );
    }
  } catch (error) {
    updateComposerOptions({ attachments: attachmentsSnapshot });
    if (submissionText && String(composerDraft.value || "").trim() === "") {
      composerDraft.value = submissionText;
    }
    setMessages(
      optimisticUserMessage
        ? state.liveView.messages.filter((message) => String(message.id || "") !== String(optimisticUserMessage.id || ""))
        : state.liveView.messages
    );
    if (!state.liveView.liveSessionId) {
      startHistorySyncLoop();
    }
    setStatus(error.message || String(error));
  } finally {
    state.loading = false;
    await syncActiveThreadSession({ silent: true }).catch(() => {});
    startHistorySyncLoop();
  }
}

async function interruptActiveSession() {
  clearSubmitFallbackTimer();
  const liveSessionId = String(state.liveView.liveSessionId || "").trim();
  const targetThreadId = String(
    expectedThreadId.value ||
      activeThreadId.value ||
      state.liveView.sessionMeta?.resumeSessionId ||
      state.threadView.threadId ||
      ""
  ).trim();
  const targetProvider = String(
    state.liveView.sessionMeta?.provider ||
      state.threadView.meta?.provider ||
      routeHistoryTarget.value?.provider ||
      "codex"
  ).trim().toLowerCase() || "codex";
  if (!liveSessionId) {
    setStatus("当前没有可中断的运行流程。");
    return;
  }
  if (state.liveView.interruptInFlight) {
    return;
  }

  try {
    state.liveView.interruptInFlight = true;
    closeSocket({ silent: true });
    setStatus("已发送中断指令。");
    if (targetThreadId) {
      await requestThreadInput(
        targetProvider,
        targetThreadId,
        { type: "interrupt", reason: "user_interrupt" }
      );
    } else {
      await requestSessionInput(
        liveSessionId,
        { type: "interrupt", reason: "user_interrupt" }
      );
    }
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    state.liveView.interruptInFlight = false;
  }
}


watch(
  () => route.name,
  async (name) => {
    if (name === "sessions") {
      closeSocket();
      stopHistorySyncLoop();
      finalizeAssistantStream();
      if (state.isAuthenticated) {
        try {
          await refreshSessions();
        } catch (error) {
          setStatus(error?.message || String(error));
        }
      }
    }
  }
);

watch(
  () => activeProviderId.value,
  () => {
    if (composerOptions.value.model) {
      return;
    }
    const model = availableModels.value[0]?.value || "";
    if (model) {
      updateComposerOptions({ model });
    }
  },
  { immediate: true }
);

watch(
  () => activeWorkspaceCwd.value,
  () => {
    refreshWorkspaceGit({ silent: true }).catch(() => {});
  },
  { immediate: true }
);

watch(
  () => [state.ready, state.isAuthenticated, route.name, route.params.sessionId],
  async () => {
    await syncRouteSession();
  },
  { immediate: true }
);

onMounted(async () => {
  const handleAuthExpired = () => {
    forceBackToLogin("登录状态已失效，请重新登录。");
  };
  window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  state.authExpiredHandler = handleAuthExpired;
  const next = await resolveInitialAuthBootstrap({
    savedToken: getSavedToken(),
    autoLoginTried,
    requestAuthSession,
    bootstrapWorkspace,
    handleAutoLogin: async (token) => {
      autoLoginTried = true;
      state.accessToken = token;
      await handleLogin({ auto: true });
    },
    routeName: String(route.name || "")
  });
  state.accessToken = next.accessToken;
  state.rememberToken = next.rememberToken;
  state.isAuthenticated = next.isAuthenticated;
  autoLoginTried = next.autoLoginTried;
  state.ready = next.ready;
});

onBeforeUnmount(() => {
  if (state.authExpiredHandler) {
    window.removeEventListener(AUTH_EXPIRED_EVENT, state.authExpiredHandler);
    state.authExpiredHandler = null;
  }
  stopHistorySyncLoop();
  closeSocket();
});

if (typeof window !== 'undefined') {
  window.__codexWebDebug = {
    state,
    groupedSessions,
    composerDraft,
    composerOptions,
    computed: {
      get routeName() {
        return route.name;
      },
      get routeSessionId() {
        return route.params.sessionId;
      },
      get routeHistoryTarget() {
        return routeHistoryTarget.value;
      },
      get canSend() {
        return canSend.value;
      },
      get canRenderChatView() {
        return canRenderChatView.value;
      }
    }
  };
}
</script>

<template>
  <div class="app-shell">
    <div v-if="!state.ready" class="splash-screen">
      <div class="splash-card">正在加载会话…</div>
    </div>

    <LoginView
      v-else-if="!state.isAuthenticated"
      v-model="state.accessToken"
      v-model:remember-token="state.rememberToken"
      :loading="state.loading"
      :status-text="state.statusText"
      @submit="handleLogin"
    />

    <template v-else>
      <section v-if="route.name === 'sessions'" class="mobile-shell">
        <SessionListView
          :groups="groupedSessions"
          :active-session-id="state.routeSessionId"
          :pending-session-id="state.pendingSessionId"
          :format-relative-time="formatRelativeTime"
          @open="openSessionItem"
          @create-group-session="createSessionInGroup"
        />

        <div v-if="state.statusText" class="notice-strip">{{ state.statusText }}</div>
      </section>

      <ChatView
        v-else-if="canRenderChatView"
        :session-key="displayedSessionMeta?.resumeSessionId || displayedSessionMeta?.id || displayedThreadSnapshot?.threadId || ''"
        :open-token="state.liveView.liveSessionId ? state.liveView.openToken : state.threadView.openToken || state.liveView.openToken"
        :title="activeSessionTitle"
        :thread-id="activeThreadId"
        :expected-thread-id="expectedThreadId"
        :thread-mismatch="threadMismatch"
        :workspace-name="activeWorkspaceName"
        :workspace-cwd="activeWorkspaceCwd"
        :assistant-name="activeAssistantName"
        :thread-snapshot="displayedThreadSnapshot"
        v-model:draft="composerDraft"
        :composer-options="composerOptions"
        :models="availableModels"
        :git-state="workspaceGitState"
        :provider-id="activeProviderId"
        :can-send="canSend"
        :can-interrupt="canInterrupt"
        :loading="state.loading"
        :status-text="state.statusText"
        @back="backToSessionList"
        @interrupt="interruptActiveSession"
        @submit="submitInput"
        @status="setStatus"
        @update:composer-options="handleComposerOptionsChange"
        @add-attachments="addAttachments"
        @remove-attachment="removeAttachment"
        @retry-attachment="retryAttachment"
        @switch-git-branch="switchGitBranch"
        @create-git-branch="createGitBranch"
      />

      <section v-else class="mobile-shell centered-shell">
        <div class="splash-card">正在加载会话页面…</div>
      </section>
    </template>
  </div>
</template>
