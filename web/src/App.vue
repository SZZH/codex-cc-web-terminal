<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import ChatView from "./components/ChatView.vue";
import LoginView from "./components/LoginView.vue";
import SessionListView from "./components/SessionListView.vue";
import {
  AUTH_EXPIRED_EVENT,
  request,
  requestAuthSession,
  requestHistoryMessages,
  requestSessionById,
  requestSessionInputStream,
  requestThreadInputStream
} from "./lib/api.js";
import {
  applyConversationDeltaPayload,
  buildTimelineMessages,
  buildTimelineMessagesFromConversation,
  buildConversationStateFromPayload,
  compareConversationContent,
  createConversationState,
  reconcileTimelineWithSnapshotBuffer
} from "./lib/conversation-timeline.js";
import { normalizeServerPayload } from "./lib/normalize-events.js";
import { resolveInitialAuthBootstrap } from "./lib/auth-bootstrap.js";
import {
  buildAuthoritativeThreadSnapshot,
  buildDisplayedThreadSnapshot,
  mergeAuthoritativeThreadSnapshotPatch,
  shouldSyncPersistedThread
} from "./lib/thread-display-state.js";
import {
  PREVIEW_FALLBACK,
  compactLine,
  createMessage,
  fallbackPreviewForSession,
  fallbackTitleForSession,
  filterTerminalNoise,
  formatRelativeTime,
  normalizeHistoryMessages,
  normalizeLine,
  sanitizeAssistantText,
  wait,
  workspaceName
} from "./lib/session-helpers.js";

const composerDraft = ref("");
const router = useRouter();
const route = useRoute();
const historyApiAvailable = ref(null);
const sessionCache = reactive({});
const pendingHydrations = new Map();
const TOKEN_STORAGE_KEY = "codex-web-terminal.saved-token";
let autoLoginTried = false;
let replaySuppressionLines = new Set();
let submitFallbackTimer = null;
let historySyncTimer = null;

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
  sessions: [],
  routeSessionId: "",
  liveView: {
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
  },
  threadView: {
    sessionId: "",
    meta: null,
    threadId: "",
    persistedSnapshot: null,
    authoritativeSnapshot: null,
    openToken: 0
  },
  pendingSessionId: "",
  lastSubmitText: "",
  lastSubmitAt: 0,
  backendHttpOrigin: "",
  backendWsOrigin: "",
  authExpiredHandler: null
});
let syncingRouteOpen = false;

function cacheKey(session) {
  const kind = String(session?.kind || "").trim().toLowerCase();
  return kind === "history" || kind === "thread"
    ? `thread:${session.provider}:${session.resumeSessionId}`
    : `live:${session?.id || "unknown"}`;
}

function resetLiveView() {
  state.liveView.sessionId = "";
  state.liveView.liveSessionId = "";
  state.liveView.sessionMeta = null;
  state.liveView.messages = [];
  state.liveView.conversation = createConversationState();
  state.liveView.liveOverlay = null;
  state.liveView.hasConversationSnapshot = false;
  state.liveView.hasConversationDelta = false;
  state.liveView.backgroundAgents = [];
  state.liveView.socket = null;
  state.liveView.activeInputStream = false;
  state.liveView.interruptInFlight = false;
  state.liveView.muteSocketLifecycleStatus = false;
  state.liveView.streamBuffer = "";
  state.liveView.replayGuardActive = false;
  state.liveView.replayGuardPrompt = "";
  state.liveView.replayGuardUntil = 0;
}

function resetThreadView() {
  state.threadView.sessionId = "";
  state.threadView.meta = null;
  state.threadView.threadId = "";
  state.threadView.persistedSnapshot = null;
  state.threadView.authoritativeSnapshot = null;
}

function parseHistoryRouteSessionId(value) {
  const text = String(value || "").trim();
  const match = text.match(/^history:([^:]+):(.+)$/i);
  if (!match) {
    return null;
  }
  const provider = String(match[1] || "").trim().toLowerCase();
  const resumeSessionId = String(match[2] || "").trim();
  if (!provider || !resumeSessionId) {
    return null;
  }
  return { provider, resumeSessionId };
}

function decorateSession(session) {
  const cache = sessionCache[cacheKey(session)] || {};
  return {
    ...session,
    displayTitle: cache.title || String(session?.name || "").trim() || fallbackTitleForSession(session),
    displayPreview: cache.preview || fallbackPreviewForSession(session),
    groupName: workspaceName(session.cwd)
  };
}

function syncThreadViewFromInteraction() {
  // liveOverlay should be cleared only by authoritative socket/state updates.
}

function getPreferredThreadSnapshot() {
  return state.threadView.authoritativeSnapshot || state.threadView.persistedSnapshot || null;
}

function clearAuthoritativeThreadSnapshot() {
  state.threadView.authoritativeSnapshot = null;
}

const groupedSessions = computed(() => {
  const sessionSorter = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt));
  const groups = new Map();
  for (const session of state.sessions.map(decorateSession)) {
    if (String(session?.sessionType || "").trim().toLowerCase() === "subagent") {
      continue;
    }
    if (!groups.has(session.groupName)) {
      groups.set(session.groupName, []);
    }
    groups.get(session.groupName).push(session);
  }

  return [...groups.entries()]
    .map(([name, sessions]) => ({
      name,
      cwd: sessions[0]?.cwd || "",
      sessions: [...sessions].sort(sessionSorter)
    }))
    .sort((left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(String(left.sessions[0]?.updatedAt || ""))
    );
});

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
const activeThreadId = computed(() => {
  return routeThreadId.value || state.threadView.threadId || interactiveThreadId.value;
});
const displayedSessionMeta = computed(() => {
  const preferredThreadSnapshot = getPreferredThreadSnapshot();
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
    includeLiveConversation: !preferAuthoritativeSnapshot,
    includeRuntimeDraft: true
  });
});
const displayedLiveOverlay = computed(() => {
  return state.liveView.liveOverlay;
});
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
const activeAssistantName = computed(() => displayedSessionMeta.value?.providerLabel || "Codex");
const threadMismatch = computed(() => {
  if (!expectedThreadId.value) {
    return false;
  }
  if (!activeThreadId.value) {
    return false;
  }
  return expectedThreadId.value !== activeThreadId.value;
});
const canSend = computed(() => Boolean(composerDraft.value.trim()) && !state.loading && Boolean(activeThreadId.value || displayedSessionMeta.value));
const canRenderChatView = computed(() => {
  if (route.name !== "chat") {
    return false;
  }
  return Boolean(displayedSessionMeta.value || displayedThreadSnapshot.value);
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
  if (String(state.liveView.streamBuffer || "").trim()) {
    return true;
  }
  const lastMessage = state.liveView.messages[state.liveView.messages.length - 1];
  return Boolean(lastMessage?.role === "assistant" && lastMessage?.streaming);
});

function setStatus(message = "") {
  state.statusText = message;
}

async function requestConversationSnapshotBySessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return null;
  }
  return request(`/api/sessions/${encodeURIComponent(id)}/conversation`);
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
  composerDraft.value = "";
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
  syncThreadViewFromInteraction();
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
  state.threadView.threadId = String(
    snapshot?.threadId || state.threadView.authoritativeSnapshot?.threadId || ""
  ).trim();
  syncThreadViewFromInteraction();
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
  syncThreadViewFromInteraction();
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
function buildSubmissionText(text) {
  const fragments = [];
  const trimmedText = String(text || "").trim();
  if (trimmedText) {
    fragments.push(trimmedText);
  }
  return fragments.join("\n\n").trim();
}

function bumpActiveSessionOpenToken() {
  if (state.liveView.liveSessionId) {
    state.liveView.openToken += 1;
    return;
  }
  state.threadView.openToken += 1;
}

function rebuildReplaySuppressionLines(messages) {
  replaySuppressionLines = new Set();
  for (const message of messages || []) {
    const lines = String(message?.text || "")
      .split("\n")
      .map((line) => compactLine(line))
      .filter(Boolean);
    for (const line of lines) {
      replaySuppressionLines.add(line);
    }
  }
}

function pruneLiveBootstrapNoise(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const filtered = lines.filter((line) => {
    const compact = compactLine(line);
    if (!compact) {
      return false;
    }
    if (LIVE_BOOTSTRAP_LINE_PATTERNS.some((pattern) => pattern.test(compact))) {
      return false;
    }
    if (/[\u2500-\u257f]/.test(compact) && compact.length < 120) {
      return false;
    }
    if (/[\[\];?]m/.test(compact) || /\?25h/.test(compact)) {
      return false;
    }
    if (replaySuppressionLines.has(compact)) {
      return false;
    }
    return true;
  });

  return filtered.join("\n").trim();
}

function pruneMessagePartNoise(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const filtered = lines.filter((line) => {
    const compact = compactLine(line);
    if (!compact) {
      return false;
    }
    if (/^[\u2500-\u257f\s]+$/.test(compact)) {
      return false;
    }
    if (
      /openai codex|^model:|^directory:|new try the codex app|\/feedback|conversation interrupted|esc to interrupt/i.test(
        compact
      )
    ) {
      return false;
    }
    return true;
  });

  return filtered.join("\n").trim();
}

function finalizeAssistantStream() {
  if (!state.liveView.streamBuffer) {
    return;
  }
  const messages = [...state.liveView.messages];
  const last = messages[messages.length - 1];
  if (last?.streaming) {
    last.streaming = false;
    last.text = sanitizeAssistantText(normalizeLine(last.text));
    if (!last.text) {
      messages.pop();
    }
    setMessages(messages);
  }
  state.liveView.streamBuffer = "";
}

function discardPendingAssistantStream() {
  state.liveView.streamBuffer = "";
  const messages = [...state.liveView.messages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.streaming) {
    messages.pop();
    setMessages(messages);
  }
}

function appendAssistantChunk(chunk, { source = "normalized" } = {}) {
  clearSubmitFallbackTimer();
  const now = Date.now();
  if (state.replayGuardActive && now >= state.replayGuardUntil) {
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
  }

  let normalized = "";
  if (source === "message_part") {
    normalized = pruneMessagePartNoise(normalizeLine(chunk || ""));
  } else {
    // 旧 `data` 通道保留原有清洗，兼容历史行为。
    normalized = pruneLiveBootstrapNoise(filterTerminalNoise(chunk || ""));
  }
  if (!normalized) {
    return;
  }

  if (state.replayGuardActive) {
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
  }

  const systemFailure = detectSystemFailureText(normalized);
  if (systemFailure) {
    discardPendingAssistantStream();
    setStatus(systemFailure);
    return;
  }

  if (state.statusText === "等待 Codex 回复…") {
    setStatus("");
  }

  const previousBuffer = normalizeLine(state.liveView.streamBuffer || "");
  if (!previousBuffer) {
    state.liveView.streamBuffer = normalized;
  } else if (normalized === previousBuffer) {
    state.liveView.streamBuffer = previousBuffer;
  } else if (normalized.startsWith(previousBuffer)) {
    // Some providers resend the whole current draft instead of a pure delta.
    state.liveView.streamBuffer = normalized;
  } else if (previousBuffer.startsWith(normalized) && normalized.length >= 24) {
    // Ignore shorter stale snapshots that would make the visible reply jump backwards.
    state.liveView.streamBuffer = previousBuffer;
  } else {
    state.liveView.streamBuffer = `${state.liveView.streamBuffer}${normalized}`;
  }
  let mergedText = sanitizeAssistantText(normalizeLine(state.liveView.streamBuffer));
  const lastUserMessage = [...state.liveView.messages].reverse().find((message) => message.role === "user")?.text || "";
  if (lastUserMessage && mergedText.startsWith(lastUserMessage)) {
    const tail = mergedText.slice(lastUserMessage.length).trim();
    if (!tail || /^[>›)\]}\-_=:.~|/\\\dA-Za-z]{1,24}$/.test(tail)) {
      mergedText = "";
      state.liveView.streamBuffer = "";
    }
  }
  if (!mergedText || isDisposableAssistantFragment(mergedText)) {
    if (isDisposableAssistantFragment(mergedText)) {
      discardPendingAssistantStream();
    }
    return;
  }

  const messages = [...state.liveView.messages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.streaming) {
    last.text = mergedText;
  } else {
    messages.push(
      createMessage("assistant", mergedText, new Date().toISOString(), {
        streaming: true,
        source: "live"
      })
    );
  }
  setMessages(messages);
}

function appendNormalizedParts(parts = []) {
  clearSubmitFallbackTimer();
  if (!Array.isArray(parts) || parts.length === 0) {
    return;
  }

  let messages = [...state.liveView.messages];
  let touched = false;
  let hasStreamingUpdate = false;

  for (const part of parts) {
    const partType = String(part?.partType || "").trim();
    const role = part?.role === "user" ? "user" : part?.role === "assistant" ? "assistant" : "system";
    const ts = part?.ts || new Date().toISOString();
    const phase = String(part?.phase || "final");
    const payload = part?.payload || {};

    if (partType === "markdown" || partType === "text") {
      const text = sanitizeAssistantText(normalizeLine(String(payload.text || "")));
      if (!text) {
        continue;
      }
      if (role === "assistant" && phase === "streaming") {
        appendAssistantChunk(text, { source: part?.source || "normalized" });
        touched = true;
        hasStreamingUpdate = true;
        continue;
      }
      if (role === "assistant") {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "assistant" && lastMessage?.streaming) {
          lastMessage.text = text;
          lastMessage.streaming = false;
          touched = true;
          continue;
        }
        if (lastMessage?.role === "assistant" && normalizeLine(String(lastMessage.text || "")) === text) {
          continue;
        }
      }
      messages.push(
        createMessage(role, text, ts, {
          source: part?.source || "normalized",
          partType,
          payload,
          rawType: part?.rawType || ""
        })
      );
      touched = true;
      continue;
    }

    if (partType === "tool" || partType === "subagent" || partType === "reference" || partType === "event") {
      const summary = sanitizeAssistantText(
        normalizeLine(
          String(payload.summary || payload.text || payload.message || "").trim() ||
            String(payload.rawType || partType)
        )
      );
      if (!summary) {
        continue;
      }
      finalizeAssistantStream();
      messages.push(
        createMessage(role === "system" ? "system" : "assistant", summary, ts, {
          source: part?.source || "normalized",
          partType,
          payload,
          rawType: part?.rawType || String(payload.rawType || "")
        })
      );
      touched = true;
      continue;
    }

    if (partType === "image") {
      const url = String(payload.url || "").trim();
      if (!url) {
        continue;
      }
      const alt = String(payload.alt || "image").trim() || "image";
      finalizeAssistantStream();
      messages.push(
        createMessage(role, `![${alt}](${url})`, ts, {
          source: part?.source || "normalized",
          partType: "image",
          payload: { url, alt },
          rawType: part?.rawType || ""
        })
      );
      touched = true;
      continue;
    }

    if (partType === "error") {
      const errorText = sanitizeAssistantText(
        normalizeLine(String(payload.message || payload.text || "系统事件，请稍后重试。"))
      );
      if (!errorText) {
        continue;
      }
      messages.push(
        createMessage("system", errorText, ts, {
          source: part?.source || "normalized",
          partType,
          payload,
          rawType: part?.rawType || ""
        })
      );
      touched = true;
    }
  }

  if (touched) {
    // Streaming chunks mutate `liveView.messages` in appendAssistantChunk.
    // If we always overwrite with the stale local `messages`, live text disappears until refresh.
    if (hasStreamingUpdate) {
      messages = [...state.liveView.messages];
    }
    setMessages(messages);
  }
}

function clearPendingReplyStatus() {
  if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
    setStatus("");
  }
}

function isTerminalTurnStatus(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "completed" || normalized === "failed" || normalized === "aborted" || normalized === "interrupted";
}

function settleAuthoritativeInputState() {
  state.liveView.activeInputStream = false;
  state.liveView.interruptInFlight = false;
  state.loading = false;
  clearPendingReplyStatus();
}

async function hydrateSession(session, { includeMessages = false, silent = false, forceRefresh = false } = {}) {
  if (!session || session.kind === "live" || !session.resumeSessionId) {
    return null;
  }

  const key = cacheKey(session);
  const cached = sessionCache[key];
  if (!forceRefresh && cached?.hydrated && (!includeMessages || cached.messages)) {
    return cached;
  }

  if (pendingHydrations.has(key)) {
    if (!includeMessages && !forceRefresh) {
      return cached || null;
    }
    while (pendingHydrations.has(key)) {
      await wait(80);
    }
    return sessionCache[key] || null;
  }

  const task = (async () => {
    const payload = await requestHistoryMessages(session, historyApiAvailable);
    if (!payload) {
      const nextValue = {
        hydrated: true,
        title: String(session?.name || fallbackTitleForSession(session)).trim() || fallbackTitleForSession(session),
        preview: String(session?.inputPreview || fallbackPreviewForSession(session)).trim() || fallbackPreviewForSession(session),
        messages: [],
        turns: [],
        backgroundAgents: [],
        conversation: createConversationState({
          threadId: String(session?.resumeSessionId || "")
        }),
        threadSnapshot: null,
        liveOverlay: null,
        session: null
      };
      sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
      return sessionCache[key];
    }

    const messages = normalizeHistoryMessages(payload.messages || []);
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const backgroundAgents = Array.isArray(payload.backgroundAgents) ? payload.backgroundAgents : [];
    const conversation = buildConversationStateFromPayload(payload, {
      threadId: String(session?.resumeSessionId || ""),
      turns,
      backgroundAgents
    });
    const title = String(payload.session?.name || session.name || fallbackTitleForSession(session)).trim() || fallbackTitleForSession(session);
    const preview = String(payload.session?.inputPreview || session.inputPreview || fallbackPreviewForSession(session)).trim() || fallbackPreviewForSession(session);
    const nextValue = {
      hydrated: true,
      title,
      preview,
      messages,
      turns,
      backgroundAgents,
      conversation,
      threadSnapshot: payload.threadSnapshot || null,
      liveOverlay: payload.liveOverlay || null,
      session: payload.session || null
    };
    sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
    return sessionCache[key];
  })();

  pendingHydrations.set(key, task);
  try {
    return await task;
  } catch (error) {
    if (!silent) {
      setStatus(error.message || String(error));
    }
    return sessionCache[key] || null;
  } finally {
    pendingHydrations.delete(key);
  }
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  const sessions = payload.sessions || [];
  for (const session of sessions) {
    const key = cacheKey(session);
    const title = String(session?.name || "").trim();
    if (!title) {
      continue;
    }
    sessionCache[key] = {
      ...(sessionCache[key] || {}),
      title
    };
  }
  state.sessions = sessions;
}

function stopHistorySyncLoop() {
  if (historySyncTimer) {
    window.clearInterval(historySyncTimer);
    historySyncTimer = null;
  }
}

function currentThreadSyncTarget() {
  if (
    !shouldSyncPersistedThread({
      routeThreadId: routeThreadId.value,
      threadMeta: state.threadView.meta,
      liveSessionId: state.liveView.liveSessionId,
      liveSessionMeta: state.liveView.sessionMeta,
      hasAuthoritativeLiveData: Boolean(state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta)
    })
  ) {
    return null;
  }
  const routeTarget = routeHistoryTarget.value;
  if (routeTarget) {
    return {
      id: `thread:${routeTarget.provider}:${routeTarget.resumeSessionId}`,
      kind: "thread",
      status: "saved",
      provider: routeTarget.provider,
      resumeSessionId: routeTarget.resumeSessionId,
      name: state.threadView.meta?.name || "会话",
      cwd: state.threadView.meta?.cwd || ""
    };
  }
  if (state.threadView.meta?.resumeSessionId) {
    return state.threadView.meta;
  }
  return null;
}

async function syncActiveThreadSession({ silent = true } = {}) {
  const target = currentThreadSyncTarget();
  if (!target?.resumeSessionId) {
    return false;
  }

  const hydrated = await hydrateSession(target, {
    includeMessages: true,
    forceRefresh: true,
    silent
  });
  if (!hydrated) {
    return false;
  }

  const nextThreadSnapshot = hydrated.threadSnapshot || null;
  const applied = JSON.stringify(state.threadView.persistedSnapshot || null) !== JSON.stringify(nextThreadSnapshot || null);
  if (applied) {
    setThreadSnapshot(nextThreadSnapshot);
  }
  if (state.threadView.meta && target.resumeSessionId === state.threadView.meta.resumeSessionId) {
    state.threadView.meta = {
      ...state.threadView.meta,
      displayTitle: hydrated.title || state.threadView.meta.displayTitle,
      displayPreview: hydrated.preview || state.threadView.meta.displayPreview,
      cwd: hydrated?.session?.cwd || state.threadView.meta.cwd || ""
    };
  }
  return applied;
}

function startHistorySyncLoop() {
  stopHistorySyncLoop();
  if (typeof window === "undefined") {
    return;
  }
  historySyncTimer = window.setInterval(() => {
    if (!state.ready || !state.isAuthenticated || route.name !== "chat") {
      return;
    }
    if (!currentThreadSyncTarget()) {
      return;
    }
    syncActiveThreadSession({ silent: true }).catch(() => {});
  }, 4000);
}

function toOriginProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "https:" : "http:";
}

function toWsProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "wss:" : "ws:";
}

function normalizeBackendHost(rawHost) {
  const host = String(rawHost || "").trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    return window.location.hostname || "localhost";
  }
  if (host === "::1") {
    return "localhost";
  }
  return host;
}

function applyBackendConfig(payload) {
  const host = normalizeBackendHost(payload?.host);
  const port = Number(payload?.port || 0);
  if (!host || !port) {
    return;
  }
  const httpProtocol = toOriginProtocol(window.location.protocol);
  const wsProtocol = toWsProtocol(window.location.protocol);
  state.backendHttpOrigin = `${httpProtocol}//${host}:${port}`;
  state.backendWsOrigin = `${wsProtocol}//${host}:${port}`;
}

function resolveWsUrl(sessionId) {
  const wsBase = String(state.backendWsOrigin || "").trim();
  if (wsBase) {
    return `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }
  const protocol = toWsProtocol(window.location.protocol);
  return `${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

async function bootstrapWorkspace({ includeSessions = true } = {}) {
  const configPayload = await request("/api/config");
  applyBackendConfig(configPayload);
  if (includeSessions) {
    await refreshSessions();
  }
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
  if (payload.type === "thread.snapshot") {
    stopHistorySyncLoop();
    const conversationPatch = buildConversationStateFromPayload(
      {
        conversation: payload?.conversation || {},
        sessionId: payload?.sessionId || "",
        threadId: payload?.threadId || "",
        threadSnapshot: payload?.snapshot || null,
        liveOverlay: payload?.liveOverlay || null,
        timestamp: payload?.timestamp || ""
      },
      state.liveView.conversation
    );
    const nextConversation = payload?.partial
      ? mergeConversationPatch(state.liveView.conversation, conversationPatch)
      : conversationPatch;
    const applied = setConversation(nextConversation, {
      fallbackMessages: collectConversationFallbackMessages(state.liveView.messages)
    });
    setLiveThreadSnapshot(
      resolveAuthoritativeLiveThreadSnapshot({
        threadSnapshot: payload?.snapshot || null,
        conversation: nextConversation,
        fallbackThreadId: payload?.threadId || activeThreadId.value
      }),
      payload?.liveOverlay || null,
      { partial: Boolean(payload?.partial) }
    );
    if (applied || payload?.snapshot || payload?.liveOverlay) {
      state.liveView.hasConversationSnapshot = true;
      state.liveView.hasConversationDelta = true;
    }
    const trackedTurnId = String(payload?.turnId || nextConversation?.activeTurnId || "").trim();
    const authoritativeTurn =
      (Array.isArray(nextConversation?.turns) ? nextConversation.turns : []).find(
        (turn) => String(turn?.id || "").trim() === trackedTurnId
      ) || null;
    const authoritativeAssistantStatus = String(authoritativeTurn?.assistant?.status || "").trim().toLowerCase();
    if (isTerminalTurnStatus(payload?.status) || isTerminalTurnStatus(authoritativeAssistantStatus)) {
      settleAuthoritativeInputState();
    }
    return;
  }

  if (payload.type === "thread.overlay") {
    stopHistorySyncLoop();
    setLiveOverlay(payload);
    state.liveView.hasConversationSnapshot = true;
    state.liveView.hasConversationDelta = true;
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    const normalizedParts = parts
      .map((part) => {
        if (String(part?.type || "").trim().toLowerCase() !== "text") {
          return null;
        }
        return {
          role: payload?.role === "user" ? "user" : "assistant",
          partType: "markdown",
          payload: {
            text: String(part?.text || "")
          },
          ts: payload?.timestamp || new Date().toISOString(),
          phase: payload?.phase || "streaming",
          source: "message_part",
          rawType: "message_part"
        };
      })
      .filter(Boolean);
    appendNormalizedParts(normalizedParts);
    return;
  }

  if (payload.type === "session.updated") {
    const updatedPayload = {
      type: "session_updated",
      session: payload.session || null
    };
    handleLivePayload(updatedPayload);
    return;
  }

  if (payload.type === "transport.error") {
    const errorText = String(payload.error || "会话发生未知错误。").trim();
    clearPendingReplyStatus();
    appendNormalizedParts([
      {
        role: "system",
        partType: "text",
        payload: { text: errorText },
        ts: new Date().toISOString(),
        phase: "final",
        source: "transport.error",
        rawType: "error"
      }
    ]);
    setStatus(errorText);
    return;
  }

  if (payload.type === "conversation.snapshot") {
    const nextConversation = buildConversationStateFromPayload(payload, state.liveView.conversation);
    const applied = setConversation(nextConversation, {
      fallbackMessages: collectConversationFallbackMessages(state.liveView.messages),
      buffer: payload?.buffer || ""
    });
    setLiveThreadSnapshot(
      resolveAuthoritativeLiveThreadSnapshot({
        threadSnapshot: payload?.threadSnapshot || null,
        conversation: nextConversation,
        fallbackThreadId: payload?.threadId || activeThreadId.value
      }),
      payload?.liveOverlay || null
    );
    if (applied) {
      state.liveView.hasConversationSnapshot = true;
    }
    return;
  }

  if (payload.type === "conversation.delta") {
    clearPendingReplyStatus();
    const applied = applyConversationDeltaPayload(state.liveView.conversation, payload);
    const updated = setConversation(applied.conversation, {
      fallbackMessages: collectConversationFallbackMessages(state.liveView.messages)
    });
    setLiveThreadSnapshot(
      resolveAuthoritativeLiveThreadSnapshot({
        threadSnapshot: resolvePayloadValue(payload, "threadSnapshot", null),
        conversation: applied.conversation,
        fallbackThreadId: payload?.threadId || activeThreadId.value
      }),
      resolvePayloadValue(payload, "liveOverlay", state.liveView.liveOverlay)
    );
    if (updated) {
      state.liveView.hasConversationSnapshot = true;
      state.liveView.hasConversationDelta = true;
    }
    return;
  }

  if (payload.type === "snapshot") {
    if (state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta) {
      return;
    }
    const nextConversation = buildConversationStateFromPayload(payload, state.liveView.conversation);
    const applied = setConversation(nextConversation, {
      fallbackMessages: state.liveView.messages,
      buffer: payload?.buffer || ""
    });
    setLiveThreadSnapshot(
      resolveAuthoritativeLiveThreadSnapshot({
        threadSnapshot: payload?.threadSnapshot || null,
        conversation: nextConversation,
        fallbackThreadId: payload?.threadId || activeThreadId.value
      }),
      payload?.liveOverlay || null
    );
    if (applied) {
      state.liveView.hasConversationSnapshot = true;
    }
    return;
  }

  if (payload.type === "conversation_snapshot") {
    if (state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta) {
      return;
    }
    const nextConversation = buildConversationStateFromPayload(payload, state.liveView.conversation);
    const applied = setConversation(nextConversation, {
      fallbackMessages: state.liveView.messages
    });
    setLiveThreadSnapshot(
      resolveAuthoritativeLiveThreadSnapshot({
        threadSnapshot: payload?.threadSnapshot || null,
        conversation: nextConversation,
        fallbackThreadId: payload?.threadId || activeThreadId.value
      }),
      payload?.liveOverlay || null
    );
    if (applied) {
      state.liveView.hasConversationSnapshot = true;
    }
    return;
  }

  if (payload.type === "session_updated" && payload.session) {
    const updated = decorateSession(payload.session);
    state.liveView.sessionMeta = updated;
    if (state.liveView.sessionId === updated.id) {
      state.liveView.liveSessionId = updated.id;
    }
    if (state.threadView.threadId && String(updated.resumeSessionId || "").trim() === state.threadView.threadId) {
      state.threadView.meta = {
        ...(state.threadView.meta || {}),
        ...updated,
        kind: "thread",
        id: state.threadView.sessionId || `history:${updated.provider}:${updated.resumeSessionId}`
      };
    }
    const index = state.sessions.findIndex((item) => item.id === updated.id);
    if (index >= 0) {
      const next = [...state.sessions];
      next[index] = updated;
      state.sessions = next;
    }
    return;
  }

  if (payload.type === "data") {
    if (state.liveView.hasConversationDelta) {
      return;
    }
    if (payload.data && String(payload.data).trim()) {
      clearPendingReplyStatus();
    }
    appendNormalizedParts(normalizeServerPayload(payload, state.liveView.sessionId));
    return;
  }

  if (payload.type === "message_part") {
    if (state.liveView.hasConversationDelta) {
      return;
    }
    if (payload?.part?.type === "text" && String(payload?.part?.text || "").trim()) {
      clearPendingReplyStatus();
    }
    appendNormalizedParts(normalizeServerPayload(payload, state.liveView.sessionId));
    return;
  }

  if (payload.type === "event_msg") {
    if (state.liveView.hasConversationDelta) {
      return;
    }
    appendNormalizedParts(normalizeServerPayload(payload, state.liveView.sessionId));
    return;
  }

  if (payload.type === "response_item") {
    if (state.liveView.hasConversationDelta) {
      return;
    }
    appendNormalizedParts(normalizeServerPayload(payload, state.liveView.sessionId));
    return;
  }

  if (payload.type === "error") {
    const errorText = String(payload.error || "会话发生未知错误。").trim();
    clearPendingReplyStatus();
    appendNormalizedParts([
      {
        role: "system",
        partType: "text",
        payload: { text: errorText },
        ts: new Date().toISOString(),
        phase: "final",
        source: "ws_error",
        rawType: "error"
      }
    ]);
    setStatus(errorText);
    return;
  }

  if (payload.type === "exit") {
    finalizeAssistantStream();
    const exitCode = Number(payload.exitCode ?? 0);
    if (state.statusText === "已发送中断指令。") {
      setStatus("当前流程已中断。");
      return;
    }
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus(exitCode === 0 ? "本轮回复已结束。" : `Codex 会话异常退出（${exitCode}），请重试一次。`);
      return;
    }
    if (exitCode !== 0) {
      setStatus(`Codex 会话异常退出（${exitCode}），请重试一次。`);
    }
  }
}

function attachLiveSocket(sessionId) {
  closeSocket({ silent: true });
  finalizeAssistantStream();
  state.liveView.liveSessionId = sessionId;
  state.liveView.streamBuffer = "";
  state.liveView.hasConversationSnapshot = false;
  state.liveView.hasConversationDelta = false;
  state.liveView.muteSocketLifecycleStatus = false;
  const socket = new WebSocket(resolveWsUrl(sessionId));
  state.liveView.socket = socket;

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleLivePayload(payload);
  });

  socket.addEventListener("close", () => {
    const silentClose = state.liveView.muteSocketLifecycleStatus;
    state.liveView.muteSocketLifecycleStatus = false;
    if (state.liveView.socket === socket) {
      state.liveView.socket = null;
    }
    finalizeAssistantStream();
    if (silentClose) {
      return;
    }
    if (state.statusText === "已发送中断指令。") {
      setStatus("当前流程已中断。");
      return;
    }
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("会话连接已关闭，请重试一次。");
    }
  });

  socket.addEventListener("error", () => {
    if (state.liveView.muteSocketLifecycleStatus) {
      return;
    }
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("会话连接失败，请重试一次。");
    }
  });

  return waitForSocketOpen(socket);
}

async function openLiveSession(session, { skipRoute = false } = {}) {
  stopHistorySyncLoop();
  state.pendingSessionId = session.id;
  setStatus("正在连接会话…");
  state.routeSessionId = session.id;
  const decorated = decorateSession(session);
  state.liveView.sessionId = session.id;
  state.liveView.sessionMeta = decorated;
  if (session.resumeSessionId) {
    clearAuthoritativeThreadSnapshot();
    state.threadView.threadId = String(session.resumeSessionId || "").trim();
    state.threadView.meta = {
      ...decorated,
      kind: "thread",
      id: `history:${session.provider}:${session.resumeSessionId}`
    };
    state.threadView.sessionId = `history:${session.provider}:${session.resumeSessionId}`;
  } else {
    resetThreadView();
    setThreadSnapshot(null);
  }
  state.liveView.openToken += 1;
  if (!skipRoute && (route.name !== "chat" || String(route.params.sessionId || "").trim() !== session.id)) {
    await router.push({ name: "chat", params: { sessionId: session.id } });
  }
  composerDraft.value = "";
  state.liveView.replayGuardActive = false;
  state.liveView.replayGuardPrompt = "";
  state.liveView.replayGuardUntil = 0;
  // Refresh auth/config before WebSocket connect to avoid stale cookie + fresh process mismatch.
  await bootstrapWorkspace({ includeSessions: false });
  let historyTurns = [];
  let historyAgents = [];
  let historyThreadSnapshot = null;
  let historyLiveOverlay = null;
  let historyConversation = createConversationState({
    sessionId: session.id,
    threadId: String(session.resumeSessionId || "")
  });
  if (session.resumeSessionId) {
    const hydrated = await hydrateSession(
      {
        ...session,
        id: `thread:${session.provider}:${session.resumeSessionId}`,
        kind: "thread",
        status: "saved"
      },
      { includeMessages: true, silent: true, forceRefresh: true }
    );
    historyTurns = hydrated?.turns || [];
    historyAgents = hydrated?.backgroundAgents || [];
    historyConversation = buildConversationStateFromPayload(hydrated?.conversation || {}, {
      sessionId: session.id,
      threadId: String(session.resumeSessionId || ""),
      turns: historyTurns,
      backgroundAgents: historyAgents
    });
    historyThreadSnapshot = hydrated?.threadSnapshot || null;
    historyLiveOverlay = hydrated?.liveOverlay || null;
    if (hydrated?.session) {
      state.liveView.sessionMeta = {
        ...state.liveView.sessionMeta,
        displayTitle: hydrated.title || state.liveView.sessionMeta.displayTitle,
        displayPreview: hydrated.preview || state.liveView.sessionMeta.displayPreview,
        cwd: hydrated.session.cwd || state.liveView.sessionMeta.cwd || ""
      };
    }
  }
  setConversation(historyConversation, {
    force: true
  });
  setThreadSnapshot(historyThreadSnapshot);
  setLiveOverlay(historyLiveOverlay);
  await attachLiveSocket(session.id);
  setStatus("");
  state.pendingSessionId = "";
}

async function openThreadSession(session, { skipRoute = false } = {}) {
  stopHistorySyncLoop();
  state.pendingSessionId = session.id;
  setStatus("正在加载会话…");
  const decorated = decorateSession(session);
  const hydrated = await hydrateSession(session, { includeMessages: true, forceRefresh: true });
  let historyThreadSnapshot = hydrated?.threadSnapshot || null;
  const targetThreadId = String(session.resumeSessionId || "").trim();
  const keepInteractiveState = targetThreadId && interactiveThreadId.value === targetThreadId;

  if (!keepInteractiveState) {
    closeSocket();
    finalizeAssistantStream();
    resetLiveView();
    clearAuthoritativeThreadSnapshot();
  }

  state.routeSessionId = session.id;
  state.threadView.sessionId = session.id;
  state.threadView.threadId = targetThreadId;
  state.threadView.meta = {
    ...decorated,
    kind: "thread",
    cwd: hydrated?.session?.cwd || decorated.cwd || "",
    displayTitle: hydrated?.title || decorated.displayTitle,
    displayPreview: hydrated?.preview || decorated.displayPreview
  };
  state.threadView.openToken += 1;
  if (!skipRoute && (route.name !== "chat" || String(route.params.sessionId || "").trim() !== session.id)) {
    await router.push({ name: "chat", params: { sessionId: session.id } });
  }
  composerDraft.value = "";
  setThreadSnapshot(historyThreadSnapshot);
  if (!keepInteractiveState) {
    startHistorySyncLoop();
    setLiveOverlay(null);
  }
  setStatus("");
  state.pendingSessionId = "";
}

async function openSessionItem(session, { skipRoute = false } = {}) {
  try {
    if (session?.resumeSessionId) {
      await openThreadSession(
        {
          ...decorateSession(session),
          id: `history:${session.provider}:${session.resumeSessionId}`,
          kind: "thread",
          status: session.status || "saved"
        },
        { skipRoute }
      );
      return;
    }
    await openLiveSession(session, { skipRoute });
  } catch (error) {
    if (session.kind === "live" && session.resumeSessionId) {
      try {
      await openThreadSession({
          ...session,
          id: `history:${session.provider}:${session.resumeSessionId}`,
          kind: "thread",
          status: "saved"
        }, { skipRoute });
        setStatus("已切换到该会话的历史记录。");
        return;
      } catch {
        // Fall through to the original error below.
      }
    }
    state.pendingSessionId = "";
    setStatus(error.message || String(error));
  }
}

async function createSessionInGroup(group) {
  const cwd = String(group?.cwd || "").trim();
  if (!cwd) {
    setStatus("该分组目录不可用，无法新增会话。");
    return;
  }

  try {
    state.pendingSessionId = "__creating__";
    setStatus("正在创建会话…");
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        provider: "codex",
        cwd
      })
    });
    await refreshSessions();
    if (payload?.session) {
      await openSessionItem(payload.session);
      return;
    }
    setStatus("会话已创建，请手动打开。");
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    if (state.pendingSessionId === "__creating__") {
      state.pendingSessionId = "";
    }
  }
}

async function ensureLiveSession() {
  if (state.liveView.liveSessionId) {
    return state.liveView.liveSessionId;
  }
  if (!state.liveView.sessionMeta) {
    const preferredThreadSnapshot = getPreferredThreadSnapshot();
    const continuationSeed =
      state.threadView.meta ||
      (routeHistoryTarget.value
        ? {
            id: `history:${routeHistoryTarget.value.provider}:${routeHistoryTarget.value.resumeSessionId}`,
            kind: "thread",
            provider: routeHistoryTarget.value.provider,
            providerLabel: "Codex",
            resumeSessionId: routeHistoryTarget.value.resumeSessionId,
            cwd: preferredThreadSnapshot?.metadata?.cwd || "",
            displayTitle:
              String(preferredThreadSnapshot?.metadata?.name || "").trim() || "会话",
            displayPreview: String(preferredThreadSnapshot?.metadata?.preview || "").trim() || ""
          }
        : null);
    if (continuationSeed?.resumeSessionId) {
      state.liveView.sessionMeta = {
        ...continuationSeed,
        kind: "thread"
      };
    }
  }
  if (!state.liveView.sessionMeta) {
    throw new Error("当前没有可继续的会话");
  }
  if (state.liveView.sessionMeta.kind === "live") {
    state.liveView.sessionId = state.liveView.sessionMeta.id;
    state.liveView.liveSessionId = state.liveView.sessionMeta.id;
    return state.liveView.sessionMeta.id;
  }

  const resumeSessionId = String(state.liveView.sessionMeta.resumeSessionId || "").trim();
  const provider = String(state.liveView.sessionMeta.provider || "").trim().toLowerCase();
  if (resumeSessionId && provider) {
    const reusable = state.sessions
      .filter(
        (session) =>
          session.kind === "live" &&
          session.status !== "exited" &&
          String(session.provider || "").trim().toLowerCase() === provider &&
          String(session.resumeSessionId || "").trim() === resumeSessionId
      )
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
    if (reusable) {
      state.liveView.sessionMeta = decorateSession(reusable);
      state.liveView.sessionId = reusable.id;
      state.liveView.liveSessionId = reusable.id;
      stopHistorySyncLoop();
      return reusable.id;
    }
  }

  const resumed = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      provider: state.liveView.sessionMeta.provider,
      cwd: state.liveView.sessionMeta.cwd,
      name: state.liveView.sessionMeta.displayTitle || state.liveView.sessionMeta.name,
      resumeSessionId: state.liveView.sessionMeta.resumeSessionId
    })
  });

  state.liveView.sessionMeta = {
    ...state.liveView.sessionMeta,
    id: resumed.session.id,
    kind: "live",
    status: resumed.session.status,
    updatedAt: resumed.session.updatedAt
  };
  state.liveView.sessionId = resumed.session.id;
  state.liveView.liveSessionId = resumed.session.id;
  stopHistorySyncLoop();
  refreshSessions().catch(() => {});
  setStatus("正在恢复会话上下文…");
  state.liveView.replayGuardActive = true;
  state.liveView.replayGuardUntil = Date.now() + 20_000;
  await wait(1800);
  discardPendingAssistantStream();
  state.liveView.streamBuffer = "";
  return resumed.session.id;
}

async function submitInput() {
  if (!canSend.value || state.loading) {
    return;
  }
  const text = composerDraft.value.trim();
  if (!text) {
    return;
  }
  const now = Date.now();
  const submissionText = buildSubmissionText(text);
  if (submissionText === state.lastSubmitText && now - Number(state.lastSubmitAt || 0) < 2500) {
    return;
  }
  state.lastSubmitText = submissionText;
  state.lastSubmitAt = now;
  const optimisticUserMessage = createMessage("user", submissionText, new Date().toISOString(), {
    source: "draft",
    partType: "text",
    payload: {}
  });

  try {
    state.loading = true;
    setStatus("正在发送…");
    stopHistorySyncLoop();
    closeSocket({ silent: true });
    if (expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value) {
      throw new Error(
        `会话线程不一致：当前=${activeThreadId.value}，目标=${expectedThreadId.value}。请返回列表后重新打开该会话。`
      );
    }
    rebuildReplaySuppressionLines([...state.liveView.messages, optimisticUserMessage]);
    setMessages([...state.liveView.messages, optimisticUserMessage]);
    composerDraft.value = "";
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
    state.liveView.activeInputStream = true;
    if (targetThreadId) {
      await requestThreadInputStream(
        targetProvider,
        targetThreadId,
        {
          type: "input",
          data: `${submissionText}\n`
        },
        {
          onPayload(payload) {
            handleLivePayload(payload);
          }
        }
      );
    } else {
      await requestSessionInputStream(
        liveSessionId,
        {
          type: "input",
          data: `${submissionText}\n`
        },
        {
          onPayload(payload) {
            handleLivePayload(payload);
          }
        }
      );
    }
    const finalPayload = await requestConversationSnapshotBySessionId(liveSessionId);
    if (finalPayload) {
      handleLivePayload(finalPayload);
    }
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("");
    }
  } catch (error) {
    if (String(composerDraft.value || "").trim() === "") {
      composerDraft.value = submissionText;
    }
    setMessages(
      state.liveView.messages.filter((message) => String(message.id || "") !== String(optimisticUserMessage.id || ""))
    );
    if (!state.liveView.liveSessionId) {
      startHistorySyncLoop();
    }
    setStatus(error.message || String(error));
  } finally {
    state.liveView.activeInputStream = false;
    state.loading = false;
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
      await requestThreadInputStream(
        targetProvider,
        targetThreadId,
        { type: "interrupt", reason: "user_interrupt" },
        {
          onPayload(payload) {
            handleLivePayload(payload);
          }
        }
      );
    } else {
      await requestSessionInputStream(
        liveSessionId,
        { type: "interrupt", reason: "user_interrupt" },
        {
          onPayload(payload) {
            handleLivePayload(payload);
          }
        }
      );
    }
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    state.liveView.interruptInFlight = false;
  }
}

async function backToList() {
  clearSubmitFallbackTimer();
  closeSocket();
  stopHistorySyncLoop();
  finalizeAssistantStream();
  state.routeSessionId = "";
  composerDraft.value = "";
  resetLiveView();
  resetThreadView();
  if (route.name !== "sessions") {
    await router.push({ name: "sessions" });
  }
  await refreshSessions();
}

function defaultPreview(session) {
  return PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
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
  () => [state.ready, state.isAuthenticated, route.name, route.params.sessionId],
  async ([ready, isAuthenticated, routeName, routeSessionId]) => {
    if (!ready) {
      return;
    }

    if (!isAuthenticated) {
      if (routeName !== "login") {
        const redirect = route.fullPath || "/sessions";
        await router.replace({ name: "login", query: { redirect } });
      }
      return;
    }

    if (routeName === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
      return;
    }

    if (routeName !== "chat") {
      return;
    }

  const targetSessionId = String(routeSessionId || "").trim();
  if (!targetSessionId) {
    await router.replace({ name: "sessions" });
    return;
  }

  const historyTarget = parseHistoryRouteSessionId(targetSessionId);

  if (
    syncingRouteOpen ||
    (state.routeSessionId === targetSessionId &&
      (!historyTarget || Boolean(state.threadView.meta) || Boolean(state.liveView.liveSessionId)))
  ) {
    return;
  }
  if (historyTarget) {
    syncingRouteOpen = true;
    try {
      await openThreadSession(
        {
          id: targetSessionId,
          kind: "thread",
          status: "saved",
          provider: historyTarget.provider,
          resumeSessionId: historyTarget.resumeSessionId,
          name: "会话",
          cwd: state.liveView.sessionMeta?.cwd || state.threadView.meta?.cwd || ""
        },
        { skipRoute: true }
      );
    } finally {
      syncingRouteOpen = false;
    }
    return;
  }

    let session = state.sessions.find((item) => item.id === targetSessionId);
    if (!session) {
      try {
        const single = await requestSessionById(targetSessionId);
        if (single) {
          session = single;
        }
      } catch {
        // Keep existing state when single-session lookup fails.
      }
    }

  if (!session) {
    setStatus("会话 ID 已失效，无法定位历史记录。请使用 history:provider:resumeSessionId 形式的链接。");
    await router.replace({ name: "sessions" });
    return;
  }

    if (session.resumeSessionId) {
      const threadRouteId = `history:${session.provider}:${session.resumeSessionId}`;
      if (targetSessionId !== threadRouteId) {
        await router.replace({ name: "chat", params: { sessionId: threadRouteId } });
        return;
      }
    }

    syncingRouteOpen = true;
    try {
      await openSessionItem(session, { skipRoute: true });
    } finally {
      syncingRouteOpen = false;
    }
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
        <header class="mobile-header list">
          <div class="header-copy">
            <h1>会话</h1>
          </div>
        </header>

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
        :assistant-name="activeAssistantName"
        :thread-snapshot="displayedThreadSnapshot"
        :live-overlay="displayedLiveOverlay"
        v-model:draft="composerDraft"
        :can-send="canSend"
        :can-interrupt="canInterrupt"
        :loading="state.loading"
        :status-text="state.statusText"
        @back="backToList"
        @interrupt="interruptActiveSession"
        @submit="submitInput"
      />

      <section v-else class="mobile-shell centered-shell">
        <div class="splash-card">正在加载会话页面…</div>
      </section>
    </template>
  </div>
</template>
