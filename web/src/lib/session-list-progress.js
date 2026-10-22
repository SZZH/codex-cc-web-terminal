import { isSessionRunning, sessionGroupKey } from "./session-list.js";

export function deriveSessionListProgress({ loaded, complete, counts }, query = "") {
  const ready = loaded && complete;
  return {
    complete: ready,
    searchPending: Boolean(query.trim()) && !ready,
    runningTotal: !ready && counts ? counts.runningTotal : null,
    groupCounts: new Map(!ready && counts ? counts.groups.map((group) => [group.key, group]) : [])
  };
}

export function sessionListGroupCounts(group, progress) {
  return progress.groupCounts.get(sessionGroupKey(group)) || {
    total: group.sessions.length,
    running: group.sessions.filter(isSessionRunning).length
  };
}
