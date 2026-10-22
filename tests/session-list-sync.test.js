import test from "node:test";
import assert from "node:assert/strict";
import { createSessionCatalogController } from "../web/src/lib/session-catalog-runtime.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(setImmediate);

function browser({ visibility = "visible", documentMode = "events", firstTimerId = 1 } = {}) {
  const timers = new Map(), listeners = new Set();
  let nextTimerId = firstTimerId;
  const view = {
    setInterval(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => timers.delete(id)
  };
  const page = documentMode === "missing" ? undefined : { visibilityState: visibility };
  if (documentMode === "events") {
    page.addEventListener = (name, callback) => {
      assert.equal(name, "visibilitychange");
      listeners.add(callback);
    };
    page.removeEventListener = (name, callback) => {
      assert.equal(name, "visibilitychange");
      listeners.delete(callback);
    };
  }
  return { view, page, timers, listeners,
    tick() { for (const { callback } of [...timers.values()]) callback(); },
    show(visibilityState) {
      page.visibilityState = visibilityState;
      for (const callback of [...listeners]) callback();
    }
  };
}

function fixture(t, options = {}) {
  const globals = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const environments = [];
  const install = (settings) => {
    const environment = browser(settings);
    environments.push(environment);
    globalThis.window = environment.view;
    if (environment.page) globalThis.document = environment.page;
    else delete globalThis.document;
    return environment;
  };
  const environment = install(options);
  const state = { ready: true, isAuthenticated: true, sessions: [], projectGroups: [] };
  const route = { name: "sessions" }, requests = [];
  const controller = createSessionCatalogController({ state, route,
    composerOptions: { value: { model: "", attachments: [] } }, sessionCache: {},
    request(url, options) {
      const pending = { url, options, ...deferred() };
      requests.push(pending);
      return pending.promise;
    }
  });
  t.after(async () => {
    try {
      controller.stopSessionListSyncLoop();
      for (const pending of requests) pending.resolve({ sessions: [], projectGroups: [] });
      await flush();
      for (const item of environments) {
        assert.equal(item.timers.size, 0, "fixture releases every owned interval");
        assert.equal(item.listeners.size, 0, "fixture releases every owned visibility listener");
      }
    } finally {
      for (const item of environments) { item.timers.clear(); item.listeners.clear(); }
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  return { ...environment, state, route, requests, controller, install };
}

test("a hidden catalog skips all four-second periodic reads", async (t) => {
  const h = fixture(t, { visibility: "hidden" });
  h.controller.startSessionListSyncLoop();
  assert.equal([...h.timers.values()][0].delay, 4000);
  for (let index = 0; index < 4; index += 1) { h.tick(); await flush(); }
  assert.equal(h.requests.length, 0);
});

test("returning from hidden to visible refreshes immediately once per transition", async (t) => {
  const h = fixture(t);
  h.controller.startSessionListSyncLoop();
  h.show("visible");
  assert.equal(h.requests.length, 0, "a repeated visible event is not a transition");
  h.show("hidden");
  assert.equal(h.requests.length, 0);
  h.show("visible");
  assert.equal(h.requests.length, 1, "resume does not wait for the next interval");
  h.requests[0].resolve({ sessions: [{ id: "resumed" }] }); await flush();
  h.show("visible");
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.sessions[0].id, "resumed");
});

test("visible periods keep the existing interval and read current document visibility", async (t) => {
  const h = fixture(t);
  h.controller.startSessionListSyncLoop();
  assert.equal(h.requests.length, 0, "start preserves the existing delayed first tick");
  h.tick();
  h.requests[0].resolve({ sessions: [{ id: "first" }] }); await flush();
  h.page.visibilityState = "hidden";
  h.tick(); await flush();
  assert.equal(h.requests.length, 1, "a tick reads visibility even before its event is dispatched");
  h.page.visibilityState = "visible";
  h.tick();
  h.requests[1].resolve({ sessions: [{ id: "second" }] }); await flush();
  assert.equal(h.state.sessions[0].id, "second");
});

test("hidden manual and initial reads continue and resume coalesces with the catalog flight", async (t) => {
  const h = fixture(t, { visibility: "hidden" });
  const bootstrap = h.controller.bootstrapWorkspace();
  h.controller.startSessionListSyncLoop();
  h.tick();
  h.show("visible"); h.tick();
  assert.deepEqual(h.requests.map(({ url }) => url), ["/api/config", "/api/sessions?compact=1&progressive=1"]);
  h.requests[0].resolve({ providers: [] });
  h.requests[1].resolve({ sessions: [{ id: "initial" }] });
  await bootstrap;
  h.show("hidden");
  const manual = h.controller.refreshSessions();
  assert.equal(h.requests.length, 3, "manual refresh is allowed while hidden");
  h.show("visible"); h.tick();
  assert.equal(h.requests.length, 3, "resume and ticks share the manual request");
  h.requests[2].resolve({ sessions: [{ id: "manual" }] }); await manual;
  assert.equal(h.state.sessions[0].id, "manual");
});

for (const blocked of ["chat", "unauthenticated", "not-ready"]) {
  test(`ticks and visibility resumes require the current ${blocked} context to become eligible`, async (t) => {
    const h = fixture(t);
    h.controller.startSessionListSyncLoop();
    if (blocked === "chat") h.route.name = "chat";
    if (blocked === "unauthenticated") h.state.isAuthenticated = false;
    if (blocked === "not-ready") h.state.ready = false;
    h.tick(); h.show("hidden"); h.show("visible"); await flush();
    assert.equal(h.requests.length, 0);
    h.route.name = "sessions"; h.state.isAuthenticated = true; h.state.ready = true;
    h.show("hidden"); h.show("visible");
    assert.equal(h.requests.length, 1, "state changes after start take effect immediately");
    h.requests[0].resolve({ sessions: [] }); await flush();
  });
}

test("failed background reads retain the confirmed catalog and recover on a later resume", async (t) => {
  const h = fixture(t);
  const sessions = [{ id: "retained" }], projectGroups = [{ id: "project", sessions }];
  const initial = h.controller.refreshSessions();
  h.requests[0].resolve({ sessions, projectGroups }); await initial;
  h.controller.startSessionListSyncLoop();
  h.tick();
  const failure = new Error("catalog temporarily offline");
  h.requests[1].reject(failure); await flush();
  assert.equal(h.state.sessions, sessions);
  assert.equal(h.state.projectGroups, projectGroups);
  assert.equal(h.state.sessionListReady, true);
  assert.equal(h.state.sessionListLoading, false);
  assert.equal(h.state.sessionListError, failure);
  h.show("hidden"); h.tick(); h.show("visible");
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ sessions: [{ id: "recovered" }] }); await flush();
  assert.equal(h.state.sessions[0].id, "recovered");
  assert.equal(h.state.sessionListError, null);
});

test("restart and stop retire queued ticks and visibility callbacks with no owned resources left", async (t) => {
  const h = fixture(t, { visibility: "hidden" });
  h.controller.startSessionListSyncLoop();
  assert.equal(h.listeners.size, 1);
  const staleTick = [...h.timers.values()][0].callback, staleEvent = [...h.listeners][0];
  h.controller.startSessionListSyncLoop();
  assert.equal(h.timers.size, 1);
  assert.equal(h.listeners.size, 1);
  const currentTick = [...h.timers.values()][0].callback, currentEvent = [...h.listeners][0];
  h.page.visibilityState = "visible";
  staleTick(); staleEvent();
  assert.equal(h.requests.length, 0, "callbacks from the previous start are inert");
  currentEvent();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ sessions: [] }); await flush();
  h.controller.stopSessionListSyncLoop(); h.controller.stopSessionListSyncLoop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  staleTick(); staleEvent(); currentTick();
  h.page.visibilityState = "hidden"; currentEvent();
  h.page.visibilityState = "visible"; currentEvent();
  assert.equal(h.requests.length, 1, "callbacks from all stopped starts are inert");
});

test("cleanup uses the original window and document after globals change and clears timer zero", async (t) => {
  const h = fixture(t, { visibility: "hidden", firstTimerId: 0 });
  h.controller.startSessionListSyncLoop();
  assert.equal(h.listeners.size, 1);
  const oldTick = [...h.timers.values()][0].callback, oldEvent = [...h.listeners][0];
  const replacement = h.install({ visibility: "hidden" });
  h.controller.startSessionListSyncLoop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(replacement.timers.size, 1);
  assert.equal(replacement.listeners.size, 1);
  h.page.visibilityState = "visible"; oldTick(); oldEvent();
  assert.equal(h.requests.length, 0);
  replacement.show("visible");
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ sessions: [] }); await flush();
  delete globalThis.window; delete globalThis.document;
  h.controller.stopSessionListSyncLoop();
  assert.equal(replacement.timers.size, 0);
  assert.equal(replacement.listeners.size, 0);
});

for (const documentMode of ["missing", "no-listeners"]) {
  test(`a ${documentMode} document preserves the original polling behavior`, async (t) => {
    const h = fixture(t, { documentMode, visibility: "hidden" });
    h.controller.startSessionListSyncLoop();
    h.tick();
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve({ sessions: [] }); await flush();
    h.tick();
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve({ sessions: [] }); await flush();
    h.controller.stopSessionListSyncLoop();
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
  });
}

test("without a window start and stop remain safe no-ops", (t) => {
  const h = fixture(t);
  delete globalThis.window;
  h.controller.startSessionListSyncLoop(); h.controller.stopSessionListSyncLoop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.requests.length, 0);
});

test("a later login can keep polling through the same active loop", async (t) => {
  const h = fixture(t);
  h.controller.startSessionListSyncLoop();
  h.controller.invalidateWorkspaceBootstrap();
  h.state.isAuthenticated = false;
  h.tick(); h.show("hidden"); h.show("visible");
  assert.equal(h.requests.length, 0);
  h.state.isAuthenticated = true;
  h.tick();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ sessions: [{ id: "new-login" }] }); await flush();
  assert.equal(h.state.sessions[0].id, "new-login");
});

test("stopping a loop leaves its existing catalog request able to finish", async (t) => {
  const h = fixture(t);
  h.controller.startSessionListSyncLoop(); h.tick();
  h.controller.stopSessionListSyncLoop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  h.requests[0].resolve({ sessions: [{ id: "completed" }] }); await flush();
  assert.equal(h.state.sessions[0].id, "completed");
});
