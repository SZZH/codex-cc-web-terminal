export const AUTH_EXPIRED_EVENT = "codex-auth-expired";

function notifyAuthExpired() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

export async function request(url, options = {}, attempt = 0) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401 && attempt === 0) {
    const relogged = await retryLoginFromSavedToken();
    if (relogged) {
      return request(url, options, attempt + 1);
    }
  }
  if (response.status === 401) {
    notifyAuthExpired();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
}

const TOKEN_STORAGE_KEY = "codex-web-terminal.saved-token";

async function retryLoginFromSavedToken() {
  if (typeof window === "undefined") {
    return false;
  }

  const token = String(window.localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
  if (!token) {
    return false;
  }

  const response = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  });

  return response.ok;
}

export async function requestHistoryMessages(session, historyApiAvailable, attempt = 0) {
  if (!session?.resumeSessionId) {
    return null;
  }

  const params = new URLSearchParams({
    provider: session.provider,
    resumeSessionId: session.resumeSessionId
  });

  const response = await fetch(`/api/history-messages?${params.toString()}`, {
    credentials: "same-origin"
  });

  if (response.status === 401 && attempt === 0) {
    const relogged = await retryLoginFromSavedToken();
    if (relogged) {
      return requestHistoryMessages(session, historyApiAvailable, attempt + 1);
    }
  }
  if (response.status === 401) {
    notifyAuthExpired();
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
    throw new Error(payload.error || response.statusText);
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

export async function requestWorkspaceChanges(cwd) {
  const params = new URLSearchParams({ cwd: String(cwd || "") });
  return request(`/api/workspace-changes?${params.toString()}`);
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

export async function reversePatchWorkspaceChanges(cwd, files = []) {
  return request("/api/workspace-changes/reverse-patch", {
    method: "POST",
    body: JSON.stringify({ cwd, files })
  });
}

export async function requestAuthSession(attempt = 0) {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin"
  });

  if (response.status === 401 && attempt === 0) {
    const relogged = await retryLoginFromSavedToken();
    if (relogged) {
      return requestAuthSession(attempt + 1);
    }
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
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
    notifyAuthExpired();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
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
    notifyAuthExpired();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
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
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/composer-state`);
}

export async function patchThreadComposerState(provider, threadId, patch = {}) {
  const providerId = String(provider || "codex").trim().toLowerCase() || "codex";
  const id = String(threadId || "").trim();
  if (!id) {
    throw new Error("Thread id is required");
  }
  return request(`/api/threads/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/composer-state`, {
    method: "PATCH",
    body: JSON.stringify(patch || {})
  });
}
