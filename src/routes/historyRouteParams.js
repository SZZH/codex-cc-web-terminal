function splitPath(pathname = "") {
  return String(pathname || "").split("/");
}

export function parseHistoryQuery(urlString = "") {
  const url = new URL(urlString, "http://localhost");
  return {
    provider: String(url.searchParams.get("provider") || "codex").trim(),
    resumeSessionId: String(url.searchParams.get("resumeSessionId") || "").trim()
  };
}

export function parseScopedHistoryRoute(pathname = "", suffix = "") {
  const parts = splitPath(pathname);
  if (parts.length !== 6 || String(parts[5] || "").trim() !== String(suffix || "").trim()) {
    return null;
  }
  return {
    provider: String(parts[3] || "codex").trim(),
    resumeSessionId: String(parts[4] || "").trim()
  };
}

export function parseThreadRoute(pathname = "") {
  const parts = splitPath(pathname);
  if (parts.length < 5 || parts.length > 6) {
    return null;
  }
  return {
    provider: String(parts[3] || "codex").trim(),
    resumeSessionId: String(parts[4] || "").trim(),
    suffix: String(parts[5] || "").trim()
  };
}
