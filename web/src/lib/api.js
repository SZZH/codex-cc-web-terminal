import { withReadDeadline } from "./api-read-deadline.js";
import { readJsonWithProgress } from "./api-read-json.js";
import { readSessionSidebarStream } from "./session-sidebar-stream.js";

export const AUTH_EXPIRED_EVENT = "codex-auth-expired";
let authenticationGeneration = 0;
let initialHistoryCapability = false;

export function supportsInitialHistory() { return initialHistoryCapability; }

function rememberAuthCapabilities(payload, generation, authenticated) {
  if (generation === authenticationGeneration) initialHistoryCapability = authenticated && payload?.capabilities?.initialHistory === 1;
}

function notifyAuthExpired(generation) {
  if (generation === authenticationGeneration) initialHistoryCapability = false;
  if (generation !== authenticationGeneration || typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

function httpError(response, payload) {
  const error = new Error(payload?.error || response.statusText);
  error.status = response.status;
  if (typeof payload?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(payload.code)) error.code = payload.code;
  if (["not-applied", "applied", "unknown"].includes(payload?.executionState)) error.executionState = payload.executionState;
  return error;
}

export async function request(url, options = {}, attempt = 0) {
  const pathname = new URL(String(url), "http://localhost").pathname;
  const isRead = String(options.method || "GET").toUpperCase() === "GET";
  if (isRead && options.readContext) return requestWithAuth(url, options, attempt, pathname, options.readContext);
  const isInitializationRead = isRead
    && (pathname === "/api/config" || pathname === "/api/sessions" || pathname === "/api/session-catalog"
      || /^\/api\/threads\/[^/]+\/[^/]+\/composer-state$/.test(pathname));
  if (isInitializationRead) {
    return withReadDeadline(options.signal, (read) => requestWithAuth(url, options, attempt, pathname, read),
      ["/api/sessions", "/api/session-catalog"].includes(pathname) ? { totalTimeoutMs: 120000, idleTimeoutMs: 30000 } : undefined);
  }
  return requestWithAuth(url, options, attempt, pathname);
}

async function requestWithAuth(url, options, attempt, pathname, read) {
  read?.assertActive();
  const isAuthEndpoint = pathname === "/api/login" || pathname === "/api/logout";
  if (isAuthEndpoint && String(options.method || "GET").toUpperCase() === "POST") {
    authenticationGeneration += 1;
    initialHistoryCapability = false;
  }
  const generation = authenticationGeneration;
  const canRecoverAuth = !isAuthEndpoint;
  const { onSidebarBootstrap, readContext: _readContext, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    ...(read ? { signal: read.signal } : {}),
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  read?.assertActive();
  read?.progress();
  const readJson = () => read ? readJsonWithProgress(response, read) : response.json();

  if (response.status === 401 && canRecoverAuth && generation === authenticationGeneration && attempt === 0) {
    const relogged = await retryLoginFromSavedToken(generation, read);
    read?.assertActive();
    if (relogged) {
      return requestWithAuth(url, options, attempt + 1, pathname, read);
    }
  }
  if (response.status === 401 && canRecoverAuth && !read) {
    notifyAuthExpired(generation);
  }

  if (!response.ok) {
    const payload = await readJson().catch(() => ({ error: response.statusText }));
    read?.assertActive();
    if (response.status === 401 && canRecoverAuth && read) notifyAuthExpired(generation);
    throw httpError(response, payload);
  }

  const isSidebarStream = pathname === "/api/sessions" && String(options.method || "GET").toUpperCase() === "GET"
    && response.headers?.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/x-ndjson";
  const payload = isSidebarStream
    ? await readSessionSidebarStream(response, { ...read, onSidebarBootstrap })
    : await readJson();
  read?.assertActive();
  if (pathname === "/api/login") rememberAuthCapabilities(payload, generation, payload?.ok === true);
  return payload;
}

const TOKEN_STORAGE_KEY = "codex-web-terminal.saved-token";

async function retryLoginFromSavedToken(generation, read) {
  read?.assertActive();
  if (generation !== authenticationGeneration || typeof window === "undefined") {
    return false;
  }

  const token = String(window.localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
  if (!token) {
    return false;
  }

  initialHistoryCapability = false;

  const response = await fetch("/api/login", {
    method: "POST",
    ...(read ? { signal: read.signal } : {}),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  });
  read?.assertActive();
  read?.progress();

  if (!response.ok || generation !== authenticationGeneration) return false;
  const payload = await (read ? readJsonWithProgress(response, read) : response.json());
  read?.assertActive();
  rememberAuthCapabilities(payload, generation, payload?.ok === true);
  return generation === authenticationGeneration;
}

export async function requestHistoryMessages(session, historyApiAvailable, attempt = 0) {
  if (!session?.resumeSessionId) {
    return null;
  }
  const generation = authenticationGeneration;

  const params = new URLSearchParams({
    provider: session.provider,
    resumeSessionId: session.resumeSessionId
  });

  const response = await fetch(`/api/history-messages?${params.toString()}`, {
    credentials: "same-origin"
  });

  if (response.status === 401 && generation === authenticationGeneration && attempt === 0) {
    const relogged = await retryLoginFromSavedToken(generation);
    if (relogged) {
      return requestHistoryMessages(session, historyApiAvailable, attempt + 1);
    }
  }
  if (response.status === 401) {
    notifyAuthExpired(generation);
  }

  if (response.status === 503 && attempt === 0) {
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return requestHistoryMessages(session, historyApiAvailable, attempt + 1);
  }

  if (response.status === 404) {
    historyApiAvailable.value = false;
    return null;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw httpError(response, payload);
  }

  historyApiAvailable.value = true;
  return response.json();
}

export async function requestSessionById(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw new Error("Session id is required");
  }
  const payload = await request(`/api/sessions/${encodeURIComponent(id)}`);
  return payload?.session || null;
}

export async function requestWorkspaceChanges(cwd, { summary = false, paths = [], signal } = {}) {
  const params = new URLSearchParams({ cwd: String(cwd || "") });
  if (summary) params.set("summary", "1");
  for (const path of paths) params.append("path", String(path));
  return request(`/api/workspace-changes?${params.toString()}`, { ...(signal ? { signal } : {}) });
}

export async function requestWorkspaceGit(cwd) {
  const params = new URLSearchParams({ cwd: String(cwd || "") });
  return request(`/api/workspace-git?${params.toString()}`);
}

export async function requestWorkspaceGitCheckout(cwd, branch) {
  return request("/api/workspace-git/checkout", {
    method: "POST",
    body: JSON.stringify({ cwd, branch })
  });
}

export async function requestWorkspaceGitBranchCreate(cwd, branch) {
  return request("/api/workspace-git/branches", {
    method: "POST",
    body: JSON.stringify({ cwd, branch, checkout: true })
  });
}

export async function revertWorkspaceChanges(cwd, paths = []) {
  return request("/api/workspace-changes/revert", {
    method: "POST",
    body: JSON.stringify({ cwd, paths })
  });
}

export async function applyPatchWorkspaceChanges(cwd, files = [], direction = "reverse") {
  return request("/api/workspace-changes/apply-patch", {
    method: "POST",
    body: JSON.stringify({ cwd, files, direction })
  });
}

export async function reversePatchWorkspaceChanges(cwd, files = []) {
  return request("/api/workspace-changes/reverse-patch", {
    method: "POST",
    body: JSON.stringify({ cwd, files })
  });
}

export async function requestAuthSession(options = {}, attempt = 0) {
  if (typeof options === "number") {
    attempt = options;
    options = {};
  }
  return withReadDeadline(options.signal, (read) => readAuthSession(attempt, read));
}

async function readAuthSession(attempt, read) {
  read.assertActive();
  const generation = authenticationGeneration;
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    signal: read.signal
  });
  read.assertActive();

  if (response.status === 401 && generation === authenticationGeneration && attempt === 0) {
    const relogged = await retryLoginFromSavedToken(generation, read);
    read.assertActive();
    if (relogged) {
      return readAuthSession(attempt + 1, read);
    }
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    read.assertActive();
    throw httpError(response, payload);
  }

  const payload = await response.json();
  read.assertActive();
  rememberAuthCapabilities(payload, generation, payload?.authenticated === true);
  return payload;
}

// Only a failed new endpoint probes again; normal navigation uses the existing auth read.
export async function recheckInitialHistorySupport(options = {}) {
  const generation = authenticationGeneration;
  let auth;
  try { auth = await requestAuthSession(options); }
  catch (error) {
    if (error.status === 401) notifyAuthExpired(generation);
    throw error;
  }
  if (generation !== authenticationGeneration) throw new DOMException("登录状态已变化。", "AbortError");
  if (auth?.authenticated !== true) {
    notifyAuthExpired(generation);
    throw Object.assign(new Error("登录状态已失效，请重新登录。"), { status: 401 });
  }
  return supportsInitialHistory();
}

function parseSseEventBlocks(buffer) {
  const blocks = buffer.split(/\n\n/);
  return {
    complete: blocks.slice(0, -1),
    remainder: blocks.at(-1) || ""
  };
}

function parseSseEvent(block) {
  const event = {
    event: "",
    data: ""
  };

  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    if (line.startsWith("event:")) {
      event.event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      event.data += `${line.slice("data:".length).trimStart()}\n`;
    }
  }

  event.data = event.data.trimEnd();
  return event;
}

function yieldToRenderer() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

export async function requestSessionInputStream(sessionId, body, { onPayload, signal } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw new Error("Session id is required");
  }
  const generation = authenticationGeneration;

  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/input-stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body || {}),
    signal
  });

  if (response.status === 401) {
    notifyAuthExpired(generation);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw httpError(response, payload);
  }
  if (!response.body) {
    throw new Error("Streaming response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { complete, remainder } = parseSseEventBlocks(buffer);
    buffer = remainder;

    for (const block of complete) {
      const event = parseSseEvent(block);
      if (!event.data) {
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = { type: event.event || "message", raw: event.data };
      }
      if (typeof onPayload === "function") {
        onPayload(payload, event.event || payload?.type || "");
        await yieldToRenderer();
      }
    }
  }
}

export async function requestSessionInput(sessionId, body) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw new Error("Session id is required");
  }
  return request(`/api/sessions/${encodeURIComponent(id)}/input`, {
    method: "POST",
    body: JSON.stringify(body || {})
  });
}

export async function requestThreadInputStream(provider, threadId, body, { onPayload, signal } = {}) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    throw new Error("Thread id is required");
  }
  const generation = authenticationGeneration;

  const response = await fetch(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/input-stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body || {}),
    signal
  });

  if (response.status === 401) {
    notifyAuthExpired(generation);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw httpError(response, payload);
  }
  if (!response.body) {
    throw new Error("Streaming response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { complete, remainder } = parseSseEventBlocks(buffer);
    buffer = remainder;

    for (const block of complete) {
      const event = parseSseEvent(block);
      if (!event.data) {
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = { type: event.event || "message", raw: event.data };
      }
      if (typeof onPayload === "function") {
        onPayload(payload, event.event || payload?.type || "");
        await yieldToRenderer();
      }
    }
  }
}

export async function requestThreadInput(provider, threadId, body) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    throw new Error("Thread id is required");
  }
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/input`, {
    method: "POST",
    body: JSON.stringify(body || {})
  });
}

export async function requestThreadComposerState(provider, threadId) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    throw new Error("Thread id is required");
  }
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/composer-state?git=0`);
}

export async function patchThreadComposerState(provider, threadId, patch = {}) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    throw new Error("Thread id is required");
  }
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/composer-state?git=0`, {
    method: "PATCH",
    body: JSON.stringify(patch || {})
  });
}
