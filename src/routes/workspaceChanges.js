import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const MAX_DIFF_BYTES = 500_000;

function normalizeWorkspacePath(cwd) {
  const resolved = String(cwd || "").trim();
  return resolved ? path.resolve(resolved) : "";
}

function assertWorkspace(cwd) {
  const workspace = normalizeWorkspacePath(cwd);
  if (!workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error("Invalid workspace path");
  }
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return workspace;
}

function runGit(cwd, args, { allowFailure = false, maxBuffer = MAX_DIFF_BYTES } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"]
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

  return false;
}

export const workspaceChangesInternals = {
  listWorkspaceChanges,
  revertWorkspaceChanges,
  parseStatusEntries
};
