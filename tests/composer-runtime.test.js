import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";

import { createComposerRuntimeController } from "../web/src/lib/composer-runtime.js";
import { createSessionRuntimeController } from "../web/src/lib/session-runtime.js";
import { buildInputRequest, createComposerOptions, createWorkspaceGitState } from "../web/src/lib/composer.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function payload(threadId, patch = {}) {
  return { provider: "codex", threadId, model: "model-a", reasoningEffort: "medium", permissionMode: "default", git: { currentBranch: "main" }, ...patch };
}

function createHarness(extra = {}) {
  const state = { codexDefaults: {}, composerSaving: false, loading: false, statusText: "", running: false };
  const composerOptions = { value: createComposerOptions({ model: "model-a", gitBranch: "main" }) };
  const workspaceGitState = { value: createWorkspaceGitState() };
  const requests = [];
  const patches = [];
  const active = { threadId: "thread-a", provider: "codex" };
  const models = [];
  const runtime = createComposerRuntimeController({
    state,
    composerDraft: { value: "draft" },
    composerOptions,
    workspaceGitState,
    createComposerOptions,
    createWorkspaceGitState,
    getActiveThreadId: () => active.threadId,
    getActiveProviderId: () => active.provider,
    getModels: () => models,
    getLoading: () => state.loading,
    getCanInterrupt: () => state.running,
    setStatus: (text) => { state.statusText = text; },
    patchThreadComposerState: (provider, threadId, patch) => {
      const pending = deferred();
      patches.push({ provider, threadId, patch, ...pending });
      return pending.promise;
    },
    requestThreadComposerState: (provider, threadId) => {
      const pending = deferred();
      requests.push({ provider, threadId, ...pending });
      return pending.promise;
    },
    ...extra
  });
  runtime.syncComposerContext();
  function switchThread(threadId) {
    active.threadId = threadId;
    runtime.syncComposerContext();
    runtime.resetComposerDraftState({ keepOptions: false });
  }
  return { state, composerOptions, workspaceGitState, requests, patches, active, models, runtime, switchThread };
}

test("settings without Git finish saving while one background read waits or fails", async () => {
  const reads = [];
  const h = createHarness({ requestWorkspaceGit: (cwd) => { const pending = deferred(); reads.push({ cwd, ...pending }); return pending.promise; } });
  const settings = { cwd: "/confirmed/settings", permissionMode: "default" };
  const initial = h.runtime.syncComposerStateForThread("codex", "thread-a");
  await flushPromises();
  h.requests[0].resolve(payload("thread-a", { ...settings, git: undefined }));
  assert.equal(await initial, true);
  assert.equal(reads.length, 1);
  const edit = h.runtime.handleComposerOptionsChange({ permissionMode: "auto-review" });
  await flushPromises();
  h.patches[0].resolve(payload("thread-a", { ...settings, permissionMode: "auto-review", git: undefined }));
  assert.equal(await edit, true);
  assert.equal(await h.runtime.waitForComposerPersistence(), true);
  assert.equal(h.state.composerSaving, false);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].cwd, "/confirmed/settings");
  reads[0].reject(new Error("Git timeout"));
  await flushPromises();
  assert.equal(h.workspaceGitState.value.available, false);
  assert.equal(h.workspaceGitState.value.dirty, null);
  assert.equal(h.workspaceGitState.value.cwd, "/confirmed/settings");
  assert.equal(h.composerOptions.value.permissionMode, "auto-review");
  const retry = h.runtime.refreshWorkspaceGit();
  const shared = h.runtime.refreshWorkspaceGit();
  assert.equal(retry, shared);
  assert.equal(reads.length, 2);
  reads[1].resolve({ isGitRepo: true, currentBranch: "recovered", cwd: "/confirmed/settings" });
  assert.equal(await retry, true);
  assert.equal(h.workspaceGitState.value.currentBranch, "recovered");
});

test("an existing Git error payload stays unavailable and does not trigger a duplicate read", () => {
  let reads = 0;
  const h = createHarness({ requestWorkspaceGit: async () => { reads += 1; return {}; } });
  h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/confirmed", git: { available: false, error: "bad config", cwd: "/confirmed" } }));
  assert.equal(h.workspaceGitState.value.available, false);
  assert.equal(h.workspaceGitState.value.error, "bad config");
  assert.equal(reads, 0);
});

function gitMutationHarness(t, extra = {}) {
  const reads = [], writes = [];
  let writeResolved = false;
  const h = createHarness({
    getActiveWorkspaceCwd: () => "/repo", validateGitBranchName: () => "",
    requestWorkspaceGit: (cwd) => { const pending = deferred(); reads.push({ cwd, afterWrite: writeResolved, ...pending }); return pending.promise; },
    requestWorkspaceGitCheckout: (...args) => { const pending = deferred(); writes.push({ args, ...pending }); return pending.promise; },
    requestWorkspaceGitBranchCreate: (...args) => { const pending = deferred(); writes.push({ args, ...pending }); return pending.promise; },
    patchThreadComposerState: async () => payload("thread-a", { cwd: "/repo", git: undefined }),
    ...extra
  });
  const ready = { available: true, isGitRepo: true, dirty: false, currentBranch: "main", cwd: "/repo" };
  h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: ready }));
  t.after(async () => {
    for (let cycle = 0; cycle < 12; cycle += 1) {
      for (const read of reads) read.resolve({ ...ready, currentBranch: "feature" });
      for (const write of writes) write.resolve({});
      await flushPromises();
    }
  });
  return { ...h, reads, writes, ready, markResolved: () => { writeResolved = true; } };
}

for (const method of ["switchGitBranch", "createGitBranch"]) {
  for (const executionState of ["unknown", "applied", "network"]) {
    test(`${method} requires an explicit read after ${executionState} and ignores old or automatic Git payloads`, async (t) => {
      const h = gitMutationHarness(t);
      const changing = h.runtime[method]("feature");
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: undefined }));
      const oldReads = [...h.reads];
      const error = Object.assign(new Error("write response unavailable"), executionState === "network" ? {} : { executionState });
      h.writes[0].reject(error);
      await changing;
      for (const read of oldReads) read.resolve(h.ready);
      await flushPromises();
      assert.equal(h.workspaceGitState.value.available, false);
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: undefined }));
      for (const read of h.reads) read.resolve(h.ready);
      await flushPromises();
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: h.ready }));
      assert.equal(h.workspaceGitState.value.available, false);
      await h.runtime[method]("again");
      assert.equal(h.writes.length, 1);
      const beforeFailedConfirmation = h.reads.length;
      const failed = h.runtime.refreshWorkspaceGit();
      assert.equal(h.reads.length, beforeFailedConfirmation + 1);
      h.reads.at(-1).reject(new Error("confirmation failed"));
      assert.equal(await failed, false);
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: h.ready }));
      assert.equal(h.workspaceGitState.value.available, false);
      const confirmed = h.runtime.refreshWorkspaceGit();
      h.reads.at(-1).resolve({ ...h.ready, currentBranch: "confirmed" });
      assert.equal(await confirmed, true);
      assert.equal(h.workspaceGitState.value.available, true);
      const again = h.runtime[method]("again");
      assert.equal(h.writes.length, 2);
      h.writes[1].reject(Object.assign(new Error("fixture ends"), { executionState: "not-applied" }));
      await again;
    });
  }
  test(`${method} pending Git writes stay busy and require a fresh post-write read`, async (t) => {
    const h = gitMutationHarness(t);
    const changing = h.runtime[method]("feature");
    h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: undefined }));
    for (const read of h.reads) read.resolve(h.ready);
    await flushPromises();
    assert.equal(h.workspaceGitState.value.loading, true);
    const stillWriting = h.runtime[method]("another");
    await stillWriting;
    assert.equal(h.writes.length, 1);
    h.markResolved();
    h.writes[0].resolve({});
    await flushPromises();
    const fresh = h.reads.find((read) => read.afterWrite);
    assert(fresh, "write confirmation must start after the mutation response");
    assert.equal(h.workspaceGitState.value.loading, true);
    fresh.resolve({ ...h.ready, currentBranch: "feature" });
    await changing;
    assert.equal(h.workspaceGitState.value.loading, false);
    assert.equal(h.workspaceGitState.value.currentBranch, "feature");
  });
  test(`${method} old settlement cannot invalidate the next thread Git read`, async (t) => {
    const h = gitMutationHarness(t);
    const changing = h.runtime[method]("feature");
    h.switchThread("thread-b");
    const current = h.runtime.refreshWorkspaceGit();
    h.writes[0].reject(Object.assign(new Error("old write uncertain"), { executionState: "unknown" }));
    await changing;
    h.reads.at(-1).resolve({ ...h.ready, currentBranch: "new-thread" });
    assert.equal(await current, true);
    assert.equal(h.workspaceGitState.value.currentBranch, "new-thread");
  });
  for (const outcome of ["success", "unknown", "applied"]) {
    test(`${method} clears its busy state after same-thread cwd changes and ${outcome} still requires explicit confirmation`, async (t) => {
      let cwd = "/repo";
      const persisted = [];
      const h = gitMutationHarness(t, {
        getActiveWorkspaceCwd: () => cwd,
        patchThreadComposerState: async (...args) => { persisted.push(args); return payload("thread-a", { cwd, git: undefined }); }
      });
      const changing = h.runtime[method]("feature");
      cwd = "/repo/sub";
      assert.equal(await h.runtime.refreshWorkspaceGit({ automatic: true }), false);
      assert.equal(h.reads.length, 0);
      assert.equal(h.workspaceGitState.value.loading, true);
      if (outcome === "success") h.writes[0].resolve({});
      else h.writes[0].reject(Object.assign(new Error("write result requires confirmation"), { executionState: outcome }));
      await changing;
      assert.equal(h.workspaceGitState.value.loading, false);
      assert.equal(h.workspaceGitState.value.available, false);
      assert.equal(h.workspaceGitState.value.dirty, null);
      assert.equal(persisted.length, 0);
      assert.match(h.workspaceGitState.value.error, /刷新.*确认/);
      assert.equal(await h.runtime.refreshWorkspaceGit({ automatic: true }), false);
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd, git: undefined }));
      h.runtime.applyComposerStatePayload(payload("thread-a", { cwd: "/repo", git: h.ready }));
      assert.equal(h.reads.length, 0);
      assert.equal(h.workspaceGitState.value.available, false);
      await h.runtime[method]("again");
      assert.equal(h.writes.length, 1);
      const confirming = h.runtime.refreshWorkspaceGit();
      assert.equal(h.reads.length, 1);
      assert.equal(h.reads[0].cwd, "/repo/sub");
      h.reads[0].resolve({ ...h.ready, currentBranch: "confirmed" });
      assert.equal(await confirming, true);
      assert.equal(h.workspaceGitState.value.loading, false);
      assert.equal(h.workspaceGitState.value.available, true);
      assert.equal(h.workspaceGitState.value.currentBranch, "confirmed");
      const again = h.runtime[method]("again");
      assert.equal(h.writes.length, 2);
      h.writes[1].reject(Object.assign(new Error("fixture ends"), { executionState: "not-applied" }));
      await again;
    });
  }
  test(`${method} settles a same-thread cwd change during its post-write confirmation without persisting the old result`, async (t) => {
    let cwd = "/repo";
    const persisted = [];
    const h = gitMutationHarness(t, {
      getActiveWorkspaceCwd: () => cwd,
      patchThreadComposerState: async (...args) => { persisted.push(args); return payload("thread-a", { cwd, git: undefined }); }
    });
    const changing = h.runtime[method]("feature");
    h.writes[0].resolve({});
    await flushPromises();
    assert.equal(h.reads.length, 1);
    cwd = "/repo/sub";
    assert.equal(await h.runtime.refreshWorkspaceGit({ automatic: true }), false);
    h.reads[0].resolve({ ...h.ready, currentBranch: "stale" });
    await changing;
    assert.equal(h.workspaceGitState.value.loading, false);
    assert.equal(h.workspaceGitState.value.available, false);
    assert.equal(h.workspaceGitState.value.currentBranch, "main");
    assert.equal(persisted.length, 0);
    assert.equal(await h.runtime.refreshWorkspaceGit({ automatic: true }), false);
    const confirming = h.runtime.refreshWorkspaceGit();
    assert.equal(h.reads.at(-1).cwd, "/repo/sub");
    h.reads.at(-1).resolve({ ...h.ready, currentBranch: "current" });
    assert.equal(await confirming, true);
    assert.equal(h.workspaceGitState.value.currentBranch, "current");
  });
  test(`${method} late success cannot clear a new thread pending mutation`, async (t) => {
    const h = gitMutationHarness(t);
    const old = h.runtime[method]("old-feature");
    h.switchThread("thread-b");
    h.runtime.applyComposerStatePayload(payload("thread-b", { cwd: "/repo", git: h.ready }));
    const current = h.runtime[method]("current-feature");
    assert.equal(h.writes.length, 2);
    h.writes[0].resolve({});
    await old;
    assert.equal(h.workspaceGitState.value.loading, true);
    assert.equal(h.workspaceGitState.value.available, false);
    assert.equal(h.reads.length, 0);
    h.writes[1].reject(Object.assign(new Error("fixture ends"), { executionState: "unknown" }));
    await current;
    assert.equal(h.workspaceGitState.value.loading, false);
  });
}

test("a restored image without its File cannot upload and can be removed", async () => {
  const { runtime, composerOptions, state } = createHarness();
  runtime.updateComposerOptions({ attachments: [{ id: "stale", kind: "image", name: "old.png", status: "failed" }] });
  await assert.rejects(runtime.uploadImageAttachments(), /移除后重新选择图片/);
  assert.equal(composerOptions.value.attachments[0].status, "failed");
  await runtime.retryAttachment("stale");
  assert.match(state.statusText, /移除后重新选择图片/);
  runtime.removeAttachment("stale");
  assert.deepEqual(composerOptions.value.attachments, []);
});

test("sending during a preupload fills every captured attachment with the shared uploaded ID", async () => {
  const upload = deferred();
  let uploads = 0;
  const { runtime, composerOptions } = createHarness({ request: () => { uploads += 1; return upload.promise; } });
  runtime.updateComposerOptions({ attachments: [{ id: "local-photo", kind: "image", name: "photo.png",
    file: new File(["pixels"], "photo.png", { type: "image/png" }), status: "pending" }] });
  const original = composerOptions.value.attachments[0];
  const preupload = runtime.uploadImageAttachments();
  const captured = [...composerOptions.value.attachments];
  assert.notEqual(captured[0], original, "upload progress replaces the reactive attachment object");
  const sending = runtime.uploadImageAttachments(captured);
  upload.resolve({ attachment: { id: "00000000-0000-4000-8000-000000000001", url: "/api/attachments/images/uploaded" } });
  await Promise.all([preupload, sending]);
  assert.equal(uploads, 1);
  assert.equal(captured[0].uploadedId, "00000000-0000-4000-8000-000000000001");
  assert.equal(captured[0].status, "uploaded");
  assert.deepEqual(buildInputRequest({ text: "with photo", composerOptions: { ...composerOptions.value, attachments: captured } }).attachments,
    [{ id: "00000000-0000-4000-8000-000000000001" }]);
});

test("composer resets and missing models use only the active provider defaults", () => {
  const { runtime, state, active, composerOptions } = createHarness();
  state.codexDefaults = { model: "gpt-r18-only", reasoningEffort: "high", permissionMode: "full-access" };
  state.providerCatalog = [{ id: "cc", defaultModel: "" }];
  for (const [provider, expected] of [["codex", "gpt-r18-only"], ["cc", ""], ["claude", ""]]) {
    active.provider = provider;
    runtime.resetComposerDraftState({ keepOptions: false });
    assert.equal(composerOptions.value.model, expected);
    assert.equal(composerOptions.value.permissionMode, provider === "codex" ? "full-access" : "default");
    assert.equal(composerOptions.value.reasoningEffort, provider === "codex" ? "high" : "medium");
    runtime.applyComposerStatePayload({});
    assert.equal(composerOptions.value.model, expected);
  }
  state.providerCatalog[0].defaultModel = "sonnet";
  active.provider = "cc";
  runtime.resetComposerDraftState({ keepOptions: false });
  assert.equal(composerOptions.value.model, "sonnet");
  runtime.applyComposerStatePayload({ model: "" });
  assert.equal(composerOptions.value.model, "");
});

test("a late Codex composer read cannot restore its model after switching the same thread ID to CC", async () => {
  const { runtime, state, active, composerOptions, requests } = createHarness();
  state.codexDefaults = { model: "gpt-r18-only" };
  const pending = runtime.readComposerStateForThread("codex", "thread-a");
  await flushPromises();
  active.provider = "cc";
  runtime.resetComposerDraftState({ keepOptions: false });
  const image = { id: "cc-image", kind: "image", file: new File(["image"], "cc.png") };
  runtime.updateComposerOptions({ attachments: [image] });
  requests[0].resolve(payload("thread-a", { model: "stale-gpt", permissionMode: "full-access" }));
  assert.equal((await pending).status, "stale");
  assert.equal(composerOptions.value.model, "");
  assert.equal(composerOptions.value.permissionMode, "default");
  assert.equal(composerOptions.value.attachments[0], image);
});

test("server empty models clear defaults without replacing a new image or a confirmed empty baseline", async () => {
  const { runtime, state, composerOptions, requests, patches } = createHarness();
  state.codexDefaults = { model: "gpt-r18-only" };
  const image = { id: "new-image", kind: "image", file: new File(["image"], "new.png") };
  runtime.updateComposerOptions({ attachments: [image] });
  const read = runtime.readComposerStateForThread("codex", "thread-a");
  await flushPromises();
  requests[0].resolve(payload("thread-a", { model: "" }));
  const result = await read;
  assert.equal(result.snapshot.model, "");
  assert.equal(composerOptions.value.model, "");
  assert.equal(composerOptions.value.attachments[0], image);
  const edit = runtime.handleComposerOptionsChange({ model: "rejected" });
  await flushPromises();
  patches[0].reject(new Error("save rejected"));
  assert.equal(await edit, false);
  assert.equal(composerOptions.value.model, "");
  runtime.applyHistoricalComposerValues({ model: "sonnet" });
  runtime.applyHistoricalComposerValues({}, { metadata: {} });
  assert.equal(composerOptions.value.model, "sonnet", "missing history model retains the current model");
  runtime.applyHistoricalComposerValues({ model: "" }, { metadata: { model: "stale" } });
  assert.equal(composerOptions.value.model, "", "an explicit empty history model overrides the snapshot fallback");
});

test("opening a fresh session retains its selected model, empty effort and access mode", async () => {
  const { state, composerOptions, models, runtime } = createHarness();
  const session = { id: "fresh", provider: "codex", model: "plain", reasoningEffort: "", permissionMode: "full-access", cwd: "/tmp/settings" };
  models.push({ value: "plain", supportedReasoningEfforts: [] });
  state.codexDefaults = { model: "other-model", reasoningEffort: "medium", permissionMode: "default" };
  state.liveView = { openToken: 0 };
  state.threadView = {};
  const sessions = createSessionRuntimeController({
    state,
    route: { name: "chat", params: { sessionId: "fresh" } },
    composerOptions,
    request: async () => ({ host: "127.0.0.1", codexDefaults: state.codexDefaults }),
    resetComposerDraftState: runtime.resetComposerDraftState,
    applyHistoricalComposerValues: runtime.applyHistoricalComposerValues,
    resetThreadView() {},
    setThreadSnapshot() {},
    setConversation() {},
    setLiveOverlay() {},
    setStatus: (value) => { state.statusText = value; },
    attachLiveSocket: async () => {},
    syncComposerStateForThread: () => assert.fail("fresh session has no thread ID")
  });
  await sessions.openLiveSession(session, { skipRoute: true });
  assert.deepEqual([composerOptions.value.model, composerOptions.value.reasoningEffort, composerOptions.value.permissionMode], ["plain", "", "full-access"]);
  assert.equal(buildInputRequest({ text: "hello", composerOptions: composerOptions.value }).reasoningEffort, "");
});

test("composer GET responses cannot replace another thread or a newer local edit", async () => {
  const context = createHarness();
  const { runtime, requests, patches, composerOptions } = context;
  const first = runtime.syncComposerStateForThread("codex", "thread-a");
  await flushPromises();
  context.switchThread("thread-b");
  const second = runtime.syncComposerStateForThread("codex", "thread-b");
  await flushPromises();
  requests[1].resolve(payload("thread-b", { model: "model-b" }));
  await second;
  requests[0].resolve(payload("thread-a", { model: "stale-a" }));
  await first;
  assert.equal(composerOptions.value.model, "model-b");

  const refresh = runtime.syncComposerStateForThread("codex", "thread-b");
  await flushPromises();
  const edit = runtime.handleComposerOptionsChange({ model: "latest-b" });
  await flushPromises();
  requests[2].resolve(payload("thread-b", { model: "stale-b" }));
  await flushPromises();
  assert.equal(composerOptions.value.model, "latest-b");
  patches[0].resolve(payload("thread-b", { model: "latest-b" }));
  await edit;
  await refresh;
});

test("only the newest GET applies when reads complete out of order", async () => {
  const { runtime, requests, composerOptions } = createHarness();
  const first = runtime.syncComposerStateForThread("codex", "thread-a");
  const second = runtime.syncComposerStateForThread("codex", "thread-a");
  await flushPromises();
  requests[1].resolve(payload("thread-a", { model: "new" }));
  await second;
  requests[0].resolve(payload("thread-a", { model: "old" }));
  await first;
  assert.equal(composerOptions.value.model, "new");
});

test("an owned settings read retains the server snapshot when a newer PATCH is preserved", async () => {
  const { runtime, requests, patches, composerOptions } = createHarness();
  const read = runtime.readComposerStateForThread("codex", "thread-a");
  await flushPromises();
  const edit = runtime.handleComposerOptionsChange({ permissionMode: "default" });
  await flushPromises();
  patches[0].resolve(payload("thread-a", { reasoningEffort: "high", permissionMode: "default" }));
  assert.equal(await edit, true);
  requests[0].resolve(payload("thread-a", { reasoningEffort: "high", permissionMode: "full-access" }));
  const result = await read;
  assert.equal(result.status, "preserved");
  assert.equal(result.provider, "codex");
  assert.equal(result.threadId, "thread-a");
  assert.equal(result.readRevision, 1);
  assert.deepEqual(result.snapshot, { model: "model-a", reasoningEffort: "high", permissionMode: "full-access" });
  assert.equal(composerOptions.value.permissionMode, "default");
});

test("owned reads distinguish latest failure from stale success while the legacy boolean stays compatible", async () => {
  const { runtime, requests, composerOptions } = createHarness();
  const old = runtime.readComposerStateForThread("codex", "thread-a");
  const newest = runtime.readComposerStateForThread("codex", "thread-a", { silent: false });
  await flushPromises();
  requests[1].reject(new Error("latest read failed"));
  const failed = await newest;
  assert.equal(failed.status, "failed");
  assert.equal(failed.snapshot, null);
  assert.match(failed.error.message, /latest read failed/);
  requests[0].resolve(payload("thread-a", { model: "old" }));
  const stale = await old;
  assert.equal(stale.status, "stale");
  assert.equal(stale.snapshot, null);
  assert.equal(composerOptions.value.model, "model-a");

  const legacy = runtime.syncComposerStateForThread("codex", "thread-a");
  const latest = runtime.readComposerStateForThread("codex", "thread-a");
  await flushPromises();
  requests[3].reject(new Error("newest failure"));
  assert.equal((await latest).status, "failed");
  requests[2].resolve(payload("thread-a", { model: "legacy stale" }));
  assert.equal(await legacy, true);
  assert.equal(await runtime.syncComposerStateForThread("codex", ""), false);
  const recovery = runtime.readComposerStateForThread("codex", "thread-a");
  await flushPromises();
  requests[4].resolve(payload("thread-a", { model: "recovered" }));
  assert.equal((await recovery).status, "applied");
  assert.equal(composerOptions.value.model, "recovered");
});

for (const readFirst of [false, true]) {
  test(`initial thread GET restores saved settings when ${readFirst ? "read resolves first" : "PATCH rejects first"}`, async () => {
    const { runtime, requests, patches, composerOptions, state } = createHarness();
    runtime.resetComposerDraftState({ keepOptions: false });
    const initialRead = runtime.syncComposerStateForThread("codex", "thread-a");
    await flushPromises();
    const edit = runtime.handleComposerOptionsChange({ permissionMode: "full-access" });
    await flushPromises();
    const saved = payload("thread-a", { model: "saved-model", reasoningEffort: "high", permissionMode: "auto-review" });
    if (readFirst) {
      requests[0].resolve(saved);
      await flushPromises();
      assert.equal(composerOptions.value.permissionMode, "full-access");
    }
    let barrierSettled = false;
    const barrier = runtime.waitForComposerPersistence().finally(() => { barrierSettled = true; });
    const failedBarrier = assert.rejects(barrier, /permission save failed/);
    patches[0].reject(new Error("permission save failed"));
    assert.equal(await edit, false);
    if (!readFirst) {
      await flushPromises();
      assert.equal(barrierSettled, false);
      assert.equal(state.composerSaving, true);
      requests[0].resolve(saved);
    }
    assert.equal(await initialRead, true);
    await failedBarrier;
    assert.equal(state.composerSaving, false);
    assert.deepEqual({
      model: composerOptions.value.model,
      reasoningEffort: composerOptions.value.reasoningEffort,
      permissionMode: composerOptions.value.permissionMode
    }, { model: "saved-model", reasoningEffort: "high", permissionMode: "auto-review" });
  });
}

test("loaded GET supplies the rollback baseline for repeated failed same-field edits", async () => {
  const { runtime, requests, patches, composerOptions } = createHarness();
  runtime.resetComposerDraftState({ keepOptions: false });
  const initialRead = runtime.syncComposerStateForThread("codex", "thread-a");
  await flushPromises();
  const first = runtime.handleComposerOptionsChange({ model: "first-model" });
  const second = runtime.handleComposerOptionsChange({ model: "second-model" });
  await flushPromises();
  requests[0].resolve(payload("thread-a", { model: "saved-model", reasoningEffort: "high", permissionMode: "auto-review" }));
  await flushPromises();
  patches[0].reject(new Error("first save failed"));
  await first;
  assert.equal(composerOptions.value.model, "second-model");
  await flushPromises();
  patches[1].reject(new Error("second save failed"));
  await second;
  await initialRead;
  assert.equal(composerOptions.value.model, "saved-model");
  assert.equal(composerOptions.value.reasoningEffort, "high");
});

test("initial GET cannot overwrite an intervening successful PATCH", async () => {
  const { runtime, requests, patches, composerOptions } = createHarness();
  const initialRead = runtime.syncComposerStateForThread("codex", "thread-a");
  await flushPromises();
  const edit = runtime.handleComposerOptionsChange({ permissionMode: "full-access" });
  await flushPromises();
  patches[0].resolve(payload("thread-a", { model: "saved-model", reasoningEffort: "high", permissionMode: "full-access" }));
  assert.equal(await edit, true);
  requests[0].resolve(payload("thread-a", { model: "saved-model", reasoningEffort: "high", permissionMode: "auto-review" }));
  await initialRead;
  assert.equal(composerOptions.value.permissionMode, "full-access");
});

test("rapid model, effort and permission selections save in order without reverting current choices", async () => {
  const { runtime, patches, composerOptions, state, models } = createHarness();
  models.push({ value: "model-b", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" });
  const modelEdit = runtime.handleComposerOptionsChange({ model: "model-b" });
  const effortEdit = runtime.handleComposerOptionsChange({ reasoningEffort: "high" });
  const permissionEdit = runtime.handleComposerOptionsChange({ permissionMode: "full-access" });
  await flushPromises();
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].patch, { model: "model-b", reasoningEffort: "low" });
  assert.equal(state.composerSaving, true);
  patches[0].resolve(payload("thread-a", { model: "model-b", reasoningEffort: "low" }));
  await modelEdit;
  await flushPromises();
  assert.equal(composerOptions.value.reasoningEffort, "high");
  assert.equal(composerOptions.value.permissionMode, "full-access");
  assert.deepEqual(patches[1].patch, { reasoningEffort: "high" });
  patches[1].resolve(payload("thread-a", { model: "model-b", reasoningEffort: "high" }));
  await effortEdit;
  await flushPromises();
  assert.deepEqual(patches[2].patch, { permissionMode: "full-access" });
  patches[2].resolve(payload("thread-a", { model: "model-b", reasoningEffort: "high", permissionMode: "full-access" }));
  await permissionEdit;
  assert.equal(state.composerSaving, false);
  assert.equal(composerOptions.value.permissionMode, "full-access");
});

test("an older PATCH failure only rolls back its own unchanged fields", async () => {
  const { runtime, patches, composerOptions, state } = createHarness();
  const failed = runtime.handleComposerOptionsChange({ model: "model-b" });
  const next = runtime.handleComposerOptionsChange({ permissionMode: "auto-review" });
  await flushPromises();
  patches[0].reject(new Error("model save failed"));
  assert.equal(await failed, false);
  assert.equal(composerOptions.value.model, "model-a");
  assert.equal(composerOptions.value.permissionMode, "auto-review");
  await flushPromises();
  patches[1].resolve(payload("thread-a", { permissionMode: "auto-review" }));
  assert.equal(await next, true);
  assert.equal(state.statusText, "");
});

test("an older same-field failure cannot roll back the latest selection", async () => {
  const { runtime, patches, composerOptions } = createHarness();
  const first = runtime.handleComposerOptionsChange({ model: "model-b" });
  const second = runtime.handleComposerOptionsChange({ model: "model-c" });
  await flushPromises();
  patches[0].reject(new Error("older save failed"));
  await first;
  assert.equal(composerOptions.value.model, "model-c");
  await flushPromises();
  patches[1].reject(new Error("latest save failed"));
  await second;
  assert.equal(composerOptions.value.model, "model-a");
});

for (const failure of [false, true]) {
  test(`late PATCH ${failure ? "failure" : "success"} cannot change another thread or its status`, async () => {
    const context = createHarness();
    const edit = context.runtime.handleComposerOptionsChange({ model: "old-a" });
    await flushPromises();
    context.switchThread("thread-b");
    context.runtime.updateComposerOptions({ model: "current-b" });
    context.state.statusText = "正在发送…";
    assert.equal(context.state.composerSaving, false);
    if (failure) {
      context.patches[0].reject(new Error("old failure"));
    } else {
      context.patches[0].resolve(payload("thread-a", { model: "old-a" }));
    }
    await edit;
    assert.equal(context.composerOptions.value.model, "current-b");
    assert.equal(context.state.statusText, "正在发送…");
  });
}

test("leaving and returning to the same thread invalidates prior activation responses", async () => {
  const context = createHarness();
  const edit = context.runtime.handleComposerOptionsChange({ model: "old-a" });
  await flushPromises();
  context.switchThread("thread-b");
  context.switchThread("thread-a");
  context.runtime.updateComposerOptions({ model: "reopened-a" });
  context.patches[0].resolve(payload("thread-a", { model: "old-a" }));
  await edit;
  assert.equal(context.composerOptions.value.model, "reopened-a");
});

test("persistence barrier includes choices queued while waiting and preserves sending status", async () => {
  const { runtime, patches, state } = createHarness();
  const first = runtime.handleComposerOptionsChange({ model: "model-b" });
  let settled = false;
  const barrier = runtime.waitForComposerPersistence().then((result) => { settled = true; return result; });
  await flushPromises();
  const second = runtime.handleComposerOptionsChange({ reasoningEffort: "high" });
  patches[0].resolve(payload("thread-a", { model: "model-b" }));
  await first;
  await flushPromises();
  assert.equal(settled, false);
  state.statusText = "等待 Codex 回复…";
  state.loading = true;
  patches[1].resolve(payload("thread-a", { model: "model-b", reasoningEffort: "high" }));
  await second;
  assert.equal(await barrier, true);
  assert.equal(state.composerSaving, false);
  assert.equal(state.statusText, "等待 Codex 回复…");
});

test("persistence barrier rejects a failed save and stops after a thread switch", async () => {
  const context = createHarness();
  const edit = context.runtime.handleComposerOptionsChange({ model: "model-b" });
  const barrier = assert.rejects(context.runtime.waitForComposerPersistence(), /save failed/);
  await flushPromises();
  context.patches[0].reject(new Error("save failed"));
  await edit;
  await barrier;
  const next = context.runtime.handleComposerOptionsChange({ model: "model-c" });
  const switchedBarrier = context.runtime.waitForComposerPersistence();
  await flushPromises();
  context.switchThread("thread-b");
  context.patches[1].resolve(payload("thread-a", { model: "model-c" }));
  await next;
  assert.equal(await switchedBarrier, false);
});

test("running turns cannot change settings and models without effort clear it", async () => {
  const { runtime, state, models, patches, composerOptions } = createHarness();
  state.running = true;
  assert.equal(await runtime.handleComposerOptionsChange({ permissionMode: "full-access" }), false);
  assert.equal(patches.length, 0);
  state.running = false;
  models.push({ value: "plain", supportedReasoningEfforts: [] });
  const edit = runtime.handleComposerOptionsChange({ model: "plain" });
  await flushPromises();
  assert.equal(composerOptions.value.reasoningEffort, "");
  assert.deepEqual(patches[0].patch, { model: "plain", reasoningEffort: "" });
  patches[0].resolve(payload("thread-a", { model: "plain", reasoningEffort: "" }));
  await edit;
  assert.equal(composerOptions.value.reasoningEffort, "");
});

test("failed edits restore historical fallback values used before persistence", async () => {
  const { runtime, patches, composerOptions } = createHarness();
  runtime.applyHistoricalComposerValues({ model: "historical-model", reasoningEffort: "high", permissionMode: "auto-review" });
  const edit = runtime.handleComposerOptionsChange({ model: "unavailable-model" });
  await flushPromises();
  patches[0].reject(new Error("save failed"));
  await edit;
  assert.equal(composerOptions.value.model, "historical-model");
  assert.equal(composerOptions.value.reasoningEffort, "high");
});

async function loadSettingsComponent() {
  const fileUrl = new URL("../web/src/components/composer/ComposerSettings.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(fileUrl, "utf8"), { filename: fileUrl.pathname });
  const compiled = compileScript(descriptor, { id: "composer-settings-test", inlineTemplate: true });
  const source = compiled.content
    .replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve("vue"))}`)
    .replace('from "../../lib/composer.js"', `from ${JSON.stringify(new URL("../web/src/lib/composer.js", import.meta.url).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

function createTestRenderer() {
  return createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }),
    createText: (text) => ({ type: "text", text }),
    createComment: (text) => ({ type: "comment", text }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    insert: (node, parent) => { node.parent = parent; parent.children.push(node); },
    remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, previous, next) => { node.props[key] = next; }
  });
}

function findElements(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => findElements(child, predicate))];
}

test("permission controls render all modes, emit the selected value, and honor running disablement", async () => {
  const Component = await loadSettingsComponent();
  const { render } = createTestRenderer();
  const root = { children: [] };
  const selected = [];
  const props = {
    composerOptions: createComposerOptions(),
    gitState: createWorkspaceGitState(),
    showPermissionMode: true,
    onSelectPermission: (value) => selected.push(value)
  };
  render(h(Component, props), root);
  const buttons = findElements(root, (node) => node.type === "button" && String(node.props.class).includes("permission-option"));
  assert.deepEqual(buttons.map((button) => button.text.trim()), ["只读", "自动审核", "完全访问权限"]);
  buttons[1].props.onClick();
  assert.deepEqual(selected, ["auto-review"]);
  render(h(Component, { ...props, disabled: true }), root);
  await nextTick();
  assert.equal(buttons.every((button) => button.props.disabled), true);
  render(h(Component, { ...props, showPermissionMode: false }), root);
  assert.equal(findElements(root, (node) => node.type === "button" && String(node.props.class).includes("permission-option")).length, 0);
  render(null, root);
});

test("settings render only model-supported effort choices and hide empty capabilities", async () => {
  const Component = await loadSettingsComponent();
  const { render } = createTestRenderer();
  const root = { children: [] };
  const selected = [];
  const props = {
    models: [{ value: "model-b", supportedReasoningEfforts: ["low", "high"] }],
    composerOptions: createComposerOptions({ model: "model-b", reasoningEffort: "high" }),
    gitState: createWorkspaceGitState(),
    onSelectReasoning: (value) => selected.push(value)
  };
  render(h(Component, props), root);
  const efforts = findElements(root, (node) => node.type === "button" && ["低", "高"].includes(node.text?.trim()));
  assert.equal(efforts.length, 2);
  efforts[0].props.onClick();
  assert.deepEqual(selected, ["low"]);
  render(h(Component, { ...props, models: [{ value: "model-b", supportedReasoningEfforts: [] }] }), root);
  assert.equal(findElements(root, (node) => node.type === "header" && node.text === "思考强度").length, 0);
  render(null, root);
});
