import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const MAX_DIFF_BYTES = 500_000;

function normalizeWorkspacePath(cwd) {
  const resolved = String(cwd || "").trim();
  return resolved ? path.resolve(resolved) : "";
}

function assertWorkspaceDirectory(cwd) {
  const workspace = normalizeWorkspacePath(cwd);
  if (!workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error("Invalid workspace path");
  }
  return workspace;
}

function assertWorkspace(cwd) {
  const workspace = assertWorkspaceDirectory(cwd);
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return workspace;
}

function runGit(cwd, args, { allowFailure = false, maxBuffer = MAX_DIFF_BYTES, input = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return {
    status: result.status ?? 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function runCommand(cwd, command, args, { input = "", allowFailure = false, maxBuffer = MAX_DIFF_BYTES } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(String(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`).trim());
  }
  return {
    status: result.status ?? 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function parseStatusEntries(raw) {
  const tokens = String(raw || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const rest = token.slice(3);
    if (!rest) {
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const nextPath = tokens[index + 1] || rest;
      entries.push({ status, path: nextPath, previousPath: rest });
      index += 1;
      continue;
    }
    entries.push({ status, path: rest, previousPath: "" });
  }
  return entries;
}

function parseNumstat(raw) {
  const stats = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [added, deleted, filePath] = line.split("\t");
    if (!filePath) {
      continue;
    }
    stats.set(filePath, {
      additions: Number.parseInt(added, 10) || 0,
      deletions: Number.parseInt(deleted, 10) || 0
    });
  }
  return stats;
}

function getFileDiff(cwd, entry) {
  if (entry.status === "??") {
    const absolute = path.resolve(cwd, entry.path);
    if (!absolute.startsWith(`${cwd}${path.sep}`) && absolute !== cwd) {
      return "";
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return "";
    }
    const result = runGit(cwd, ["diff", "--no-index", "--", "/dev/null", entry.path], {
      allowFailure: true
    });
    return result.stdout || result.stderr || "";
  }

  const diffArgs = ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", entry.path];
  const result = runGit(cwd, diffArgs, { allowFailure: true });
  return result.stdout || "";
}

function summarizeDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function listWorkspaceChanges(cwd) {
  const workspace = assertWorkspace(cwd);
  const statusRaw = runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const entries = parseStatusEntries(statusRaw);
  const numstat = parseNumstat(runGit(workspace, ["diff", "--numstat", "HEAD", "--"], { allowFailure: true }).stdout);

  const files = entries.map((entry) => {
    const diff = getFileDiff(workspace, entry);
    const fallbackStats = summarizeDiff(diff);
    const stat = numstat.get(entry.path) || fallbackStats;
    return {
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      additions: stat.additions,
      deletions: stat.deletions,
      diff,
      truncated: Buffer.byteLength(diff, "utf8") >= MAX_DIFF_BYTES
    };
  });

  return {
    cwd: workspace,
    total: files.length,
    additions: files.reduce((sum, file) => sum + Number(file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + Number(file.deletions || 0), 0),
    files
  };
}

function removeUntrackedPath(cwd, relativePath) {
  const absolute = path.resolve(cwd, relativePath);
  if (!absolute.startsWith(`${cwd}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside workspace: ${relativePath}`);
  }
  if (!fs.existsSync(absolute)) {
    return;
  }
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    fs.rmSync(absolute, { recursive: true, force: true });
    return;
  }
  fs.unlinkSync(absolute);
}

function revertWorkspaceChanges(cwd, paths) {
  const workspace = assertWorkspace(cwd);
  const requested = new Set((Array.isArray(paths) ? paths : []).map((item) => String(item || "").trim()).filter(Boolean));
  const current = listWorkspaceChanges(workspace);
  const targets = requested.size ? current.files.filter((file) => requested.has(file.path)) : current.files;
  if (!targets.length) {
    return { ...current, reverted: [] };
  }

  const untracked = targets.filter((file) => file.status === "??");
  const tracked = targets.filter((file) => file.status !== "??");

  if (tracked.length) {
    runGit(workspace, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked.map((file) => file.path)]);
  }
  for (const file of untracked) {
    removeUntrackedPath(workspace, file.path);
  }

  return {
    ...listWorkspaceChanges(workspace),
    reverted: targets.map((file) => file.path)
  };
}

function normalizePatchPath(filePath = "") {
  const text = String(filePath || "").trim();
  if (!text || path.isAbsolute(text) || text.includes("\0")) {
    return "";
  }
  return text.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function patchNeedsHeader(diff = "") {
  const text = String(diff || "");
  return !/^---\s+/m.test(text) || !/^\+\+\+\s+/m.test(text);
}

function synthesizePatch(file = {}) {
  const filePath = normalizePatchPath(file.path);
  const diff = String(file.diff || "").trimEnd();
  if (!filePath || !diff) {
    return "";
  }
  if (!patchNeedsHeader(diff)) {
    return `${diff}\n`;
  }
  const status = String(file.status || "").trim().toLowerCase();
  const isAdded = status === "??" || status === "a" || status === "add" || status === "added" || status === "create" || status === "created";
  const isDeleted = status === "d" || status === "delete" || status === "deleted" || status === "remove" || status === "removed";
  const fromPath = isAdded ? "/dev/null" : `a/${filePath}`;
  const toPath = isDeleted ? "/dev/null" : `b/${filePath}`;
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- ${fromPath}`,
    `+++ ${toPath}`,
    diff,
    ""
  ].join("\n");
}

function buildReversePatchPayload(files = []) {
  const patches = [];
  for (const file of Array.isArray(files) ? files : []) {
    const patch = synthesizePatch(file);
    if (patch) {
      patches.push(patch);
    }
  }
  if (!patches.length) {
    throw new Error("No reversible file diff found");
  }
  return patches.join("\n");
}

function assertPatchPaths(workspace, files = []) {
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = normalizePatchPath(file?.path);
    if (!filePath) {
      throw new Error(`Invalid file path: ${file?.path || ""}`);
    }
    const absolute = path.resolve(workspace, filePath);
    if (!absolute.startsWith(`${workspace}${path.sep}`) && absolute !== workspace) {
      throw new Error(`Refusing to patch path outside workspace: ${filePath}`);
    }
  }
}

function reversePatchWorkspaceChanges(cwd, files) {
  const workspace = assertWorkspaceDirectory(cwd);
  assertPatchPaths(workspace, files);
  const patch = buildReversePatchPayload(files);
  const repo = probeWorkspaceRepo(workspace);

  if (repo.isGitRepo) {
    runGit(workspace, ["apply", "--reverse", "--check", "-"], { input: patch });
    runGit(workspace, ["apply", "--reverse", "-"], { input: patch });
  } else {
    runCommand(workspace, "patch", ["-R", "-p1", "--dry-run"], { input: patch });
    runCommand(workspace, "patch", ["-R", "-p1"], { input: patch });
  }

  const result = repo.isGitRepo ? listWorkspaceChanges(workspace) : { cwd: workspace, total: 0, additions: 0, deletions: 0, files: [] };
  return {
    ...result,
    reverted: (Array.isArray(files) ? files : []).map((file) => normalizePatchPath(file?.path)).filter(Boolean)
  };
}

function normalizeBranchName(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.startsWith("-") || /[\0-\x1f\x7f\s~^:?*\[]/.test(branch) || branch.includes("..") || branch.includes("@{")) {
    throw new Error("Invalid branch name");
  }
  return branch;
}

function probeWorkspaceRepo(cwd) {
  const workspace = assertWorkspaceDirectory(cwd);
  const result = runGit(workspace, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0) {
    return {
      cwd: workspace,
      isGitRepo: false
    };
  }
  return {
    cwd: String(result.stdout || "").trim() || workspace,
    isGitRepo: true
  };
}

function listGitBranches(cwd) {
  const repo = probeWorkspaceRepo(cwd);
  if (!repo.isGitRepo) {
    return {
      ok: true,
      cwd: repo.cwd,
      isGitRepo: false,
      currentBranch: "",
      dirty: false,
      branches: []
    };
  }

  const workspace = repo.cwd;
  const currentBranch = runGit(workspace, ["branch", "--show-current"], { allowFailure: true }).stdout.trim();
  const branchLines = runGit(
    workspace,
    ["for-each-ref", "--format=%(refname:short)\t%(refname)\t%(HEAD)", "refs/heads", "refs/remotes"],
    { allowFailure: true }
  ).stdout;
  const branches = branchLines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, fullRef, headMarker] = line.split("\t");
      return {
        name: String(name || "").trim(),
        current: String(headMarker || "").trim() === "*",
        remote: String(fullRef || "").includes("refs/remotes/")
      };
    })
    .filter((branch) => {
      const name = String(branch?.name || "").trim();
      return Boolean(name) && !name.endsWith("/HEAD") && name !== "origin";
    });
  branches.sort((left, right) => {
    if (left.current && !right.current) {
      return -1;
    }
    if (!left.current && right.current) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
  const dirty = Boolean(runGit(workspace, ["status", "--porcelain"], { allowFailure: true }).stdout.trim());
  return {
    ok: true,
    cwd: workspace,
    isGitRepo: true,
    currentBranch,
    dirty,
    branches
  };
}

function checkoutGitBranch(cwd, branch) {
  const targetBranch = normalizeBranchName(branch);
  const state = listGitBranches(cwd);
  if (!state.isGitRepo) {
    throw new Error("Workspace is not a git repository");
  }
  if (state.currentBranch === targetBranch) {
    return state;
  }
  if (state.dirty) {
    const error = new Error("Workspace has uncommitted changes");
    error.code = "DIRTY_WORKTREE";
    throw error;
  }
  runGit(state.cwd, ["switch", targetBranch]);
  return listGitBranches(state.cwd);
}

function createGitBranch(cwd, branch, { checkout = true, startPoint = "" } = {}) {
  const targetBranch = normalizeBranchName(branch);
  const state = listGitBranches(cwd);
  if (!state.isGitRepo) {
    throw new Error("Workspace is not a git repository");
  }
  if (checkout && state.dirty) {
    const error = new Error("Workspace has uncommitted changes");
    error.code = "DIRTY_WORKTREE";
    throw error;
  }
  const args = checkout ? ["switch", "-c", targetBranch] : ["branch", targetBranch];
  const normalizedStartPoint = String(startPoint || "").trim();
  if (normalizedStartPoint) {
    args.push(normalizedStartPoint);
  }
  runGit(state.cwd, args);
  return listGitBranches(state.cwd);
}

export async function handleWorkspaceChangesRoute(ctx, runtime) {
  if (ctx.path === "/api/workspace-changes" && ctx.method === "GET") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const url = new URL(ctx.url, "http://localhost");
      runtime.json(ctx, 200, listWorkspaceChanges(url.searchParams.get("cwd")));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/workspace-changes/revert" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, revertWorkspaceChanges(body.cwd, body.paths));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/workspace-changes/reverse-patch" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, reversePatchWorkspaceChanges(body.cwd, body.files));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err), details: err?.stack || "" });
    }
    return true;
  }

  if (ctx.path === "/api/workspace-git" && ctx.method === "GET") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }
    try {
      const url = new URL(ctx.url, "http://localhost");
      runtime.json(ctx, 200, listGitBranches(url.searchParams.get("cwd")));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/workspace-git/checkout" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }
    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, checkoutGitBranch(body.cwd, body.branch));
    } catch (err) {
      const status = err?.code === "DIRTY_WORKTREE" ? 409 : 400;
      runtime.json(ctx, status, { error: err?.message || String(err), dirty: err?.code === "DIRTY_WORKTREE" });
    }
    return true;
  }

  if (ctx.path === "/api/workspace-git/branches" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }
    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, createGitBranch(body.cwd, body.branch, { checkout: body.checkout !== false, startPoint: body.startPoint }));
    } catch (err) {
      const status = err?.code === "DIRTY_WORKTREE" ? 409 : 400;
      runtime.json(ctx, status, { error: err?.message || String(err), dirty: err?.code === "DIRTY_WORKTREE" });
    }
    return true;
  }

  return false;
}

export const workspaceChangesInternals = {
  listWorkspaceChanges,
  revertWorkspaceChanges,
  reversePatchWorkspaceChanges,
  parseStatusEntries,
  listGitBranches,
  checkoutGitBranch,
  createGitBranch
};
