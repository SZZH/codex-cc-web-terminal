import path from "node:path";
import { isVisibleSidebarSession } from "./codexDesktopSidebar.js";

function normalizeComparablePath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    return path.resolve(text);
  } catch {
    return text;
  }
}

function isSubpathOf(targetPath, rootPath) {
  const target = normalizeComparablePath(targetPath);
  const root = normalizeComparablePath(rootPath);
  if (!target || !root) {
    return false;
  }
  if (target === root) {
    return true;
  }
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function bestProjectRootForCwd(cwd, projectRoots) {
  const matches = projectRoots.filter((rootPath) => isSubpathOf(cwd, rootPath));
  return matches.sort((left, right) => right.length - left.length)[0] || "";
}

export function byUpdatedAtDesc(left, right) {
  return String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""));
}

export function filterSidebarSessionsByRecency(sessions = []) {
  // Preserve the public helper name; Codex does not hide older unarchived threads.
  return (Array.isArray(sessions) ? sessions : []).filter(isVisibleSidebarSession);
}

function dedupeSessionsByIdentity(sessions = []) {
  const deduped = new Map();
  for (const session of sessions) {
    const identity = `${String(session?.provider || "codex").trim()}:${String(
      session?.resumeSessionId || session?.threadId || session?.id || ""
    ).trim()}`;
    const existing = deduped.get(identity);
    if (!existing || byUpdatedAtDesc(session, existing) < 0) {
      deduped.set(identity, session);
    }
  }
  return [...deduped.values()].sort(byUpdatedAtDesc);
}

export function mergeProjectGroupsWithLiveSessions(baseGroups = [], liveSessions = []) {
  if (!Array.isArray(baseGroups) || !baseGroups.length) {
    return [];
  }

  const groups = baseGroups.map((group) => ({
    ...group,
    sessions: Array.isArray(group?.sessions) ? [...group.sessions] : []
  }));
  const projectRoots = groups.map((group) => String(group?.projectRoot || group?.cwd || "").trim()).filter(Boolean);
  const groupsByRoot = new Map(groups.map((group) => [String(group?.projectRoot || group?.cwd || "").trim(), group]));

  for (const session of Array.isArray(liveSessions) ? liveSessions : []) {
    const projectRoot = bestProjectRootForCwd(session?.cwd, projectRoots);
    if (!projectRoot) {
      continue;
    }
    const group = groupsByRoot.get(projectRoot);
    if (!group) {
      continue;
    }
    group.sessions.push(session);
  }

  for (const group of groups) {
    group.sessions = dedupeSessionsByIdentity(filterSidebarSessionsByRecency(group.sessions));
  }

  return groups;
}

export function buildSidebarSnapshotFromGroups(sessions = [], projectGroups = []) {
  if (!Array.isArray(projectGroups) || !projectGroups.length) {
    return {
      sessions: filterSidebarSessionsByRecency(sessions).sort(byUpdatedAtDesc),
      projectGroups: []
    };
  }

  const sessionsById = new Map();
  for (const group of projectGroups) {
    for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
      const sessionId = String(session?.id || "").trim();
      if (!sessionId) {
        continue;
      }
      const existing = sessionsById.get(sessionId);
      if (!existing || byUpdatedAtDesc(session, existing) < 0) {
        sessionsById.set(sessionId, session);
      }
    }
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = String(session?.id || "").trim();
    if (!sessionId || sessionsById.has(sessionId)) {
      continue;
    }
    sessionsById.set(sessionId, session);
  }

  return {
    sessions: filterSidebarSessionsByRecency([...sessionsById.values()]).sort(byUpdatedAtDesc),
    projectGroups
  };
}
