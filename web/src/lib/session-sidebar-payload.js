function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function restoreSessionSidebarPayload(payload) {
  if (!isRecord(payload)) throw new Error("Invalid session sidebar payload");
  if (!Object.hasOwn(payload, "sidebarFormat")) return payload;

  const { sidebarFormat, ...restored } = payload;
  if (sidebarFormat !== "compact-v1") throw new Error("Unsupported session sidebar format");
  if (!Array.isArray(payload.sessions)
    || Object.hasOwn(payload, "projectGroups") && !Array.isArray(payload.projectGroups)) {
    throw new Error("Invalid compact session sidebar structure");
  }

  const sessionsById = new Map();
  for (const session of payload.sessions) {
    if (!isRecord(session) || typeof session.id !== "string" || !session.id.trim() || sessionsById.has(session.id)) {
      throw new Error("Invalid or duplicate compact sidebar session ID");
    }
    sessionsById.set(session.id, session);
  }

  if (Object.hasOwn(payload, "projectGroups")) {
    restored.projectGroups = payload.projectGroups.map((group) => {
      if (!isRecord(group) || !Array.isArray(group.sessionIds) || Object.hasOwn(group, "sessions")) {
        throw new Error("Invalid compact sidebar project group");
      }
      const { sessionIds, ...metadata } = group;
      const sessions = sessionIds.map((id) => {
        if (typeof id !== "string" || !sessionsById.has(id)) {
          throw new Error("Missing compact sidebar session reference");
        }
        return sessionsById.get(id);
      });
      return { ...metadata, sessions };
    });
  }
  return restored;
}
