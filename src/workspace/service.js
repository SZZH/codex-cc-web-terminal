import path from "node:path";
import { createWorkspaceCommandRunner } from "./command.js";
import { createWorkspaceJobs } from "./jobs.js";
import { readGitBranches, checkoutBranch, createBranch } from "./branches.js";
import { readWorkspaceChanges, revertWorkspaceFiles, normalizeChangeReadOptions, MAX_DIFF_BYTES } from "./changes.js";
import { applyWorkspacePatch, normalizePatchPath } from "./patches.js";

export function createWorkspaceService({ gitBin = "git", patchBin = "patch", runnerOptions = {}, jobOptions = {} } = {}) {
  const runner = createWorkspaceCommandRunner(runnerOptions);
  const git = (context, args, options = {}) => context.runCommand(gitBin, args, {
    cwd: context.cwd, maxBuffer: MAX_DIFF_BYTES, timeoutMs: options.mutates ? 10000 : 5000, ...options,
    env: { ...options.env, GIT_LITERAL_PATHSPECS: "1" }
  });
  const changesContext = (context) => context.isGitRepo ? Object.assign(Object.create(context), { cwd: context.repoRoot }) : context;
  const jobs = createWorkspaceJobs({ runner, ...jobOptions, resolveWorkspace: async (cwd, context) => {
    try {
      const result = await git(context, ["rev-parse", "--show-toplevel"], { cwd });
      return { repoRoot: result.stdout.trim() || cwd, isGitRepo: true };
    } catch (error) {
      if (error.code !== "WORKSPACE_COMMAND_EXIT" || error.status !== 128 || !/not a git repository/i.test(error.stderr || "")) throw error;
      // All ordinary directories on a volume share a lock, including parent/child selections.
      return { repoRoot: path.parse(cwd).root, isGitRepo: false };
    }
  } });
  const run = (cwd, operation, args, mode, fn, options = {}) => jobs.run({
    cwd, operation, args, mode, timeoutMs: operation === "branches" ? 5000 : 15000, ...options
  }, fn).then((result) => result && !result.isGitRepo
    ? { ...result, cwd: path.resolve(String(cwd)) } : result);
  const applyPatch = (cwd, files, direction = "reverse", options) => run(cwd, "patch", [files, direction], "write", async (context) => {
    const normalized = await applyWorkspacePatch(context, files, direction, { git, patchBin });
    return { ...await readWorkspaceChanges(changesContext(context), git), direction: normalized,
      reverted: normalized === "reverse" ? files.map((file) => normalizePatchPath(file.path)).filter(Boolean) : [],
      restored: normalized === "forward" ? files.map((file) => normalizePatchPath(file.path)).filter(Boolean) : [] };
  }, options);
  return {
    listWorkspaceChanges: async (cwd, options = {}) => {
      const { summary, paths, ...jobOptions } = options;
      const readOptions = normalizeChangeReadOptions({ summary, paths });
      return run(cwd, "changes", [readOptions], "read", (context) => readWorkspaceChanges(changesContext(context), git, readOptions), jobOptions);
    },
    listGitBranches: (cwd, options) => run(cwd, "branches", [], "read", (context) => readGitBranches(context, git), options),
    revertWorkspaceChanges: (cwd, paths, options) => run(cwd, "revert", paths, "write", (context) => revertWorkspaceFiles(changesContext(context), paths, git), options),
    applyPatchWorkspaceChanges: applyPatch,
    reversePatchWorkspaceChanges: (cwd, files, options) => applyPatch(cwd, files, "reverse", options),
    checkoutGitBranch: (cwd, branch, options) => run(cwd, "checkout", [branch], "write", (context) => checkoutBranch(context, branch, git), options),
    createGitBranch: (cwd, branch, createOptions, options) => run(cwd, "create", [branch, createOptions], "write", (context) => createBranch(context, branch, createOptions, git), options),
    close: () => jobs.close(),
    stats: () => ({ jobs: jobs.getStats(), commands: runner.getStats() })
  };
}

export const defaultWorkspaceService = createWorkspaceService();

export function workspaceErrorResponse(error) {
  const code = error?.code || "WORKSPACE_FAILED";
  const executionState = ["not-applied", "applied", "unknown"].includes(error?.executionState) ? error.executionState : "not-applied";
  const status = code === "DIRTY_WORKTREE" ? 409 : /TIMEOUT/.test(code) ? 504 : /QUEUE_FULL|CLOSED/.test(code) ? 503 : executionState === "applied" ? 502 : 400;
  return { status, body: { error: error?.message || String(error), code, executionState, ...(code === "DIRTY_WORKTREE" ? { dirty: true } : {}) } };
}
