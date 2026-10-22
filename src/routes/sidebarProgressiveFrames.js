import { createHash } from "node:crypto";

const PROTOCOL = "session-sidebar-progressive-v1";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (session) => `${session.provider || "codex"}:${session.resumeSessionId || session.threadId || session.id || ""}`;
const groupKey = (group) => String(group.id || group.projectId || group.cwd || group.name || "");
const running = (session) => session.activityState === "running";

function activityTime(session) {
  const value = session.lastActivityAt || session.updatedAt || session.createdAt;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function canonicalSessions(payload) {
  if (!isRecord(payload) || payload.sidebarFormat !== "compact-v1" || !Array.isArray(payload.sessions)
    || !Array.isArray(payload.projectGroups) || !payload.projectGroups.length || payload.sidebarStatus?.degraded) return null;
  const sessions = new Map();
  for (const session of payload.sessions) {
    if (!isRecord(session) || typeof session.id !== "string" || !session.id.trim() || sessions.has(session.id)) return null;
    sessions.set(session.id, session);
  }
  const keys = new Set();
  const covered = new Set();
  for (const group of payload.projectGroups) {
    if (!isRecord(group) || !Array.isArray(group.sessionIds) || Object.hasOwn(group, "sessions")) return null;
    const key = groupKey(group);
    if (!key.trim() || keys.has(key)) return null;
    keys.add(key);
    const members = new Set();
    for (const id of group.sessionIds) {
      if (typeof id !== "string" || !sessions.has(id) || members.has(id)) return null;
      members.add(id);
      covered.add(id);
    }
  }
  // Unassigned records require client-side grouping, whose counts cannot be stated here.
  return covered.size === sessions.size ? sessions : null;
}

export function buildSidebarProgressiveFrames(payload, serialized = `${JSON.stringify(payload)}\n`) {
  if (!isRecord(payload) || payload.sidebarFormat !== "compact-v1") return null;
  // Own the complete representation before any streaming work can yield to mutations.
  const snapshot = JSON.parse(serialized);
  const sessions = canonicalSessions(snapshot);
  if (!sessions) return null;

  const activities = new Map();
  const selected = new Set();
  const groups = snapshot.projectGroups.map((group) => {
    group.sessionIds.slice(0, 5).forEach((id) => selected.add(id));
    let runningCount = 0;
    for (const id of group.sessionIds) {
      const session = sessions.get(id);
      const key = identity(session);
      const previous = activities.get(key);
      if (!previous || activityTime(session) > activityTime(previous)) activities.set(key, session);
      else if (running(session)) activities.set(key, { ...previous, activityState: "running" });
      if (running(session)) runningCount += 1;
    }
    return { key: groupKey(group), total: group.sessionIds.length, running: runningCount };
  });
  const orderedActivities = [...activities.values()].sort((left, right) => activityTime(right) - activityTime(left)
    || identity(left).localeCompare(identity(right)));
  const recent = new Set(orderedActivities.slice(0, 20).map(identity));
  for (const session of snapshot.sessions) if (recent.has(identity(session))) selected.add(session.id);
  if (selected.size === sessions.size) return null;

  const bootstrap = { ...snapshot, sessions: snapshot.sessions.filter((session) => selected.has(session.id)),
    projectGroups: snapshot.projectGroups.map((group) => ({ ...group, sessionIds: group.sessionIds.filter((id) => selected.has(id)) })) };
  const counts = { sessionsTotal: snapshot.sessions.length, activitiesTotal: activities.size,
    runningTotal: orderedActivities.filter(running).length, groups };
  const snapshotId = createHash("sha256").update(serialized).digest("base64url");
  const common = { protocol: PROTOCOL, snapshotId };
  return {
    snapshotId,
    bootstrapLine: `${JSON.stringify({ ...common, type: "bootstrap", complete: false, counts, payload: bootstrap })}\n`,
    completeLine: `${JSON.stringify({ ...common, type: "complete", complete: true, payload: snapshot })}\n`
  };
}
