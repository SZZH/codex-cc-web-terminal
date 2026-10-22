import test from "node:test";
import assert from "node:assert/strict";
import { createCodexRuntimeErrors } from "../web/src/lib/codex-runtime-errors.js";

function fixture() {
  const state = { error: "" };
  let disposed = false;
  const errors = createCodexRuntimeErrors({ state, isDisposed: () => disposed });
  return { state, errors, detach: () => { disposed = true; } };
}

test("successful recovery retires only its owner and reveals any other unresolved failure", () => {
  const { state, errors } = fixture();
  const older = errors.begin("older");
  errors.fail(older, new Error("older failed"));
  const interrupt = errors.begin("interrupt");
  errors.fail(interrupt, new Error("stop failed"));
  errors.succeed(errors.begin("submit"));
  assert.equal(state.error, "stop failed");
  errors.succeed(interrupt);
  assert.equal(state.error, "older failed");
  errors.succeed(errors.begin("older"));
  assert.equal(state.error, "");
});

test("identical error text retains distinct owners through independent recovery", () => {
  const { state, errors } = fixture();
  const older = errors.begin("older"), interrupt = errors.begin("interrupt");
  errors.fail(older, new Error("Failed to fetch"));
  assert.equal(state.errorOwner, "older");
  errors.fail(interrupt, new Error("Failed to fetch"));
  assert.equal(state.errorOwner, "interrupt");
  errors.succeed(older);
  assert.equal(state.error, "Failed to fetch");
  assert.equal(state.errorOwner, "interrupt");
  errors.succeed(interrupt);
  assert.equal(state.error, "");
  assert.equal(state.errorOwner, "");
});

test("older outcomes cannot overwrite the newest outcome for the same operation owner", () => {
  const { state, errors } = fixture();
  const old = errors.begin("promote", "old");
  const latest = errors.begin("promote", "new");
  errors.fail(latest, new Error("new failure"));
  errors.succeed(old);
  errors.fail(old, new Error("old failure"));
  assert.equal(state.error, "new failure");
  errors.succeed(latest);
  errors.fail(old, new Error("late failure after recovery"));
  assert.equal(state.error, "");
});

test("a successful request for another target cannot clear the owner's previous failed target", () => {
  const { state, errors } = fixture();
  errors.fail(errors.begin("confirmation", "first"), "first check failed");
  errors.succeed(errors.begin("confirmation", "second"));
  assert.equal(state.error, "first check failed");
  errors.succeed(errors.begin("confirmation", "first"));
  assert.equal(state.error, "");
});

test("owners are fixed and detached or disposed operations cannot publish runtime errors", () => {
  const { state, errors, detach } = fixture();
  assert.throws(() => errors.begin("arbitrary-request-id"), /Unknown runtime error owner/);
  const poll = errors.begin("poll");
  errors.fail(poll, "poll failed");
  detach();
  errors.succeed(poll);
  errors.fail(poll, "late failure");
  assert.equal(state.error, "poll failed");
  errors.dispose();
  assert.equal(errors.begin("poll"), null);
  assert.equal(errors.fail(poll, "after cleanup"), false);
});
