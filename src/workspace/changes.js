import fs from "node:fs/promises";
import path from "node:path";

export const MAX_DIFF_BYTES = 500_000;

export function normalizeChangeReadOptions({ summary = false, paths } = {}) {
  if (typeof summary !== "boolean") throw new Error("Invalid change summary option");
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 50)) throw new Error("Invalid file paths");
  const selected = paths?.map((value) => {
    if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)
      || value.split(process.platform === "win32" ? /[\\/]/ : /\//).some((part) => !part || part === "." || part === "..")) throw new Error("Invalid file path");
    return value;
  });
  return { summary, paths: selected ? [...new Set(selected)].sort() : undefined };
}

export function parseStatusEntries(raw) {
  const tokens = String(raw || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const rest = token.slice(3);
    if (!rest) {
      continue;
    }
    if (/[RC]/.test(status)) {
      const previousPath = tokens[index + 1] || rest;
      entries.push({ status, path: rest, previousPath });
      index += 1;
      continue;
    }
    entries.push({ status, path: rest, previousPath: "" });
  }
  return entries;
}

function parseNumstat(raw) {
  const stats = new Map();
  const tokens = String(raw || "").split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]);
    if (!match) continue;
    const [, added, deleted, name] = match;
    // NUL-delimited rename records carry the old and new names separately.
    const filePath = name || tokens[index + 2];
    if (!name) index += 2;
    if (!filePath) continue;
    const statsKnown = added !== "-" && deleted !== "-";
    stats.set(filePath, {
      additions: statsKnown ? Number(added) : null,
      deletions: statsKnown ? Number(deleted) : null,
      statsKnown
    });
  }
  return stats;
}


function summarizeDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

async function readFileDiff(context, entry, hasHead, git) {
  if (entry.status === "??" || !hasHead) {
    const absolute = path.resolve(context.cwd, entry.path);
    if (!absolute.startsWith(context.cwd + path.sep)) return "";
    const stat = await fs.lstat(absolute).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    return stat?.isFile() || stat?.isSymbolicLink()
      ? (await git(context, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", entry.path], { acceptedExitCodes: [0, 1] })).stdout : "";
  }
  return (await git(context, ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", entry.path])).stdout;
}

export async function readWorkspaceChanges(context, git, options = {}) {
  const { summary, paths } = normalizeChangeReadOptions(options);
  const cwd = context.cwd;
  const capabilities = { liveChanges: context.isGitRepo, applyPatch: true, gitRevert: context.isGitRepo };
  if (!context.isGitRepo) return { cwd, isGitRepo: false, capabilities, total: 0, additions: 0, deletions: 0, files: [] };
  const [status, head] = await Promise.all([
    git(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(context, ["rev-parse", "--verify", "--quiet", "HEAD"], { acceptedExitCodes: [0, 1] })
  ]);
  const requested = paths && new Set(paths);
  const entries = parseStatusEntries(status.stdout).filter((entry) => !requested || requested.has(entry.path));
  const statPaths = paths ? [...new Set(entries.flatMap((entry) => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]))] : [];
  const readStats = async () => head.status === 0 && entries.length
    ? parseNumstat((await git(context, ["diff", "--no-ext-diff", "--numstat", "-z", "HEAD", "--", ...statPaths])).stdout) : new Map();
  let numstat = summary ? await readStats() : new Map();
  const files = [];
  for (let offset = 0; offset < entries.length; offset += 2) {
    const batch = entries.slice(offset, offset + 2);
    let diffs;
    if (summary) diffs = batch.map(() => "");
    else if (!offset) {
      const [stats, ...results] = await Promise.all([readStats(), ...batch.map((entry) => readFileDiff(context, entry, head.status === 0, git))]);
      numstat = stats;
      diffs = results;
    } else diffs = await Promise.all(batch.map((entry) => readFileDiff(context, entry, head.status === 0, git)));
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const diff = diffs[index];
      const unknown = { additions: null, deletions: null, statsKnown: false };
      const fallback = summary ? entry.status !== "??" && head.status === 0
        ? { additions: 0, deletions: 0, statsKnown: true } : unknown
        : /^(?:Binary files |GIT binary patch)/m.test(diff) ? unknown : { ...summarizeDiff(diff), statsKnown: true };
      files.push({ ...entry, ...(numstat.get(entry.path) || fallback), diff,
        detailsLoaded: !summary, truncated: Buffer.byteLength(diff, "utf8") >= MAX_DIFF_BYTES });
    }
  }
  return { cwd, isGitRepo: true, capabilities, total: files.length,
    statsKnown: files.every((file) => file.statsKnown),
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0), files };
}

export async function revertWorkspaceFiles(context, paths, git) {
  if (!context.isGitRepo) throw new Error("Workspace is not a git repository");
  if (Array.isArray(paths) && paths.some((item) => typeof item !== "string" || !item.length)) throw new Error("Invalid file path");
  const current = await readWorkspaceChanges(context, git);
  const requested = new Set(Array.isArray(paths) ? paths : []);
  const targets = requested.size ? current.files.filter((file) => requested.has(file.path)) : current.files;
  const tracked = targets.filter((file) => file.status !== "??");
  if (tracked.length) {
    if ((await git(context, ["rev-parse", "--verify", "--quiet", "HEAD"], { acceptedExitCodes: [0, 1] })).status !== 0) throw new Error("Workspace has no committed HEAD to restore");
    const paths = [...new Set(tracked.flatMap((file) => file.status.includes("R") && file.previousPath ? [file.path, file.previousPath] : [file.path]))];
    await git(context, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], { mutates: true });
  }
  for (const file of targets.filter((file) => file.status === "??")) {
    const absolute = path.resolve(context.cwd, file.path);
    if (!absolute.startsWith(context.cwd + path.sep)) throw new Error("Refusing to remove path outside workspace");
    await context.mutate(() => fs.rm(absolute, { recursive: true, force: true }));
  }
  return { ...await readWorkspaceChanges(context, git), reverted: targets.map((file) => file.path) };
}

