import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildDesktopSidebarSnapshot, desktopProjectIdMap, hasDesktopProjectMetadata, normalizeSidebarPath } from "./codexDesktopSidebar.js";
import { createSidebarReadRuntime } from "./sidebar-read-runtime.js";

const THREAD_COLUMNS = ["id", "cwd", "title", "name", "preview", "created_at", "updated_at", "created_at_ms", "updated_at_ms", "recency_at", "recency_at_ms", "archived", "archived_at", "source", "thread_source", "ephemeral", "agent_path", "agent_role", "agent_nickname", "parent_thread_id", "git_branch", "model", "project_id", "is_pinned"];

function sqlite3Json(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-readonly", "-cmd", ".timeout 2000", "-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : [];
}

export class CodexSidebarService {
  constructor(config, { readerOptions = {} } = {}) {
    this.config = config;
    this.globalStatePath = config.codexGlobalStatePath || path.join(config.home, ".codex", ".codex-global-state.json");
    this.stateDbPath = config.codexStateDbPath || path.join(config.home, ".codex", "state_5.sqlite");
    this.lastThreads = [];
    this.lastReadError = "";
    this.lastGlobalState = {};
    this.lastGlobalReadError = "";
    this.readRuntime = createSidebarReadRuntime({ ...readerOptions, globalStatePath: this.globalStatePath,
      stateDbPath: this.stateDbPath, columns: THREAD_COLUMNS, publish: (kind, { value, error }) => {
        if (kind === "global") {
          if (!error) this.lastGlobalState = value;
          this.lastGlobalReadError = error ? "Codex project metadata could not be read" : "";
        } else {
          if (!error) this.lastThreads = value;
          this.lastReadError = !error ? "" : error.code === "ENOENT" ? "Codex state database is unavailable"
            : /TIMEOUT/.test(error.code || "") ? "Codex state database read timed out" : "Codex state database could not be read";
        }
      } });
  }

  loadGlobalState() {
    this.readRuntime.invalidate("global");
    try {
      const state = JSON.parse(fs.readFileSync(this.globalStatePath, "utf8"));
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid global state");
      this.lastGlobalState = state;
      this.lastGlobalReadError = "";
      return state;
    } catch {
      this.lastGlobalReadError = "Codex project metadata could not be read";
      return this.lastGlobalState;
    }
  }

  resolveProjectId(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return "";
    const state = this.loadGlobalState();
    const mapping = desktopProjectIdMap(state, path.dirname(this.globalStatePath));
    if (hasDesktopProjectMetadata(state)) {
      const knownIds = new Set([
        ...Object.keys(state["local-projects"]),
        ...Object.values(state["local-projects"]).map((project) => String(project?.id || "").trim()),
        ...Object.values(mapping)
      ]);
      if (!knownIds.has(id)) throw new Error("Codex project is no longer available. Refresh the session list.");
    }
    return String(mapping[id] || id).trim();
  }

  loadThreads() {
    this.readRuntime.invalidate("threads");
    this.lastReadError = "";
    if (!fs.existsSync(this.stateDbPath)) {
      this.lastReadError = "Codex state database is unavailable";
      return this.lastThreads;
    }
    try {
      const columns = new Set(sqlite3Json(this.stateDbPath, "pragma table_info(threads)").map((column) => column.name));
      if (!columns.has("id")) throw new Error("Codex threads table is unavailable");
      const fields = THREAD_COLUMNS.map((column) => columns.has(column) ? `"${column}"` : `null as "${column}"`);
      this.lastThreads = sqlite3Json(this.stateDbPath, `select ${fields.join(", ")} from threads`);
      return this.lastThreads;
    } catch (error) {
      this.lastReadError = error.code === "ETIMEDOUT" ? "Codex state database read timed out" : "Codex state database could not be read";
      return this.lastThreads;
    }
  }

  getDesktopSnapshot(liveSessions = []) {
    const globalState = this.loadGlobalState();
    if (!hasDesktopProjectMetadata(globalState)) return null;
    this.loadThreads();
    return this.buildDesktopSnapshot(liveSessions);
  }

  buildDesktopSnapshot(liveSessions = []) {
    const globalState = this.lastGlobalState;
    if (!hasDesktopProjectMetadata(globalState)) return null;
    const snapshot = buildDesktopSidebarSnapshot({
      globalState,
      threads: this.lastThreads,
      liveSessions,
      codexHome: path.dirname(this.globalStatePath)
    });
    const warnings = [this.lastGlobalReadError, this.lastReadError].filter(Boolean);
    return {
      ...snapshot,
      sidebarStatus: { source: "codex_desktop", degraded: warnings.length > 0, warnings }
    };
  }

  async getDesktopSnapshotAsync(liveSessions = []) {
    await this.readRuntime.readGlobal();
    if (!hasDesktopProjectMetadata(this.lastGlobalState)) return null;
    await this.readRuntime.readThreads();
    return this.buildDesktopSnapshot(typeof liveSessions === "function" ? liveSessions() : liveSessions);
  }

  async listProjectGroupsAsync() {
    const desktop = await this.getDesktopSnapshotAsync();
    if (desktop) return desktop.projectGroups;
    if (!this.legacyProjectRoots().length) return [];
    await this.readRuntime.readThreads();
    return this.buildLegacyProjectGroups(this.lastThreads);
  }

  legacyProjectRoots() {
    const globalState = this.lastGlobalState;
    return [...new Set([
      ...(Array.isArray(globalState["project-order"]) ? globalState["project-order"] : []),
      ...(Array.isArray(globalState["electron-saved-workspace-roots"]) ? globalState["electron-saved-workspace-roots"] : [])
    ].filter((root) => typeof root === "string" && path.isAbsolute(root)).map(normalizeSidebarPath))];
  }

  listProjectGroups() {
    const desktop = this.getDesktopSnapshot();
    if (desktop) return desktop.projectGroups;
    this.loadGlobalState();
    return this.buildLegacyProjectGroups(this.legacyProjectRoots().length ? this.loadThreads() : []);
  }

  buildLegacyProjectGroups(threads) {
    const globalState = this.lastGlobalState;
    const roots = this.legacyProjectRoots();
    if (!roots.length) return [];
    const collapsed = globalState["electron-persisted-atom-state"]?.["sidebar-collapsed-groups"] || {};
    const snapshot = buildDesktopSidebarSnapshot({
      globalState: {
        ...globalState,
        "local-projects": Object.fromEntries(roots.map((root) => [root, { id: root, name: path.basename(root) || root, rootPaths: [root] }])),
        "project-order": roots
      },
      threads
    });
    return snapshot.projectGroups.filter((group) => group.groupKind === "project").map((group) => ({ ...group, collapsed: Boolean(collapsed[group.projectRoot]) }));
  }

  close() { return this.readRuntime.close(); }
}
