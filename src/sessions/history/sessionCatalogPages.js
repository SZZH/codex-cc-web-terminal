import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_PAGE_SIZE = 20;
const SNAPSHOT_TTL_MS = 120_000;
const MAX_SNAPSHOTS = 4;
const briefFields = ["id", "provider", "providerLabel", "cliLabel", "name", "displayTitle", "cwd", "kind", "status",
  "threadId", "resumeSessionId", "projectId", "projectName", "groupName", "createdAt", "updatedAt", "lastActivityAt", "activityState", "sessionType"];
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const normalize = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
const groupKey = (group) => String(group.id || group.projectId || group.cwd || group.name || "");
const identity = (session) => `${session.provider || "codex"}:${session.resumeSessionId || session.threadId || session.id || ""}`;
const workspaceName = (cwd) => String(cwd || "").split("/").filter(Boolean).at(-1) || String(cwd || "").trim() || "\u672a\u547d\u540d\u9879\u76ee";
const brief = (session) => Object.fromEntries(briefFields.filter((key) => Object.hasOwn(session, key)
  && (session[key] === null || ["string", "number", "boolean"].includes(typeof session[key]))).map((key) => [key, session[key]]));
const running = (session) => session.activityState === "running";

function fail(message, status = 400, code = "CATALOG_INVALID_REQUEST") {
  throw Object.assign(new Error(message), { status, code });
}

function parseParams(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
  for (const key of ["view", "q", "group", "limit", "cursor", "loaded"]) {
    if (params.getAll(key).length > 1) fail(`Repeated catalog parameter: ${key}`);
  }
  const view = params.get("view") || "groups";
  const query = normalize(params.get("q")).trim().split(/\s+/).filter(Boolean).join(" ");
  const group = params.get("group") || "";
  const limitText = params.get("limit") ?? String(MAX_PAGE_SIZE);
  if (!["groups", "activity"].includes(view) || query.length > 1000 || group.length > 2048
    || !/^(?:[1-9]|1[0-9]|20)$/.test(limitText) || view === "activity" && group) fail("Invalid catalog context or page limit");
  const cursor = params.get("cursor") || "";
  let loaded = null;
  if (params.has("loaded")) {
    if (cursor || group || (params.get("loaded") || "").length > 100_000) fail("Invalid loaded catalog context");
    try { loaded = JSON.parse(params.get("loaded")); } catch { fail("Invalid loaded catalog ranges"); }
    if (!record(loaded)) fail("Loaded catalog ranges must be an object");
    const entries = Object.entries(loaded);
    if (entries.some(([key, count]) => !key || key.length > 2048 || !Number.isSafeInteger(count) || count < 0)
      || view === "activity" && entries.some(([key]) => key !== "activity")) fail("Invalid loaded catalog ranges");
  }
  return { view, query, group, limit: Number(limitText), cursor, loaded };
}

function canonicalGroups(source) {
  if (!record(source) || !Array.isArray(source.sessions) || source.projectGroups != null && !Array.isArray(source.projectGroups)) {
    fail("Session catalog is unavailable", 503, "CATALOG_UNAVAILABLE");
  }
  const groups = (source.projectGroups || []).map((group) => {
    if (!record(group) || !Array.isArray(group.sessions)) fail("Session catalog groups are unavailable", 503, "CATALOG_UNAVAILABLE");
    return { ...group, sessions: [...group.sessions] };
  });
  const all = [...source.sessions, ...groups.flatMap((group) => group.sessions)];
  if (all.some((row) => !record(row) || typeof row.id !== "string" || !row.id.trim())) {
    fail("Session catalog records are unavailable", 503, "CATALOG_UNAVAILABLE");
  }
  const included = new Set(groups.flatMap((group) => group.sessions.map(identity)));
  const unassigned = source.sessions.filter((row) => !included.has(identity(row)));
  if (unassigned.length) {
    const recent = groups.find((group) => group.groupKind === "recent");
    if (recent) recent.sessions.push(...unassigned);
    else {
      let id = "recent:unassigned", suffix = 0;
      while (groups.some((group) => groupKey(group) === id)) id = `recent:unassigned:${++suffix}`;
      groups.push({ id, name: "\u6700\u8fd1\u4f1a\u8bdd", groupKind: "recent", cwd: "", sessions: unassigned });
    }
  }
  const keys = new Set();
  for (const group of groups) {
    const key = groupKey(group);
    if (!key || keys.has(key)) fail("Session catalog group identities are unavailable", 503, "CATALOG_UNAVAILABLE");
    keys.add(key);
  }
  return groups;
}

function indexGroups(groups) {
  const projectNames = new Map(groups.filter((group) => group.groupKind === "project" && group.projectId)
    .map((group) => [group.projectId, group.name]));
  return groups.map((group) => {
    const text = normalize([group.name, group.cwd, group.projectRoot, ...(group.rootPaths || [])].join("\n"));
    const entries = group.sessions.map((session) => ({ session: brief(session),
      text: `${text}\n${normalize([...new Set([session.name, String(session.name || "").trim(), session.inputPreview, String(session.inputPreview || "").trim(),
        session.cwd, workspaceName(session.cwd), session.projectName, projectNames.get(session.projectId),
        session.provider, session.providerLabel, session.id, session.threadId, session.resumeSessionId])].join("\n"))}` }));
    const { sessions, catalogPage, ...metadata } = group;
    return { group: { ...JSON.parse(JSON.stringify(metadata)), sessions: entries.map((entry) => entry.session) }, text, entries };
  });
}

function searchGroups(indexed, query) {
  if (!query) return indexed.map(({ group }) => group);
  const terms = query.split(" ");
  const matches = (text) => terms.every((term) => text.includes(term));
  return indexed.flatMap(({ group, text, entries }) => {
    const found = entries.filter((entry) => matches(entry.text)).map((entry) => entry.session);
    if (!found.length && (entries.length || !matches(text))) return [];
    return [{ ...group, sessions: found }];
  });
}

function activityTime(session) {
  const value = session.lastActivityAt || session.updatedAt || session.createdAt;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function activitySessions(groups) {
  const names = new Map(groups.filter((group) => group.groupKind === "project" && group.projectId)
    .map((group) => [group.projectId, group.name]));
  const sessions = new Map();
  for (const group of groups) for (const session of group.sessions) {
    const key = identity(session), previous = sessions.get(key);
    const next = { ...session, projectName: names.get(session.projectId) || (group.groupKind === "project" ? group.name : "")
      || session.groupName || workspaceName(session.cwd) };
    if (!previous || activityTime(next) > activityTime(previous)) sessions.set(key, next);
    else if (running(next)) sessions.set(key, { ...previous, activityState: "running" });
  }
  return [...sessions.values()].sort((left, right) => activityTime(right) - activityTime(left) || identity(left).localeCompare(identity(right)));
}

export function createSessionCatalogPages({ loadSnapshot, now = Date.now } = {}) {
  const snapshots = new Map();
  const secret = randomBytes(32);
  let loading = null;
  const sign = (body) => createHmac("sha256", secret).update(body).digest();
  function prune() {
    for (const [revision, snapshot] of snapshots) if (now() - snapshot.createdAt >= SNAPSHOT_TTL_MS) snapshots.delete(revision);
  }
  function capture(source) {
    prune();
    const serialized = JSON.stringify(source);
    const digest = createHash("sha256").update(serialized).digest("base64url");
    const existing = [...snapshots.values()].find((snapshot) => snapshot.digest === digest);
    if (existing) return existing;
    // Keep briefs and search text, so frozen cursors do not retain another full preview copy.
    const metadata = JSON.parse(JSON.stringify({ sidebarPreferences: source.sidebarPreferences, sidebarStatus: source.sidebarStatus }));
    const snapshot = { revision: randomBytes(18).toString("base64url"), digest, createdAt: now(),
      indexed: indexGroups(canonicalGroups(source)), ...metadata };
    snapshots.set(snapshot.revision, snapshot);
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    return snapshot;
  }
  function freshSnapshot() {
    if (!loading) loading = Promise.resolve().then(loadSnapshot).then(capture).finally(() => { loading = null; });
    return loading;
  }
  function encodeCursor(snapshot, context, group, offset) {
    const body = Buffer.from(JSON.stringify({ revision: snapshot.revision, view: context.view, query: context.query,
      group, limit: context.limit, offset })).toString("base64url");
    return `${body}.${sign(body).toString("base64url")}`;
  }
  function decodeCursor(context) {
    const parts = context.cursor.split(".");
    if (context.cursor.length > 32_768 || parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) fail("Invalid catalog cursor");
    const received = Buffer.from(parts[1], "base64url"), expected = sign(parts[0]);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail("Invalid catalog cursor signature");
    let cursor;
    try { cursor = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { fail("Invalid catalog cursor payload"); }
    if (!record(cursor) || cursor.view !== context.view || cursor.query !== context.query || cursor.group !== context.group
      || cursor.limit !== context.limit || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
      || typeof cursor.revision !== "string") fail("Catalog cursor does not match this request");
    prune();
    const snapshot = snapshots.get(cursor.revision);
    if (!snapshot) fail("Session catalog snapshot expired; reload this view", 409, "CATALOG_SNAPSHOT_EXPIRED");
    return { snapshot, offset: cursor.offset };
  }

  async function read(input = {}) {
    const context = parseParams(input);
    const { snapshot, offset } = context.cursor ? decodeCursor(context) : { snapshot: await freshSnapshot(), offset: 0 };
    const groups = searchGroups(snapshot.indexed, context.query);
    const activities = activitySessions(groups);
    const keys = new Set(groups.map(groupKey));
    if (context.group && !keys.has(context.group)) fail("Unknown catalog group");
    const counts = new Map(), selected = new Map();
    let sessions = [], nextCursor = null;
    if (context.view === "activity") {
      if (offset > activities.length) fail("Catalog cursor offset exceeds activity bounds");
      const count = context.loaded ? Math.min(context.loaded.activity || 0, activities.length) : context.limit;
      const page = activities.slice(offset, offset + count);
      const selectedIds = new Set(page.map(identity));
      sessions = page.map(brief);
      for (const group of groups) selected.set(groupKey(group), group.sessions.filter((row) => selectedIds.has(identity(row))));
      if (offset + page.length < activities.length) nextCursor = encodeCursor(snapshot, context, "", offset + page.length);
    } else {
      let budget = context.limit;
      for (const group of groups) {
        const key = groupKey(group);
        let start = 0, count = 0;
        if (context.group) { if (key === context.group) { start = offset; count = context.limit; } }
        else if (context.loaded) count = Math.min(context.loaded[key] || 0, group.sessions.length);
        else if (!group.collapsed || context.query) { count = Math.min(5, budget); budget -= Math.min(count, group.sessions.length); }
        if (start > group.sessions.length) fail("Catalog cursor offset exceeds group bounds");
        const rows = group.sessions.slice(start, start + count);
        selected.set(key, rows);
        counts.set(key, start + rows.length);
      }
      sessions = [...new Map(groups.flatMap((group) => selected.get(groupKey(group))).map((row) => [row.id, brief(row)])).values()];
    }
    const projectGroups = groups.map((group) => {
      const key = groupKey(group), count = counts.get(key) || 0;
      const cursor = context.view === "groups" && count < group.sessions.length ? encodeCursor(snapshot, context, key, count) : null;
      if (context.group === key) nextCursor = cursor;
      return { ...group, sessions: selected.get(key).map(brief), catalogPage: { total: group.sessions.length,
        running: group.sessions.filter(running).length, nextCursor: cursor } };
    });
    const sessionsTotal = new Set(groups.flatMap((group) => group.sessions.map((row) => row.id))).size;
    return { catalogFormat: "paged-v1", revision: snapshot.revision, view: context.view, query: context.query, sessions, projectGroups,
      ...(snapshot.sidebarPreferences ? { sidebarPreferences: snapshot.sidebarPreferences } : {}),
      ...(snapshot.sidebarStatus ? { sidebarStatus: snapshot.sidebarStatus } : {}),
      catalogPage: { total: context.group ? groups.find((group) => groupKey(group) === context.group).sessions.length
        : context.view === "activity" ? activities.length : sessionsTotal,
      runningTotal: activities.filter(running).length, sessionsTotal, activitiesTotal: activities.length, nextCursor,
      degraded: snapshot.sidebarStatus?.degraded === true } };
  }
  return { read };
}
