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
