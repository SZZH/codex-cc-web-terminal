import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { CodexDesktopClient } from "../src/sessions/codex/desktopClient.js";
import { buildAppServerTurnOptions } from "../src/sessions/shared/appServerOptions.js";

const unix = { skip: process.platform === "win32" };
const answer = (text = "Chosen option") => [{ type: "text", text: "<send_user_message_question_reply>\n" +
  JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "question-item", 0]), question: "Which option?", answer: text }]) +
  "\n</send_user_message_question_reply>", text_elements: [] }];
const settings = (permissionMode = "default") => buildAppServerTurnOptions({
  model: "fixture-model", reasoningEffort: "high", permissionMode, cwd: "/fixture/workspace",
});
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32LE(body.length);
  body.copy(result, 4);
  return result;
}

async function fixture(t, handle = () => false, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-ipc-test-"));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, "ipc.sock");
  const sockets = new Set(), requests = [], replies = [];
  let replyReceived;
  const nextReply = new Promise((resolve) => { replyReceived = resolve; });
  let connections = 0, owner = "desktop-owner";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    connections++;
    const clientId = `web-client-${connections}`;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        if (request.type === "client-discovery-response") { replies.push(request); replyReceived(request); continue; }
        requests.push(request);
        const success = (result, handledByClientId = request.method === "initialize" ? clientId : owner) => ({
          type: "response", requestId: request.requestId, resultType: "success", method: request.method, handledByClientId, result,
        });
        const send = (result, handledByClientId) => socket.write(frame(success(result, handledByClientId)));
        if (handle({ request, socket, send, success })) continue;
        if (request.method === "initialize") send({ clientId });
        else if (request.method === "thread-owner-discovery") send({ supportsUntrustedAppInput: true });
        else if (request.method === "thread-follower-steer-turn") send({ result: { turnId: "active-turn" } });
        else if (request.method === "thread-follower-start-turn") send({ result: { turn: { id: "new-turn", status: "inProgress" } } });
        else if (request.method === "thread-follower-interrupt-turn") send({ ok: true, interruptedTurnId: request.params.expectedTurnId });
        else assert.fail(`Unexpected RPC: ${request.method}`);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const client = new CodexDesktopClient({ socketPath, timeoutMs: 250, ...options });
  t.after(async () => {
    client.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client, socketPath, directory, requests, replies, nextReply, sockets, connections: () => connections,
    owner: (id) => { owner = id; } };
}

test("desktop IPC shares initialization and briefly caches owner discovery", unix, async (t) => {
  const f = await fixture(t);
  const owners = await Promise.all([f.client.discover("thread"), f.client.discover("thread"), f.client.discover("other")]);
  assert.deepEqual(owners[0], { clientId: "desktop-owner", supportsUntrustedAppInput: true });
  assert.equal(f.connections(), 1);
  assert.equal(f.requests.filter((r) => r.method === "initialize").length, 1);
  assert.equal(f.requests.filter((r) => r.method === "thread-owner-discovery").length, 2);
  await f.client.discover("thread");
  assert.equal(f.requests.length, 3);
  const [initialize, discovery] = f.requests;
  assert.equal(initialize.version, 0);
  assert.equal(initialize.sourceClientId, "initializing-client");
  assert.equal(discovery.version, 1);
  assert.equal(discovery.sourceClientId, "web-client-1");
  assert.deepEqual(discovery.params, { hostId: "local", conversationId: "thread" });
});

test("native async replies recheck owner and return the actual desktop receipt", unix, async (t) => {
  const f = await fixture(t);
  const owner = await f.client.discover("thread");
  const input = answer("选项一");
  const result = await f.client.steer("thread", { owner, clientUserMessageId: "reply-one", input, expectedTurnId: "previous-turn" });
  assert.deepEqual(result, { turnId: "active-turn" });
  assert.equal(f.requests.filter((r) => r.method === "thread-owner-discovery").length, 2);
  const sent = f.requests.at(-1);
  assert.equal(sent.method, "thread-follower-steer-turn");
  assert.equal(sent.targetClientId, owner.clientId);
  assert.equal(sent.params.clientUserMessageId, "reply-one");
  assert.deepEqual(sent.params.input, input);
  assert.equal(sent.params.restoreMessage.context.prompt, input[0].text);
  assert.equal(sent.params.restoreMessage.context.turnTrigger, "send_user_message_async_question");
  assert.equal("expectedTurnId" in sent.params, false, "the private API has no atomic expected-turn parameter");
  assert.equal("hostId" in sent, false, "local follower requests use version 1 without envelope hostId");
});

test("desktop interruption uses v4 with an explicit target and a fresh owner", unix, async (t) => {
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-owner-discovery") return false;
    send({ supportsUntrustedAppInput: false }); return true;
  });
  const owner = await f.client.discover("thread");
  assert.deepEqual(await f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" }),
    { ok: true, turnId: "active-turn" });
  assert.equal(f.requests.filter((request) => request.method === "thread-owner-discovery").length, 2);
  const sent = f.requests.at(-1);
  assert.equal(sent.method, "thread-follower-interrupt-turn");
  assert.equal(sent.version, 4);
  assert.equal(sent.targetClientId, owner.clientId);
  assert.equal(sent.sourceClientId, "web-client-1");
  assert.deepEqual(sent.params, { conversationId: "thread", mode: "user-stop", expectedTurnId: "active-turn" });
  assert.equal("hostId" in sent, false);
  assert.equal("clientUserMessageId" in sent.params, false);
});

test("interrupt requires a valid target and does not follow an owner change", unix, async (t) => {
  const f = await fixture(t);
  for (const expectedTurnId of [undefined, null, "", " ", " padded ", "turn\nnext", "turn\0next", 7, {}]) {
    await assert.rejects(f.client.interruptTurn("thread", { owner: { clientId: "owner" }, expectedTurnId }),
      { code: "CODEX_DESKTOP_INVALID_INTERRUPT", uncertain: false });
  }
  assert.equal(f.connections(), 0);
  const owner = await f.client.discover("thread");
  f.owner("replacement-owner");
  await assert.rejects(f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" }),
    { code: "CODEX_DESKTOP_OWNER_CHANGED", uncertain: false });
  assert.equal(f.requests.some((request) => request.method === "thread-follower-interrupt-turn"), false);
});

test("a repeated stop keeps its original target and accepts null after that target ends", unix, async (t) => {
  let interrupted = false;
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-follower-interrupt-turn") return false;
    send({ ok: true, interruptedTurnId: interrupted ? null : request.params.expectedTurnId });
    interrupted = true; return true;
  });
  const owner = await f.client.discover("thread");
  assert.deepEqual(await f.client.interruptTurn("thread", { owner, expectedTurnId: "target-turn" }),
    { ok: true, turnId: "target-turn" });
  assert.deepEqual(await f.client.interruptTurn("thread", { owner, expectedTurnId: "target-turn" }),
    { ok: true, turnId: null });
  const sent = f.requests.filter((request) => request.method === "thread-follower-interrupt-turn");
  assert.equal(sent.length, 2, "only the two explicit caller actions send requests");
  assert.ok(sent.every((request) => request.version === 4 && request.params.expectedTurnId === "target-turn"));
});

test("interrupt preserves a goal-pause error alongside the confirmed target receipt", unix, async (t) => {
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-follower-interrupt-turn") return false;
    send({ ok: true, interruptedTurnId: "active-turn", goalPauseError: "Failed to pause thread goal" }); return true;
  });
  const owner = await f.client.discover("thread");
  assert.deepEqual(await f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" }),
    { ok: true, turnId: "active-turn", goalPauseError: "Failed to pause thread goal" });
  assert.equal(f.requests.filter((request) => request.method === "thread-follower-interrupt-turn").length, 1);
});

test("interrupt rejects unverifiable result shapes and mismatched targets as uncertain", unix, async (t) => {
  const replies = {
    "wrong-turn": { ok: true, interruptedTurnId: "another-turn" },
    "missing-turn": { ok: true },
    "missing-ok": { interruptedTurnId: "active-turn" },
    "false-ok": { ok: false, interruptedTurnId: "active-turn" },
    "wrong-nesting": { result: { ok: true, interruptedTurnId: "active-turn" } },
    "invalid-goal-error": { ok: true, interruptedTurnId: "active-turn", goalPauseError: {} },
  };
  for (const [name, reply] of Object.entries(replies)) await t.test(name, async (t) => {
    const f = await fixture(t, ({ request, send }) => {
      if (request.method !== "thread-follower-interrupt-turn") return false;
      send(reply); return true;
    });
    const owner = await f.client.discover("thread");
    await assert.rejects(f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" }),
      { code: "CODEX_DESKTOP_DELIVERY_UNCERTAIN", uncertain: true, expectedTurnId: "active-turn" });
    assert.equal(f.requests.filter((request) => request.method === "thread-follower-interrupt-turn").length, 1);
  });
});

test("concurrent duplicate stops share one mutation and duplicate replies do not cause retries", unix, async (t) => {
  let release, seen;
  const dispatched = new Promise((resolve) => { seen = resolve; });
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-follower-interrupt-turn") return false;
    release = () => {
      send({ ok: true, interruptedTurnId: "active-turn" });
      send({ ok: true, interruptedTurnId: "active-turn" });
    };
    seen(); return true;
  });
  const owner = await f.client.discover("thread");
  const first = f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" });
  const second = f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" });
  await dispatched;
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true, turnId: "active-turn" }, { ok: true, turnId: "active-turn" }]);
  assert.equal(f.requests.filter((request) => request.method === "thread-follower-interrupt-turn").length, 1);
  assert.equal(f.requests.filter((request) => request.method === "thread-owner-discovery").length, 2);
});

test("interrupt timeout, lost acknowledgements and version rejection never remove the target or retry", unix, async (t) => {
  for (const mode of ["timeout", "disconnect", "router-timeout", "wrong-owner", "version-rejected"]) await t.test(mode, async (t) => {
    const f = await fixture(t, ({ request, socket, send }) => {
      if (request.method !== "thread-follower-interrupt-turn") return false;
      if (mode === "disconnect") socket.destroy();
      if (mode === "wrong-owner") send({ ok: true, interruptedTurnId: "active-turn" }, "different-owner");
      if (["router-timeout", "version-rejected"].includes(mode)) socket.write(frame({ type: "response",
        requestId: request.requestId, resultType: "error", error: mode === "router-timeout" ? "request-timeout" : "request-version-mismatch" }));
      return true;
    }, { timeoutMs: 50 });
    const owner = await f.client.discover("thread");
    await assert.rejects(f.client.interruptTurn("thread", { owner, expectedTurnId: "active-turn" }), (error) => {
      assert.equal(error.code, mode === "version-rejected" ? "CODEX_DESKTOP_REJECTED" : "CODEX_DESKTOP_DELIVERY_UNCERTAIN");
      assert.equal(error.uncertain, mode !== "version-rejected");
      if (error.uncertain) {
        assert.equal(error.expectedTurnId, "active-turn");
        assert.ok(error.requestId);
      }
      return true;
    });
    const sent = f.requests.filter((request) => request.method.startsWith("thread-follower-"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].version, 4);
    assert.equal(sent[0].params.expectedTurnId, "active-turn");
  });
});

test("an idle native question starts on its existing owner with version 2 and inherited settings", unix, async (t) => {
  const f = await fixture(t);
  const owner = await f.client.discover("thread");
  const input = answer("继续执行");
  const result = await f.client.startQuestion("thread", { owner, clientUserMessageId: "idle-answer", input });
  assert.deepEqual(result, { turnId: "new-turn" });
  assert.equal(f.requests.filter((r) => r.method === "thread-owner-discovery").length, 2);
  const sent = f.requests.at(-1);
  assert.equal(sent.method, "thread-follower-start-turn");
  assert.equal(sent.version, 2);
  assert.equal(sent.targetClientId, owner.clientId);
  assert.equal("hostId" in sent, false);
  assert.equal(sent.params.conversationId, "thread");
  assert.deepEqual(sent.params.turnStart.request, { threadId: "thread", clientUserMessageId: "idle-answer", input,
    turnTrigger: "send_user_message_async_question" });
  const context = sent.params.turnStart.context;
  assert.equal(context.inheritThreadSettings, true);
  assert.deepEqual(context.attachments, []);
  assert.equal(context.restoreMessage.id, "idle-answer");
  assert.equal(context.restoreMessage.text, input[0].text);
  assert.equal(context.restoreMessage.context.prompt, input[0].text);
  assert.deepEqual(context.restoreMessage.context.workspaceRoots, []);
  assert.ok(Number.isFinite(context.restoreMessage.createdAt));
  assert.equal(f.requests.some((r) => r.method === "thread-follower-steer-turn"), false);
});

test("idle question start refuses an owner changed since discovery", unix, async (t) => {
  const f = await fixture(t);
  const owner = await f.client.discover("thread");
  f.owner("new-owner");
  await assert.rejects(f.client.startQuestion("thread", { owner, clientUserMessageId: "reply", input: answer() }),
    { code: "CODEX_DESKTOP_OWNER_CHANGED", uncertain: false });
  assert.equal(f.requests.some((r) => r.method === "thread-follower-start-turn"), false);
});

test("submitted messages carry their complete settings without inheriting desktop choices", unix, async (t) => {
  for (const permissionMode of ["default", "manual-review", "auto-review", "full-access"]) await t.test(permissionMode, async (t) => {
    const f = await fixture(t);
    const owner = await f.client.discover("thread");
    const input = [{ type: "text", text: "继续\n  保留缩进", text_elements: [] },
      { type: "localImage", path: "/fixture/image.png" }];
    const submittedSettings = settings(permissionMode);
    assert.deepEqual(await f.client.startMessage("thread", { owner, clientUserMessageId: "manual-send", input,
      settings: submittedSettings }), { turnId: "new-turn" });
    assert.equal(f.requests.filter((request) => request.method === "thread-owner-discovery").length, 2);
    const sent = f.requests.at(-1);
    assert.equal(sent.method, "thread-follower-start-turn");
    assert.equal(sent.version, 2);
    assert.equal(sent.targetClientId, owner.clientId);
    assert.deepEqual(sent.params.turnStart.request, { threadId: "thread", clientUserMessageId: "manual-send", input,
      turnTrigger: "composer", ...submittedSettings });
    const context = sent.params.turnStart.context;
    assert.equal(context.inheritThreadSettings, false);
    assert.equal(context.useAppServerPermissionDefault, false);
    assert.equal(context.usePermissionSelection, false);
    assert.equal(context.restoreMessage.text, input[0].text);
    assert.equal(context.restoreMessage.context.prompt, input[0].text);
    assert.deepEqual(context.restoreMessage.context.imageAttachments, [{ id: "manual-send:0", src: "/fixture/image.png" }]);
    assert.deepEqual(context.attachments, []);
    assert.deepEqual(f.requests.filter((request) => request.method.startsWith("thread-follower-")).map((request) => request.method),
      ["thread-follower-start-turn"]);
  });
});

test("message input and nested permission settings are captured before owner discovery", unix, async (t) => {
  let discoveries = 0, release, seen;
  const discovering = new Promise((resolve) => { seen = resolve; });
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-owner-discovery" || ++discoveries !== 2) return false;
    release = () => send({ supportsUntrustedAppInput: true }); seen(); return true;
  });
  const owner = await f.client.discover("thread");
  const input = [{ type: "text", text: "submitted text" }], submittedSettings = settings("auto-review");
  const sending = f.client.startMessage("thread", { owner, clientUserMessageId: "snapshot", input, settings: submittedSettings });
  await discovering;
  input[0].text = "later draft";
  submittedSettings.model = "later-model";
  submittedSettings.sandboxPolicy.writableRoots.push("/later-root");
  release();
  await sending;
  assert.deepEqual(f.requests.at(-1).params.turnStart.request, { threadId: "thread", clientUserMessageId: "snapshot",
    input: [{ type: "text", text: "submitted text", text_elements: [] }], turnTrigger: "composer", ...settings("auto-review") });
});

test("message starts require the same capable owner immediately before dispatch", unix, async (t) => {
  for (const mode of ["owner-changed", "capability-lost"]) await t.test(mode, async (t) => {
    let discoveries = 0;
    const f = await fixture(t, ({ request, send }) => {
      if (request.method !== "thread-owner-discovery" || ++discoveries !== 2 || mode !== "capability-lost") return false;
      send({ supportsUntrustedAppInput: false }); return true;
    });
    const owner = await f.client.discover("thread");
    if (mode === "owner-changed") f.owner("replacement-owner");
    await assert.rejects(f.client.startMessage("thread", { owner, clientUserMessageId: "send",
      input: [{ type: "text", text: "new message" }], settings: settings() }), {
      code: mode === "owner-changed" ? "CODEX_DESKTOP_OWNER_CHANGED" : "CODEX_DESKTOP_UNSUPPORTED", uncertain: false,
    });
    assert.equal(f.requests.some((request) => request.method.startsWith("thread-follower-")), false);
  });
});

test("message starts recheck idle state after discovering the owner and skip writes on a conflict", unix, async (t) => {
  const f = await fixture(t);
  const owner = await f.client.discover("thread");
  let checks = 0;
  await assert.rejects(f.client.startMessage("thread", { owner, clientUserMessageId: "send",
    input: [{ type: "text", text: "new message" }], settings: settings(), beforeSend: async () => {
      checks++;
      assert.equal(f.requests.filter((r) => r.method === "thread-owner-discovery").length, 2);
      return false;
    } }), { code: "CODEX_DESKTOP_NOT_IDLE", uncertain: false });
  assert.equal(checks, 1);
  assert.equal(f.requests.some((request) => request.method.startsWith("thread-follower-")), false);
});

test("message starts reject unsupported input and incomplete or extra settings before connecting", unix, async (t) => {
  const f = await fixture(t);
  for (const input of [[], [{ type: "text", text: "   " }], [{ type: "image", url: "https://example.invalid/image.png" }],
    [{ type: "localImage", path: "relative.png" }], [{ type: "localImage", path: "/bad\0path.png" }], [{ type: "text", text: 3 }]]) {
    await assert.rejects(f.client.startMessage("thread", { owner: { clientId: "owner" }, clientUserMessageId: "send",
      input, settings: settings() }), { code: "CODEX_DESKTOP_INVALID_MESSAGE", uncertain: false });
  }
  const incomplete = settings(); delete incomplete.approvalsReviewer;
  for (const submittedSettings of [incomplete, { ...settings(), collaborationMode: { mode: "plan" } },
    { ...settings(), approvalsReviewer: "unknown" }, { ...settings(), sandboxPolicy: null }]) {
    await assert.rejects(f.client.startMessage("thread", { owner: { clientId: "owner" }, clientUserMessageId: "send",
      input: [{ type: "text", text: "new message" }], settings: submittedSettings }),
    { code: "CODEX_DESKTOP_INVALID_SETTINGS", uncertain: false });
  }
  await assert.rejects(f.client.startMessage("thread", { owner: { clientId: "owner" }, clientUserMessageId: " ",
    input: [{ type: "text", text: "new message" }], settings: settings() }),
  { code: "CODEX_DESKTOP_INVALID_MESSAGE", uncertain: false });
  assert.equal(f.connections(), 0);
});

test("message starts never retry or steer when their receipt is uncertain or rejected", unix, async (t) => {
  for (const mode of ["timeout", "disconnect", "missing-turn", "wrong-owner", "rejected"]) await t.test(mode, async (t) => {
    const f = await fixture(t, ({ request, socket, send }) => {
      if (request.method !== "thread-follower-start-turn") return false;
      if (mode === "disconnect") socket.destroy();
      if (mode === "missing-turn") send({ result: { turnId: "wrong-shape" } });
      if (mode === "wrong-owner") send({ result: { turn: { id: "turn" } } }, "replacement-owner");
      if (mode === "rejected") socket.write(frame({ type: "response", requestId: request.requestId, resultType: "error", error: "turn already active" }));
      return true;
    }, { timeoutMs: 50 });
    const owner = await f.client.discover("thread");
    await assert.rejects(f.client.startMessage("thread", { owner, clientUserMessageId: "send",
      input: [{ type: "text", text: "new message" }], settings: settings() }),
    { code: mode === "rejected" ? "CODEX_DESKTOP_REJECTED" : "CODEX_DESKTOP_DELIVERY_UNCERTAIN", uncertain: mode !== "rejected" });
    assert.deepEqual(f.requests.filter((request) => request.method.startsWith("thread-follower-")).map((request) => request.method),
      ["thread-follower-start-turn"]);
  });
});

test("idle start with a missing native turn.id has uncertain delivery and does not resend", unix, async (t) => {
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-follower-start-turn") return false;
    send({ result: { turnId: "wrong-shape" } }); return true;
  });
  const owner = await f.client.discover("thread");
  await assert.rejects(f.client.startQuestion("thread", { owner, clientUserMessageId: "reply", input: answer() }),
    { code: "CODEX_DESKTOP_DELIVERY_UNCERTAIN", uncertain: true, clientUserMessageId: "reply" });
  assert.equal(f.requests.filter((r) => r.method.startsWith("thread-follower-")).length, 1);
});

test("idle start cannot accept ordinary text or malformed native answer identities", unix, async (t) => {
  const f = await fixture(t);
  for (const input of [[{ type: "text", text: "Start an unrelated task" }],
    [{ type: "text", text: '<send_user_message_question_reply>[{"questionItemId":"wrong","question":"Q","answer":"A"}]</send_user_message_question_reply>' }]]) {
    await assert.rejects(f.client.startQuestion("thread", { owner: { clientId: "owner" }, clientUserMessageId: "reply", input }),
      { code: "CODEX_DESKTOP_INVALID_REPLY", uncertain: false });
  }
  assert.equal(f.connections(), 0);
});

test("lost idle-start acknowledgements remain uncertain without steering or retrying", unix, async (t) => {
  const f = await fixture(t, ({ request, socket }) => {
    if (request.method !== "thread-follower-start-turn") return false;
    socket.destroy(); return true;
  });
  const owner = await f.client.discover("thread");
  await assert.rejects(f.client.startQuestion("thread", { owner, clientUserMessageId: "reply", input: answer() }),
    { code: "CODEX_DESKTOP_DELIVERY_UNCERTAIN", uncertain: true });
  assert.deepEqual(f.requests.filter((r) => r.method.startsWith("thread-follower-")).map((r) => r.method), ["thread-follower-start-turn"]);
});

test("native start and steer errors never cause automatic cross-method fallback", unix, async (t) => {
  for (const method of ["steer", "startQuestion"]) await t.test(method, async (t) => {
    const f = await fixture(t, ({ request, socket }) => {
      if (!request.method.startsWith("thread-follower-")) return false;
      socket.write(frame({ type: "response", requestId: request.requestId, resultType: "error",
        error: method === "steer" ? "NoActiveTurn" : "turn already active" }));
      return true;
    });
    const owner = await f.client.discover("thread");
    await assert.rejects(f.client[method]("thread", { owner, clientUserMessageId: "reply", input: answer() }),
      { code: "CODEX_DESKTOP_REJECTED", uncertain: false });
    assert.equal(f.requests.filter((r) => r.method.startsWith("thread-follower-")).length, 1);
  });
});

test("a changed owner is rejected before dispatching an answer", unix, async (t) => {
  const f = await fixture(t);
  const owner = await f.client.discover("thread");
  f.owner("replacement-owner");
  await assert.rejects(f.client.steer("thread", { owner, clientUserMessageId: "reply", input: answer() }),
    { code: "CODEX_DESKTOP_OWNER_CHANGED", uncertain: false });
  assert.equal(f.requests.some((r) => r.method === "thread-follower-steer-turn"), false);
});

test("discovery cancellation does not cancel other readers or the persistent connection", unix, async (t) => {
  let release, seen;
  const discovered = new Promise((resolve) => { seen = resolve; });
  const f = await fixture(t, ({ request, send }) => {
    if (request.method !== "thread-owner-discovery") return false;
    release = () => send({ supportsUntrustedAppInput: true }); seen(); return true;
  });
  const controller = new AbortController();
  const cancelled = f.client.discover("thread", { signal: controller.signal });
  const continued = f.client.discover("thread");
  await discovered;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release();
  assert.equal((await continued).clientId, "desktop-owner");
  assert.equal((await f.client.discover("thread")).clientId, "desktop-owner");
  assert.equal(f.connections(), 1);
});

test("fragmented UTF-8 frames, unrelated broadcasts and discovery probes are handled without owning threads", unix, async (t) => {
  const f = await fixture(t, ({ request, socket, success }) => {
    if (request.method !== "thread-owner-discovery") return false;
    const reply = Buffer.concat([
      frame({ type: "broadcast", method: "unused", params: { text: "本地状态" } }),
      frame({ type: "client-discovery-request", requestId: "probe", request: { method: "thread-owner-discovery" } }),
      frame(success({ supportsUntrustedAppInput: true })),
    ]);
    socket.write(reply.subarray(0, 2));
    setImmediate(() => { socket.write(reply.subarray(2, 37)); socket.write(reply.subarray(37)); });
    return true;
  });
  assert.equal((await f.client.discover("thread")).clientId, "desktop-owner");
  await f.nextReply;
  assert.deepEqual(f.replies, [{ type: "client-discovery-response", requestId: "probe", response: { canHandle: false } }]);
});

test("lost mutation acknowledgements stay uncertain and are never automatically retried", unix, async (t) => {
  const f = await fixture(t, ({ request, socket }) => {
    if (request.method !== "thread-follower-steer-turn") return false;
    socket.destroy(); return true;
  });
  const owner = await f.client.discover("thread");
  await assert.rejects(f.client.steer("thread", { owner, clientUserMessageId: "reply-lost", input: answer() }), (error) => {
    assert.equal(error.code, "CODEX_DESKTOP_DELIVERY_UNCERTAIN");
    assert.equal(error.uncertain, true);
    assert.equal(error.clientUserMessageId, "reply-lost");
    assert.ok(error.requestId); return true;
  });
  assert.equal(f.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
  assert.equal((await f.client.discover("thread")).clientId, "desktop-owner");
  assert.equal(f.connections(), 2, "a later read may reconnect but does not replay the answer");
});

test("a mutation timeout is uncertain while an explicit owner rejection is definite", unix, async (t) => {
  for (const mode of ["timeout", "rejection", "router-timeout"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, ({ request, socket }) => {
        if (request.method !== "thread-follower-steer-turn") return false;
        if (mode !== "timeout") socket.write(frame({ type: "response", requestId: request.requestId,
          resultType: "error", error: mode === "rejection" ? "no-client-found" : "request-timeout" }));
        return true;
      }, { timeoutMs: 40 });
      const owner = await f.client.discover("thread");
      await assert.rejects(f.client.steer("thread", { owner, clientUserMessageId: "reply", input: answer() }),
        { uncertain: mode !== "rejection" });
      assert.equal(f.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
    });
  }
});

test("a mismatched response owner or an unverifiable receipt cannot report success", unix, async (t) => {
  for (const mode of ["wrong-owner", "missing-turn"]) await t.test(mode, async (t) => {
    const f = await fixture(t, ({ request, send }) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      send(mode === "missing-turn" ? { ok: true } : { result: { turnId: "turn" } }, mode === "wrong-owner" ? "other-owner" : undefined);
      return true;
    });
    const owner = await f.client.discover("thread");
    await assert.rejects(f.client.steer("thread", { owner, clientUserMessageId: "reply", input: answer() }), { uncertain: true });
  });
});

test("oversized and malformed incoming frames fail pending requests and reset the connection", unix, async (t) => {
  for (const mode of ["oversized", "malformed"]) await t.test(mode, async (t) => {
    const f = await fixture(t, ({ request, socket }) => {
      if (request.method !== "thread-owner-discovery") return false;
      const bad = Buffer.alloc(mode === "oversized" ? 4 : 5);
      bad.writeUInt32LE(mode === "oversized" ? 8 * 1024 * 1024 + 1 : 1);
      if (mode === "malformed") bad[4] = 0xff;
      socket.write(bad); return true;
    });
    await assert.rejects(f.client.discover("thread"), { code: "CODEX_DESKTOP_PROTOCOL", uncertain: false });
  });
});

test("unconfigured clients never fall back to the real home directory", async () => {
  const client = new CodexDesktopClient();
  assert.equal(client.socketPath, null);
  await assert.rejects(client.discover("thread"), { code: "CODEX_DESKTOP_UNAVAILABLE" });
  client.shutdown();
});

test("socket locations are derived only from configured paths", async () => {
  const config = { codexConfigPath: path.join(os.tmpdir(), "example-codex", "config.toml") };
  const client = new CodexDesktopClient({ config });
  assert.equal(client.socketPath, path.join(path.dirname(config.codexConfigPath), "ipc", "ipc.sock"));
  client.shutdown();
});

test("unsafe permissions, symlinks and ordinary files are rejected before connecting", unix, async (t) => {
  const f = await fixture(t);
  await chmod(f.socketPath, 0o666);
  await assert.rejects(f.client.discover("thread"), { code: "CODEX_DESKTOP_UNSAFE_SOCKET" });
  await chmod(f.socketPath, 0o600);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.client.discover("thread"), { code: "CODEX_DESKTOP_UNSAFE_SOCKET" });
  await chmod(f.directory, 0o700);
  const alias = path.join(f.directory, "alias.sock");
  await symlink(f.socketPath, alias);
  const linked = new CodexDesktopClient({ socketPath: alias });
  await assert.rejects(linked.discover("thread"), { code: "CODEX_DESKTOP_UNSAFE_SOCKET" });
  linked.shutdown();
  const file = path.join(f.directory, "file.sock");
  await writeFile(file, "", { mode: 0o600 });
  const ordinary = new CodexDesktopClient({ socketPath: file });
  await assert.rejects(ordinary.discover("thread"), { code: "CODEX_DESKTOP_UNSAFE_SOCKET" });
  ordinary.shutdown();
  assert.equal(f.connections(), 0);
});

test("the client refuses arbitrary steering, malformed identities and oversized answers", unix, async (t) => {
  const f = await fixture(t);
  for (const input of [[{ type: "text", text: "Run an arbitrary command" }], answer("x".repeat(256 * 1024)),
    [{ type: "text", text: "<send_user_message_question_reply>[]</send_user_message_question_reply>" }]]) {
    await assert.rejects(f.client.steer("thread", { owner: { clientId: "owner" }, clientUserMessageId: "reply", input }),
      { code: "CODEX_DESKTOP_INVALID_REPLY", uncertain: false });
  }
  assert.equal(f.connections(), 0);
});

test("discovery is bounded and shutdown prevents reconnecting", unix, async (t) => {
  const f = await fixture(t, ({ request }) => request.method === "thread-owner-discovery", { timeoutMs: 35 });
  const started = Date.now();
  await assert.rejects(f.client.discover("thread"), { uncertain: false });
  assert.ok(Date.now() - started < 1000);
  f.client.shutdown();
  await assert.rejects(f.client.discover("thread"), { code: "CODEX_DESKTOP_UNAVAILABLE" });
  assert.equal(f.connections(), 1);
});
