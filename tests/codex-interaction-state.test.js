import test from "node:test";
import assert from "node:assert/strict";
import { createCodexInteractionState } from "../web/src/lib/codex-interactions/state.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";

const interaction = (id = "one", patch = {}) => ({ id, threadId: "thread", turnId: "turn", itemId: "item",
  method: "item/tool/requestUserInput", params: { questions: [{ id: "answer", question: "Answer?", isSecret: true }] },
  status: "pending", version: 1, createdAt: "now", updatedAt: "now", ...patch });
const envelope = (interactions, revision = 1, epoch = "registry") => ({ interactions, epoch, revision });

test("interaction snapshots retain independent handles and never persist or alter chat drafts", () => {
  const store = createCodexInteractionState("thread");
  store.applySnapshot(envelope([interaction("one", { params: { approvalId: "a" } }), interaction("two", { params: { approvalId: "b" } })]));
  store.setDraft("one", { answer: "secret" });
  assert.deepEqual(store.state.order, ["one", "two"]);
  assert.equal(store.state.drafts.one.answer, "secret");
  assert.equal(store.state.ready, true);
  assert.equal(store.storageKey, undefined);
  store.dispose();
  assert.deepEqual(Object.keys(store.state.drafts), []);
});

test("resolved events clear answers and cannot be reopened by old snapshots or versions", () => {
  const store = createCodexInteractionState("thread");
  store.applySnapshot(envelope([interaction()]));
  const read = store.beginRead();
  store.setDraft("one", { answer: "secret" });
  store.applyUpdate({ interaction: interaction("one", { status: "resolved", version: 2 }), epoch: "registry", revision: 2 });
  store.applySnapshot(envelope([interaction()]), read);
  assert.equal(store.state.interactions.one.status, "resolved");
  assert.equal(store.state.drafts.one, undefined);
  store.setDraft("one", { answer: "late" });
  assert.equal(store.state.drafts.one, undefined);
});

test("registry epoch changes revoke pending handles and reject reads from a previous epoch", () => {
  const store = createCodexInteractionState("thread");
  store.applySnapshot(envelope([interaction()]));
  const old = store.beginRead();
  store.applyUpdate({ interaction: interaction("two"), epoch: "replacement", revision: 1 });
  store.applySnapshot(envelope([interaction()], 8), old);
  assert.equal(store.state.epoch, "replacement");
  assert.equal(store.state.interactions.one.status, "unavailable");
  assert.equal(store.state.interactions.two.status, "pending");
});

test("the first websocket epoch invalidates an HTTP snapshot started before its handshake", () => {
  const store = createCodexInteractionState("thread");
  const old = store.beginRead();
  store.applyUpdate({ interaction: interaction("current"), epoch: "current-epoch", revision: 1 });
  store.applySnapshot(envelope([interaction("old")], 99, "old-epoch"), old);
  assert.equal(store.state.epoch, "current-epoch");
  assert.equal(store.state.interactions.old, undefined);
  assert.equal(store.state.interactions.current.status, "pending");
});

test("invalid and cross-thread snapshots preserve known pending interactions", () => {
  const store = createCodexInteractionState("thread");
  store.applySnapshot(envelope([interaction()]));
  assert.throws(() => store.applySnapshot({ interactions: null, epoch: "registry", revision: 3 }), /交互/);
  assert.throws(() => store.applySnapshot(envelope([interaction("other", { threadId: "other" })], 3)), /交互/);
  assert.equal(store.state.interactions.one.status, "pending");
});

test("the real chat store accepts interactions only through current WS sequence guards and never persists answers", () => {
  const values = new Map(), store = createCodexChatStore("thread", { storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } });
  store.setDraft({ text: "ordinary draft", attachments: [{ id: "photo", kind: "image", uploadedId: "uploaded", url: "/photo" }] });
  const socket = store.beginSocket();
  const event = (seq, row, options = {}) => store.applyEvent({ schemaVersion: 2, epoch: "wire", threadId: "thread", seq,
    type: "interaction.updated", payload: { interaction: row, epoch: "registry", revision: row.version }, ...options }, socket);
  assert.equal(event(1, interaction()).reconnect, true);
  assert.equal(store.state.interactionState.order.length, 0);
  store.applyEvent({ schemaVersion: 2, epoch: "wire", threadId: "thread", seq: 0, type: "sync.required", payload: {} }, socket);
  event(1, interaction());
  store.interactions.setDraft("one", { answers: { answer: "private-value" } });
  event(1, interaction("one", { status: "resolved", version: 2 }));
  assert.equal(store.state.interactionState.interactions.one.status, "pending");
  event(2, interaction("one", { status: "resolved", version: 2 }), { threadId: "different" });
  assert.equal(store.state.interactionState.interactions.one.status, "pending");
  store.persist();
  assert.doesNotMatch(values.get(store.storageKey), /private-value|interactionState/);
  assert.equal(store.state.draft.text, "ordinary draft");
  assert.equal(store.state.draft.attachments[0].uploadedId, "uploaded");
  event(2, interaction("one", { status: "resolved", version: 2 }));
  assert.equal(store.state.interactionState.drafts.one, undefined);
  store.interactions.dispose();
});
