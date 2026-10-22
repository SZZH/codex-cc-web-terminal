import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceChangesRefresh } from "../web/src/lib/workspace-changes-refresh.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function fixture() {
  const calls = [], results = [];
  let visibilityHandler;
  const visibility = { hidden: false, addEventListener: (_name, callback) => { visibilityHandler = callback; },
    removeEventListener: () => { visibilityHandler = null; } };
  const controller = createWorkspaceChangesRefresh({
    read: (cwd, options) => { const pending = deferred(); calls.push({ cwd, options, pending }); return pending.promise; },
    onResult: (result) => results.push(result), onError: (error) => { throw error; }, onLoading() {}, visibility
  });
  return { controller, calls, results, visibility,
    setHidden(hidden) { visibility.hidden = hidden; visibilityHandler?.(); } };
}

test("a visible completed workspace loads one summary without polling on repeated observations", async () => {
  const f = fixture();
  try {
    f.controller.configure({ cwd: "/repo", interactive: true });
    assert.equal(f.calls.length, 0);
    f.controller.setVisible(true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.summary, true);
    f.controller.setVisible(true); void f.controller.refresh();
    assert.equal(f.calls.length, 1);
    f.calls[0].pending.resolve({ files: [] }); await settle();
    f.controller.setVisible(false); f.controller.setVisible(true); await settle();
    assert.equal(f.calls.length, 1);
  } finally { f.controller.dispose(); }
});

for (const suspend of ["offscreen", "hidden", "disabled", "cwd", "dispose"]) {
  test(`${suspend} cancels an in-flight summary and ignores a late response`, async () => {
    const f = fixture();
    try {
      f.controller.configure({ cwd: "/old", interactive: true });
      f.controller.setVisible(true);
      const old = f.calls[0];
      if (suspend === "offscreen") f.controller.setVisible(false);
      if (suspend === "hidden") f.setHidden(true);
      if (suspend === "disabled") f.controller.configure({ cwd: "/old", interactive: false });
      if (suspend === "cwd") f.controller.configure({ cwd: "/new", interactive: true });
      if (suspend === "dispose") f.controller.dispose();
      assert.equal(old.options.signal.aborted, true);
      old.pending.resolve({ source: "obsolete", files: [] }); await settle();
      assert.equal(f.results.length, 0);
      if (suspend === "cwd") {
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].options.summary, true);
        f.calls[1].pending.resolve({ source: "current", files: [] }); await settle();
        assert.equal(f.results[0].source, "current");
      } else assert.equal(f.calls.length, 1);
    } finally { f.controller.dispose(); }
  });
}

test("hidden and offscreen panels resume pending work only after both conditions clear", async () => {
  const f = fixture();
  try {
    f.setHidden(true);
    f.controller.configure({ cwd: "/repo", interactive: true });
    f.controller.setVisible(true);
    assert.equal(f.calls.length, 0);
    f.controller.setVisible(false); f.setHidden(false);
    assert.equal(f.calls.length, 0);
    f.controller.setVisible(true);
    assert.equal(f.calls.length, 1);
    f.calls[0].pending.resolve({ files: [] }); await settle();
    f.setHidden(true); f.setHidden(false);
    assert.equal(f.calls.length, 1, "a settled read does not repeat on foregrounding");
  } finally { f.controller.dispose(); }
});
