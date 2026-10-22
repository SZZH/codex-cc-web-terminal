import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { SessionManager } from "../src/sessionManager.js";
import { normalizeAppServerErrorMessage } from "../src/sessions/runners/codexRunner.js";
import { buildThreadSnapshotFromFile } from "../src/threads/history.js";
import { deriveConversationStateFromThreadSnapshot, deriveThreadSnapshotFromConversationState } from "../src/threads/legacyConversation.js";
import { createLegacyThreadProjection, projectorSnapshotToLegacyThread } from "../src/projector/legacyBridge.js";
import { createBaseConfig, createTempDir, waitForMicrotasks } from "./helpers/backendTestUtils.js";

const rpcError = {
  message: 'unexpected status 400 Bad Request: {"error":{"message":"The requested model gpt-test-mini is not supported.","type":"invalid_request_error","param":"model","code":"unsupported_model"}}',
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } },
  additionalDetails: "provider rejected the requested model"
};

function fixture(t) {
  const root = createTempDir();
  const config = createBaseConfig(root);
  const bridge = new EventEmitter();
  bridge.startTurn = async (session) => {
    session.resumeSessionId ||= "thread-failure";
    return { turn: { id: `server-${session.turnSequence}`, status: "inProgress", items: [] } };
  };
  const manager = new SessionManager(config, { appServerBridge: bridge });
  const events = [];
  manager.broadcast = (session, payload) => events.push(payload);
  manager.scheduleConversationHistoryResync = () => {};
  const session = manager.get(manager.create({ provider: "codex" }).id);
  t.after(() => { manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, bridge, manager, session, events };
}

function complete(bridge, id, status, error = null) {
  bridge.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-failure", turn: { id, status, error } }
  });
}

test("nested provider JSON error becomes readable while retaining raw message and metadata", async (t) => {
  const { manager, session, bridge, events } = fixture(t);
  manager.write(session.id, "first prompt");
  await waitForMicrotasks();
  complete(bridge, "server-1", "failed", rpcError);
  const turn = session.threadSnapshot.turns[0];
  assert.equal(turn.status, "failed");
  assert.equal(turn.error.message, "The requested model gpt-test-mini is not supported. provider rejected the requested model");
  assert.equal(turn.error.rawMessage, rpcError.message);
  assert.deepEqual(turn.error.codexErrorInfo, rpcError.codexErrorInfo);
  assert.equal(turn.error.additionalDetails, rpcError.additionalDetails);
  assert.equal(turn.items.filter((item) => item.kind === "AgentMessage").length, 0);
  assert.equal(events.filter((event) => event.type === "turn.failed").length, 1);
});

test("repeated terminal notification is emitted once and a successful next turn retains the earlier failure", async (t) => {
  const { manager, session, bridge, events } = fixture(t);
  manager.write(session.id, "first prompt");
  await waitForMicrotasks();
  complete(bridge, "server-1", "failed", rpcError);
  const failure = structuredClone(session.threadSnapshot.turns[0].error);
  complete(bridge, "server-1", "failed", rpcError);
  assert.equal(events.filter((event) => event.type === "turn.failed").length, 1);
  assert.equal(session.turnRunning, false);
  manager.write(session.id, "next prompt");
  await waitForMicrotasks();
  bridge.emit("notification", {
    method: "item/completed", params: {
      threadId: "thread-failure", turnId: "server-2",
      item: { id: "reply-2", type: "agentMessage", phase: "final_answer", text: "next turn succeeded" }
    }
  });
  complete(bridge, "server-2", "completed");
  assert.equal(session.threadSnapshot.turns.length, 2);
  assert.deepEqual(session.threadSnapshot.turns[0].error, failure);
  assert.equal(session.threadSnapshot.turns[1].error, null);
  assert.equal(session.threadSnapshot.turns[1].status, "completed");
  assert.equal(session.turnRunning, false);
});

test("synchronous failed turn results retain the same error structure as notifications", async (t) => {
  const { manager, session, bridge } = fixture(t);
  bridge.startTurn = async (target) => {
    target.resumeSessionId = "thread-failure";
    return { turn: { id: "failed-synchronous", status: "failed", items: [], error: rpcError } };
  };
  manager.write(session.id, "prompt");
  await waitForMicrotasks();
  assert.equal(session.threadSnapshot.turns[0].status, "failed");
  assert.match(session.threadSnapshot.turns[0].error.message, /not supported/);
  assert.equal(session.threadSnapshot.turns[0].error.rawMessage, rpcError.message);
});

test("rejected start RPC retains its error without inventing an assistant answer", async (t) => {
  const { manager, session, bridge } = fixture(t);
  bridge.startTurn = async () => { throw Object.assign(new Error(rpcError.message), { code: -32000, additionalDetails: rpcError.additionalDetails }); };
  manager.write(session.id, "prompt");
  await waitForMicrotasks();
  const turn = session.threadSnapshot.turns[0];
  assert.equal(turn.status, "failed");
  assert.match(turn.error.message, /not supported/);
  assert.equal(turn.error.code, -32000);
  assert.equal(turn.error.rawMessage, rpcError.message);
  assert.equal(turn.items.some((item) => item.kind === "AgentMessage"), false);
});

test("failed snapshot errors survive projector reseeding and conversation round trips", async (t) => {
  const { manager, session, bridge } = fixture(t);
  manager.write(session.id, "prompt");
  await waitForMicrotasks();
  complete(bridge, "server-1", "failed", rpcError);
  const expected = session.threadSnapshot.turns[0].error;
  const projection = createLegacyThreadProjection({ snapshot: session.threadSnapshot });
  const reseeded = projectorSnapshotToLegacyThread(projection.projector.getSnapshot());
  assert.deepEqual(reseeded.turns[0].error, expected);
  const conversation = deriveConversationStateFromThreadSnapshot(reseeded);
  assert.deepEqual(conversation.turns[0].assistant.error, expected);
  assert.deepEqual(deriveThreadSnapshotFromConversationState(conversation).turns[0].error, expected);
  assert.deepEqual(manager.getConversationSnapshot(session.id).conversation.turns[0].assistant.error, expected);
});

test("historical task_failed records retain original provider errors through rebuilding and reseeding", (t) => {
  const { root } = fixture(t);
  const file = path.join(root, "failure-history.jsonl");
  fs.writeFileSync(file, [
    { type: "event_msg", timestamp: "2026-10-15T00:00:00Z", payload: { type: "user_message", turn_id: "turn-old", message: "prompt" } },
    { type: "event_msg", timestamp: "2026-10-15T00:00:01Z", payload: { type: "task_failed", turn_id: "turn-old", error: rpcError } }
  ].map((record) => JSON.stringify(record)).join("\n"));
  const rebuilt = buildThreadSnapshotFromFile(file, { threadId: "old-thread" });
  assert.deepEqual(rebuilt.turns[0].error, rpcError);
  const projection = createLegacyThreadProjection({ snapshot: rebuilt });
  assert.deepEqual(projectorSnapshotToLegacyThread(projection.projector.getSnapshot()).turns[0].error, rpcError);
});

test("error normalization handles nested objects and leaves ordinary messages intact", () => {
  assert.equal(normalizeAppServerErrorMessage({ message: "ordinary error" }), "ordinary error");
  assert.equal(normalizeAppServerErrorMessage({ message: '{"error":{"message":"nested cause"}}' }), "nested cause");
  assert.equal(normalizeAppServerErrorMessage({ error: { message: "object cause" } }), "object cause");
});

test("standard final_answer notifications retain reply text after local-to-server turn aliasing", async (t) => {
  const { manager, session, bridge } = fixture(t);
  manager.write(session.id, "return QA-A-7294");
  await waitForMicrotasks();
  bridge.emit("notification", { method: "turn/started", params: {
    threadId: "thread-failure", turn: { id: "server-1", status: "inProgress", items: [], error: null }
  } });
  bridge.emit("notification", { method: "item/started", params: {
    threadId: "thread-failure", turnId: "server-1", item: { id: "message-1", type: "agentMessage", text: "", phase: "final_answer" }
  } });
  bridge.emit("notification", { method: "item/agentMessage/delta", params: {
    threadId: "thread-failure", turnId: "server-1", itemId: "message-1", delta: "QA-A-7294"
  } });
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "AgentMessage").text, "QA-A-7294");
  bridge.emit("notification", { method: "item/completed", params: {
    threadId: "thread-failure", turnId: "server-1", item: { id: "message-1", type: "agentMessage", text: "QA-A-7294", phase: "final_answer" }
  } });
  complete(bridge, "server-1", "completed");
  const turn = session.threadSnapshot.turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.filter((item) => item.kind === "AgentMessage").length, 1);
  assert.equal(turn.items.find((item) => item.kind === "AgentMessage").text, "QA-A-7294");
  assert.equal(session.conversationState.turns[0].assistant.body[0].text, "QA-A-7294");
  const projection = createLegacyThreadProjection({ snapshot: session.threadSnapshot });
  assert.equal(projectorSnapshotToLegacyThread(projection.projector.getSnapshot()).turns[0].items.find((item) => item.kind === "AgentMessage").text, "QA-A-7294");
});
