import { buildSidebarSnapshotFromGroups } from "../sessions/history/sessionSidebarSnapshot.js";

export function buildSessionSidebarPayload(sessionManager) {
  if (typeof sessionManager?.listSidebarSnapshot === "function") {
    return sessionManager.listSidebarSnapshot();
  }

  const sessions = typeof sessionManager?.listAll === "function" ? sessionManager.listAll() : [];
  const projectGroups = typeof sessionManager?.listProjectGroups === "function" ? sessionManager.listProjectGroups() : [];
  return buildSidebarSnapshotFromGroups(sessions, projectGroups);
}
