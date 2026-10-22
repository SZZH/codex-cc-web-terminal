import test from "node:test";
import assert from "node:assert/strict";
import { computed } from "vue";
import { createCodeHighlighter, preserveCodeScroll } from "../web/src/lib/code-highlighting.js";

test("a shared highlighter stays unloaded until requested and deduplicates concurrent code blocks", async () => {
  let loads = 0, resolve;
  const module = { highlight() {} };
  const highlighter = createCodeHighlighter(() => { loads += 1; return new Promise((yes) => { resolve = yes; }); });
  const current = computed(() => highlighter.get());
  assert.equal(current.value, null);
  assert.equal(loads, 0);
  const first = highlighter.load(), second = highlighter.load();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(loads, 1);
  resolve({ default: module });
  assert.equal(await first, module);
  assert.equal(current.value, module);
  assert.equal(await highlighter.load(), module);
  assert.equal(loads, 1);
});

test("an unavailable optional chunk leaves code readable without repeated import attempts", async () => {
  let loads = 0;
  const highlighter = createCodeHighlighter(() => { loads += 1; throw new Error("chunk unavailable"); });
  assert.equal(await highlighter.load(), null);
  assert.equal(await highlighter.load(), null);
  assert.equal(highlighter.get(), null);
  assert.equal(loads, 1);
});

test("code scroll offsets survive replacement without moving the outer transcript", () => {
  let nodes = [{ scrollLeft: 230, scrollTop: 0 }, { scrollLeft: 0, scrollTop: 42 }], restore;
  const element = { scrollTop: 920, querySelectorAll: () => nodes };
  preserveCodeScroll(element, (callback) => { restore = callback; });
  nodes = [{ scrollLeft: 0, scrollTop: 0 }, { scrollLeft: 0, scrollTop: 0 }];
  restore();
  assert.deepEqual(nodes, [{ scrollLeft: 230, scrollTop: 0 }, { scrollLeft: 0, scrollTop: 42 }]);
  assert.equal(element.scrollTop, 920);
  preserveCodeScroll({ querySelectorAll: () => [{ scrollLeft: 0, scrollTop: 0 }] }, () => assert.fail("no scroll restoration needed"));
});

test("queued code scrolling does not affect replacement content or a detached item", () => {
  for (const state of ["replaced", "detached", "removed"]) {
    let node = { scrollLeft: 220, scrollTop: 0, textContent: "old code" }, restore;
    const element = { isConnected: true, querySelectorAll: () => node ? [node] : [] };
    preserveCodeScroll(element, (callback) => { restore = callback; });
    node = state === "removed" ? null : { scrollLeft: 0, scrollTop: 0, textContent: state === "detached" ? "old code" : "different code" };
    element.isConnected = state !== "detached";
    restore();
    assert.equal(node?.scrollLeft || 0, 0);
  }
});
