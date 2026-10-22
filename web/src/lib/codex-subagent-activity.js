import { activityDuration } from "./activity-time.js";

const TERMINAL_STATES = new Set(["completed", "failed", "interrupted"]);
const terminal = (activity) => TERMINAL_STATES.has(activity?.state);
const duration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function sameLifecycle(previous, current) {
  return ["startedItemId", "agentThreadId", "agentPath"].every((key) =>
    !previous[key] || !current[key] || previous[key] === current[key]);
}

/** Merge observations of one native item without allowing a stale start to reopen it. */
export function mergeCodexSubagentActivity(previous, current) {
  if (!previous) return current;
  if (!current) return previous;
  if (!sameLifecycle(previous, current)) return current;
  const preserveTerminal = terminal(previous) && (!terminal(current) ||
    current.state === "completed" && ["failed", "interrupted"].includes(previous.state));
  const result = { ...previous, ...current,
    startedItemId: current.startedItemId || previous.startedItemId,
    startedAt: current.startedAt ?? previous.startedAt,
    completedAt: current.completedAt ?? previous.completedAt,
    durationMs: duration(current.durationMs) ? current.durationMs : previous.durationMs };
  if (preserveTerminal) {
    result.state = previous.state;
    result.event = previous.event;
    result.startedAt = previous.startedAt ?? current.startedAt;
    result.completedAt = previous.completedAt ?? current.completedAt;
    result.durationMs = duration(previous.durationMs) ? previous.durationMs : current.durationMs;
  }
  return result;
}

/** Each invocation is scoped to one turn; child identity alone never pairs wakeups. */
export function createCodexSubagentActivityProjector(items) {
  const completions = new Map();
  for (const item of items) {
    const activity = item?.presentation?.activity;
    if (!TERMINAL_STATES.has(activity?.event) || !terminal(activity) || !activity.startedItemId) continue;
    completions.set(activity.startedItemId, mergeCodexSubagentActivity(completions.get(activity.startedItemId), activity));
  }
  return (item) => {
    const activity = item?.presentation?.activity;
    const completed = completions.get(item?.id);
    if (activity?.event !== "started" || !completed || !sameLifecycle(activity, completed)) return activity;
    const settled = mergeCodexSubagentActivity(activity, completed);
    const result = { ...activity, state: settled.state, startedItemId: item.id,
      startedAt: activity.startedAt ?? completed.startedAt ?? null,
      completedAt: settled.completedAt ?? null,
      durationMs: duration(settled.durationMs) ? settled.durationMs : null };
    if (result.durationMs == null) result.durationMs = activityDuration(result);
    return result;
  };
}
