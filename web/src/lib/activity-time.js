export function activityTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function activityDuration(activity, now = Date.now()) {
  if (typeof activity?.durationMs === "number" && Number.isFinite(activity.durationMs) && activity.durationMs >= 0 && activity.state !== "running") return activity.durationMs;
  const start = activityTimestamp(activity?.startedAt);
  const end = activityTimestamp(activity?.completedAt);
  if (start == null) return null;
  if (end != null) return end >= start ? end - start : null;
  return activity?.state === "running" && now >= start ? now - start : null;
}

export function formatActivityDuration(value) {
  if (value == null || !Number.isFinite(value) || value < 0) return "";
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}小时${minutes % 60}分${seconds % 60}秒` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}
