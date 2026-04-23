import test from "node:test";
import assert from "node:assert/strict";

import { normalizeThreadItem, summarizeProcessItems } from "../web/src/lib/thread-item-renderers.js";

test("thread item renderer normalizes process items with explicit type title and status label", () => {
  const item = normalizeThreadItem({
    id: "cmd-1",
    kind: "CommandExecution",
    status: "completed",
    summary: "exec_command",
    text: "npm run check"
  });

  assert.equal(item.category, "process");
  assert.equal(item.label, "命令执行");
  assert.equal(item.title, "命令执行");
  assert.equal(item.statusLabel, "完成");
  assert.match(item.body, /npm run check/);
  assert.equal(item.summary, "exec_command");
});

test("thread item renderer keeps command process body in code-friendly raw form", () => {
  const item = normalizeThreadItem({
    id: "cmd-2",
    kind: "CommandExecution",
    status: "completed",
    summary: "exec_command",
    text: "npm run check\nnode --version"
  });

  assert.equal(item.category, "process");
  assert.match(item.body, /npm run check/);
  assert.match(item.body, /node --version/);
});

test("thread item renderer summarizes process counts by type", () => {
  const summary = summarizeProcessItems([
    { kind: "Reasoning" },
    { kind: "CommandExecution" },
    { kind: "CommandExecution" },
    { kind: "DynamicToolCall" }
  ]);

  assert.equal(summary.reasoning, 1);
  assert.equal(summary.command, 2);
  assert.equal(summary.tool, 1);
  assert.match(summary.label, /思考 1/);
  assert.match(summary.label, /命令 2/);
  assert.match(summary.label, /工具 1/);
});
