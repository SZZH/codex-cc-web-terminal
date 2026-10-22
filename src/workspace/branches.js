function normalizeBranchName(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.startsWith("-") || /[\0-\x1f\x7f\s~^:?*\[]/.test(branch) || branch.includes("..") || branch.includes("@{")) {
    throw new Error("Invalid branch name");
  }
  return branch;
}

export async function readGitBranches(context, git) {
  const repo = { cwd: context.isGitRepo ? context.repoRoot : context.cwd, isGitRepo: context.isGitRepo };
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
  const [current, refs, status] = await Promise.all([
    git(context, ["branch", "--show-current"], { cwd: workspace }),
    git(context, ["for-each-ref", "--format=%(refname:short)\t%(refname)\t%(HEAD)", "refs/heads", "refs/remotes"], { cwd: workspace }),
    git(context, ["status", "--porcelain"], { cwd: workspace })
  ]);
  const currentBranch = current.stdout.trim();
  const branchLines = refs.stdout;
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
  const dirty = Boolean(status.stdout.trim());
  return {
    ok: true,
    cwd: workspace,
    isGitRepo: true,
    currentBranch,
    dirty,
    branches
  };
}

export async function checkoutBranch(context, branch, git) {
  const targetBranch = normalizeBranchName(branch);
  const state = await readGitBranches(context, git);
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
  await git(context, ["switch", targetBranch], { cwd: state.cwd, mutates: true });
  return readGitBranches(context, git);
}

export async function createBranch(context, branch, { checkout = true, startPoint = "" } = {}, git) {
  const targetBranch = normalizeBranchName(branch);
  const state = await readGitBranches(context, git);
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
  if (normalizedStartPoint.startsWith("-") || /[\0\r\n]/.test(normalizedStartPoint)) throw new Error("Invalid branch start point");
  if (normalizedStartPoint) {
    args.push(normalizedStartPoint);
  }
  await git(context, args, { cwd: state.cwd, mutates: true });
  return readGitBranches(context, git);
}


