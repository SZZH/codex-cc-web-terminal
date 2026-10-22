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

export function sessionGroupKey(group) {
  return String(group?.id || group?.projectId || group?.cwd || group?.name || "");
}

export function createSessionSearch(groups = []) {
  const normalize = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
  const projectNames = new Map(groups.filter((group) => group.groupKind === "project" && group.projectId)
    .map((group) => [group.projectId, group.name]));
  const indexed = groups.map((group) => {
    const text = normalize([group.name, group.cwd, group.projectRoot, ...(group.rootPaths || [])].join("\n"));
    const sessions = (group.sessions || []).map((session) => ({ session,
      text: `${text}\n${normalize([session.name, session.displayTitle, session.inputPreview, session.displayPreview,
        session.cwd, session.groupName, session.projectName, projectNames.get(session.projectId),
        session.provider, session.providerLabel, session.id, session.threadId, session.resumeSessionId].join("\n"))}` }));
    return { group, text, sessions };
  });
  return (query = "") => {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return groups;
    const matches = (text) => terms.every((term) => text.includes(term));
    return indexed.flatMap(({ group, text, sessions }) => {
      const found = sessions.filter((entry) => matches(entry.text)).map((entry) => entry.session);
      if (!found.length && (sessions.length || !matches(text))) return [];
      return [found.length === sessions.length ? group : { ...group, sessions: found }];
    });
  };
}

export function sessionIdentity(session) {
  return `${session?.provider || "codex"}:${session?.resumeSessionId || session?.threadId || session?.id || ""}`;
}

export function sessionActivityTime(session) {
  const value = session?.lastActivityAt || session?.updatedAt || session?.createdAt;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function isSessionRunning(session) {
  return session?.activityState === "running";
}

export function buildActivitySessions(groups = []) {
  const projectNames = new Map(groups.filter((group) => group.groupKind === "project" && group.projectId)
    .map((group) => [group.projectId, group.name]));
  const sessions = new Map();
  for (const group of groups) for (const session of group.sessions || []) {
    const id = sessionIdentity(session);
    const previous = sessions.get(id);
    const projectName = projectNames.get(session.projectId) || (group.groupKind === "project" ? group.name : "") || session.groupName || workspaceName(session.cwd);
    const next = { ...session, projectName };
    if (!previous || sessionActivityTime(next) > sessionActivityTime(previous)) sessions.set(id, next);
    else if (isSessionRunning(next)) sessions.set(id, { ...previous, activityState: "running" });
  }
  return [...sessions.values()].sort((left, right) => sessionActivityTime(right) - sessionActivityTime(left)
    || sessionIdentity(left).localeCompare(sessionIdentity(right)));
}

export function buildGroupedSessions(sessions = [], projectGroups = []) {
  if (Array.isArray(projectGroups) && projectGroups.length > 0) {
    const groups = projectGroups.map((group) => ({
      ...group,
      sessions: (group.sessions || []).map(decorateSession)
    }));
    const included = new Set(groups.flatMap((group) => group.sessions.map(sessionIdentity)));
    const ungrouped = sessions.filter((session) => !included.has(sessionIdentity(session))).map(decorateSession);
    if (ungrouped.length) {
      const recent = groups.find((group) => group.groupKind === "recent");
      if (recent) recent.sessions.push(...ungrouped);
      else groups.push({ id: "recent:unassigned", name: "最近会话", groupKind: "recent", cwd: "", sessions: ungrouped });
    }
    return groups;
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
