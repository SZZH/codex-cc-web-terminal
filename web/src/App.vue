<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import ChatView from "./components/ChatView.vue";
import LoginView from "./components/LoginView.vue";
import SessionListView from "./components/SessionListView.vue";
import { request, requestHistoryMessages } from "./lib/api.js";
import { normalizeServerPayload } from "./lib/normalize-events.js";
import {
  PREVIEW_FALLBACK,
  compactLine,
  createMessage,
  fallbackPreviewForSession,
  fallbackTitleForSession,
  filterTerminalNoise,
  formatRelativeTime,
  isLowSignalTitle,
  normalizeHistoryMessages,
  normalizeLine,
  pickPreview,
  pickRealTitle,
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
  activeSessionId: "",
  activeLiveSessionId: "",
  activeSessionMeta: null,
  activeMessages: [],
  activeSocket: null,
  activeStreamBuffer: "",
  pendingSessionId: "",
  activeSessionOpenToken: 0,
  replayGuardActive: false,
  replayGuardPrompt: "",
  replayGuardUntil: 0
});
let syncingRouteOpen = false;

function cacheKey(session) {
  return session?.kind === "history"
    ? `history:${session.provider}:${session.resumeSessionId}`
    : `live:${session?.id || "unknown"}`;
}

function decorateSession(session) {
  const cache = sessionCache[cacheKey(session)] || {};
  return {
    ...session,
    displayTitle: cache.title || fallbackTitleForSession(session),
    displayPreview: cache.preview || fallbackPreviewForSession(session),
    groupName: workspaceName(session.cwd)
  };
}

const groupedSessions = computed(() => {
  const groups = new Map();
  for (const session of state.sessions.map(decorateSession)) {
    if (!groups.has(session.groupName)) {
      groups.set(session.groupName, []);
    }
    groups.get(session.groupName).push(session);
  }

  return [...groups.entries()]
    .map(([name, sessions]) => ({
      name,
      sessions: [...sessions].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    }))
    .sort((left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(String(left.sessions[0]?.updatedAt || ""))
    );
});

const activeSessionTitle = computed(() => {
  if (!state.activeSessionMeta) {
    return "会话";
  }
  const cached = sessionCache[cacheKey(state.activeSessionMeta)] || {};
  return cached.title || state.activeSessionMeta.displayTitle || state.activeSessionMeta.name || "会话";
});

const activeWorkspaceName = computed(() => workspaceName(state.activeSessionMeta?.cwd || ""));
const activeAssistantName = computed(() => state.activeSessionMeta?.providerLabel || "Codex");
const canSend = computed(() => Boolean(composerDraft.value.trim()));
const canInterrupt = computed(
  () =>
    Boolean(state.activeLiveSessionId) &&
    Boolean(state.activeSocket) &&
    state.activeSocket.readyState === WebSocket.OPEN
);

function setStatus(message = "") {
  state.statusText = message;
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

function setMessages(messages) {
  state.activeMessages = messages.filter((message) => message?.text);
  rebuildReplaySuppressionLines(state.activeMessages);
}

function bumpActiveSessionOpenToken() {
  state.activeSessionOpenToken += 1;
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

function finalizeAssistantStream() {
  if (!state.activeStreamBuffer) {
    return;
  }
  const messages = [...state.activeMessages];
  const last = messages[messages.length - 1];
  if (last?.streaming) {
    last.streaming = false;
    last.text = sanitizeAssistantText(normalizeLine(last.text));
    if (!last.text) {
      messages.pop();
    }
    state.activeMessages = messages;
  }
  state.activeStreamBuffer = "";
}

function discardPendingAssistantStream() {
  state.activeStreamBuffer = "";
  const messages = [...state.activeMessages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.streaming) {
    messages.pop();
    state.activeMessages = messages;
  }
}

function appendAssistantChunk(chunk) {
  const now = Date.now();
  if (state.replayGuardActive && now >= state.replayGuardUntil) {
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
  }

  let normalized = pruneLiveBootstrapNoise(filterTerminalNoise(chunk || ""));
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

  state.activeStreamBuffer += normalized;
  let mergedText = sanitizeAssistantText(normalizeLine(state.activeStreamBuffer));
  const lastUserMessage = [...state.activeMessages].reverse().find((message) => message.role === "user")?.text || "";
  if (lastUserMessage && mergedText.startsWith(lastUserMessage)) {
    const tail = mergedText.slice(lastUserMessage.length).trim();
    if (!tail || /^[>›)\]}\-_=:.~|/\\\dA-Za-z]{1,24}$/.test(tail)) {
      mergedText = "";
      state.activeStreamBuffer = "";
    }
  }
  if (!mergedText || isDisposableAssistantFragment(mergedText)) {
    if (isDisposableAssistantFragment(mergedText)) {
      discardPendingAssistantStream();
    }
    return;
  }

  const messages = [...state.activeMessages];
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
  state.activeMessages = messages;
}

function stringifyPartPayload(payload) {
  try {
    return `\`\`\`json\n${JSON.stringify(payload || {}, null, 2)}\n\`\`\``;
  } catch {
    return String(payload || "");
  }
}

function appendNormalizedParts(parts = []) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return;
  }

  let messages = [...state.activeMessages];
  let touched = false;

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
        appendAssistantChunk(text);
        touched = true;
        continue;
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

    const fallbackText = stringifyPartPayload(payload);
    messages.push(
      createMessage(role, fallbackText, ts, {
        source: part?.source || "normalized",
        partType: partType || "unknown",
        payload,
        rawType: part?.rawType || ""
      })
    );
    touched = true;
  }

  if (touched) {
    state.activeMessages = messages;
  }
}

function clearPendingReplyStatus() {
  if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
    setStatus("");
  }
}

async function hydrateSession(session, { includeMessages = false, silent = false } = {}) {
  if (!session || session.kind !== "history" || !session.resumeSessionId) {
    return null;
  }

  const key = cacheKey(session);
  const cached = sessionCache[key];
  if (cached?.hydrated && (!includeMessages || cached.messages)) {
    return cached;
  }

  if (pendingHydrations.has(key)) {
    if (!includeMessages) {
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
        title: fallbackTitleForSession(session),
        preview: fallbackPreviewForSession(session),
        messages: []
      };
      sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
      return sessionCache[key];
    }

    const messages = normalizeHistoryMessages(payload.messages || []);
    const title = pickRealTitle(messages, payload.session?.name || session.name, session);
    const preview = pickPreview(messages, session, title);
    const nextValue = { hydrated: true, title, preview, messages };
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

async function prefetchSessionTitles() {
  const candidates = state.sessions
    .filter(
      (session) =>
        session.kind === "history" &&
        (isLowSignalTitle(session.name, session) || isLowSignalTitle(session.inputPreview, session))
    )
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 18);

  for (const session of candidates) {
    await hydrateSession(session, { silent: true });
  }
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  state.sessions = payload.sessions || [];
  prefetchSessionTitles().catch(() => {});
}

async function bootstrapWorkspace() {
  await request("/api/config");
  await refreshSessions();
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
    if (route.name !== "sessions") {
      await router.replace({ name: "sessions" });
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

function closeSocket() {
  if (state.activeSocket) {
    state.activeSocket.close();
    state.activeSocket = null;
  }
}

function waitForSocketOpen(socket, timeoutMs = 4000) {
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

function attachLiveSocket(sessionId, historyMessages = []) {
  closeSocket();
  finalizeAssistantStream();
  state.activeLiveSessionId = sessionId;
  state.activeStreamBuffer = "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);
  state.activeSocket = socket;

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "snapshot") {
      if (!historyMessages.length) {
        const snapshot = filterTerminalNoise(payload.buffer || "");
        if (snapshot) {
          const systemFailure = detectSystemFailureText(snapshot);
          if (systemFailure) {
            discardPendingAssistantStream();
            setStatus(systemFailure);
            return;
          }
          clearPendingReplyStatus();
          setMessages([
            createMessage("assistant", snapshot, payload.session?.updatedAt || "", {
              source: "snapshot"
            })
          ]);
        }
      }
      return;
    }

    if (payload.type === "data") {
      if (payload.data && String(payload.data).trim()) {
        clearPendingReplyStatus();
      }
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
      return;
    }

    if (payload.type === "message_part") {
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
      return;
    }

    if (payload.type === "event_msg" || payload.type === "response_item") {
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
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
  });

  socket.addEventListener("close", () => {
    if (state.activeSocket === socket) {
      state.activeSocket = null;
    }
    finalizeAssistantStream();
    if (state.statusText === "已发送中断指令。") {
      setStatus("当前流程已中断。");
      return;
    }
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("会话连接已关闭，请重试一次。");
    }
  });

  socket.addEventListener("error", () => {
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("会话连接失败，请重试一次。");
    }
  });

  return waitForSocketOpen(socket);
}

async function openLiveSession(session, { skipRoute = false } = {}) {
  state.pendingSessionId = session.id;
  setStatus("正在连接会话…");
  state.activeSessionId = session.id;
  state.activeSessionMeta = decorateSession(session);
  bumpActiveSessionOpenToken();
  if (!skipRoute && route.name !== "chat") {
    await router.push({ name: "chat", params: { sessionId: session.id } });
  }
  composerDraft.value = "";
  state.replayGuardActive = false;
  state.replayGuardPrompt = "";
  state.replayGuardUntil = 0;
  setMessages([]);
  await attachLiveSocket(session.id, []);
  setStatus("");
  state.pendingSessionId = "";
}

async function openHistoricalSession(session, { skipRoute = false } = {}) {
  state.pendingSessionId = session.id;
  setStatus("正在加载会话…");
  const decorated = decorateSession(session);
  const hydrated = await hydrateSession(session, { includeMessages: true });
  const historyMessages = hydrated?.messages || [];

  state.activeSessionId = session.id;
  state.activeSessionMeta = {
    ...decorated,
    displayTitle: hydrated?.title || decorated.displayTitle,
    displayPreview: hydrated?.preview || decorated.displayPreview
  };
  bumpActiveSessionOpenToken();
  if (!skipRoute && route.name !== "chat") {
    await router.push({ name: "chat", params: { sessionId: session.id } });
  }
  composerDraft.value = "";
  state.replayGuardActive = false;
  state.replayGuardPrompt = "";
  state.replayGuardUntil = 0;
  setMessages(historyMessages);
  state.activeLiveSessionId = "";
  setStatus("");
  state.pendingSessionId = "";
}

async function openSessionItem(session, { skipRoute = false } = {}) {
  try {
    if (session.kind === "history") {
      await openHistoricalSession(session, { skipRoute });
      return;
    }
    await openLiveSession(session, { skipRoute });
  } catch (error) {
    if (session.kind === "live" && session.resumeSessionId) {
      try {
        await openHistoricalSession({
          ...session,
          id: `history:${session.provider}:${session.resumeSessionId}`,
          kind: "history",
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

async function ensureLiveSession() {
  if (state.activeLiveSessionId && state.activeSocket && state.activeSocket.readyState === WebSocket.OPEN) {
    return state.activeLiveSessionId;
  }
  if (!state.activeSessionMeta) {
    throw new Error("当前没有可继续的会话");
  }

  if (state.activeSessionMeta.kind === "live") {
    await attachLiveSocket(state.activeSessionMeta.id, []);
    return state.activeSessionMeta.id;
  }

  const resumed = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      provider: state.activeSessionMeta.provider,
      cwd: state.activeSessionMeta.cwd,
      name: state.activeSessionMeta.displayTitle || state.activeSessionMeta.name,
      resumeSessionId: state.activeSessionMeta.resumeSessionId
    })
  });

  state.activeSessionMeta = {
    ...state.activeSessionMeta,
    id: resumed.session.id,
    kind: "live",
    status: resumed.session.status,
    updatedAt: resumed.session.updatedAt
  };
  state.activeLiveSessionId = resumed.session.id;
  await refreshSessions();
  await attachLiveSocket(resumed.session.id, state.activeMessages);
  setStatus("正在恢复会话上下文…");
  state.replayGuardActive = true;
  state.replayGuardUntil = Date.now() + 20_000;
  await wait(1800);
  discardPendingAssistantStream();
  state.activeStreamBuffer = "";
  return resumed.session.id;
}

async function submitInput() {
  if (!canSend.value) {
    return;
  }
  const text = composerDraft.value.trim();
  if (!text) {
    return;
  }

  try {
    state.loading = true;
    setStatus("正在发送…");
    await ensureLiveSession();
    if (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error("会话连接还没准备好，请重试一次");
    }
    finalizeAssistantStream();
    state.activeSocket.send(JSON.stringify({ type: "input", data: `${text}\r` }));
    if (state.replayGuardActive) {
      state.replayGuardPrompt = text;
    }
    rebuildReplaySuppressionLines([...state.activeMessages, createMessage("user", text, new Date().toISOString())]);
    setMessages([
      ...state.activeMessages,
      createMessage("user", text, new Date().toISOString(), { source: "draft" })
    ]);
    composerDraft.value = "";
    setStatus("等待 Codex 回复…");
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    state.loading = false;
  }
}

function interruptActiveSession() {
  if (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN) {
    setStatus("当前没有可中断的运行流程。");
    return;
  }

  try {
    state.activeSocket.send(JSON.stringify({ type: "input", data: "\u001b" }));
    setStatus("已发送中断指令。");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function backToList() {
  closeSocket();
  finalizeAssistantStream();
  state.replayGuardActive = false;
  state.replayGuardPrompt = "";
  state.replayGuardUntil = 0;
  state.activeSessionId = "";
  state.activeLiveSessionId = "";
  state.activeSessionMeta = null;
  composerDraft.value = "";
  setMessages([]);
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
  (name) => {
    if (name === "sessions") {
      closeSocket();
      finalizeAssistantStream();
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
        await router.replace({ name: "login" });
      }
      return;
    }

    if (routeName === "login") {
      await router.replace({ name: "sessions" });
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

    if (syncingRouteOpen || state.activeSessionId === targetSessionId) {
      return;
    }

    let session = state.sessions.find((item) => item.id === targetSessionId);
    if (!session) {
      try {
        await refreshSessions();
      } catch {
        // Keep existing state when refresh fails.
      }
      session = state.sessions.find((item) => item.id === targetSessionId);
    }

    if (!session) {
      setStatus("会话不存在或已失效。");
      await router.replace({ name: "sessions" });
      return;
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
  try {
    const savedToken = getSavedToken();
    if (savedToken) {
      state.accessToken = savedToken;
      state.rememberToken = true;
    }
    await bootstrapWorkspace();
    state.isAuthenticated = true;
  } catch {
    state.isAuthenticated = false;
    const savedToken = getSavedToken();
    if (savedToken && !autoLoginTried) {
      autoLoginTried = true;
      state.accessToken = savedToken;
      await handleLogin({ auto: true });
    }
  } finally {
    state.ready = true;
  }
});

onBeforeUnmount(() => {
  closeSocket();
});

if (typeof window !== 'undefined') {
  window.__codexWebDebug = {
    state,
    groupedSessions,
    composerDraft
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
          :active-session-id="state.activeSessionId"
          :pending-session-id="state.pendingSessionId"
          :format-relative-time="formatRelativeTime"
          @open="openSessionItem"
        />

        <div v-if="state.statusText" class="notice-strip">{{ state.statusText }}</div>
      </section>

      <ChatView
        v-else-if="route.name === 'chat' && state.activeSessionMeta"
        :session-key="state.activeSessionMeta?.resumeSessionId || state.activeSessionMeta?.id || ''"
        :open-token="state.activeSessionOpenToken"
        :title="activeSessionTitle"
        :workspace-name="activeWorkspaceName"
        :assistant-name="activeAssistantName"
        :messages="state.activeMessages"
        v-model:draft="composerDraft"
        :can-send="canSend"
        :can-interrupt="canInterrupt"
        :loading="state.loading"
        :status-text="state.statusText"
        @back="backToList"
        @interrupt="interruptActiveSession"
        @submit="submitInput"
      />

      <section v-else class="mobile-shell">
        <div class="splash-card">正在加载会话页面…</div>
      </section>
    </template>
  </div>
</template>
