import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { handleWorkspaceChangesRoute, workspaceChangesInternals as workspace } from "../src/routes/workspaceChanges.js";
import { createWorkspaceService } from "../src/workspace/service.js";
import { readWorkspaceChanges } from "../src/workspace/changes.js";

function fixture(t, git = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-capability-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (git) {
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
    execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd });
    fs.writeFileSync(path.join(cwd, "sample.txt"), "before\n");
    execFileSync("git", ["add", "sample.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd, stdio: "ignore" });
  }
  return cwd;
}

async function listRoute(cwd, options = {}) {
  const query = new URLSearchParams({ cwd, ...(options.summary == null ? {} : { summary: String(options.summary) }) });
  for (const file of options.paths || []) query.append("path", file);
  const ctx = { path: "/api/workspace-changes", url: `/api/workspace-changes?${query}`, method: "GET" };
  const handled = await handleWorkspaceChangesRoute(ctx, { forbidCrossOrigin: () => false, requireAuthorized: () => true,
    json: (context, status, body) => Object.assign(context, { status, body }) });
  assert.equal(handled, true);
  return ctx;
}

test("ordinary non-Git directories return successful empty live changes and explicit capabilities", async (t) => {
  const cwd = fixture(t);
  const file = path.join(cwd, "weekly-report.docx");
  fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0, 1]));
  const response = await listRoute(cwd);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { cwd, isGitRepo: false, capabilities: { liveChanges: false, applyPatch: true, gitRevert: false },
    total: 0, additions: 0, deletions: 0, files: [] });
  assert.deepEqual(fs.readFileSync(file), Buffer.from([0x50, 0x4b, 0, 1]));
});

test("non-Git capability detection is independent of the host Git locale", async (t) => {
  const cwd = fixture(t);
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = "zh_CN.UTF-8";
  try {
    const response = await listRoute(cwd);
    assert.equal(response.status, 200);
    assert.equal(response.body.isGitRepo, false);
    assert.equal(response.body.capabilities.gitRevert, false);
  } finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
  }
});

test("invalid directories and genuine Git configuration errors are not disguised as non-Git success", async (t) => {
  const cwd = fixture(t, true);
  assert.equal((await listRoute(path.join(cwd, "missing"))).status, 400);
  fs.appendFileSync(path.join(cwd, ".git", "config"), "\n[broken\n");
  const response = await listRoute(cwd);
  assert.equal(response.status, 400);
  assert.match(response.body.error, /config/i);
});

test("non-Git text reverse and forward patches retain their supported capability", async (t) => {
  const cwd = fixture(t);
  const target = path.join(cwd, "report.txt");
  fs.writeFileSync(target, "after\n");
  const files = [{ path: "report.txt", status: "M", diff: "@@ -1 +1 @@\n-before\n+after" }];
  const reversed = await workspace.reversePatchWorkspaceChanges(cwd, files);
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
  assert.equal(reversed.isGitRepo, false);
  assert.equal(reversed.capabilities.applyPatch, true);
  assert.deepEqual(reversed.reverted, ["report.txt"]);
  const restored = await workspace.applyPatchWorkspaceChanges(cwd, files, "forward");
  assert.equal(fs.readFileSync(target, "utf8"), "after\n");
  assert.deepEqual(restored.restored, ["report.txt"]);
});

test("binary, incomplete and truncated patches reject before modifying a non-Git file", async (t) => {
  const cwd = fixture(t);
  const target = path.join(cwd, "report.txt");
  fs.writeFileSync(target, "after\n");
  for (const patch of [
    { diff: "Binary files differ" },
    { diff: "@@ -1,2 +1,2 @@\n-before\n+after" },
    { diff: "@@ -1 +1 @@\n-before\n+after", truncated: true },
    { diff: "--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-before\n+after" }
  ]) {
    await assert.rejects(workspace.reversePatchWorkspaceChanges(cwd, [{ path: "report.txt", status: "M", ...patch }]), /complete text diffs/);
    assert.equal(fs.readFileSync(target, "utf8"), "after\n");
  }
});

test("Git workspaces retain live diffs and selected-file revert behavior", async (t) => {
  const cwd = fixture(t, true);
  fs.writeFileSync(path.join(cwd, "sample.txt"), "before\nafter\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  const response = await listRoute(cwd);
  assert.equal(response.status, 200);
  assert.equal(response.body.isGitRepo, true);
  assert.deepEqual(response.body.capabilities, { liveChanges: true, applyPatch: true, gitRevert: true });
  assert.deepEqual(response.body.files.map((file) => file.path).sort(), ["new.txt", "sample.txt"]);
  assert.match(response.body.files.find((file) => file.path === "sample.txt").diff, /\+after/);
  const reverted = await workspace.revertWorkspaceChanges(cwd, ["sample.txt"]);
  assert.deepEqual(reverted.reverted, ["sample.txt"]);
  assert.equal(fs.readFileSync(path.join(cwd, "sample.txt"), "utf8"), "before\n");
  assert.equal(fs.readFileSync(path.join(cwd, "new.txt"), "utf8"), "new\n");
});

test("summary reads many dirty files with one numstat command and no per-file diffs", async (t) => {
  const cwd = fixture(t, true), names = Array.from({ length: 80 }, (_, index) => `tracked-${index}.txt`);
  for (const name of names) fs.writeFileSync(path.join(cwd, name), "before\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "many files"], { cwd, stdio: "ignore" });
  for (const name of names) fs.appendFileSync(path.join(cwd, name), "after\n");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "new\n");
  const commands = [];
  const result = await readWorkspaceChanges({ cwd, isGitRepo: true }, async (_context, args) => {
    commands.push(args);
    assert.ok(args[0] !== "diff" || args.includes("--numstat"), "summary must not generate a file diff");
    return { stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), status: 0 };
  }, { summary: true });
  assert.equal(commands.filter((args) => args[0] === "diff").length, 1);
  assert.equal(result.total, 81);
  assert.equal(result.additions, 80);
  assert.equal(result.deletions, 0);
  assert.equal(result.statsKnown, false);
  assert.ok(result.files.every((file) => file.diff === "" && file.detailsLoaded === false && file.truncated === false));
  assert.deepEqual(result.files.find((file) => file.path === "untracked.txt"), {
    status: "??", path: "untracked.txt", previousPath: "", additions: null, deletions: null, statsKnown: false,
    diff: "", detailsLoaded: false, truncated: false
  });
});

test("summary numstat preserves Git names with whitespace, tabs, newlines and staged renames", async (t) => {
  const cwd = fixture(t, true), names = [" spaced name .txt", "tab\tname.txt", "line\nbreak.txt"];
  for (const name of [...names, "binary.bin"]) fs.writeFileSync(path.join(cwd, name), name === "binary.bin" ? Buffer.from([0, 1, 2]) : "before\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "unusual names"], { cwd, stdio: "ignore" });
  for (const name of names) fs.appendFileSync(path.join(cwd, name), "after\n");
  fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0, 2, 3]));
  execFileSync("git", ["mv", "sample.txt", "renamed\nfile.txt"], { cwd });
  const summary = await listRoute(cwd, { summary: 1 });
  assert.equal(summary.status, 200);
  for (const name of names) {
    const file = summary.body.files.find((file) => file.path === name);
    assert.ok(file, JSON.stringify(name));
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 0);
    assert.equal(file.statsKnown, true);
  }
  const binary = summary.body.files.find((file) => file.path === "binary.bin");
  assert.equal(binary.additions, null);
  assert.equal(binary.deletions, null);
  assert.equal(binary.statsKnown, false);
  const renamed = summary.body.files.find((file) => file.path === "renamed\nfile.txt");
  assert.equal(renamed.previousPath, "sample.txt");
  assert.equal(renamed.additions, 0);
  assert.equal(renamed.deletions, 0);
  const selectedRename = await listRoute(cwd, { summary: 1, paths: [renamed.path] });
  assert.equal(selectedRename.body.files.length, 1);
  assert.equal(selectedRename.body.files[0].additions, 0);
  assert.equal(selectedRename.body.files[0].deletions, 0);
  const detail = await listRoute(cwd, { paths: [names[0], names[2]] });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.files.map((file) => file.path).sort(), [names[0], names[2]].sort());
  assert.ok(detail.body.files.every((file) => file.detailsLoaded === true && /\+after/.test(file.diff)));
});

test("filtered detail reads only selected changed files and does not read clean or unknown paths", async (t) => {
  const cwd = fixture(t, true);
  fs.appendFileSync(path.join(cwd, "sample.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  fs.writeFileSync(path.join(cwd, "other.txt"), "other\n");
  const reads = [];
  const result = await readWorkspaceChanges({ cwd, isGitRepo: true }, async (_context, args, options = {}) => {
    if (args[0] === "diff" && !args.includes("--numstat")) reads.push(args.at(-1));
    try { return { stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), status: 0 }; }
    catch (error) {
      if (!options.acceptedExitCodes?.includes(error.status)) throw error;
      return { stdout: error.stdout, status: error.status };
    }
  }, { paths: ["new.txt", "missing.txt"] });
  assert.deepEqual(reads, ["new.txt"]);
  assert.deepEqual(result.files.map((file) => file.path), ["new.txt"]);
  assert.equal(result.files[0].detailsLoaded, true);
  assert.match(result.files[0].diff, /\+new/);
  const empty = await listRoute(cwd, { paths: ["missing.txt"] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.files, []);
});

test("summary and detail jobs have distinct keys while identical filtered reads still share", async (t) => {
  const cwd = fixture(t, true), service = createWorkspaceService();
  t.after(() => service.close());
  fs.appendFileSync(path.join(cwd, "sample.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  const [summary, sameSummary, full, selected, sameSelected] = await Promise.all([
    service.listWorkspaceChanges(cwd, { summary: true }),
    service.listWorkspaceChanges(cwd, { summary: true }),
    service.listWorkspaceChanges(cwd),
    service.listWorkspaceChanges(cwd, { paths: ["new.txt", "sample.txt"] }),
    service.listWorkspaceChanges(cwd, { paths: ["sample.txt", "new.txt"] })
  ]);
  assert.equal(summary, sameSummary);
  assert.equal(selected, sameSelected);
  assert.notEqual(summary, full);
  assert.notEqual(full, selected);
  assert.ok(summary.files.every((file) => file.detailsLoaded === false && file.diff === ""));
  assert.ok(full.files.every((file) => file.detailsLoaded === true && file.diff));
  const controller = new AbortController();
  const cancelled = service.listWorkspaceChanges(cwd, { summary: true, signal: controller.signal });
  const survivor = service.listWorkspaceChanges(cwd, { summary: true });
  controller.abort();
  await assert.rejects(cancelled, { code: "WORKSPACE_JOB_ABORTED" });
  assert.equal((await survivor).total, 2);
  await assert.rejects(service.listWorkspaceChanges(cwd, { summary: true, timeoutMs: -1 }), { code: "WORKSPACE_JOB_INVALID" });
});

test("summary and filtered paths validate before reading directories and never accept traversal", async (t) => {
  const cwd = fixture(t, true);
  for (const value of ["../outside", "dir/../outside", "/tmp/outside", "C:\\outside", "./sample.txt", "", "sample.txt\0other", "dir//file"]) {
    const response = await listRoute(cwd, { paths: [value] });
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  assert.equal((await listRoute(cwd, { summary: "unexpected" })).status, 400);
  assert.equal((await listRoute(cwd, { paths: Array(51).fill("sample.txt") })).status, 400);
  const response = await listRoute(cwd, { paths: Array(50).fill("sample.txt") });
  assert.equal(response.status, 200);
  let commands = 0;
  const ordinary = await readWorkspaceChanges({ cwd: fixture(t), isGitRepo: false }, () => { commands += 1; }, { paths: ["safe.txt"], summary: true });
  assert.deepEqual(ordinary.files, []);
  assert.equal(commands, 0);
});

test("an unborn repository reports summary statistics as unknown without materializing diffs", async (t) => {
  const cwd = fixture(t), service = createWorkspaceService();
  t.after(() => service.close());
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "first.txt"), "first\n");
  execFileSync("git", ["add", "."], { cwd });
  const summary = await service.listWorkspaceChanges(cwd, { summary: true });
  assert.equal(summary.total, 1);
  assert.equal(summary.files[0].additions, null);
  assert.equal(summary.files[0].statsKnown, false);
  assert.equal(summary.files[0].diff, "");
  assert.equal(summary.files[0].detailsLoaded, false);
});

test("a non-Git patch context mismatch remains a failure and leaves the current file intact", async (t) => {
  const cwd = fixture(t);
  const target = path.join(cwd, "report.txt");
  fs.writeFileSync(target, "different current content\n");
  await assert.rejects(workspace.reversePatchWorkspaceChanges(cwd, [{ path: "report.txt", status: "M",
    diff: "@@ -1 +1 @@\n-before\n+after" }]), /context does not match/);
  assert.equal(fs.readFileSync(target, "utf8"), "different current content\n");
});

test("non-Git patches cannot follow links outside the selected workspace", async (t) => {
  const cwd = fixture(t);
  const outside = fixture(t);
  const target = path.join(outside, "report.txt");
  fs.writeFileSync(target, "after\n");
  fs.symlinkSync(target, path.join(cwd, "linked.txt"));
  await assert.rejects(workspace.reversePatchWorkspaceChanges(cwd, [{ path: "linked.txt", status: "M",
    diff: "@@ -1 +1 @@\n-before\n+after" }]), /linked path outside workspace/);
  assert.equal(fs.readFileSync(target, "utf8"), "after\n");
});

for (const [label, initial, changed, diff] of [
  ["replacement", "prefix\nfirst\nlast\n", "prefix\nFIRST\nlast\nEND\n",
    "@@ -1 +1 @@\n-first\n+FIRST\n@@ -2,0 +3 @@\n+END\n"],
  ["growing replacement", "prefix\nfirst\nlast\n", "prefix\nFIRST\nextra\nlast\nEND\n",
    "@@ -1 +1,2 @@\n-first\n+FIRST\n+extra\n@@ -2,0 +4 @@\n+END\n"],
  ["shrinking replacement", "prefix\nfirst\nremove\nlast\n", "prefix\nFIRST\nlast\nEND\n",
    "@@ -1,2 +1 @@\n-first\n-remove\n+FIRST\n@@ -3,0 +3 @@\n+END\n"]
]) {
  for (const direction of ["forward", "reverse"]) {
    test(`mixed hunks carry actual ${label} drift in ${direction} with both patch executors`, async (t) => {
      const cwd = fixture(t);
      const target = path.join(cwd, "sample.txt");
      const file = { path: "sample.txt", status: "M", diff };
      for (const patchBin of ["patch", path.join(cwd, "missing-patch-tool")]) {
        const service = createWorkspaceService({ patchBin });
        t.after(() => service.close());
        fs.writeFileSync(target, direction === "forward" ? initial : changed);
        await service.applyPatchWorkspaceChanges(cwd, [file], direction);
        assert.equal(fs.readFileSync(target, "utf8"), direction === "forward" ? changed : initial, patchBin);
      }
    });
  }
}

test("an unmatched later mixed hunk rejects the fallback before any file is written", async (t) => {
  const cwd = fixture(t);
  const service = createWorkspaceService({ patchBin: path.join(cwd, "missing-patch-tool") });
  t.after(() => service.close());
  fs.writeFileSync(path.join(cwd, "first.txt"), "before\n");
  const initial = "prefix\nfirst\nlast\n";
  fs.writeFileSync(path.join(cwd, "sample.txt"), initial);
  await assert.rejects(service.applyPatchWorkspaceChanges(cwd, [
    { path: "first.txt", status: "M", diff: "@@ -1 +1 @@\n-before\n+after\n" },
    { path: "sample.txt", status: "M", diff: "@@ -1 +1 @@\n-first\n+FIRST\n@@ -2 +2 @@\n-missing\n+END\n" }
  ], "forward"), /context does not match/);
  assert.equal(fs.readFileSync(path.join(cwd, "first.txt"), "utf8"), "before\n");
  assert.equal(fs.readFileSync(path.join(cwd, "sample.txt"), "utf8"), initial);
});
