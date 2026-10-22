import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRequestStore } from "../src/sessions/codex/requestStore.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-request-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new CodexRequestStore({ dataDir }) };
}
const body = (id = "request-123") => ({ clientRequestId: id, input: { text: "继续\n    code()", attachments: [{ id: "image-123" }] }, options: { model: "test", reasoningEffort: "low" } });

test("request receipt survives recreation and preserves multiline and attachment identity", (t) => {
  const { dataDir, store } = fixture(t);
  store.receive("thread-123", body());
  const reopened = new CodexRequestStore({ dataDir }).get("thread-123", "request-123");
  assert.equal(reopened.state, "received");
  assert.deepEqual(reopened.input, body().input);
  assert.equal(reopened.fingerprint, undefined);
});

test("same request is idempotent but same text with different request IDs is independent", (t) => {
  const { store } = fixture(t);
  const first = store.receive("thread-123", body());
  assert.deepEqual(store.receive("thread-123", { ...body(), options: { reasoningEffort: "low", model: "test" } }), first);
  store.receive("thread-123", body("request-456"));
  assert.equal(store.list("thread-123").length, 2);
  assert.throws(() => store.receive("thread-123", { ...body(), input: { text: "different" } }), (error) => error.status === 409);
});

test("dispatched requests recover as unknown without pretending failure or restarting execution", (t) => {
  const { dataDir, store } = fixture(t);
  for (const [id, state] of [["request-a", "dispatching"], ["request-b", "accepted"], ["request-c", "running"], ["request-d", "completed"]]) {
    store.receive("thread-123", body(id));
    store.update("thread-123", id, { state, turnId: `turn-${id}` });
  }
  const restored = new CodexRequestStore({ dataDir });
  assert.deepEqual(restored.list("thread-123").map((entry) => entry.state).sort(), ["completed", "unknown", "unknown", "unknown"]);
  assert.equal(restored.get("thread-123", "request-b").turnId, "turn-request-b");
});

test("terminal completion is not downgraded by a late acknowledgement", (t) => {
  const { store } = fixture(t);
  store.receive("thread-123", body());
  store.update("thread-123", "request-123", { state: "completed", turnId: "turn-1" });
  assert.equal(store.update("thread-123", "request-123", { state: "accepted" }).state, "completed");
});

test("receipt lookup is thread-scoped and invalid IDs cannot escape the journal", (t) => {
  const { store } = fixture(t);
  store.receive("thread-123", body());
  assert.equal(store.get("thread-456", "request-123"), null);
  assert.throws(() => store.receive("thread-123", body("../../secret")), /Invalid client/);
});

test("unresolved requests remain in bounded listings even after many terminal receipts", (t) => {
  const { store } = fixture(t);
  store.receive("thread-123", body("request-pending"));
  for (let i = 0; i < 5; i++) {
    store.receive("thread-123", body(`request-done-${i}`));
    store.update("thread-123", `request-done-${i}`, { state: "completed" });
  }
  assert.ok(store.list("thread-123", { limit: 1 }).some((entry) => entry.id === "request-pending"));
});

test("long thread listings read only recent receipts and older unresolved requests after restart", (t) => {
  const { dataDir, store } = fixture(t);
  store.receive("thread-123", body("request-pending"));
  for (let index = 0; index < 205; index += 1) {
    const id = `request-done-${index}`;
    store.receive("thread-123", body(id));
    store.update("thread-123", id, { state: "completed" });
  }

  const restored = new CodexRequestStore({ dataDir });
  let reads = 0;
  const get = restored.get.bind(restored);
  restored.get = (...args) => { reads += 1; return get(...args); };
  assert.deepEqual(restored.list("thread-123", { limit: 2 }).map((entry) => entry.id),
    ["request-pending", "request-done-203", "request-done-204"]);
  assert.equal(reads, 3);
  assert.deepEqual(restored.pendingThreadIds(), ["thread-123"]);
});

test("request mode is part of idempotency and queue order does not depend on random IDs", (t) => {
  const { dataDir } = fixture(t);
  const store = new CodexRequestStore({ dataDir, now: () => "2026-10-16T00:00:00.000Z" });
  store.receive("thread-123", body("request-zzz"));
  store.receive("thread-123", body("request-aaa"));
  assert.deepEqual(store.list("thread-123").map((entry) => entry.id), ["request-zzz", "request-aaa"]);
  assert.throws(() => store.receive("thread-123", { ...body("request-zzz"), mode: "steer", expectedTurnId: "turn-1" }), (error) => error.status === 409);
});
