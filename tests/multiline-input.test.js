import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { SessionManager } from "../src/sessionManager.js";
import { buildCodexJsonExecArgs, enqueueRunnerInput } from "../src/sessions/runners/codexRunner.js";
import { createBaseConfig, createTempDir, waitForMicrotasks } from "./helpers/backendTestUtils.js";

function fixture(t) {
  const config = createBaseConfig(createTempDir());
  const bridge = new EventEmitter();
  bridge.turns = [];
  bridge.startTurn = async (session, text, images) => {
    bridge.turns.push({ text, images });
    return { turn: { id: `server-${bridge.turns.length}`, status: "inProgress", items: [] } };
  };
  const manager = new SessionManager(config, { appServerBridge: bridge });
  manager.scheduleConversationHistoryResync = () => {};
  const session = manager.get(manager.create({ provider: "codex" }).id);
  t.after(() => manager.shutdown());
  return { manager, session, bridge };
}

test("a multiline submit reaches app-server as one turn with indentation and blank lines intact", async (t) => {
  const { manager, session, bridge } = fixture(t);
  const message = "Review this code:\n\n```js\n    first();\n    second();\n```";
  manager.write(session.id, `${message}\n`);
  await waitForMicrotasks();
  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].text, message);
  assert.equal(session.threadSnapshot.turns.length, 1);
  assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "UserMessage").text, message);
  assert.deepEqual(session.queuedInputs, []);
});

test("queued multiline messages consume one queue slot and retain their full text", (t) => {
  const { manager, session } = fixture(t);
  session.turnRunning = true;
  manager.config.maxQueuedInputs = 1;
  const message = "  leading indentation\n\n    nested\n";
  manager.write(session.id, `${message}\n`);
  assert.deepEqual(session.queuedInputs, [message]);
  assert.equal(session.queuedTurnIds.length, 1);
  assert.throws(() => manager.write(session.id, "another"), /上限 1/);
  assert.equal(session.queuedInputs.length, 1);
});

test("empty whitespace input creates no turn, while CRLF is normalized without flattening", async (t) => {
  const { manager, session, bridge } = fixture(t);
  manager.write(session.id, " \n\t\n");
  assert.equal(session.threadSnapshot.turns.length, 0);
  manager.write(session.id, "one\r\n\r\n  two\r\n");
  await waitForMicrotasks();
  assert.equal(bridge.turns[0].text, "one\n\n  two");
});

test("JSON exec receives multiline prompt in one argument and counts it as one input", () => {
  const text = "first\n\n    second\n";
  const session = { provider: "codex", runnerMode: "json_exec", turnRunning: true, queuedInputs: [], queuedTurnIds: [], permissionMode: "default" };
  const recorded = [];
  const manager = {
    config: { maxQueuedInputs: 1, codexExtraArgs: [] },
    createConversationTurn: (target, prompt) => { recorded.push(prompt); return "local-turn"; }
  };
  enqueueRunnerInput(manager, session, `${text}\n`);
  assert.deepEqual(session.queuedInputs, [text]);
  assert.deepEqual(recorded, [text]);
  assert.equal(buildCodexJsonExecArgs(manager, session, session.queuedInputs[0]).at(-1), text);
});
