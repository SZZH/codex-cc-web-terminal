let createApp;
let computed;
let nextTick;
let onMounted;
let reactive;
let ref;
let watch;

async function resolveVueRuntime() {
  if (window.Vue?.createApp) {
    return window.Vue;
  }

  try {
    const moduleRuntime = await import("/vendor/vue.js");
    if (moduleRuntime?.createApp) {
      return moduleRuntime;
    }
    if (moduleRuntime?.default?.createApp) {
      return moduleRuntime.default;
    }
  } catch (error) {
    console.warn("dynamic Vue import failed", error);
  }

  if (window.Vue?.createApp) {
    return window.Vue;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/vue.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });

  if (window.Vue?.createApp) {
    return window.Vue;
  }

  throw new Error("Vue runtime failed to load");
}

const GENERIC_TITLES = new Set(["codex", "claude", "session", "会话", "untitled workspace"]);
const TITLE_NOISE_PATTERNS = [
  /^saved\b/i,
  /^-\s/,
  /若必须做较大重构/,
  /accessibility override/i,
  /auth-required override/i,
  /automatic routing rule/i,
  /global instructions/i,
  /approval policy/i,
  /filesystem sandboxing/i,
  /current user accessibility context/i,
  /environment_context/i,
  /AGENTS\.md/i
];
const PREVIEW_FALLBACK = {
  history: "恢复这个 Codex 会话",
  live: "继续当前会话"
};

let historyApiAvailable = null;

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeLine(value) {
  return stripAnsi(value)
    .replace(/\t/g, "  ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function filterTerminalNoise(value) {
  const lines = stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const filtered = lines.filter((line) => {
    const text = line.trim();
    if (!text) {
      return false;
    }
    if (/codex\s+resume/i.test(text)) {
      return false;
    }
    if (/dangerously-bypass-approvals-and-sandbox/i.test(text)) {
      return false;
    }
    if (/--no-alt-screen/i.test(text)) {
      return false;
    }
    if (/^➜/.test(text) || /^%$/.test(text) || /^>$/.test(text)) {
      return false;
    }
    return true;
  });

  return filtered.join("\n");
}

function compactLine(value) {
  return normalizeLine(value).replace(/\s+/g, " ").trim();
}

function clampText(value, max = 54) {
  const text = compactLine(value);
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

function createMessage(role, text, timestamp = "", extra = {}) {
  return {
    id: `${role}-${timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text: normalizeLine(text),
    timestamp,
    ...extra
  };
}

function workspaceName(cwd) {
  const parts = String(cwd || "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || String(cwd || "").trim() || "未命名项目";
}

function isInstructionLike(value) {
  const text = compactLine(value);
  if (!text) {
    return true;
  }
  return TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function isLowSignalTitle(title, session) {
  const text = compactLine(title);
  if (!text) {
    return true;
  }
  if (GENERIC_TITLES.has(text.toLowerCase())) {
    return true;
  }
  if (TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const folder = workspaceName(session?.cwd).toLowerCase();
  return text.toLowerCase() === folder;
}

function normalizeHistoryMessages(messages) {
  return (messages || [])
    .map((item) => {
      const role = item?.role === "user" ? "user" : "assistant";
      const text = normalizeLine(item?.text || "");
      if (!text || isInstructionLike(text)) {
        return null;
      }
      return createMessage(role, text, item?.timestamp || "", { source: "history" });
    })
    .filter(Boolean);
}

function pickRealTitle(messages, fallback, session) {
  const firstUser = messages.find((message) => message.role === "user" && !isInstructionLike(message.text));
  if (firstUser?.text) {
    return clampText(firstUser.text, 36);
  }
  if (!isLowSignalTitle(fallback, session)) {
    return clampText(fallback, 36);
  }
  return clampText(fallback || workspaceName(session?.cwd), 36) || workspaceName(session?.cwd);
}

function pickPreview(messages, session, title) {
  const assistant = messages.find((message) => message.role === "assistant" && !isInstructionLike(message.text));
  const userFollowup = messages.find((message) => message.role === "user" && clampText(message.text, 52) !== title);
  const candidate = assistant?.text || userFollowup?.text || session?.inputPreview || "";
  return clampText(candidate, 58) || PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
}

function fallbackTitleForSession(session) {
  if (!isLowSignalTitle(session?.name, session)) {
    return clampText(session.name, 36);
  }

  if (!isLowSignalTitle(session?.inputPreview, session)) {
    return clampText(session.inputPreview, 36);
  }

  if (session?.kind === "history") {
    return "历史会话";
  }
  return clampText(session?.name || session?.providerLabel || "当前会话", 36) || "当前会话";
}

function fallbackPreviewForSession(session) {
  if (!isLowSignalTitle(session?.inputPreview, session)) {
    return clampText(session.inputPreview, 58);
  }
  if (!isLowSignalTitle(session?.name, session)) {
    return clampText(session.name, 58);
  }
  return PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
}

function formatRelativeTime(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) {
    return "";
  }

  const diff = Date.now() - parsed;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < hour) {
    return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  }
  if (diff < day) {
    return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  }
  if (diff < week) {
    return `${Math.max(1, Math.round(diff / day))} 天前`;
  }
  return `${Math.max(1, Math.round(diff / week))} 周前`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
}

async function requestHistoryMessages(session) {
  if (!session?.resumeSessionId || historyApiAvailable === false) {
    return null;
  }

  const params = new URLSearchParams({
    provider: session.provider,
    resumeSessionId: session.resumeSessionId
  });

  const response = await fetch(`/api/history-messages?${params.toString()}`, {
    credentials: "same-origin"
  });

  if (response.status === 404) {
    historyApiAvailable = false;
    return null;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }

  historyApiAvailable = true;
  return response.json();
}

async function bootstrapApp() {
  const vueRuntime = await resolveVueRuntime();
  ({ createApp, computed, nextTick, onMounted, reactive, ref, watch } = vueRuntime);

  createApp({
  setup() {
    const messageListRef = ref(null);
    const composerRef = ref(null);
    const sessionCache = reactive({});
    const state = reactive({
      ready: false,
      isAuthenticated: false,
      accessToken: "",
      statusText: "",
      sessions: [],
      view: "list",
      activeSessionId: "",
      activeLiveSessionId: "",
      activeSessionMeta: null,
      activeMessages: [],
      activeSocket: null,
      activeStreamBuffer: "",
      draft: "",
      pendingSessionId: "",
    });

    const pendingHydrations = new Map();

    function cacheKey(session) {
      return session?.kind === "history"
        ? `history:${session.provider}:${session.resumeSessionId}`
        : `live:${session?.id || "unknown"}`;
    }

    function decorateSession(session) {
      const cache = sessionCache[cacheKey(session)] || {};
      const displayTitle = cache.title || fallbackTitleForSession(session);
      const displayPreview = cache.preview || fallbackPreviewForSession(session);
      return {
        ...session,
        displayTitle,
        displayPreview,
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
        .sort((left, right) => String(right.sessions[0]?.updatedAt || "").localeCompare(String(left.sessions[0]?.updatedAt || "")));
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
    const canSend = computed(() => Boolean(state.draft.trim()));

    function scrollMessagesToBottom() {
      nextTick(() => {
        const el = messageListRef.value;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }

    function autoGrowComposer() {
      const el = composerRef.value;
      if (!el) {
        return;
      }
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }

    function closeSocket() {
      if (state.activeSocket) {
        state.activeSocket.close();
        state.activeSocket = null;
      }
    }

    function setStatus(message = "") {
      state.statusText = message;
    }

    function setMessages(messages) {
      state.activeMessages = messages.filter((message) => message?.text);
      scrollMessagesToBottom();
    }

    function finalizeAssistantStream() {
      if (!state.activeStreamBuffer) {
        return;
      }
      const messages = [...state.activeMessages];
      const last = messages[messages.length - 1];
      if (last?.streaming) {
        last.streaming = false;
        last.text = normalizeLine(last.text);
        state.activeMessages = messages;
      }
      state.activeStreamBuffer = "";
    }

    function appendAssistantChunk(chunk) {
      const normalized = filterTerminalNoise(chunk || "");
      if (!normalized) {
        return;
      }

      state.activeStreamBuffer += normalized;
      const mergedText = normalizeLine(state.activeStreamBuffer);
      if (!mergedText) {
        return;
      }

      const messages = [...state.activeMessages];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        last.text = mergedText;
        state.activeMessages = messages;
      } else {
        messages.push(createMessage("assistant", mergedText, new Date().toISOString(), { streaming: true, source: "live" }));
        state.activeMessages = messages;
      }
      scrollMessagesToBottom();
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
        const payload = await requestHistoryMessages(session);
        if (!payload) {
          const nextValue = {
            hydrated: true,
            title: fallbackTitleForSession(session),
            preview: fallbackPreviewForSession(session),
            messages: []
          };
          sessionCache[key] = {
            ...(sessionCache[key] || {}),
            ...nextValue
          };
          return sessionCache[key];
        }

        const messages = normalizeHistoryMessages(payload.messages || []);
        const title = pickRealTitle(messages, payload.session?.name || session.name, session);
        const preview = pickPreview(messages, session, title);
        const nextValue = {
          hydrated: true,
          title,
          preview,
          messages
        };
        sessionCache[key] = {
          ...(sessionCache[key] || {}),
          ...nextValue
        };
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
        .filter((session) => session.kind === "history" && (isLowSignalTitle(session.name, session) || isLowSignalTitle(session.inputPreview, session)))
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
      const payload = await request("/api/config");
      await refreshSessions();
    }

    async function handleLogin() {
      try {
        if (!state.accessToken) {
          throw new Error("请输入 token");
        }
        await request("/api/login", {
          method: "POST",
          body: JSON.stringify({ token: state.accessToken })
        });
        state.isAuthenticated = true;
        state.accessToken = "";
        setStatus("");
        await bootstrapWorkspace();
      } catch (error) {
        setStatus(error.message || String(error));
      }
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
            const snapshot = normalizeLine(payload.buffer || "");
            if (snapshot) {
              setMessages([createMessage("assistant", snapshot, payload.session?.updatedAt || "", { source: "snapshot" })]);
            }
          }
          return;
        }

        if (payload.type === "data") {
          appendAssistantChunk(payload.data || "");
          return;
        }

        if (payload.type === "exit") {
          finalizeAssistantStream();
          const exitMessage = createMessage("assistant", `会话已退出 (${payload.exitCode ?? 0})`, new Date().toISOString(), {
            source: "system"
          });
          setMessages([...state.activeMessages, exitMessage]);
        }
      });

      socket.addEventListener("close", () => {
        if (state.activeSocket === socket) {
          state.activeSocket = null;
        }
        finalizeAssistantStream();
      });
    }

    async function openLiveSession(session) {
      state.pendingSessionId = session.id;
      setStatus("");
      const decorated = decorateSession(session);
      state.activeSessionId = session.id;
      state.activeSessionMeta = decorated;
      state.view = "chat";
      setMessages([]);
      attachLiveSocket(session.id, []);
      state.pendingSessionId = "";
    }

    async function openHistoricalSession(session) {
      state.pendingSessionId = session.id;
      setStatus("");
      const decorated = decorateSession(session);
      const hydrated = await hydrateSession(session, { includeMessages: true });
      const historyMessages = hydrated?.messages || [];

      state.activeSessionId = session.id;
      state.activeSessionMeta = {
        ...decorated,
        displayTitle: hydrated?.title || decorated.displayTitle,
        displayPreview: hydrated?.preview || decorated.displayPreview
      };
      state.view = "chat";
      setMessages(historyMessages);
      state.activeLiveSessionId = "";
      state.pendingSessionId = "";
    }

    async function openSessionItem(session) {
      try {
        if (session.kind === "history") {
          await openHistoricalSession(session);
          return;
        }
        await openLiveSession(session);
      } catch (error) {
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
        attachLiveSocket(state.activeSessionMeta.id, []);
        await wait(120);
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
      attachLiveSocket(resumed.session.id, state.activeMessages);
      await wait(120);
      return resumed.session.id;
    }

    async function submitInput() {
      if (!canSend.value) {
        return;
      }
      const text = state.draft.trim();
      if (!text) {
        return;
      }
      try {
        await ensureLiveSession();
        if (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN) {
          throw new Error("会话连接还没准备好，请重试一次");
        }
        finalizeAssistantStream();
        state.activeSocket.send(JSON.stringify({ type: "input", data: `${text}\r` }));
        setMessages([...state.activeMessages, createMessage("user", text, new Date().toISOString(), { source: "draft" })]);
        state.draft = "";
        setStatus("");
        nextTick(autoGrowComposer);
      } catch (error) {
        setStatus(error.message || String(error));
      }
    }

    async function backToList() {
      closeSocket();
      finalizeAssistantStream();
      state.view = "list";
      state.activeSessionId = "";
      state.activeLiveSessionId = "";
      state.activeSessionMeta = null;
      state.draft = "";
      setMessages([]);
      nextTick(autoGrowComposer);
      await refreshSessions();
    }

    function defaultPreview(session) {
      return PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
    }

    watch(
      () => state.view,
      (view) => {
        if (view === "list") {
          closeSocket();
        }
      }
    );

    onMounted(async () => {
      try {
        await bootstrapWorkspace();
        state.isAuthenticated = true;
      } catch {
        state.isAuthenticated = false;
      } finally {
        state.ready = true;
        nextTick(autoGrowComposer);
      }
    });

    return {
      state,
      groupedSessions,
      activeSessionTitle,
      activeWorkspaceName,
      activeAssistantName,
      canSend,
      messageListRef,
      composerRef,
      formatRelativeTime,
      defaultPreview,
      autoGrowComposer,
      handleLogin,
      openSessionItem,
      submitInput,
      backToList
    };
  }
  }).mount("#app");
}

bootstrapApp().catch((error) => {
  console.error(error);
  const root = document.getElementById("app");
  if (root) {
    root.innerHTML = `
      <section class="login-view">
        <div class="login-card">
          <p class="login-kicker">Codex</p>
          <h1>页面加载失败</h1>
          <p class="status-copy">${String(error?.message || error || "未知错误")}</p>
        </div>
      </section>
    `;
  }
});
