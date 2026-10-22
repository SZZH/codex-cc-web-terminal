import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseHistoricalThreadComposerContext } from "../src/sessions/shared/historicalComposerState.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "historical-composer-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "session.jsonl");
}

function contextLine(model, overrides = {}) {
  return `${JSON.stringify({
    type: "turn_context",
    payload: {
      cwd: "/workspace",
      model,
      collaboration_mode: { settings: { reasoning_effort: "high" } },
      sandbox_policy: { type: "workspace-write" },
      approval_policy: "on-request",
      ...overrides
    }
  })}\n`;
}

function countReads(t, targetPath, onRead = null) {
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", function (filePath, ...args) {
    if (String(filePath) === targetPath) {
      reads += 1;
      onRead?.(reads);
    }
    return original.call(this, filePath, ...args);
  });
  return () => reads;
}

test("unchanged transcripts reuse the latest composer context without sharing mutable state", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, `${contextLine("old-model")}invalid-json\n${contextLine("new-model")}`);
  const reads = countReads(t, filePath);

  const first = parseHistoricalThreadComposerContext(filePath);
  assert.deepEqual(first, {
    cwd: "/workspace", model: "new-model", reasoningEffort: "high", permissionMode: "auto-review"
  });
  first.model = "mutated-model";
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "new-model");
  assert.equal(reads(), 1);
});

test("a successful read with no turn context is cached and invalidates after append", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, `${JSON.stringify({ type: "session_meta", payload: {} })}\n`);
  const reads = countReads(t, filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath), null);
  assert.equal(parseHistoricalThreadComposerContext(filePath), null);
  assert.equal(reads(), 1);

  fs.appendFileSync(filePath, contextLine("appended-model", {
    sandbox_policy: { type: "danger-full-access" }
  }));
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "appended-model");
  assert.equal(parseHistoricalThreadComposerContext(filePath).permissionMode, "full-access");
  assert.equal(reads(), 2);
});

test("same-size rewrites invalidate even when modification time is restored", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, contextLine("model-a"));
  const oldStat = fs.statSync(filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-a");

  fs.writeFileSync(filePath, contextLine("model-b"));
  fs.utimesSync(filePath, oldStat.atime, oldStat.mtime);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-b");
});

test("atomic replacements and deletion invalidate the cached file identity", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, contextLine("model-a"));
  const oldStat = fs.statSync(filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-a");

  const replacementPath = `${filePath}.replacement`;
  fs.writeFileSync(replacementPath, contextLine("model-b"));
  fs.utimesSync(replacementPath, oldStat.atime, oldStat.mtime);
  fs.renameSync(replacementPath, filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-b");
  fs.rmSync(filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath), null);
  fs.writeFileSync(filePath, contextLine("model-c"));
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-c");
});

test("read failures are retried instead of caching a successful empty result", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, contextLine("recovered-model"));
  const reads = countReads(t, filePath, (readCount) => {
    if (readCount === 1) {
      throw new Error("temporary read failure");
    }
  });
  assert.equal(parseHistoricalThreadComposerContext(filePath), null);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "recovered-model");
  assert.equal(reads(), 2);
});

test("a file changed during a read is not retained as a stable cache entry", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, contextLine("model-a"));
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", function (targetPath, ...args) {
    const result = original.call(this, targetPath, ...args);
    if (String(targetPath) === filePath) {
      reads += 1;
      if (reads === 1) {
        fs.appendFileSync(filePath, contextLine("model-b"));
      }
    }
    return result;
  });
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-a");
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "model-b");
  assert.equal(reads, 2);
});

test("composer context cache evicts older files when its capacity is exceeded", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, contextLine("first-model"));
  const reads = countReads(t, filePath);
  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "first-model");

  for (let index = 0; index < 512; index += 1) {
    const extraPath = path.join(path.dirname(filePath), `extra-${index}.jsonl`);
    fs.writeFileSync(extraPath, contextLine("extra-model"));
    parseHistoricalThreadComposerContext(extraPath);
  }

  assert.equal(parseHistoricalThreadComposerContext(filePath).model, "first-model");
  assert.equal(reads(), 2);
});
