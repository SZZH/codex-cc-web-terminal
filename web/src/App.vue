<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { defineAppView } from "./lib/async-view.js";
import InterfaceState from "./components/InterfaceState.js";
import { useRoute, useRouter } from "vue-router";
import PreviewHost from "./components/preview/PreviewHost.vue";
import { previewState, closeLocalPreview, invalidateLocalPreviewPosition } from "./lib/preview.js";
import { createAppViewport } from "./lib/app-viewport.js";

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
import { createLiveViewState, createSessionListViewState, createThreadViewState, resetLiveViewState, resetThreadViewState } from "./lib/app-state.js";
import { createComposerRuntimeController, createComposerSubmissionController } from "./lib/composer-runtime.js";
import { cacheKey, createGroupedSessionsComputed, decorateSession, parseHistoryRouteSessionId } from "./lib/session-list.js";
import { createLiveSessionRuntimeController } from "./lib/live-session-runtime.js";
import { createSessionSelectors } from "./lib/session-selectors.js";
import { createSessionRuntimeController } from "./lib/session-runtime.js";
import { createThreadRuntimeController } from "./lib/thread-runtime.js";
import { createMessage, formatRelativeTime, normalizeLine, wait } from "./lib/session-helpers.js";
import {
  canSendComposerMessage,
  collectAttachmentLimitError,
  createAttachmentRecord,
  createComposerOptions,
  createWorkspaceGitState,
  hasOnlyFileAttachments,
  validateGitBranchName
} from "./lib/composer.js";

const viewLoading = { getGeneration: () => `${authGeneration}:${chatRouteGeneration}:${route.name}:${route.params.sessionId || ""}:${state.isAuthenticated}` };
const ChatView = defineAppView(() => import("./components/ChatView.vue"), viewLoading);
const CodexThreadView = defineAppView(() => import("./components/CodexThreadView.vue"), { ...viewLoading, dependsOn: [ChatView] });
const LoginView = defineAppView(() => import("./components/LoginView.vue"), viewLoading);
const SessionListView = defineAppView(() => import("./components/SessionListView.vue"), viewLoading);

const composerDraft = ref("");
const codexThreadId = ref("");
let chatRouteGeneration = 0;
let authGeneration = 0;
const composerOptions = ref(createComposerOptions());
const workspaceGitState = ref(createWorkspaceGitState());
const router = useRouter();
const route = useRoute();
const appViewport = createAppViewport();
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
  composerSaving: false,
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
  sessionListReady: false,
  sessionListComplete: false,
  sessionListCounts: null,
  sessionListLoading: false,
  sessionListError: null,
  sessionCatalog: null,
  sessionSearch: "",
  sessionListViewState: createSessionListViewState(),
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

watch(viewLoading.getGeneration, invalidateLocalPreviewPosition, { flush: "sync" });

watch(
  () => {
    if (state.ready && !state.isAuthenticated || route.name === "login") return LoginView;
    if (route.name === "sessions") return SessionListView;
    if (route.name !== "chat") return null;
    const history = parseHistoryRouteSessionId(route.params.sessionId);
    return history?.provider === "codex" ? CodexThreadView : ChatView;
  },
  (view) => { if (view) void view.preload(); },
  { immediate: true }
);

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
const initialCodexSession = computed(() => state.sessions.find((session) =>
  (session.resumeSessionId || session.threadId) === codexThreadId.value));
watch(() => route.name, (name) => {
  if (name !== "chat" && typeof document !== "undefined") document.title = `Codex Web · ${name === 'login' ? '登录' : '会话'}`;
}, { immediate: true });
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
  if (state.loading || state.composerSaving || state.pendingSessionId || state.liveView.activeInputStream || state.liveView.interruptInFlight || !Boolean(activeThreadId.value || displayedSessionMeta.value)) {
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
  if (!state.liveView.liveSessionId && !activeThreadId.value) {
    return false;
  }
  if (state.liveView.activeInputStream || state.liveView.interruptInFlight) {
    return true;
  }
  if (state.statusText === "等待 Codex 回复…") {
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
  authGeneration += 1;
  chatRouteGeneration += 1;
  invalidateActivation();
  invalidateWorkspaceBootstrap();
  closeLocalPreview();
  clearSubmitFallbackTimer();
  closeSocket();
  finalizeAssistantStream();
  state.loading = false;
  state.isAuthenticated = false;
  state.ready = true;
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
  request,
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
  getActivationToken: () => sessionRuntime.getActivationToken(),
  getModels: () => availableModels.value,
  getCanInterrupt: () => canInterrupt.value,
  getLoading: () => state.loading,
  getGitDirtyErrorMessage: () => GIT_DIRTY_ERROR_MESSAGE
});

const {
  resetComposerDraftState,
  updateComposerOptions,
  handleComposerOptionsChange,
  syncComposerContext,
  waitForComposerPersistence,
  applyComposerStatePayload,
  applyHistoricalComposerValues,
  syncComposerStateForThread,
  refreshWorkspaceGit,
  addAttachments,
  removeAttachment,
  retryAttachment,
  uploadImageAttachments,
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
  refreshSessions: () => refreshSessions(),
  onSocketUnavailable: (sessionId) => sessionRuntime.recoverLiveSession(sessionId),
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
  pagedCatalog: true,
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
  getActiveProviderId: () => activeProviderId.value,
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
  setSessionCatalogView, loadSessionCatalogGroup, loadMoreSessionCatalog,
  bootstrapWorkspace,
  requestWorkspaceConfig,
  invalidateWorkspaceBootstrap: invalidateCatalogBootstrap,
  hydrateSession,
  refreshSessions,
  startSessionListSyncLoop,
  stopSessionListSyncLoop,
  invalidateActivation,
  getActivationToken,
  isActivationCurrent,
  applyInputResponse,
  stopHistorySyncLoop,
  startHistorySyncLoop,
  syncActiveThreadSession,
  openSessionItem,
  createSessionInGroup,
  ensureLiveSession,
  backToList,
  syncRouteSession
} = sessionRuntime;

function invalidateWorkspaceBootstrap() {
  invalidateCatalogBootstrap();
  state.sessionListViewState = createSessionListViewState();
}

async function backToSessionList() {
  clearSubmitFallbackTimer();
  await backToList();
}

async function openSession(session) {
  if (session.provider === "codex") {
    const id = session.resumeSessionId || session.threadId;
    await router.push({ name: "chat", params: { sessionId: id ? `history:codex:${id}` : session.id } });
    return;
  }
  await openSessionItem(session);
}

async function createCodexSession(group) {
  const cwd = String(group?.cwd || "").trim();
  if (!cwd || state.pendingSessionId) return;
  state.pendingSessionId = `__creating__:${cwd}`;
  const generation = chatRouteGeneration;
  try {
    const { thread } = await request("/api/v2/codex/threads", { method: "POST", body: JSON.stringify({
      cwd, projectId: group.projectId || ""
    }) });
    if (generation !== chatRouteGeneration) return;
    setStatus("");
    await router.push({ name: "chat", params: { sessionId: `history:codex:${thread.id}` } });
  } catch (error) { if (generation === chatRouteGeneration) setStatus(error.message); }
  finally { if (state.pendingSessionId === `__creating__:${cwd}`) state.pendingSessionId = ""; }
}

async function syncCurrentChatRoute() {
  const generation = ++chatRouteGeneration;
  codexThreadId.value = "";
  if (!state.ready || !state.isAuthenticated || route.name !== "chat") {
    await syncRouteSession();
    return;
  }
  const routeId = String(route.params.sessionId || "");
  const history = parseHistoryRouteSessionId(routeId);
  if (history?.provider === "codex") {
    invalidateActivation();
    closeSocket({ silent: true });
    resetLiveView();
    resetThreadView();
    state.routeSessionId = routeId;
    codexThreadId.value = history.resumeSessionId;
    return;
  }
  if (!history && routeId) {
    try {
      const session = state.sessions.find((item) => item.id === routeId) || await requestSessionById(routeId);
      if (generation !== chatRouteGeneration) return;
      if (session?.provider === "codex") {
        let threadId = session.resumeSessionId;
        if (!threadId) {
          const { thread } = await request("/api/v2/codex/threads", { method: "POST", body: JSON.stringify({
            cwd: session.cwd, name: session.name, projectId: session.projectId,
            model: session.model, reasoningEffort: session.reasoningEffort, permissionMode: session.permissionMode
          }) });
          threadId = thread.id;
        }
        if (generation === chatRouteGeneration) await router.replace({ name: "chat", params: { sessionId: `history:codex:${threadId}` } });
        return;
      }
    } catch (error) { if (generation === chatRouteGeneration) setStatus(error.message); return; }
  }
  if (generation === chatRouteGeneration) {
    try {
      await requestWorkspaceConfig();
      if (generation === chatRouteGeneration && state.isAuthenticated) await syncRouteSession();
    } catch (error) {
      if (generation === chatRouteGeneration) setStatus(error.message);
    }
  }
}

function startWorkspaceBootstrap(generation) {
  void bootstrapWorkspace({ includeSessions: route.name !== "chat" }).catch((error) => {
    if (generation === authGeneration && state.isAuthenticated && error !== state.sessionListError) setStatus(error.message);
  });
}

async function handleLogin({ silent = false, auto = false } = {}) {
  const token = state.accessToken.trim();
  const generation = auto ? authGeneration : ++authGeneration;
  invalidateWorkspaceBootstrap();
  try {
    state.loading = true;
    if (!token) {
      throw new Error("请输入 token");
    }

    await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    if (generation !== authGeneration) return null;
    saveTokenPreference(token);
    state.isAuthenticated = true;
    state.ready = true;
    state.accessToken = "";
    setStatus("");
    startWorkspaceBootstrap(generation);
    if (route.name === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
    }
    return { isAuthenticated: true, accessToken: "", rememberToken: state.rememberToken };
  } catch (error) {
    if (generation !== authGeneration) return null;
    if (auto && [401, 403].includes(error?.status)) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
      state.rememberToken = false;
      state.accessToken = "";
      setStatus("已保存的 token 已失效，请重新输入一次。");
      return { isAuthenticated: false, accessToken: "", rememberToken: false };
    }
    if (!silent) {
      setStatus(toFriendlyLoginError(error));
    }
    return { isAuthenticated: false, accessToken: token, rememberToken: state.rememberToken };
  } finally {
    if (generation === authGeneration) state.loading = false;
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

const { submitInput, interruptActiveSession } = createComposerSubmissionController({
  state,
  composerDraft,
  composerOptions,
  getContext: () => ({
    activation: getActivationToken(),
    provider: activeProviderId.value,
    threadId: activeThreadId.value,
    expectedThreadId: expectedThreadId.value,
    liveSessionId: state.liveView.liveSessionId
  }),
  isContextCurrent: (context) => isActivationCurrent(context.activation),
  getCanSend: () => canSend.value,
  waitForComposerPersistence,
  uploadImageAttachments,
  ensureLiveSession,
  attachLiveSocket,
  requestSessionInput,
  requestThreadInput,
  applyInputResponse,
  createUserMessage: (text) => createMessage("user", text, new Date().toISOString(), { source: "draft", partType: "text", payload: {} }),
  setMessages,
  finalizeAssistantStream,
  setStatus,
  syncActiveThreadSession,
  startHistorySyncLoop
});

watch(
  () => route.name,
  async (name) => {
    if (name !== "chat") invalidateActivation();
    if (name !== "sessions") stopSessionListSyncLoop({ abortBootstrap: true });
    if (name === "sessions") {
      closeSocket();
      stopHistorySyncLoop();
      finalizeAssistantStream();
      if (state.isAuthenticated) {
        startSessionListSyncLoop();
        await refreshSessions().catch(() => {});
      }
    }
  }
);

watch(
  () => [activeProviderId.value, activeThreadId.value, expectedThreadId.value],
  () => syncComposerContext(),
  { immediate: true, flush: "sync" }
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
    refreshWorkspaceGit({ silent: true, automatic: true }).catch(() => {});
  },
  { immediate: true }
);

watch(
  () => [state.ready, state.isAuthenticated, route.name, route.params.sessionId],
  async () => {
    await syncCurrentChatRoute();
  },
  { immediate: true }
);

onMounted(async () => {
  appViewport.start();
  const generation = authGeneration;
  const handleAuthExpired = () => {
    forceBackToLogin("登录状态已失效，请重新登录。");
  };
  window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  state.authExpiredHandler = handleAuthExpired;
  const next = await resolveInitialAuthBootstrap({
    savedToken: getSavedToken(),
    autoLoginTried,
    requestAuthSession,
    handleAutoLogin: async (token) => {
      autoLoginTried = true;
      state.accessToken = token;
      return handleLogin({ auto: true });
    },
    isCurrent: () => generation === authGeneration
  });
  if (!next || generation !== authGeneration) return;
  state.accessToken = next.accessToken;
  state.rememberToken = next.rememberToken;
  state.isAuthenticated = next.isAuthenticated;
  autoLoginTried = next.autoLoginTried;
  if (next.statusText) setStatus(next.statusText);
  state.ready = next.ready;
  if (state.isAuthenticated) startWorkspaceBootstrap(generation);
  if (state.isAuthenticated && route.name === "sessions") startSessionListSyncLoop();
});

onBeforeUnmount(() => {
  appViewport.dispose();
  invalidateLocalPreviewPosition();
  authGeneration += 1;
  invalidateWorkspaceBootstrap();
  if (state.authExpiredHandler) {
    window.removeEventListener(AUTH_EXPIRED_EVENT, state.authExpiredHandler);
    state.authExpiredHandler = null;
  }
  stopHistorySyncLoop();
  stopSessionListSyncLoop();
  invalidateActivation();
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
  <div class="app-preview-layout" :class="{ 'has-preview': previewState.open && state.isAuthenticated }">
    <div class="app-content">
  <div class="app-shell">
    <div v-if="!state.ready" class="splash-screen">
      <InterfaceState title="正在读取会话…" detail="Codex Web" />
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
      <section v-if="route.name === 'sessions'" class="mobile-shell session-list-shell">
        <SessionListView
          v-model:search-query="state.sessionSearch"
          :view-state="state.sessionListViewState"
          :get-position-generation="viewLoading.getGeneration"
          :groups="groupedSessions"
          :loaded="state.sessionListReady"
          :complete="state.sessionListComplete"
          :counts="state.sessionListCounts"
          :loading="state.sessionListLoading"
          :load-error="state.sessionListError?.message || String(state.sessionListError || '')"
          :pagination="state.sessionCatalog"
          :active-session-id="state.routeSessionId"
          :pending-session-id="state.pendingSessionId"
          :format-relative-time="formatRelativeTime"
          @open="openSession"
          @create-group-session="createCodexSession"
          @retry="refreshSessions().catch(() => {})"
          @catalog-view="setSessionCatalogView($event)?.catch(() => {})"
          @load-group="({ key, more }) => loadSessionCatalogGroup(key, { more })?.catch(() => {})"
          @load-more="loadMoreSessionCatalog()?.catch(() => {})"
        />

        <div v-if="state.statusText" class="notice-strip">{{ state.statusText }}</div>
      </section>

      <CodexThreadView
        v-else-if="codexThreadId"
        :key="codexThreadId"
        :thread-id="codexThreadId"
        :initial-title="initialCodexSession?.name || initialCodexSession?.displayTitle || ''"
        :initial-cwd="initialCodexSession?.cwd || ''"
        :load-config="requestWorkspaceConfig"
        @back="backToSessionList"
        @status="setStatus"
      />

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
        @refresh-git="refreshWorkspaceGit()"
      />

      <section v-else class="mobile-shell centered-shell">
        <InterfaceState :title="state.statusText || '正在加载会话页面…'" />
      </section>
    </template>
  </div>
    </div>
    <PreviewHost v-if="state.isAuthenticated" />
  </div>
</template>

<style scoped>
.app-preview-layout { position: fixed; left: 0; right: 0; top: var(--app-viewport-top, 0px); height: var(--app-viewport-height, 100dvh); min-height: 0; min-width: 0; overflow: hidden; }
.app-content { height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
.session-list-shell { display: flex; flex-direction: column; overflow: hidden; }
.session-list-shell > .notice-strip { flex: 0 1 auto; min-height: 0; max-height: 40%; overflow-y: auto; overflow-wrap: anywhere; }
@media (min-width: 960px) {
  .app-preview-layout.has-preview { display: grid; grid-template-columns: minmax(400px, .9fr) minmax(480px, 1.1fr); grid-template-rows: minmax(0, 1fr); }
}
</style>
