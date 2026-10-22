import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerBridge } from "../src/appServerBridge.js";
import { CodexInteractionService } from "../src/sessions/codex/interactions/service.js";
import { validateInteractionResponse } from "../src/sessions/codex/interactions/responses.js";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { createBaseConfig } from "./helpers/backendTestUtils.js";
import { describeMcpForm, buildMcpFormResponse } from "../web/src/lib/codex-interactions/form.js";
import { capabilityError } from "../src/sessions/codex/interactions/responses.js";

function fixture(t, options = {}) {
  const { send, ...serviceOptions } = options;
  const bridge = new AppServerBridge({});
  const messages = [], events = [];
  bridge.bindSocket({ readyState: 1, on() {}, send(payload, callback) { messages.push(JSON.parse(payload)); if (send) send(callback); else callback?.(); } });
  const service = new CodexInteractionService({ bridge, ownsThread: (id) => id === "thread-123", publish: (...event) => events.push(event), ...serviceOptions });
  t.after(() => { service.shutdown(); bridge.resetConnectionState(); });
  function receive(method, params = {}, id = randomUUID()) {
    bridge.handleMessage(JSON.stringify({ id, method, params: { threadId: "thread-123", turnId: "turn-123", itemId: "item-123", startedAtMs: 100, ...params } }));
    return service.list("thread-123").interactions.at(-1);
  }
  return { bridge, service, messages, events, receive };
}

test("questions remain available without observers and answers are sent once without retention", async (t) => {
  const f = fixture(t);
  const interaction = f.receive("item/tool/requestUserInput", { isBlocking: false,
    questions: [{ id: "secret", header: "Token", question: "Value", isSecret: true }] });
  assert.equal(interaction.status, "pending");
  const answer = { responseId: randomUUID(), response: { answers: { secret: { answers: ["private-response-value"] } } } };
  const completed = await f.service.respond("thread-123", interaction.id, answer);
  assert.equal(completed.interaction.status, "submitted");
  await f.service.respond("thread-123", interaction.id, answer);
  assert.equal(f.messages.length, 1);
  assert.equal(JSON.stringify(f.events).includes("private-response-value"), false);
  assert.equal(JSON.stringify(f.service.list("thread-123")).includes("private-response-value"), false);
  assert.equal(f.messages[0].result.answers.secret.answers[0], "private-response-value");
});

test("permission and command responses cannot invent grants or persistent rules", async (t) => {
  const f = fixture(t);
  const permission = f.receive("item/permissions/requestApproval", { cwd: "/workspace", permissions: { network: { enabled: true }, fileSystem: { write: ["/workspace"] } } });
  await assert.rejects(f.service.respond("thread-123", permission.id, { responseId: randomUUID(), response: { permissions: { fileSystem: { write: ["/"] } }, scope: "turn" } }), /permission|权限/);
  assert.equal(f.messages.length, 0);
  await f.service.respond("thread-123", permission.id, { responseId: randomUUID(), response: { permissions: { network: { enabled: true } }, scope: "turn" } });
  const command = f.receive("item/commandExecution/requestApproval", { availableDecisions: ["decline", "accept"], proposedExecpolicyAmendment: ["git", "status"] });
  await assert.rejects(f.service.respond("thread-123", command.id, { responseId: randomUUID(), response: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sh"] } } } }), /decision|规则/);
  assert.equal(f.messages.length, 1);
});

test("MCP form validates typed content and standalone elicitations survive unrelated turn completion", async (t) => {
  const f = fixture(t);
  const entry = f.receive("mcpServer/elicitation/request", { turnId: null, serverName: "forms", mode: "form", message: "Pick", requestedSchema: {
    type: "object", properties: { count: { type: "integer", minimum: 1 }, tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 } }, required: ["count"]
  } });
  f.bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "other", status: "completed" } } });
  assert.equal(f.service.get("thread-123", entry.id).interaction.status, "pending");
  await assert.rejects(f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { action: "accept", content: { count: 1.5 } } }), /form|integer|表单/);
  await f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { action: "accept", content: { count: 2, tags: ["a"] } } });
  assert.equal(f.messages.length, 1);
});

test("same-item approvals and typed IDs remain independent, including writeStdin", async (t) => {
  const f = fixture(t);
  f.receive("item/commandExecution/requestApproval", { approvalId: "approval-one", kind: "command" }, 1);
  f.receive("item/commandExecution/requestApproval", { approvalId: "approval-two", kind: "writeStdin" }, "1");
  const [one, two] = f.service.list("thread-123").interactions;
  assert.notEqual(one.id, two.id);
  f.bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "wrong-thread", requestId: 1 } }));
  assert.equal(f.service.get("thread-123", one.id).interaction.status, "pending");
  f.bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: 1 } }));
  assert.equal(f.service.get("thread-123", one.id).interaction.status, "resolved");
  assert.equal(f.service.get("thread-123", two.id).interaction.status, "pending");
  await assert.rejects(f.service.respond("thread-123", one.id, { responseId: randomUUID(), response: { decision: "accept" } }), (error) => error.status === 409);
  await f.service.respond("thread-123", two.id, { responseId: randomUUID(), response: { decision: "decline" } });
  assert.equal(f.messages[0].id, "1");
  assert.equal(f.events.at(-1)[2].interaction.params.kind, "writeStdin");
});

test("multiple respondents claim once and official resolution wins a pending send callback", async (t) => {
  let callback;
  const f = fixture(t, { send: (done) => { callback = done; } });
  const entry = f.receive("item/fileChange/requestApproval");
  const answer = { responseId: randomUUID(), response: { decision: "accept" } };
  const first = f.service.respond("thread-123", entry.id, answer);
  const repeat = f.service.respond("thread-123", entry.id, answer);
  await assert.rejects(f.service.respond("thread-123", entry.id, { ...answer, responseId: randomUUID() }), (error) => error.code === "interaction_response_conflict");
  await assert.rejects(f.service.respond("thread-123", entry.id, { ...answer, response: { decision: "decline" } }), (error) => error.status === 409);
  assert.equal(f.messages.length, 1);
  f.bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: f.messages[0].id } }));
  assert.equal((await first).interaction.status, "resolved");
  assert.equal((await repeat).interaction.status, "resolved");
  callback();
  assert.equal(f.service.get("thread-123", entry.id).interaction.status, "resolved");
  assert.equal(f.service.records.get(entry.id).request, null);
});

test("uncertain delivery is queried and repeated answers never replay the mutation", async (t) => {
  const f = fixture(t, { send: (done) => done(new Error("write uncertain")) });
  const entry = f.receive("item/fileChange/requestApproval");
  const answer = { responseId: randomUUID(), response: { decision: "accept" } };
  assert.equal((await f.service.respond("thread-123", entry.id, answer)).interaction.status, "unknown");
  assert.equal((await f.service.respond("thread-123", entry.id, answer)).interaction.status, "unknown");
  assert.equal(f.service.get("thread-123", entry.id).interaction.error.code, "response_delivery_uncertain");
  assert.equal(f.messages.length, 1);
  f.bridge.resetConnectionState();
  assert.equal(f.service.get("thread-123", entry.id).interaction.status, "unavailable");
  assert.equal(f.bridge.inbound.requests.size, 0);
});

test("disconnect releases a stalled send and keeps only non-actionable snapshot state", async (t) => {
  const f = fixture(t, { send: () => {} });
  const entry = f.receive("item/fileChange/requestApproval");
  const awaiting = f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { decision: "accept" } });
  f.bridge.resetConnectionState();
  assert.equal((await awaiting).interaction.status, "unavailable");
  assert.equal(f.service.records.get(entry.id).request, null);
  assert.equal(f.bridge.listenerCount("notification"), 1);
  f.service.shutdown();
  assert.equal(f.bridge.listenerCount("notification"), 0);
  assert.equal(f.bridge.inbound.listenerCount("resolved"), 0);
});

test("bounded collection rejects overflow without losing earlier callbacks", async (t) => {
  const f = fixture(t, { maxPending: 1, maxTerminal: 1 });
  const original = f.receive("item/fileChange/requestApproval");
  f.receive("item/tool/requestUserInput", { isBlocking: true, questions: [] });
  assert.equal(f.service.list("thread-123").interactions.length, 1);
  assert.match(f.messages[0].error.message, /Too many/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.bridge.inbound.requests.size, 1);
  f.bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: f.service.records.get(original.id).request.rpcId } }));
  const next = f.receive("item/fileChange/requestApproval");
  f.bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: f.service.records.get(next.id).request.rpcId } }));
  assert.equal(f.service.list("thread-123").interactions.length, 1);
  assert.equal(f.service.get("thread-123", next.id).interaction.status, "resolved");
});

test("file evidence and turn terminal cleanup do not clear standalone MCP callbacks", async (t) => {
  const f = fixture(t);
  const file = f.receive("item/fileChange/requestApproval");
  const standalone = f.receive("mcpServer/elicitation/request", { turnId: null, serverName: "auth", mode: "url", elicitationId: "auth-123", url: "https://example.com/approve", message: "Open" });
  f.bridge.emit("notification", { method: "item/started", params: { threadId: "thread-123", turnId: "turn-123", item: { id: "item-123", type: "fileChange", changes: [{ path: "file.txt", diff: "+new" }] } } });
  assert.equal(f.service.get("thread-123", file.id).interaction.item.changes[0].diff, "+new");
  f.bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } } });
  assert.equal(f.service.get("thread-123", file.id).interaction.status, "unavailable");
  assert.equal(f.service.get("thread-123", standalone.id).interaction.status, "pending");
  f.bridge.emit("notification", { method: "thread/closed", params: { threadId: "thread-123" } });
  assert.equal(f.service.get("thread-123", standalone.id).interaction.status, "unavailable");
});

for (const method of ["item/fileChange/requestApproval", "item/commandExecution/requestApproval"]) {
  test(`${method} accepts exactly the four plain decisions`, () => {
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) assert.deepEqual(validateInteractionResponse(method, {}, { decision }), { decision });
    for (const response of [{ decision: "approve" }, { decision: "accept", injected: true }, {}]) assert.throws(() => validateInteractionResponse(method, {}, response));
  });
}

test("persistent approval rules match authoritative available decisions or fallback proposals", () => {
  const exec = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } };
  const params = { availableDecisions: ["decline", exec, network], proposedExecpolicyAmendment: ["git", "status"], proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }] };
  for (const decision of [exec, network]) assert.deepEqual(validateInteractionResponse("item/commandExecution/requestApproval", params, { decision }), { decision });
  assert.throws(() => validateInteractionResponse("item/commandExecution/requestApproval", params, { decision: "acceptForSession" }));
  assert.deepEqual(validateInteractionResponse("item/commandExecution/requestApproval", { availableDecisions: [exec] }, { decision: exec }), { decision: exec });
  assert.throws(() => validateInteractionResponse("item/commandExecution/requestApproval", {}, { decision: network }));
  for (const decision of [exec, network]) assert.deepEqual(validateInteractionResponse("item/commandExecution/requestApproval", {
    proposedExecpolicyAmendment: ["git", "status"], proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }]
  }, { decision }), { decision });
});

for (const [kind, decision, mutation] of [
  ["exec", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "ok"] } }, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sh"] } }],
  ["network", { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "other.example", action: "allow" } } }]
]) {
  test(`${kind} rules embedded in available decisions are collected and answered without redundant proposals`, async (t) => {
    const f = fixture(t);
    for (const proposalFields of [{}, { proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null },
      { proposedExecpolicyAmendment: ["sh"], proposedNetworkPolicyAmendments: [{ host: "other.example", action: "allow" }] }]) {
      const entry = f.receive("item/commandExecution/requestApproval", { availableDecisions: ["accept", decision, "cancel"], ...proposalFields });
      assert.ok(entry, "the original callback must remain available in the registry");
      assert.equal(entry.status, "pending");
      await assert.rejects(f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { decision: mutation } }), (error) => error.code === "invalid_interaction_response");
      const response = await f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { decision } });
      assert.equal(response.interaction.status, "submitted");
      assert.deepEqual(f.messages.at(-1).result, { decision });
    }
    assert.equal(f.messages.length, 3);
  });
}

test("authoritative rules still require exact typed payloads and reject forged alternatives", async (t) => {
  const f = fixture(t);
  const malformed = [
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [1] } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: "echo" } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"], injected: true } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "", action: "allow" } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "invented" } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow", injected: true } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } }, injected: true }
  ];
  for (const decision of malformed) {
    assert.throws(() => validateInteractionResponse("item/commandExecution/requestApproval", { availableDecisions: [decision] }, { decision }));
    f.receive("item/commandExecution/requestApproval", { availableDecisions: ["accept", decision, "cancel"] });
  }
  assert.equal(f.service.list("thread-123").interactions.length, 0);
  assert.ok(f.messages.every((message) => message.error.code === -32602));
  const original = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "deny" } } };
  assert.throws(() => validateInteractionResponse("item/commandExecution/requestApproval", { availableDecisions: [original] }, {
    decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }
  }));
});

test("permission subsets include legacy paths, typed glob/special entries and deny constraints", () => {
  const deny = { access: "deny", path: { type: "path", path: "/workspace/private" } };
  const write = { access: "write", path: { type: "glob_pattern", pattern: "/workspace/**" } };
  const read = { access: "read", path: { type: "special", value: { kind: "project_roots" } } };
  const permissions = { network: { enabled: true }, fileSystem: { read: ["/workspace"], write: ["/workspace"], entries: [write, read, deny], globScanMaxDepth: 5 } };
  const validate = (response) => validateInteractionResponse("item/permissions/requestApproval", { permissions }, response);
  assert.equal(validate({ permissions: {} }).scope, "turn");
  assert.deepEqual(validate({ permissions: { fileSystem: { entries: [write, deny], globScanMaxDepth: 3 } }, scope: "session", strictAutoReview: true }).permissions.fileSystem.entries, [write, deny]);
  for (const response of [
    { permissions: { fileSystem: { entries: [write] } } },
    { permissions: { fileSystem: { entries: [{ ...write, path: { type: "path", path: "/" } }] } } },
    { permissions: { fileSystem: { write: ["/workspace"], entries: [deny], globScanMaxDepth: 6 } } },
    { permissions: { network: { enabled: "true" } } },
    { permissions: {}, scope: "forever" },
    { permissions: {}, strictAutoReview: "yes" }
  ]) assert.throws(() => validate(response));
});

test("question answers preserve skip/other/secret semantics and reject unknown or malformed answers", () => {
  const method = "item/tool/requestUserInput";
  const params = { isBlocking: true, questions: [{ id: "pick", options: [{ label: "A" }] }, { id: "free", isOther: true, isSecret: true, options: [{ label: "B" }] }] };
  const valid = { answers: { pick: { answers: [] }, free: { answers: ["custom secret"] } } };
  assert.deepEqual(validateInteractionResponse(method, params, valid), valid);
  for (const answers of [{}, { pick: { answers: ["invalid"] }, free: { answers: [] } }, { pick: { answers: [3] }, free: { answers: [] } }, { ...valid.answers, unknown: { answers: [] } }]) {
    assert.throws(() => validateInteractionResponse(method, params, { answers }));
  }
  assert.throws(() => validateInteractionResponse(method, params, JSON.parse('{"answers":{"__proto__":{"answers":[]}}}')));
  assert.deepEqual(validateInteractionResponse(method, { questions: [{ id: "free", options: [] }] }, { answers: { free: { answers: ["free form"] } } }), { answers: { free: { answers: ["free form"] } } });
});

test("native capabilities are explicit for unsafe URLs, device proof and unsupported form schemas", async (t) => {
  const f = fixture(t);
  for (const params of [
    { mode: "url", elicitationId: "unsafe-123", url: "javascript:alert(1)", message: "Unsafe" },
    { mode: "url", elicitationId: "credential-123", url: "https://username:password@example.com", message: "Credentialed" },
    { mode: "openai/userVerification", challenge: "challenge", title: "Verify", description: "Device proof" },
    { mode: "openai/form", message: "Unsupported", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } }
  ]) {
    const entry = f.receive("mcpServer/elicitation/request", { serverName: "native", ...params });
    assert.ok(entry.error.code);
    assert.equal(entry.params.challenge, undefined);
    await assert.rejects(f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { action: "accept", content: {} } }));
    await f.service.respond("thread-123", entry.id, { responseId: randomUUID(), response: { action: "decline" } });
  }
  assert.equal(f.messages.length, 4);
});

test("typed forms support all native primitive widgets and enforce field constraints", () => {
  const schema = { type: "object", properties: {
    text: { type: "string", minLength: 2, maxLength: 4 }, email: { type: "string", format: "email" },
    date: { type: "string", format: "date" }, count: { type: "integer", minimum: 1, maximum: 3 }, number: { type: "number" }, enabled: { type: "boolean" },
    plain: { type: "string", enum: ["a", "b"] }, titled: { type: "string", oneOf: [{ const: "a", title: "A" }] },
    legacy: { type: "string", enum: ["a"], enumNames: ["A"] },
    multi: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 2 },
    titledMulti: { type: "array", items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } }
  }, required: ["text"] };
  const content = { text: "OK", email: "user@example.com", date: "2026-10-18", count: 2, number: 1.5, enabled: false, plain: "a", titled: "a", legacy: "a", multi: ["a", "b"], titledMulti: ["a"] };
  for (const mode of ["form", "openai/form", "openaiForm"]) assert.deepEqual(validateInteractionResponse("mcpServer/elicitation/request", { mode, requestedSchema: schema }, { action: "accept", content }), { action: "accept", content });
  assert.deepEqual(validateInteractionResponse("mcpServer/elicitation/request", { mode: "openai/form", requestedSchema: { ...schema, title: "Settings", description: "Required choices", additionalProperties: false } }, { action: "accept", content }), { action: "accept", content });
  for (const changes of [{ text: "x" }, { text: "too long" }, { email: "invalid" }, { date: "2026-02-31" }, { count: 1.1 }, { count: 0 }, { count: 4 }, { enabled: 1 }, { plain: "c" }, { multi: [] }, { multi: ["a", "a"] }, { multi: ["c"] }, { unknown: "field" }]) {
    assert.throws(() => validateInteractionResponse("mcpServer/elicitation/request", { mode: "form", requestedSchema: schema }, { action: "accept", content: { ...content, ...changes } }));
  }
});

test("malformed original requests are rejected before exposing actionable prompts", async (t) => {
  const f = fixture(t);
  const cases = [
    ["item/tool/requestUserInput", { isBlocking: true, questions: [{ id: "q", header: "Missing question" }] }],
    ["item/tool/requestUserInput", { isBlocking: true, questions: [{ id: "q", header: "Question", question: "Choose", options: { label: "A" } }] }],
    ["item/commandExecution/requestApproval", { kind: "unknown" }],
    ["item/commandExecution/requestApproval", { availableDecisions: ["invented-decision"] }],
    ["item/commandExecution/requestApproval", { additionalPermissions: { fileSystem: { write: [42] } } }],
    ["item/permissions/requestApproval", { cwd: "/workspace", permissions: { fileSystem: { entries: [{ path: { type: "path", path: "/workspace" }, access: "invented" }] } } }],
    ["item/permissions/requestApproval", { cwd: "/workspace", permissions: { network: { enabled: "yes" } } }]
  ];
  for (const [method, params] of cases) f.receive(method, params);
  assert.equal(f.service.list("thread-123").interactions.length, 0);
  assert.ok(f.messages.every((message) => message.error.code === -32602));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.bridge.inbound.requests.size, 0);
});

test("frontend field responses and backend validation share an annotated native form contract", () => {
  const requestedSchema = { type: "object", title: "Review", description: "Required values", additionalProperties: false,
    properties: { name: { type: "string", title: "Name", minLength: 2, maxLength: 8 }, count: { type: "integer", minimum: 1, maximum: 3 },
      enabled: { type: "boolean" }, tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] }, minItems: 1, maxItems: 2 } }, required: ["name", "count"] };
  for (const mode of ["form", "openai/form", "openaiForm"]) {
    const params = { mode, requestedSchema };
    const described = describeMcpForm(params);
    assert.equal(described.supported, true);
    const response = buildMcpFormResponse(described.fields, { name: "Alice", count: "2", enabled: false, tags: ["a"] });
    assert.deepEqual(validateInteractionResponse("mcpServer/elicitation/request", params, response), response);
    const unsupported = { ...params, requestedSchema: { ...requestedSchema, properties: { nested: { type: "object", properties: {} } } } };
    assert.equal(describeMcpForm(unsupported).supported, false);
    assert.equal(capabilityError("mcpServer/elicitation/request", unsupported).code, "unsupported_interaction_schema");
  }
});

test("thread service owns pre-ACK requests without claiming desktop queued turns", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r22-interaction-owner-"));
  const config = createBaseConfig(root);
  const bridge = new AppServerBridge(config);
  bridge.bindSocket({ readyState: 1, on() {}, send(_payload, callback) { callback?.(); } });
  bridge.ensureReady = async () => {};
  let acknowledge;
  bridge.request = async (method) => method === "turn/start" ? new Promise((resolve) => { acknowledge = resolve; }) : {};
  const service = new CodexThreadService({ config, bridge, reader: { getThread: async () => ({ id: "thread-123", cwd: root }), listTurns: async () => ({ turns: [] }) }, sessionManager: { codexModelCatalog: () => [] } });
  t.after(() => { service.shutdown(); bridge.resetConnectionState(); fs.rmSync(root, { recursive: true, force: true }); });
  service.submit("thread-123", { clientRequestId: "request-123", input: { text: "test" } });
  for (let i = 0; i < 10 && !acknowledge; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.active.get("thread-123").turnId, null);
  bridge.handleMessage(JSON.stringify({ id: "pre-ack", method: "item/tool/requestUserInput", params: { threadId: "thread-123", turnId: "native-turn", itemId: "tool", isBlocking: true, questions: [] } }));
  assert.equal(service.interactions.list("thread-123").interactions.length, 1);
  acknowledge({ turn: { id: "native-turn", status: "inProgress", items: [] } });
  await new Promise((resolve) => setImmediate(resolve));
  service.loaded.delete("thread-123");
  service.requests.update("thread-123", "request-123", { executionRoute: "desktopQueue" });
  bridge.handleMessage(JSON.stringify({ id: "desktop", method: "item/fileChange/requestApproval", params: { threadId: "thread-123", turnId: "desktop-turn", itemId: "file" } }));
  assert.equal(service.interactions.list("thread-123").interactions.length, 1);
  service.active.clear();
  service.loaded.add("standalone-thread");
  bridge.handleMessage(JSON.stringify({ id: "standalone", method: "mcpServer/elicitation/request", params: { threadId: "standalone-thread", turnId: null, mode: "url", elicitationId: "external-123", serverName: "external", message: "Open", url: "https://example.com" } }));
  assert.equal(service.streams.has("standalone-thread"), false);
  assert.equal(service.interactions.list("standalone-thread").interactions.length, 1);
});
