import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { filterSidebarSessionsByRecency } from "./sessionSidebarSnapshot.js";

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    return path.resolve(text);
  } catch {
    return text;
  }
}

function uniquePaths(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizePath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function basenameLabel(projectRoot) {
  const normalized = normalizePath(projectRoot);
  return normalized ? path.basename(normalized) || normalized : "";
}

function isSubpathOf(targetPath, rootPath) {
  const target = normalizePath(targetPath);
  const root = normalizePath(rootPath);
  if (!target || !root) {
    return false;
  }
  if (target === root) {
    return true;
  }
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function bestProjectRootForCwd(cwd, projectRoots) {
  const matches = projectRoots.filter((rootPath) => isSubpathOf(cwd, rootPath));
  return matches.sort((left, right) => right.length - left.length)[0] || "";
}

function sqlite3Json(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : [];
}

function readGitBranch(cwd) {
  const target = normalizePath(cwd);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return "";
  }
  try {
    return String(
      execFileSync("git", ["-C", target, "branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }) || ""
    ).trim();
  } catch {
    return "";
  }
}

export class CodexSidebarService {
  constructor(config) {
    this.config = config;
    this.globalStatePath =
      this.config.codexGlobalStatePath || path.join(this.config.home, ".codex", ".codex-global-state.json");
    this.stateDbPath = this.config.codexStateDbPath || path.join(this.config.home, ".codex", "state_5.sqlite");
  }

  loadGlobalState() {
    return readJsonFile(this.globalStatePath, {});
  }

  loadThreads() {
    if (!fs.existsSync(this.stateDbPath)) {
      return [];
    }
    try {
      return sqlite3Json(
        this.stateDbPath,
        [
          "select id, cwd, title, updated_at, archived, source, agent_path, agent_role, agent_nickname, git_branch",
          "from threads",
          "where archived = 0",
          "order by updated_at desc"
        ].join(" ")
      );
    } catch {
      return [];
    }
  }

  listProjectGroups() {
    const globalState = this.loadGlobalState();
    const orderedRoots = uniquePaths(globalState["project-order"] || []);
    const savedRoots = uniquePaths(globalState["electron-saved-workspace-roots"] || []);
    const projectRoots = uniquePaths([...orderedRoots, ...savedRoots]);
    if (!projectRoots.length) {
      return [];
    }

    const collapsedGroups = globalState["electron-persisted-atom-state"]?.["sidebar-collapsed-groups"] || {};
    const threads = this.loadThreads();
    const branchByRoot = new Map(projectRoots.map((projectRoot) => [projectRoot, readGitBranch(projectRoot)]));
    const groups = new Map(
      projectRoots.map((projectRoot) => [
        projectRoot,
        {
          id: `project:${projectRoot}`,
          name: basenameLabel(projectRoot),
          projectRoot,
          cwd: projectRoot,
          collapsed: Boolean(collapsedGroups[projectRoot]),
          sessions: []
        }
      ])
    );

    for (const thread of threads) {
      if (String(thread.source || "").trim() !== "vscode") {
        continue;
      }
      const projectRoot = bestProjectRootForCwd(thread.cwd, projectRoots);
      if (!projectRoot || !groups.has(projectRoot)) {
        continue;
      }
      const activeBranch = String(branchByRoot.get(projectRoot) || "").trim();
      const threadBranch = String(thread.git_branch || "").trim();
      if (activeBranch && threadBranch && activeBranch !== threadBranch) {
        continue;
      }
      groups.get(projectRoot).sessions.push({
        id: `history:codex:${String(thread.id || "").trim()}`,
        threadId: String(thread.id || "").trim(),
        provider: "codex",
        providerLabel: "Codex",
        cliLabel: "Codex CLI",
        name: String(thread.title || "").trim(),
        cwd: normalizePath(thread.cwd),
        kind: "history",
        status: "saved",
        createdAt: "",
        updatedAt: new Date(Number(thread.updated_at || 0) * 1000).toISOString(),
        exitCode: null,
        autoNamed: false,
        inputPreview: "",
        resumeSessionId: String(thread.id || "").trim(),
        model: "",
        titleSource: "codex_state_db",
        sessionType: String(thread.agent_path || "").trim() ? "subagent" : "main",
        parentThreadId: "",
        agentRole: String(thread.agent_role || "").trim(),
        agentNickname: String(thread.agent_nickname || "").trim()
      });
    }

    return projectRoots.map((projectRoot) => {
      const group = groups.get(projectRoot);
      group.sessions = filterSidebarSessionsByRecency(group.sessions).sort((left, right) =>
        String(right.updatedAt).localeCompare(String(left.updatedAt))
      );
      return group;
    });
  }
}
