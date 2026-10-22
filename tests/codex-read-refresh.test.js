import test from "node:test";
import assert from "node:assert/strict";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexReadRefresh } from "../web/src/lib/codex-read-refresh.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(handler) {
  const store = createCodexChatStore("thread");
  let disposed = false, settled = 0, reconciled = 0;
  const calls = [], turns = [];
  const reads = createCodexReadRefresh({ store, base: "/thread", isDisposed: () => disposed,
    call: async (url) => {
      calls.push(url);
      const response = handler?.(url);
      if (response !== undefined) return response;
      if (url === "/thread") return { thread: { id: "thread" } };
      if (url.endsWith("/requests")) return { requests: [] };
      return { turns: [], hasMore: false };
    },
    onTurns: (page) => turns.push(page), serverRequest: (receipt) => receipt,
    onSettled: () => { settled += 1; }, reconcileDismissedRequests: () => { reconciled += 1; }
  });
  return { store, reads, calls, turns, dispose: () => { disposed = true; },
    get settled() { return settled; }, get reconciled() { return reconciled; } };
}

test("metadata and turns retain separate failures until their matching reads succeed", async () => {
  let metadataFails = true, turnsFail = true;
  const { store, reads } = fixture((url) => {
    if (url === "/thread" && metadataFails) throw new Error("metadata unavailable");
    if (url.includes("/turns?") && turnsFail) throw new Error("history unavailable");
  });
  store.state.error = "an action needs attention";
  await reads.refreshLatest();
  assert.match(store.state.historyReadError, /metadata unavailable/);
  assert.match(store.state.historyReadError, /history unavailable/);
  assert.equal(reads.needsRecovery(), true);
  assert.equal(store.state.initialized, false);
  assert.equal(store.state.error, "an action needs attention");
  metadataFails = false;
  await reads.refreshLatest();
  assert.equal(store.state.historyReadError, "history unavailable");
  assert.equal(reads.needsRecovery(), true);
  turnsFail = false;
  await reads.refreshLatest();
  assert.equal(store.state.historyReadError, "");
  assert.equal(reads.needsRecovery(), false);
  assert.equal(store.state.initialized, true, "a successful empty history is initialized");
  assert.equal(store.state.error, "an action needs attention");
});

test("capability refresh reads metadata alone and shares its request with a full refresh", async () => {
  const pending = deferred();
  const harness = fixture((url) => url === "/thread" ? pending.promise : undefined);
  const capability = harness.reads.refreshMetadata();
  assert.deepEqual(harness.calls, ["/thread"]);
  assert.equal(harness.reads.refreshMetadata(), capability);
  const full = harness.reads.refreshLatest();
  assert.deepEqual(harness.calls, ["/thread", "/thread/turns?limit=1", "/thread/requests"]);
  harness.store.upsertThread({ id: "thread", name: "updated while reading" });
  pending.resolve({ thread: { id: "thread", name: "stale name", capabilities: { desktopQuestionAnswers: true } } });
  await Promise.all([capability, full]);
  assert.equal(harness.store.state.thread.name, "updated while reading");
  assert.equal(harness.store.state.thread.capabilities.desktopQuestionAnswers, true);
});

test("metadata-only recovery clears its own failure while preserving a separate history failure", async () => {
  let failMetadata = true;
  const { store, reads, calls } = fixture((url) => {
    if (url.includes("/turns?")) throw new Error("history unavailable");
    if (url === "/thread") {
      if (failMetadata) throw new Error("metadata unavailable");
      return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } };
    }
  });
  await reads.refreshLatest();
  assert.equal(reads.needsRecovery("metadata"), true);
  assert.equal(reads.needsRecovery("turns"), true);
  failMetadata = false;
  calls.length = 0;
  await reads.refreshMetadata();
  assert.deepEqual(calls, ["/thread"]);
  assert.equal(reads.needsRecovery("metadata"), false);
  assert.equal(reads.needsRecovery("turns"), true);
  assert.equal(store.state.historyReadError, "history unavailable");
});

test("disposal discards an in-flight metadata-only capability refresh", async () => {
  const pending = deferred();
  const harness = fixture(() => pending.promise);
  const reading = harness.reads.refreshMetadata();
  harness.dispose();
  pending.resolve({ thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } });
  await reading;
  await harness.reads.refreshMetadata();
  assert.equal(harness.store.state.thread, null);
  assert.equal(harness.store.state.historyReadError, "");
  assert.deepEqual(harness.calls, ["/thread"]);
});

test("overlapping refreshes keep one active batch and one rerun with the existing hooks", async () => {
  const pending = deferred();
  let metadataReads = 0;
  const harness = fixture((url) => url === "/thread" && ++metadataReads === 1 ? pending.promise : undefined);
  const first = harness.reads.refreshLatest();
  const second = harness.reads.refreshLatest();
  const third = harness.reads.refreshLatest({ reconcileDismissed: false });
  assert.equal(harness.calls.length, 3);
  pending.resolve({ thread: { id: "thread", name: "initial" } });
  await Promise.all([first, second, third]);
  assert.equal(harness.calls.length, 6);
  assert.equal(metadataReads, 2);
  assert.equal(harness.turns.length, 2);
  assert.equal(harness.settled, 1);
  assert.equal(harness.reconciled, 2);
});

test("continuous changes release the initial barrier after two batches while one background reader catches up", async () => {
  const pending = [], waiting = [];
  let active = 0, peak = 0, openingSettled = false;
  const harness = fixture((url) => {
    const read = deferred();
    pending.push({ url, read }); active += 1; peak = Math.max(peak, active);
    return read.promise.finally(() => { active -= 1; });
  });
  const opening = harness.reads.refreshLatest().then(() => { openingSettled = true; });
  for (let batch = 1; batch <= 6; batch += 1) {
    assert.equal(pending.length, 3);
    if (batch < 6) waiting.push(harness.reads.refreshLatest({ reconcileDismissed: false }));
    for (const { url, read } of pending.splice(0)) {
      const status = batch === 6 ? "completed" : "inProgress";
      read.resolve(url === "/thread" ? { thread: { id: "thread", name: `batch-${batch}` } }
        : url.endsWith("/requests") ? { requests: [{ id: "known", state: batch === 6 ? "completed" : "running", turnId: "latest" }] }
          : { turns: [{ id: "latest", status, items: [] }], hasMore: false });
    }
    await new Promise(setImmediate);
    assert.equal(harness.store.state.requestListReady, true);
    assert.equal(harness.store.state.thread.name, `batch-${batch}`);
    assert.equal(openingSettled, batch >= 2, "new notifications cannot extend the shared initial barrier indefinitely");
  }
  await Promise.all([opening, ...waiting]);
  assert.equal(harness.calls.length, 18);
  assert.equal(peak, 3, "only one metadata/turns/receipt batch can read at a time");
  assert.equal(active, 0);
  assert.equal(pending.length, 0);
  assert.equal(harness.settled, 3);
  assert.equal(harness.reconciled, 1);
  assert.equal(harness.store.state.requests.known.state, "completed");
  assert.equal(harness.store.state.turns.latest.status, "completed");
});

test("disposal during the second batch prevents queued background catchup and consumes late rejections", async () => {
  let batch = 0;
  const pending = deferred();
  const harness = fixture((url) => {
    if (url === "/thread") batch += 1;
    if (batch === 2) return pending.promise;
  });
  const first = harness.reads.refreshLatest();
  const overlapping = harness.reads.refreshLatest({ reconcileDismissed: false });
  await new Promise(setImmediate);
  const secondOverlap = harness.reads.refreshLatest({ reconcileDismissed: false });
  assert.equal(harness.calls.length, 6);
  harness.dispose(); pending.reject(new Error("late background read"));
  await Promise.all([first, overlapping, secondOverlap]);
  await new Promise(setImmediate);
  assert.equal(harness.calls.length, 6);
  assert.equal(harness.settled, 1);
  assert.equal(harness.store.state.historyReadError, "");
});

for (const seq of [0, 7]) {
  test(`initial history renders while the handshake reconciliation at sequence ${seq} is pending`, async () => {
    const firstPage = deferred(), followupPage = deferred(), followupStarted = deferred();
    const store = createCodexChatStore("thread");
    let socket, turnsReads = 0, openingSettled = false, itemText = "first readable answer";
    const runtime = createCodexChatRuntime({ store, maxPolls: 0,
      location: { protocol: "https:", host: "example.test" },
      createSocket: () => (socket = { close() {} }),
      request: async (path) => {
        if (path.endsWith("/requests")) return { requests: [] };
        if (path.endsWith("/interactions")) return { interactions: [], epoch: "interactions", revision: 0 };
        if (path.includes("/items?")) return { items: [{ ...page.turns[0].items[0], text: itemText }], hasMore: false };
        if (path.includes("/turns?")) {
          if (++turnsReads === 1) return firstPage.promise;
          followupStarted.resolve();
          return followupPage.promise;
        }
        return { thread: { id: "thread" } };
      }
    });
    const page = { threadId: "thread", turns: [{ id: "latest", status: "completed", items: [
      { id: "answer", type: "agentMessage", status: "completed", text: "first readable answer" }
    ] }], hasMore: false };
    try {
      const opening = runtime.open().finally(() => { openingSettled = true; });
      socket.onmessage({ data: JSON.stringify({ schemaVersion: 2, threadId: "thread", epoch: "server-epoch",
        seq, type: "sync.required", payload: {} }) });
      firstPage.resolve(page);
      await followupStarted.promise;
      await new Promise(setImmediate);
      assert.equal(turnsReads, 2, "the full follow-up reconciliation remains required");
      assert.equal(openingSettled, false, "initialization still waits for reconciliation before sending");
      assert.equal(store.state.loading, true);
      assert.equal(presentCodexChatSnapshot(store.state).turns[0].items[0].text, "first readable answer");
      itemText = "reconciled answer";
      followupPage.resolve({ ...page, turns: [{ ...page.turns[0], items: [
        { ...page.turns[0].items[0], text: "reconciled answer" }
      ] }] });
      await opening;
      await new Promise(setImmediate);
      assert.equal(store.state.loading, false);
      assert.equal(presentCodexChatSnapshot(store.state).turns[0].items[0].text, "reconciled answer");
    } finally {
      firstPage.resolve(page); followupPage.resolve(page);
      runtime.dispose();
    }
  });
}

test("an older failed turns read cannot replace a newer successful history read", async () => {
  const pending = deferred();
  let count = 0;
  const { store, reads } = fixture((url) => url.includes("/turns?") && ++count === 1 ? pending.promise : undefined);
  const old = reads.refreshLatestTurns();
  await reads.refreshLatestTurns();
  pending.reject(new Error("old history failure"));
  await assert.rejects(old, /old history failure/);
  assert.equal(store.state.historyReadError, "");
  assert.equal(reads.needsRecovery(), false);
});

test("an older successful turns read cannot clear a newer failed history read", async () => {
  const pending = deferred();
  let count = 0;
  const { store, reads } = fixture((url) => {
    if (!url.includes("/turns?")) return;
    if (++count === 1) return pending.promise;
    throw new Error("new history failure");
  });
  const old = reads.refreshLatestTurns();
  await reads.refreshLatest();
  assert.equal(store.state.historyReadError, "new history failure");
  pending.resolve({ turns: [], hasMore: false });
  await old;
  assert.equal(store.state.historyReadError, "new history failure");
  assert.equal(reads.needsRecovery(), true);
});

test("a disposed refresh drops late history and does not rerun or publish a recovery error", async () => {
  const pending = deferred();
  const harness = fixture(() => pending.promise);
  const first = harness.reads.refreshLatest();
  const second = harness.reads.refreshLatest();
  harness.dispose();
  pending.reject(new Error("late read"));
  await Promise.all([first, second]);
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.store.state.historyReadError, "");
  assert.equal(harness.store.state.error, "");
  assert.equal(harness.store.state.initialized, false);
  assert.deepEqual(harness.turns, []);
  assert.equal(harness.reads.needsRecovery(), false);
});

test("an older successful receipt list cannot clear a newer failure but still confirms one valid read", async () => {
  const pending = deferred();
  let count = 0;
  const { store, reads } = fixture(() => {
    if (++count === 1) return pending.promise;
    throw new Error("new receipt list failure");
  });
  const old = reads.readRequestList(store.beginRead());
  await assert.rejects(reads.readRequestList(store.beginRead()), /new receipt list failure/);
  pending.resolve({ requests: [] });
  await old;
  assert.equal(store.state.requestListReady, true);
  assert.equal(store.state.requestListError, "new receipt list failure");
});

test("an older failed receipt list cannot replace a newer successful read or regress its merged receipt", async () => {
  const pending = deferred();
  let count = 0;
  const { store, reads } = fixture(() => ++count === 1 ? pending.promise : { requests: [{ id: "known", state: "completed" }] });
  const old = reads.readRequestList(store.beginRead());
  await reads.readRequestList(store.beginRead());
  pending.reject(new Error("old receipt list failure"));
  await assert.rejects(old, /old receipt list failure/);
  assert.equal(store.state.requestListReady, true);
  assert.equal(store.state.requestListError, "");
  assert.equal(store.state.requests.known.state, "completed");
});

for (const domain of ["metadata", "turns"]) {
  test(`malformed successful ${domain} payloads cannot confirm recovery`, async () => {
    const malformed = domain === "metadata" ? [{}, { thread: null }, { thread: {} }]
      : [{}, { turns: null }, { turns: {} }];
    let response;
    const { store, reads } = fixture((url) => {
      if (domain === "metadata" ? url === "/thread" : url.includes("/turns?")) return response;
    });
    for (response of malformed) {
      await reads.refreshLatest();
      assert.match(store.state.historyReadError, /响应.*无效/);
      assert.equal(reads.needsRecovery(), true);
      if (domain === "turns") assert.equal(store.state.initialized, false);
      else assert.equal(store.state.thread, null);
    }
    response = domain === "metadata" ? { thread: { id: "thread" } } : { turns: [] };
    await reads.refreshLatest();
    assert.equal(store.state.historyReadError, "");
    assert.equal(reads.needsRecovery(), false);
    assert.equal(store.state.initialized, true);
  });
}
