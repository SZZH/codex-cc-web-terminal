import { restoreSessionSidebarPayload } from "./session-sidebar-payload.js";
import { buildActivitySessions, isSessionRunning, sessionGroupKey } from "./session-list.js";

const PROTOCOL = "session-sidebar-progressive-v1";
const invalid = (cause = new Error("Invalid session sidebar stream")) => new Error("会话列表尚未完整加载，请重试。", { cause });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function restoreCompact(payload) {
  if (payload?.sidebarFormat !== "compact-v1" || !Array.isArray(payload.projectGroups)) throw invalid();
  let restored;
  try { restored = restoreSessionSidebarPayload(payload); } catch (cause) { throw invalid(cause); }
  const covered = new Set();
  for (const group of payload.projectGroups) {
    if (new Set(group.sessionIds).size !== group.sessionIds.length) throw invalid();
    group.sessionIds.forEach((id) => covered.add(id));
  }
  if (covered.size !== payload.sessions.length) throw invalid();
  return restored;
}

function validateCounts(counts, payload, complete) {
  const activity = buildActivitySessions(payload.projectGroups);
  const match = (expected, actual) => integer(expected) && (complete ? expected === actual : expected >= actual);
  if (!counts || !match(counts.sessionsTotal, payload.sessions.length)
    || !match(counts.activitiesTotal, activity.length)
    || !integer(counts.runningTotal) || complete && counts.runningTotal !== activity.filter(isSessionRunning).length
    || counts.activitiesTotal > counts.sessionsTotal || counts.runningTotal > counts.activitiesTotal
    || !Array.isArray(counts.groups) || counts.groups.length !== payload.projectGroups.length) throw invalid();
  const keys = new Set();
  payload.projectGroups.forEach((group, index) => {
    const key = sessionGroupKey(group), count = counts.groups[index];
    if (!key.trim() || keys.has(key) || count?.key !== key || !match(count.total, group.sessions.length)
      || !match(count.running, group.sessions.filter(isSessionRunning).length) || count.running > count.total) throw invalid();
    keys.add(key);
  });
}

function validateContinuation(bootstrap, payload) {
  const sessions = new Map(payload.sessions.map((session) => [session.id, session]));
  for (const session of bootstrap.sessions) {
    if (JSON.stringify(session) !== JSON.stringify(sessions.get(session.id))) throw invalid();
  }
  bootstrap.projectGroups.forEach((group, index) => {
    const full = payload.projectGroups[index];
    const { sessions: partialSessions, ...partialMetadata } = group;
    const { sessions: fullSessions, ...fullMetadata } = full;
    if (JSON.stringify(partialMetadata) !== JSON.stringify(fullMetadata)) throw invalid();
    let previous = -1;
    for (const session of partialSessions) {
      const position = fullSessions.findIndex(({ id }) => id === session.id);
      if (position <= previous) throw invalid();
      previous = position;
    }
  });
}

export async function readSessionSidebarStream(response, { signal, assertActive = () => {}, progress, onSidebarBootstrap } = {}) {
  const active = () => {
    assertActive();
    if (signal?.aborted) throw signal.reason || new DOMException("读取已取消。", "AbortError");
  };
  active();
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bootstrap = null, complete = null, completed = false;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      active();
      const { value, done } = await reader.read();
      active();
      if (value?.byteLength) progress?.();
      try { buffer += decoder.decode(value, { stream: !done }); } catch (cause) { throw invalid(cause); }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(text); } catch (cause) { throw invalid(cause); }
        if (!frame || frame.protocol !== PROTOCOL || !/^[A-Za-z0-9_-]{43}$/.test(frame.snapshotId)
          || complete) throw invalid();
        const payload = restoreCompact(frame.payload);
        if (!bootstrap) {
          if (frame.type !== "bootstrap" || frame.complete !== false) throw invalid();
          validateCounts(frame.counts, payload, false);
          bootstrap = { frame, payload };
          active();
          onSidebarBootstrap?.(frame);
        } else {
          if (frame.type !== "complete" || frame.complete !== true || frame.snapshotId !== bootstrap.frame.snapshotId) throw invalid();
          validateCounts(bootstrap.frame.counts, payload, true);
          validateContinuation(bootstrap.payload, payload);
          complete = frame.payload;
        }
      }
      if (done) break;
    }
    if (buffer || !complete) throw invalid();
    active();
    completed = true;
    return complete;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
}
