import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-interaction-options-"));
  const calls = [], bridge = new EventEmitter();
  bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-new-options", cwd: root } };
    if (method === "turn/start") return { turn: { id: "turn-options", status: "inProgress", items: [] } };
    return {};
  };
  const service = new CodexThreadService({ config: { dataDir: root, defaultCwd: root }, bridge,
    reader: { getThread: async (id) => ({ id, cwd: root }), listTurns: async () => ({ turns: [] }) },
    sessionManager: { resolveCwd: (value) => value, codexModelCatalog: () => [] } });
  t.after(() => { service.shutdown(); fs.rmSync(root, { recursive: true }); });
  return { root, calls, service };
}

test("V2 creation enables ordinary questions on its thread and retains reasoning and manual policy", async (t) => {
  const { root, calls, service } = fixture(t);
  await service.createThread({ cwd: root, model: "fixture", reasoningEffort: "high", permissionMode: "manual-review" });
  const { params } = calls.find(({ method }) => method === "thread/start");
  assert.equal(params.config["features.default_mode_request_user_input"], true);
  assert.equal(params.config.model_reasoning_effort, "high");
  assert.equal(params.model, "fixture");
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "user");
});

test("resuming a stored V2 thread enables questions without changing the default execution policy", async (t) => {
  const { calls, service } = fixture(t);
  const receipt = service.submit("thread-existing-options", { clientRequestId: "question-options-123", input: { text: "fixture", attachments: [] },
    options: { model: "fixture", reasoningEffort: "low", permissionMode: "default" } });
  for (let index = 0; index < 10; index += 1) await new Promise(setImmediate);
  assert.equal(service.requests.get("thread-existing-options", receipt.id).state, "accepted");
  const resume = calls.find(({ method }) => method === "thread/resume").params;
  assert.equal(resume.config["features.default_mode_request_user_input"], true);
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.sandbox, "read-only");
  assert.equal(resume.approvalPolicy, "never");
  const turn = calls.find(({ method }) => method === "turn/start").params;
  assert.equal(turn.model, "fixture");
  assert.equal(turn.effort, "low");
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.approvalsReviewer, "user");
});
