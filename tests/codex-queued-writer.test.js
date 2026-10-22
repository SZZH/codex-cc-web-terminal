import test from "node:test";
import assert from "node:assert/strict";
import { CodexQueuedWriter } from "../src/sessions/codex/queuedWriter.js";

function fixture(reply) {
  const calls = [];
  const bridge = {
    ensureReady: async () => { calls.push({ method: "ensureReady" }); },
    request: async (method, params) => {
      calls.push({ method, params });
      return reply(method, params);
    }
  };
  return { writer: new CodexQueuedWriter({ bridge }), calls };
}

test("queue writer sends the exact input and returns the acknowledged submission", async () => {
  const input = [
    { type: "text", text: "Describe this", text_elements: [] },
    { type: "localImage", path: "/tmp/upload.png" }
  ];
  const submission = { id: "queue-1", clientUserMessageId: "request-1", input };
  const { writer, calls } = fixture(() => ({ queuedSubmission: submission }));

  assert.equal(await writer.enqueue("thread-1", "request-1", input), submission);
  assert.deepEqual(calls, [
    { method: "ensureReady" },
    { method: "thread/queue/add", params: { threadId: "thread-1", input, clientUserMessageId: "request-1" } }
  ]);
  assert.equal(calls[1].params.input, input);
});

test("queue writer treats invalid acknowledgements as uncertain and does not resend", async () => {
  for (const result of [{}, { queuedSubmission: { id: "", clientUserMessageId: "request-1" } },
    { queuedSubmission: { id: "queue-1", clientUserMessageId: "different" } }]) {
    const { writer, calls } = fixture(() => result);
    await assert.rejects(writer.enqueue("thread-1", "request-1", [{ type: "text", text: "hello" }]),
      (error) => error.uncertain === true && /acknowledgement/.test(error.message));
    assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
  }
});

test("queue writer preserves RPC errors for caller recovery", async () => {
  const failure = Object.assign(new Error("connection lost"), { uncertain: true });
  const { writer, calls } = fixture(() => { throw failure; });
  await assert.rejects(writer.enqueue("thread-1", "request-1", [{ type: "text", text: "hello" }]),
    (error) => error === failure);
  assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
});

test("queue writer finds a client message ID across bounded pages", async () => {
  const target = { id: "queue-2", clientUserMessageId: "request-2" };
  const { writer, calls } = fixture((_method, params) => params.cursor === null
    ? { data: [{ id: "queue-1", clientUserMessageId: "request-1" }], nextCursor: "1" }
    : { data: [target], nextCursor: null });

  assert.equal(await writer.find("thread-1", "request-2"), target);
  assert.deepEqual(calls, [
    { method: "ensureReady" },
    { method: "thread/queue/list", params: { threadId: "thread-1", cursor: null, limit: 50 } },
    { method: "thread/queue/list", params: { threadId: "thread-1", cursor: "1", limit: 50 } }
  ]);
});

test("queue writer returns null only after exhausting a valid queue", async () => {
  const { writer, calls } = fixture(() => ({ data: [{ id: "queue-1", clientUserMessageId: "other" }], nextCursor: null }));
  assert.equal(await writer.find("thread-1", "request-1"), null);
  assert.equal(calls.filter((call) => call.method === "thread/queue/list").length, 1);
});

test("queue writer rejects incomplete pagination instead of reporting a missing message", async () => {
  const { writer, calls } = fixture((_method, params) => ({ data: [], nextCursor: params.cursor === null ? "1" : "2" }));
  await assert.rejects(writer.find("thread-1", "request-1"), /pagination exceeded/);
  assert.equal(calls.filter((call) => call.method === "thread/queue/list").length, 2);
});

test("queue writer deletes only the exact acknowledged queue ID", async () => {
  const { writer, calls } = fixture(() => ({ deleted: true }));
  assert.equal(await writer.delete("thread-1", "queue-1"), true);
  assert.deepEqual(calls.at(-1), { method: "thread/queue/delete",
    params: { threadId: "thread-1", queuedSubmissionId: "queue-1" } });
});

test("queue membership snapshot reads the whole capacity atomically and rejects partial or malformed data", async () => {
  const { writer, calls } = fixture(() => ({ data: [{ id: "queue-1", clientUserMessageId: "request-1" }], nextCursor: null }));
  assert.equal((await writer.list("thread-1")).length, 1);
  assert.equal(calls.at(-1).params.limit, 100);
  for (const result of [{}, { data: [], nextCursor: "next" }, { data: [null], nextCursor: null },
    { data: [{ id: "same" }, { id: "same" }], nextCursor: null },
    { data: [{ id: "a", clientUserMessageId: "same" }, { id: "b", clientUserMessageId: "same" }], nextCursor: null }]) {
    await assert.rejects(fixture(() => result).writer.list("thread-1"), /incomplete or invalid/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writer.list("thread-1", { signal: controller.signal }), { name: "AbortError" });
});
