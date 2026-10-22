import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HistoricalSessionService } from "../src/sessions/history/HistoricalSessionService.js";
import { createBaseConfig } from "./helpers/backendTestUtils.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-catalog-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = createBaseConfig(root);
  const service = new HistoricalSessionService(config);
  const provider = { id: "codex", sessionsDir: config.codexSessionsDir, historyDir: config.codexArchivedSessionsDir };
  const files = ["a", "b"].map((name) => path.join(config.codexSessionsDir, `${name}.jsonl`));
  files.forEach((filePath, index) => writeSession(filePath, `thread-${index}`));
  return { config, service, provider, files, scan: () => service.scanHistoricalSessionsForProvider(provider) };
}

function writeSession(filePath, id) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "session_meta", payload: { id, cwd: "/workspace", thread_name: `Title ${id}` }
  })}\n`);
}

function recordReads(t, filePaths) {
  const reads = new Map(filePaths.map((filePath) => [filePath, 0]));
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (filePath, ...args) {
    if (reads.has(String(filePath))) {
      reads.set(String(filePath), reads.get(String(filePath)) + 1);
    }
    return original.call(this, filePath, ...args);
  });
  return (filePath) => reads.get(filePath);
}

test("unchanged catalog files are parsed once and an append only reparses the changed file", (t) => {
  const { scan, files } = fixture(t);
  const reads = recordReads(t, files);
  assert.equal(scan().length, 2);
  assert.equal(scan().length, 2);
  assert.deepEqual(files.map(reads), [1, 1]);

  fs.appendFileSync(files[0], `${JSON.stringify({
    type: "event_msg", payload: { type: "user_message", message: "synthetic appended input" }
  })}\n`);
  const entries = scan();
  assert.equal(entries.find((entry) => entry.resumeSessionId === "thread-0").messages.length, 1);
  assert.deepEqual(files.map(reads), [2, 1]);
  scan();
  assert.deepEqual(files.map(reads), [2, 1]);
});

test("adding a nested file only parses the new file and deleted files leave the catalog", (t) => {
  const { config, scan, files } = fixture(t);
  const nested = path.join(config.codexSessionsDir, "nested", "new.jsonl");
  const reads = recordReads(t, [...files, nested]);
  scan();
  writeSession(nested, "thread-new");
  assert.equal(scan().length, 3);
  assert.deepEqual([...files, nested].map(reads), [1, 1, 1]);

  fs.rmSync(files[0]);
  assert.deepEqual(scan().map((entry) => entry.resumeSessionId).sort(), ["thread-1", "thread-new"]);
  writeSession(files[0], "thread-2");
  assert.equal(scan().some((entry) => entry.resumeSessionId === "thread-2"), true);
  assert.deepEqual([...files, nested].map(reads), [2, 1, 1]);
});

test("same-size rewrites and atomic replacements invalidate even with restored modification time", (t) => {
  const { scan, files } = fixture(t);
  const reads = recordReads(t, files);
  scan();
  const oldStat = fs.statSync(files[0]);
  writeSession(files[0], "thread-2");
  fs.utimesSync(files[0], oldStat.atime, oldStat.mtime);
  assert.equal(scan().some((entry) => entry.resumeSessionId === "thread-2"), true);

  const replacement = `${files[0]}.replacement`;
  writeSession(replacement, "thread-3");
  fs.utimesSync(replacement, oldStat.atime, oldStat.mtime);
  fs.renameSync(replacement, files[0]);
  assert.equal(scan().some((entry) => entry.resumeSessionId === "thread-3"), true);
  assert.deepEqual(files.map(reads), [3, 1]);
});

test("index updates refresh titles and timestamps without reparsing unchanged transcripts", (t) => {
  const { config, scan, files } = fixture(t);
  const reads = recordReads(t, files);
  scan();
  const indexRecord = (title, updatedAt) => `${JSON.stringify({ id: "thread-0", thread_name: title, updated_at: updatedAt })}\n`;
  fs.writeFileSync(config.codexSessionIndexPath, indexRecord("Indexed A", "2026-10-14T00:00:00.000Z"));
  let entry = scan().find((item) => item.resumeSessionId === "thread-0");
  assert.equal(entry.title, "Indexed A");
  assert.equal(entry.indexedUpdatedAt, "2026-10-14T00:00:00.000Z");

  const oldStat = fs.statSync(config.codexSessionIndexPath);
  const replacement = `${config.codexSessionIndexPath}.replacement`;
  fs.writeFileSync(replacement, indexRecord("Indexed B", "2026-10-15T00:00:00.000Z"));
  fs.utimesSync(replacement, oldStat.atime, oldStat.mtime);
  fs.renameSync(replacement, config.codexSessionIndexPath);
  entry = scan().find((item) => item.resumeSessionId === "thread-0");
  assert.equal(entry.title, "Indexed B");
  assert.equal(entry.indexedUpdatedAt, "2026-10-15T00:00:00.000Z");

  fs.rmSync(config.codexSessionIndexPath);
  entry = scan().find((item) => item.resumeSessionId === "thread-0");
  assert.equal(entry.title, "Title thread-0");
  assert.equal(entry.indexedUpdatedAt, "");
  assert.deepEqual(files.map(reads), [1, 1]);
});

test("a temporary transcript read failure is retried while successful files stay cached", (t) => {
  const { scan, files } = fixture(t);
  const original = fs.readFileSync;
  const reads = new Map(files.map((filePath) => [filePath, 0]));
  t.mock.method(fs, "readFileSync", function (filePath, ...args) {
    if (reads.has(String(filePath))) {
      const count = reads.get(String(filePath)) + 1;
      reads.set(String(filePath), count);
      if (String(filePath) === files[0] && count === 1) {
        throw new Error("temporary read failure");
      }
    }
    return original.call(this, filePath, ...args);
  });
  assert.equal(scan().length, 1);
  assert.equal(scan().length, 2);
  assert.deepEqual(files.map((filePath) => reads.get(filePath)), [2, 1]);
});

test("a transcript appended during scanning is refreshed on the next scan", (t) => {
  const { scan, files } = fixture(t);
  const original = fs.readFileSync;
  let changedFileReads = 0;
  t.mock.method(fs, "readFileSync", function (filePath, ...args) {
    const result = original.call(this, filePath, ...args);
    if (String(filePath) === files[0]) {
      changedFileReads += 1;
      if (changedFileReads === 1) {
        fs.appendFileSync(files[0], `${JSON.stringify({
          type: "event_msg", payload: { type: "user_message", message: "synthetic concurrent append" }
        })}\n`);
      }
    }
    return result;
  });
  assert.equal(scan().find((entry) => entry.resumeSessionId === "thread-0").messages.length, 0);
  assert.equal(scan().find((entry) => entry.resumeSessionId === "thread-0").messages.length, 1);
  scan();
  assert.equal(changedFileReads, 2);
});
