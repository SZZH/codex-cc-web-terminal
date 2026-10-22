import path from "node:path";

const text = (value) => String(value ?? "").trim();
const values = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const unique = (items) => [...new Set(items.map(text).filter(Boolean))];

export function normalizeSidebarPath(value) {
  const normalized = text(value);
  return normalized ? path.resolve(normalized) : "";
}

function containsPath(cwd, root) {
  if (!cwd || !root) return false;
  const relative = path.relative(root, cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isVisibleSidebarSession(session = {}) {
  const source = text(session.source).toLowerCase();
  const threadSource = text(session.thread_source || session.threadSource).toLowerCase();
  const role = text(session.agent_role || session.agentRole).toLowerCase();
  const agentPath = text(session.agent_path || session.agentPath);
  return !session.archived && !session.archivedAt && !session.archived_at &&
    text(session.kind).toLowerCase() !== "archived" && text(session.status).toLowerCase() !== "archived" &&
    session.ephemeral !== true && session.ephemeral !== 1 &&
    !/sub_?agent|guardian|auto_review|ambient_suggestions/.test(source) &&
    !/guardian|auto_review/.test(role) &&
    !text(session.parent_thread_id || session.parentThreadId) && (!agentPath || agentPath === "/root") &&
    !/sub_?agent|guardian|auto_review|ambient_suggestions/.test(threadSource) &&
    text(session.sessionType) !== "subagent";
}

export function hasDesktopProjectMetadata(globalState = {}) {
  return Object.hasOwn(globalState, "local-projects") &&
    globalState["local-projects"] != null && typeof globalState["local-projects"] === "object" &&
    !Array.isArray(globalState["local-projects"]);
}

function timestamp(milliseconds, seconds, fallback = "") {
  const ms = Number(milliseconds) > 0 ? Number(milliseconds) : Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return text(fallback);
  return new Date(ms).toISOString();
}

function updatedAtDesc(left, right) {
  return text(right.updatedAt).localeCompare(text(left.updatedAt));
}

function sortByOrder(items, order, identity) {
  const positions = new Map(unique(order).map((id, index) => [id, index]));
  return [...items].sort((left, right) =>
    (positions.get(identity(left)) ?? Infinity) - (positions.get(identity(right)) ?? Infinity));
}

function threadIdFromKey(key) {
  const normalized = text(key);
  return normalized.startsWith("codex:thread:local:") ? normalized.slice(19) : normalized;
}

function projectIdFromKey(key) {
  return text(key).replace(/^codex:project:/, "");
}

export function desktopSidebarPreferences(globalState = {}) {
  const atoms = record(globalState["electron-persisted-atom-state"]);
  const legacy = record(atoms["flat-project-sidebar-preferences-v1"]);
  const normalizeMode = (mode) => mode === "manual" && legacy.manualSortVersion === 1 ? "manual" : "updated_at";
  const forceUpdatedAt = atoms["codex-sidebar-sort-mode-v1"] != null;
  return {
    grouping: ["project", "connection", "list"].includes(legacy.mode) ? legacy.mode : "project",
    chats: forceUpdatedAt ? "updated_at" : normalizeMode(legacy.chatSortMode),
    projects: forceUpdatedAt ? "updated_at" : normalizeMode(legacy.projectSortMode),
    pinned: atoms["pinned-sidebar-sort-mode-v1"] === "updated_at" || atoms["pinned-sidebar-sort-mode-v1"] === "priority"
      ? "updated_at" : "manual"
  };
}

export function desktopProjectIdMap(globalState, codexHome) {
  const byHost = record(globalState["app-server-project-id-by-legacy-project-id-by-host"]);
  return record(byHost[`local:${codexHome}`] || byHost.local);
}

function makeSession(thread) {
  const id = text(thread.id);
  return {
    id: `history:codex:${id}`,
    threadId: id,
    provider: "codex",
    providerLabel: "Codex",
    cliLabel: "Codex CLI",
    name: text(thread.name) || text(thread.title),
    cwd: normalizeSidebarPath(thread.cwd),
    kind: "history",
    status: "saved",
    createdAt: timestamp(thread.created_at_ms, thread.created_at),
    updatedAt: Number(thread.recency_at_ms) > 0 || Number(thread.recency_at) > 0
      ? timestamp(thread.recency_at_ms, thread.recency_at)
      : timestamp(thread.updated_at_ms, thread.updated_at),
    exitCode: null,
    autoNamed: false,
    inputPreview: text(thread.preview),
    resumeSessionId: id,
    model: text(thread.model),
    titleSource: "codex_state_db",
    sessionType: "main",
    parentThreadId: "",
    agentRole: text(thread.agent_role),
    agentNickname: text(thread.agent_nickname)
  };
}

function bestProjectForCwd(cwd, projects) {
  const normalized = normalizeSidebarPath(cwd);
  let longest = -1;
  let matches = [];
  for (const project of projects) {
    for (const root of project.rootPaths) {
      if (!containsPath(normalized, root) || root.length < longest) continue;
      if (root.length > longest) {
        longest = root.length;
        matches = [];
      }
      if (!matches.includes(project.projectId)) matches.push(project.projectId);
    }
  }
  return matches.length === 1 ? matches[0] : "";
}

function sortSessions(sessions, mode, order = []) {
  const sorted = [...sessions].sort(updatedAtDesc);
  return mode === "manual" ? sortByOrder(sorted, order.map(threadIdFromKey), (session) => session.resumeSessionId || session.id) : sorted;
}

export function buildDesktopSidebarSnapshot({ globalState = {}, threads = [], liveSessions = [], codexHome = "" } = {}) {
  const atoms = record(globalState["electron-persisted-atom-state"]);
  const preferences = desktopSidebarPreferences(globalState);
  const aliases = new Map(Object.entries(desktopProjectIdMap(globalState, codexHome)).map(([legacyId, serverId]) => [text(serverId), legacyId]));
  const normalizeProjectId = (id) => aliases.get(text(id)) || text(id);
  const collapsed = record(atoms["sidebar-collapsed-groups"]);
  const projects = Object.entries(record(globalState["local-projects"])).flatMap(([key, raw]) => {
    const project = record(raw);
    const projectId = text(project.id) || key;
    if (!projectId) return [];
    const rootPaths = unique(values(project.rootPaths).map(normalizeSidebarPath));
    return [{
      id: `project:${projectId}`,
      groupKind: "project",
      projectId,
      name: text(project.name) || projectId,
      rootPaths,
      projectRoot: rootPaths[0] || "",
      cwd: rootPaths[0] || "",
      createdAt: project.createdAt ?? null,
      updatedAt: project.updatedAt ?? null,
      collapsed: typeof atoms[`sidebar-project-expanded-v1-codex:${projectId}`] === "boolean"
        ? !atoms[`sidebar-project-expanded-v1-codex:${projectId}`]
        : typeof atoms[`sidebar-project-expanded-v1-codex:${rootPaths[0]}`] === "boolean"
          ? !atoms[`sidebar-project-expanded-v1-codex:${rootPaths[0]}`]
          : Boolean(collapsed[projectId] ?? collapsed[rootPaths[0]]),
      sessions: []
    }];
  });
  const projectOrder = unique([
    ...values(atoms["unified-sidebar-project-order-v1"]).filter((key) => text(key).startsWith("codex:project:")).map(projectIdFromKey),
    ...values(globalState["project-order"])
  ]).map(normalizeProjectId);
  const orderedProjects = sortByOrder(projects, projectOrder, (project) => project.projectId);
  const projectsById = new Map(orderedProjects.map((project) => [project.projectId, project]));
  const assignments = record(globalState["thread-project-assignments"]);
  const projectlessIds = new Set(values(globalState["projectless-thread-ids"]).map(text));
  const workspaceHints = record(globalState["thread-workspace-root-hints"]);
  const pinnedIds = unique([
    ...values(atoms["unified-sidebar-pinned-order-v1"]).filter((key) => text(key).startsWith("codex:thread:local:")).map(threadIdFromKey),
    ...values(atoms["app-server-pinned-thread-order-v1"]),
    ...values(globalState["pinned-thread-ids"])
  ]);
  const pinnedSet = new Set([
    ...values(globalState["pinned-thread-ids"]).map(text),
    ...threads.filter((thread) => thread.is_pinned === true || thread.is_pinned === 1).map((thread) => text(thread.id))
  ]);
  const pinnedProjectIds = unique([
    ...values(atoms["unified-sidebar-pinned-order-v1"]).filter((key) => text(key).startsWith("codex:project:")).map(projectIdFromKey),
    ...values(globalState["pinned-project-ids"])
  ]).map(normalizeProjectId);
  const pinnedProjectSet = new Set(values(globalState["pinned-project-ids"]).map(normalizeProjectId));
  const knownThreads = new Map(threads.map((thread) => [text(thread.id), thread]));
  const sessions = new Map();
  for (const thread of threads) {
    if (text(thread.id) && isVisibleSidebarSession(thread)) sessions.set(text(thread.id), makeSession(thread));
  }
  for (const live of liveSessions) {
    if (text(live.provider || "codex") !== "codex" || !isVisibleSidebarSession(live)) continue;
    const id = text(live.resumeSessionId || live.threadId || live.id);
    const persisted = sessions.get(id);
    if (knownThreads.has(id) && !persisted) continue;
    if (persisted?.kind === "live" && updatedAtDesc(live, persisted) >= 0) continue;
    sessions.set(id, {
      ...persisted,
      ...live,
      name: persisted?.name || text(live.name),
      updatedAt: [persisted?.updatedAt, live.updatedAt].filter(Boolean).sort().at(-1) || "",
      kind: "live"
    });
  }

  const pinned = { id: "pinned:codex", groupKind: "pinned", name: "置顶", cwd: "", sessions: [] };
  const recent = { id: "recent:codex", groupKind: "recent", name: "最近会话", cwd: "", sessions: [] };
  for (const [threadId, session] of sessions) {
    const assignment = record(assignments[threadId]);
    let projectId = "";
    if (Object.hasOwn(assignments, threadId)) {
      projectId = assignment.projectKind === "local" ? normalizeProjectId(assignment.projectId) : "";
    } else if (!projectlessIds.has(threadId)) {
      const dbProjectId = text(knownThreads.get(threadId)?.project_id);
      projectId = dbProjectId ? normalizeProjectId(dbProjectId)
        : normalizeProjectId(session.projectId) || bestProjectForCwd(workspaceHints[threadId] || session.cwd, orderedProjects);
    }
    const project = projectsById.get(projectId);
    session.projectId = project?.projectId || "";
    if (pinnedSet.has(threadId)) pinned.sessions.push(session);
    else if (project) project.sessions.push(session);
    else recent.sessions.push(session);
  }

  const manualOrders = record(globalState["sidebar-project-thread-orders"]);
  for (const project of orderedProjects) {
    project.pinned = pinnedProjectSet.has(project.projectId);
    project.sessions = sortSessions(project.sessions, preferences.projects, values(manualOrders[project.projectId]?.threadIds));
  }
  pinned.sessions = sortSessions(pinned.sessions, preferences.pinned, pinnedIds);
  recent.sessions = sortSessions(recent.sessions, preferences.chats, values(atoms["unified-sidebar-chat-order-v1"]));
  const projectGroups = [
    ...(pinned.sessions.length ? [pinned] : []),
    ...sortByOrder(orderedProjects.filter((project) => project.pinned), pinnedProjectIds, (project) => project.projectId),
    ...orderedProjects.filter((project) => !project.pinned),
    ...(recent.sessions.length ? [recent] : [])
  ].map((group, order) => ({ ...group, order }));
  return { sessions: projectGroups.flatMap((group) => group.sessions), projectGroups, sidebarPreferences: preferences };
}
