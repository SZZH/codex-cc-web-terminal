import test, { after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";

import { AppServerBridge } from "../src/appServerBridge.js";
import { createBaseConfig, createTempDir as createBackendTempDir } from "./helpers/backendTestUtils.js";

const tempRoots = new Set();
function createTempDir() {
  const root = createBackendTempDir();
  tempRoots.add(root);
  return root;
}
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

class RecordingAppServerBridge extends AppServerBridge {
  constructor(config) {
    super(config);
    this.requests = [];
  }

  async ensureReady() {
    this.connected = true;
    this.initialized = true;
  }

  request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return Promise.resolve({ thread: { id: "thread-created" } });
    }
    return Promise.resolve({ turn: { items: [] } });
  }
}

test("missing CODEX_BIN rejects startup without an uncaught child-process error", async () => {
  const root = createTempDir();
  const bridge = new AppServerBridge({
    ...createBaseConfig(root),
    codexBin: path.join(root, "missing-codex")
  });

  await assert.rejects(bridge.startProcess(), { code: "ENOENT" });
  assert.equal(bridge.proc, null);
  assert.equal(bridge.connected, false);
});

test("new named project conversations persist desktop identity before their first turn", async () => {
  const bridge = new RecordingAppServerBridge(createBaseConfig(createTempDir()));
  const session = { cwd: "/tmp/qa", projectId: "project-canonical", name: "QA named thread", titleSource: "user_provided" };

  await bridge.startTurn(session, "hello");

  assert.deepEqual(bridge.requests.map(({ method }) => method), ["thread/start", "thread/name/set", "turn/start"]);
  assert.equal(bridge.requests[0].params.projectId, "project-canonical");
  assert.deepEqual(bridge.requests[1].params, { threadId: "thread-created", name: "QA named thread" });
  assert.equal(bridge.requests[2].params.threadId, session.resumeSessionId);

  bridge.requests = [];
  await bridge.startTurn(session, "again");
  assert.deepEqual(bridge.requests.map(({ method }) => method), ["thread/resume", "turn/start"]);
  assert.equal(bridge.requests[0].params.projectId, undefined);
});

test("renaming a draft persists its custom title when the official thread is first created", async () => {
  const bridge = new RecordingAppServerBridge(createBaseConfig(createTempDir()));
  await bridge.startTurn({ cwd: "/tmp/qa", name: "Renamed draft", titleSource: "custom_name" }, "hello");
  assert.deepEqual(bridge.requests.find(({ method }) => method === "thread/name/set")?.params,
    { threadId: "thread-created", name: "Renamed draft" });
});

test("app-server turn/start sends composer overrides through authoritative protocol fields", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new RecordingAppServerBridge(config);
  const session = {
    id: "session-1",
    cwd: config.root,
    model: "gpt-5.4",
    reasoningEffort: "low",
    permissionMode: "full-access",
    resumeSessionId: "thread-1"
  };

  await bridge.startTurn(session, "hello");

  const resume = bridge.requests.find((item) => item.method === "thread/resume");
  const turn = bridge.requests.find((item) => item.method === "turn/start");
  assert.equal(resume.params.model, "gpt-5.4");
  assert.equal(resume.params.approvalPolicy, "never");
  assert.equal(resume.params.approvalsReviewer, "user");
  assert.equal(resume.params.sandbox, "danger-full-access");
  assert.equal(resume.params.persistExtendedHistory, true);
  assert.equal(resume.params.reasoningEffort, undefined);
  assert.equal(turn.params.model, "gpt-5.4");
  assert.equal(turn.params.effort, "low");
  assert.equal(turn.params.reasoningEffort, undefined);
  assert.equal(turn.params.approvalPolicy, "never");
  assert.equal(turn.params.approvalsReviewer, "user");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
});

test("app-server turn/start maps auto-review to workspace-write sandbox overrides", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new RecordingAppServerBridge(config);
  const session = {
    id: "session-1",
    cwd: config.root,
    model: "gpt-5.5",
    reasoningEffort: "high",
    permissionMode: "auto-review"
  };

  await bridge.startTurn(session, "hello");

  const start = bridge.requests.find((item) => item.method === "thread/start");
  const turn = bridge.requests.find((item) => item.method === "turn/start");
  assert.equal(start.params.model, "gpt-5.5");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.persistExtendedHistory, true);
  assert.equal(start.params.reasoningEffort, undefined);
  assert.equal(turn.params.effort, "high");
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.equal(turn.params.approvalsReviewer, "auto_review");
  assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(turn.params.sandboxPolicy.writableRoots, [config.root]);
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.equal(session.resumeSessionId, "thread-created");
  assert.equal(turn.params.threadId, "thread-created");
});

test("app-server turn/start sends default permission as a concrete restricted mode", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new RecordingAppServerBridge(config);
  const session = {
    id: "session-1",
    cwd: config.root,
    model: "gpt-5.5",
    reasoningEffort: "low",
    permissionMode: "default"
  };

  await bridge.startTurn(session, "hello");

  const start = bridge.requests.find((item) => item.method === "thread/start");
  const turn = bridge.requests.find((item) => item.method === "turn/start");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(turn.params.approvalPolicy, "never");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.approvalsReviewer, "user");
  assert.equal(turn.params.approvalsReviewer, "user");
  assert.deepEqual(turn.params.sandboxPolicy, {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: true
  });
});

test("app-server default permissions stay restricted when the CLI full-access fallback is configured", async () => {
  const config = { ...createBaseConfig(createTempDir()), codexFullAccess: true };
  const bridge = new RecordingAppServerBridge(config);

  await bridge.startTurn({ cwd: config.root, permissionMode: "default" }, "hello");

  const start = bridge.requests.find((item) => item.method === "thread/start");
  const turn = bridge.requests.find((item) => item.method === "turn/start");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.approvalsReviewer, "user");
  assert.equal(turn.params.sandboxPolicy.type, "readOnly");
});

test("app-server snapshots model, reasoning and permissions before initialization awaits", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new RecordingAppServerBridge(config);
  let finishInitialization;
  bridge.ensureReady = () => new Promise((resolve) => { finishInitialization = resolve; });
  const session = {
    cwd: config.root,
    model: "original",
    reasoningEffort: "low",
    permissionMode: "auto-review",
    resumeSessionId: "thread-existing"
  };
  const firstTurn = bridge.startTurn(session, "first");
  Object.assign(session, { model: "next", reasoningEffort: "xhigh", permissionMode: "full-access" });
  finishInitialization();
  await firstTurn;

  assert.equal(bridge.requests[0].params.model, "original");
  assert.equal(bridge.requests[0].params.approvalsReviewer, "auto_review");
  assert.equal(bridge.requests[1].params.model, "original");
  assert.equal(bridge.requests[1].params.effort, "low");
  assert.equal(bridge.requests[1].params.approvalsReviewer, "auto_review");
  bridge.ensureReady = async () => {};
  await bridge.startTurn(session, "second");
  assert.equal(bridge.requests[3].params.model, "next");
  assert.equal(bridge.requests[3].params.effort, "xhigh");
  assert.equal(bridge.requests[3].params.approvalsReviewer, "user");
  assert.deepEqual(bridge.requests[3].params.sandboxPolicy, { type: "dangerFullAccess" });
});

test("app-server clears inherited auto-review settings and omits effort for models without reasoning", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new RecordingAppServerBridge(config);
  const session = { cwd: config.root, model: "model", reasoningEffort: "high", permissionMode: "auto-review" };
  await bridge.startTurn(session, "first");
  session.permissionMode = "default";
  session.reasoningEffort = "";
  await bridge.startTurn(session, "second");
  const resume = bridge.requests[2].params;
  const turn = bridge.requests[3].params;
  assert.equal(resume.approvalPolicy, "never");
  assert.equal(resume.approvalsReviewer, "user");
  assert.equal(resume.sandbox, "read-only");
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.approvalsReviewer, "user");
  assert.equal(turn.sandboxPolicy.type, "readOnly");
  assert.equal(turn.effort, null);
});

test("app-server initializes the client before announcing readiness", async () => {
  const config = createBaseConfig(createTempDir());
  const bridge = new AppServerBridge(config);
  const messages = [];
  bridge.startProcess = async () => {};
  bridge.openWebSocket = async () => {
    bridge.connected = true;
    bridge.ws = {
      readyState: 1,
      send: (payload) => {
        assert.equal(bridge.initialized, false);
        messages.push(JSON.parse(payload));
      }
    };
  };
  bridge.request = async (method, params) => {
    messages.push({ method, params });
    return {};
  };

  await bridge.connectInternal();

  assert.deepEqual(messages.map((message) => message.method), ["initialize", "initialized"]);
  assert.equal(Object.hasOwn(messages[1], "id"), false);
  assert.equal(bridge.initialized, true);
});

test("app-server declines command and file approvals without an approval UI", () => {
  const bridge = new AppServerBridge(createBaseConfig(createTempDir()));
  const responses = [];
  bridge.ws = { readyState: 1, send: (payload) => responses.push(JSON.parse(payload)) };

  for (const [index, method] of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ].entries()) {
    bridge.handleMessage(JSON.stringify({ id: index + 1, method, params: {} }));
  }

  assert.deepEqual(responses, [
    { jsonrpc: "2.0", id: 1, result: { decision: "decline" } },
    { jsonrpc: "2.0", id: 2, result: { decision: "decline" } }
  ]);
});

test("app-server grants no additional permissions when approval cannot be collected", () => {
  const bridge = new AppServerBridge(createBaseConfig(createTempDir()));
  const responses = [];
  bridge.ws = { readyState: 1, send: (payload) => responses.push(JSON.parse(payload)) };

  bridge.handleMessage(JSON.stringify({
    id: "permission-request",
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp"] } } }
  }));

  assert.deepEqual(responses, [{
    jsonrpc: "2.0",
    id: "permission-request",
    result: { permissions: {}, scope: "turn" }
  }]);
});

test("app-server interrupt sends the current thread and supplied server turn directly", async () => {
  const bridge = new RecordingAppServerBridge(createBaseConfig(createTempDir()));
  bridge.ensureReady = async () => { throw new Error("interrupt must not reinitialize the server"); };
  bridge.ensureThread = async () => { throw new Error("interrupt must not resume the thread"); };

  await bridge.interruptTurn({ resumeSessionId: "thread-running" }, "turn-running");

  assert.deepEqual(bridge.requests, [{
    method: "turn/interrupt",
    params: { threadId: "thread-running", turnId: "turn-running" }
  }]);
});

test("app-server interrupt requires explicit thread and turn ids", async () => {
  const bridge = new RecordingAppServerBridge(createBaseConfig(createTempDir()));

  await assert.rejects(bridge.interruptTurn({}, "turn-running"), /requires thread and turn ids/);
  await assert.rejects(bridge.interruptTurn({ resumeSessionId: "thread-running" }, " "), /requires thread and turn ids/);
  assert.deepEqual(bridge.requests, []);
});
