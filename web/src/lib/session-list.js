import { computed } from "vue";

import { workspaceName } from "./session-helpers.js";

export function cacheKey(session) {
  const kind = String(session?.kind || "").trim().toLowerCase();
  return kind === "history" || kind === "thread"
    ? `thread:${session.provider}:${session.resumeSessionId}`
    : `live:${session?.id || "unknown"}`;
}

export function parseHistoryRouteSessionId(value) {
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

export function decorateSession(session) {
  return {
    ...session,
    displayTitle: String(session?.name || "").trim(),
    displayPreview: String(session?.inputPreview || "").trim(),
    groupName: workspaceName(session.cwd)
  };
}

export function buildGroupedSessions(sessions = [], projectGroups = []) {
  if (Array.isArray(projectGroups) && projectGroups.length > 0) {
    return projectGroups.map((group) => ({
      ...group,
      sessions: (group.sessions || []).map(decorateSession)
    }));
  }

  const sessionSorter = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt));
  const groups = new Map();
  for (const session of sessions.map(decorateSession)) {
    if (!groups.has(session.groupName)) {
      groups.set(session.groupName, []);
    }
    groups.get(session.groupName).push(session);
  }

  return [...groups.entries()]
    .map(([name, grouped]) => ({
      name,
      cwd: grouped[0]?.cwd || "",
      sessions: [...grouped].sort(sessionSorter)
    }))
    .sort((left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(String(left.sessions[0]?.updatedAt || ""))
    );
}

export function createGroupedSessionsComputed(state) {
  return computed(() => buildGroupedSessions(state.sessions, state.projectGroups));
}

export function mergeSessionTitlesIntoCache(sessions = [], sessionCache = {}) {
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
}
