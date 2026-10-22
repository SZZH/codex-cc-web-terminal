import { buildSidebarSnapshotFromGroups } from "../sessions/history/sessionSidebarSnapshot.js";
import { withSessionActivity } from "../sessions/history/sessionActivity.js";

export async function buildSessionSidebarPayload(sessionManager, codexThreads = null) {
  if (typeof sessionManager?.listSidebarSnapshotAsync === "function") {
    return withSessionActivity(await sessionManager.listSidebarSnapshotAsync(), { sessionManager, codexThreads });
  }
  if (typeof sessionManager?.listSidebarSnapshot === "function") {
    return withSessionActivity(await sessionManager.listSidebarSnapshot(), { sessionManager, codexThreads });
  }

  const sessions = typeof sessionManager?.listAll === "function" ? await sessionManager.listAll() : [];
  const projectGroups = typeof sessionManager?.listProjectGroups === "function" ? await sessionManager.listProjectGroups() : [];
  return withSessionActivity(buildSidebarSnapshotFromGroups(sessions, projectGroups), { sessionManager, codexThreads });
}
