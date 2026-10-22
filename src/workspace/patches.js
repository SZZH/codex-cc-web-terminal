import fs from "node:fs/promises";
import path from "node:path";

function normalizePatchPath(filePath = "") {
  const text = String(filePath || "");
  if (!text || path.isAbsolute(text) || /^[A-Za-z]:/.test(text) || /[\0\r\n]/.test(text)) {
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
  const diff = String(file.diff || "");
  if (!filePath || !diff) {
    return "";
  }
  if (!patchNeedsHeader(diff)) {
    return diff.endsWith("\n") ? diff : diff + "\n";
  }
  const status = String(file.status || "").trim().toLowerCase();
  const isAdded = status === "??" || status === "a" || status === "add" || status === "added" || status === "create" || status === "created";
  const isDeleted = status === "d" || status === "delete" || status === "deleted" || status === "remove" || status === "removed";
  const a = /\s|"/.test(filePath) ? JSON.stringify("a/" + filePath) : "a/" + filePath;
  const b = /\s|"/.test(filePath) ? JSON.stringify("b/" + filePath) : "b/" + filePath;
  const fromPath = isAdded ? "/dev/null" : a;
  const toPath = isDeleted ? "/dev/null" : b;
  return [
    `diff --git ${a} ${b}`,
    `--- ${fromPath}`,
    `+++ ${toPath}`,
    diff.endsWith("\n") ? diff : diff + "\n"
  ].join("\n");
}

function buildPatchPayload(files = []) {
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

async function assertPatchPaths(workspace, files = []) {
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = normalizePatchPath(file?.path);
    if (!filePath) {
      throw new Error(`Invalid file path: ${file?.path || ""}`);
    }
    const absolute = path.resolve(workspace, filePath);
    if (!absolute.startsWith(`${workspace}${path.sep}`) && absolute !== workspace) {
      throw new Error(`Refusing to patch path outside workspace: ${filePath}`);
    }
    const root = await fs.realpath(workspace);
    let existing = absolute;
    while (!await fs.lstat(existing).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) && existing !== path.dirname(existing)) existing = path.dirname(existing);
    const resolved = await fs.realpath(existing);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing to patch linked path outside workspace: ${filePath}`);
    const headersSafe = String(file.diff || "").split(/\r?\n/).filter((line) => /^(---|\+\+\+) /.test(line))
      .every((line) => ["/dev/null", `a/${filePath}`, `b/${filePath}`].includes(line.slice(4).split("\t")[0]));
    if (file.previousPath || !headersSafe || file.truncated || !isCompleteTextDiff(file.diff)) {
      throw new Error(`Only complete text diffs can be applied: ${filePath}`);
    }
  }
}

function isCompleteTextDiff(diff) {
  if (typeof diff !== "string" || diff.includes("\0")) return false;
  let hunk = null;
  let count = 0;
  const complete = () => !hunk || hunk.old === 0 && hunk.next === 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      if (!complete()) return false;
      hunk = { old: Number(header[1] ?? 1), next: Number(header[2] ?? 1) }; count += 1;
    } else if (hunk && !complete()) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith(" ") || line.startsWith("-")) hunk.old -= 1;
      if (line.startsWith(" ") || line.startsWith("+")) hunk.next -= 1;
      if (![" ", "-", "+"].includes(line[0]) || hunk.old < 0 || hunk.next < 0) return false;
    } else if (line.startsWith("@@") || hunk && line && !line.startsWith("\\")) return false;
  }
  return count > 0 && complete();
}


function splitPatchHunks(diff = "") {
  const lines = String(diff || "").split(/\r?\n/);
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) {
        hunks.push(current);
      }
      current = [line];
      continue;
    }
    if (current) {
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        continue;
      }
      current.push(line);
    }
  }
  if (current) {
    hunks.push(current);
  }
  return hunks;
}

function hunkSideLines(hunk = [], side = "new") {
  const lines = [];
  for (const line of hunk.slice(1)) {
    if (!line) {
      continue;
    }
    const marker = line[0];
    const body = line.slice(1);
    if (marker === "\\") {
      continue;
    }
    if (marker === " ") {
      lines.push(body);
      continue;
    }
    if (side === "old" && marker === "-") {
      lines.push(body);
      continue;
    }
    if (side === "new" && marker === "+") {
      lines.push(body);
    }
  }
  return lines;
}

function findSubsequence(lines = [], needle = [], start = 0) {
  if (!needle.length) {
    return Math.max(0, start);
  }
  for (let index = Math.max(0, start); index <= lines.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

function applyHunkPatchToText(text = "", diff = "", direction = "reverse") {
  let hasFinalNewline = String(text).endsWith("\n");
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  let cursor = 0;
  let offset = 0;
  for (const hunk of splitPatchHunks(diff)) {
    const before = hunkSideLines(hunk, direction === "reverse" ? "new" : "old");
    const after = hunkSideLines(hunk, direction === "reverse" ? "old" : "new");
    const header = hunk[0].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const sourceStart = Number(header?.[direction === "reverse" ? 3 : 1]);
    const sourceCount = Number(header?.[direction === "reverse" ? 4 : 2] ?? 1);
    const expected = (sourceCount === 0 ? sourceStart : sourceStart - 1) + offset;
    const positional = !before.length || !after.length;
    const index = positional ? expected : findSubsequence(lines, before, cursor);
    if (index < cursor || index < 0 || index > lines.length || positional && before.some((line, step) => lines[index + step] !== line)) {
      throw new Error("Patch context does not match current file content");
    }
    lines.splice(index, before.length, ...after);
    cursor = index + after.length;
    offset += index - expected + after.length - before.length;
    const targetStart = Number(header?.[direction === "reverse" ? 1 : 3]);
    const targetCount = Number(header?.[direction === "reverse" ? 2 : 4] ?? 1);
    if (targetStart + targetCount - 1 >= lines.length) {
      const targetMarker = direction === "reverse" ? "-" : "+";
      hasFinalNewline = !hunk.some((line, offset) => line.startsWith("\\") && [targetMarker, " "].includes(hunk[offset - 1]?.[0]));
    }
  }
  return lines.length ? `${lines.join("\n")}${hasFinalNewline ? "\n" : ""}` : "";
}

async function applyPatchWithJsFallback(context, files, direction = "reverse") {
  const planned = [];
  for (const file of files) {
    const absolute = path.resolve(context.cwd, normalizePatchPath(file.path));
    const current = await fs.readFile(absolute, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const patch = synthesizePatch(file).replace(/\r\n/g, "\n");
    const fromNull = /^--- \/dev\/null$/m.test(patch);
    const toNull = /^\+\+\+ \/dev\/null$/m.test(patch);
    const creates = direction === "reverse" ? toNull : fromNull;
    const removes = direction === "reverse" ? fromNull : toNull;
    if (creates && current !== null || !creates && current === null || current?.includes("\0")) throw new Error("Patch context does not match current file content");
    const text = applyHunkPatchToText(current || "", file.diff, direction);
    if (removes && text) throw new Error("Patch context does not match current file content");
    planned.push({ absolute, text, removes });
  }
  await context.mutate(async ({ signal, deadline }) => {
    for (const file of planned) {
      if (signal.aborted || Date.now() >= deadline) throw new Error("Workspace patch deadline exceeded");
      if (file.removes) await fs.unlink(file.absolute);
      else {
        await fs.mkdir(path.dirname(file.absolute), { recursive: true });
        await fs.writeFile(file.absolute, file.text);
      }
    }
  });
}

function normalizePatchDirection(direction = "reverse") {
  const normalized = String(direction || "reverse").trim().toLowerCase();
  if (normalized === "forward" || normalized === "apply" || normalized === "restore") {
    return "forward";
  }
  return "reverse";
}


export async function applyWorkspacePatch(context, files, direction, { git, patchBin = "patch" }) {
  await assertPatchPaths(context.cwd, files);
  const patch = buildPatchPayload(files);
  const normalized = normalizePatchDirection(direction);
  const args = normalized === "reverse" ? ["apply", "--reverse"] : ["apply"];
  if (context.isGitRepo) {
    const directory = path.relative(context.repoRoot, context.cwd).split(path.sep).join("/");
    const rootedArgs = directory ? [...args, "--directory=" + directory] : args;
    await git(context, [...rootedArgs, "--check", "-"], { cwd: context.repoRoot, input: patch });
    await git(context, [...rootedArgs, "-"], { cwd: context.repoRoot, input: patch, mutates: true });
  } else {
    // Portable patch implementations can trim even quoted header filenames.
    if (files.some((file) => /\s|"/.test(normalizePatchPath(file.path)))) {
      await applyPatchWithJsFallback(context, files, normalized);
      return normalized;
    }
    const patchArgs = normalized === "reverse" ? ["-R", "-p1"] : ["-p1"];
    try {
      await context.runCommand(patchBin, [...patchArgs, "--dry-run"], { input: patch });
    } catch (error) {
      const unsupported = error.code === "WORKSPACE_COMMAND_SPAWN" && error.spawnCode === "ENOENT"
        || error.code === "WORKSPACE_COMMAND_EXIT" && /unrecognized option|unknown option|illegal option|unsupported option/i.test(error.stderr || "");
      if (!unsupported || error.executionState !== "not-applied") {
        if (error.code === "WORKSPACE_COMMAND_EXIT" && /hunk|failed|reject/i.test(error.stdout + error.stderr)) error.message = "Patch context does not match current file content: " + error.message;
        throw error;
      }
      await applyPatchWithJsFallback(context, files, normalized);
      return normalized;
    }
    await context.runCommand(patchBin, patchArgs, { input: patch, mutates: true, timeoutMs: 10000 });
  }
  return normalized;
}

export { normalizePatchPath, normalizePatchDirection };

