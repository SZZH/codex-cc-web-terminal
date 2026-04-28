import test from "node:test";
import assert from "node:assert/strict";

import { normalizeImageUrl } from "../web/src/lib/image-url.js";
import { normalizeThreadItem, summarizeProcessItems } from "../web/src/lib/thread-item-renderers.js";
import { buildThreadViewModel } from "../web/src/lib/thread-view-model.js";

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

test("thread item renderer extracts image payload for structured image items", () => {
  const item = normalizeThreadItem({
    id: "img-1",
    kind: "ImageGeneration",
    payload: {
      url: "https://example.com/demo.png",
      alt: "demo image"
    }
  });

  assert.equal(item.imageUrl, "https://example.com/demo.png");
  assert.equal(item.imageAlt, "demo image");
  assert.equal(item.body, "");
});

test("thread item renderer extracts user input images from nested content payloads", () => {
  const item = normalizeThreadItem({
    id: "user-1",
    kind: "UserMessage",
    text: "看下这张图",
    payload: {
      content: [
        { type: "input_text", text: "看下这张图" },
        { type: "input_image", image_url: "https://example.com/input-a.png", alt: "截图 A" },
        { type: "local_image", path: "/api/files/input-b.png", name: "截图 B" }
      ]
    }
  });

  assert.equal(item.category, "user");
  assert.equal(item.imageUrl, "https://example.com/input-a.png");
  assert.equal(item.imageAlt, "截图 A");
  assert.equal(item.imageItems.length, 2);
  assert.deepEqual(
    item.imageItems.map((image) => image.url),
    ["https://example.com/input-a.png", "/api/files/input-b.png"]
  );
  assert.match(item.body, /看下这张图/);
});

test("image url normalization proxies absolute local image paths through backend route", () => {
  assert.equal(
    normalizeImageUrl("/Users/demo/Desktop/example.png"),
    "/api/local-file-image?path=%2FUsers%2Fdemo%2FDesktop%2Fexample.png"
  );
  assert.equal(
    normalizeImageUrl("file:///Users/demo/Desktop/example.png"),
    "/api/local-file-image?path=%2FUsers%2Fdemo%2FDesktop%2Fexample.png"
  );
  assert.equal(
    normalizeImageUrl("C:\\Users\\demo\\Desktop\\example.png"),
    "/api/local-file-image?path=C%3A%5CUsers%5Cdemo%5CDesktop%5Cexample.png"
  );
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

test("thread item renderer marks historical dump command output as diagnostic dump", () => {
  const item = normalizeThreadItem({
    id: "cmd-dump-1",
    kind: "CommandExecution",
    status: "completed",
    summary: "exec_command",
    text: [
      "Command: curl http://localhost:3210/api/history-messages?provider=codex&resumeSessionId=abc",
      "{",
      '  "session": "history:codex:abc",',
      '  "conversation.turns": [',
      '    { "role": "user", "text": "提交代码" },',
      '    { "role": "assistant", "text": "已提交，commit 是 e949854" }',
      "  ]",
      "}",
      "/Users/demo/.codex/sessions/2026/04/28/rollout-2026-04-28T00-38-22-abc.jsonl"
    ].join("\n")
  });

  assert.equal(item.isDiagnosticDump, true);
  assert.equal(item.summary, "会话历史调试输出");
});

test("thread view model collapses process segments for terminal turns", () => {
  const viewModel = buildThreadViewModel({
    turns: [
      {
        id: "turn-history",
        completedAt: "2026-04-27T12:00:00.000Z",
        items: [
          { id: "cmd-1", kind: "CommandExecution", status: "completed", summary: "npm test" },
          { id: "msg-1", kind: "AgentMessage", text: "完成" }
        ]
      },
      {
        id: "turn-running",
        status: "inProgress",
        items: [
          { id: "cmd-2", kind: "CommandExecution", status: "completed", summary: "npm run dev" }
        ]
      },
      {
        id: "turn-completed",
        status: "completed",
        items: [
          { id: "cmd-3", kind: "CommandExecution", status: "completed", summary: "npm run build" }
        ]
      }
    ]
  });

  const historyProcess = viewModel.turns[0].segments.find((segment) => segment.kind === "process");
  const runningProcess = viewModel.turns[1].segments.find((segment) => segment.kind === "process");
  const completedProcess = viewModel.turns[2].segments.find((segment) => segment.kind === "process");

  assert.equal(historyProcess.defaultCollapsed, true);
  assert.equal(runningProcess.defaultCollapsed, false);
  assert.equal(completedProcess.defaultCollapsed, true);
});

test("thread view model collapses process segments that contain diagnostic dumps", () => {
  const viewModel = buildThreadViewModel({
    turns: [
      {
        id: "turn-diagnostic",
        status: "inProgress",
        items: [
          {
            id: "cmd-dump-2",
            kind: "CommandExecution",
            status: "completed",
            summary: "exec_command",
            text: [
              "Command: node dump-history.js",
              "{",
              '  "threadSnapshot": {',
              '    "turns": [',
              '      { "kind": "UserMessage", "text": "提交代码" },',
              '      { "kind": "AgentMessage", "text": "已提交，commit 是 e949854" }',
              "    ]",
              "  }",
              "}"
            ].join("\n")
          }
        ]
      }
    ]
  });

  const processSegment = viewModel.turns[0].segments.find((segment) => segment.kind === "process");
  assert.equal(processSegment.hasDiagnosticDump, true);
  assert.equal(processSegment.defaultCollapsed, true);
  assert.match(processSegment.processSummary.label, /调试输出 1/);
});

test("thread view model keeps workspace changes anchored to the file-change turn", () => {
  const viewModel = buildThreadViewModel({
    turns: [
      {
        id: "turn-change",
        items: [
          { id: "msg-1", kind: "AgentMessage", text: "已完成修改" },
          { id: "patch-1", kind: "FileChange", status: "completed", summary: "apply_patch" }
        ]
      },
      {
        id: "turn-chat",
        items: [
          { id: "msg-2", kind: "AgentMessage", text: "后续普通问答" }
        ]
      }
    ]
  });

  assert.equal(viewModel.latestFileChangeTurnId, "turn-change");
  assert.equal(viewModel.turns.find((turn) => turn.id === "turn-change")?.hasFileChange, true);
  assert.equal(viewModel.turns.find((turn) => turn.id === "turn-chat")?.hasFileChange, false);
});

test("thread view model extracts historical file changes from file-change payloads", () => {
  const viewModel = buildThreadViewModel({
    turns: [
      {
        id: "turn-change",
        items: [
          {
            id: "patch-1",
            kind: "FileChange",
            status: "completed",
            payload: {
              changes: {
                "/workspace/codex-cc-web-terminal/package.json": {
                  type: "update",
                  unified_diff: "@@ -1 +1 @@\n-foo\n+bar\n"
                }
              }
            }
          }
        ]
      }
    ]
  });

  assert.equal(viewModel.latestFileChangeTurnId, "turn-change");
  assert.deepEqual(viewModel.turns[0].fileChanges, [
    {
      path: "package.json",
      previousPath: "",
      status: "update",
      additions: 1,
      deletions: 1,
      diff: "@@ -1 +1 @@\n-foo\n+bar"
    }
  ]);
});

test("thread view model keeps historical file changes on every changed turn", () => {
  const viewModel = buildThreadViewModel({
    turns: [
      {
        id: "turn-first-change",
        items: [
          {
            id: "patch-1",
            kind: "FileChange",
            status: "completed",
            payload: {
              callId: "patch-1",
              name: "apply_patch",
              output: {
                "/workspace/codex-cc-web-terminal/src/one.js": {
                  type: "update",
                  unified_diff: "@@ -1 +1 @@\n-old\n+new\n"
                }
              }
            }
          },
          {
            id: "patch-1b",
            kind: "FileChange",
            status: "completed",
            payload: {
              output: {
                "/workspace/codex-cc-web-terminal/src/one.js": {
                  type: "update",
                  unified_diff: "@@ -2 +2 @@\n-left\n+right\n"
                }
              }
            }
          }
        ]
      },
      {
        id: "turn-chat",
        items: [{ id: "msg-1", kind: "AgentMessage", text: "中间普通问答" }]
      },
      {
        id: "turn-second-change",
        items: [
          {
            id: "patch-2",
            kind: "FileChange",
            status: "completed",
            payload: {
              output: {
                "/workspace/codex-cc-web-terminal/src/two.js": {
                  type: "update",
                  unified_diff: "@@ -1 +1 @@\n-left\n+right\n"
                }
              }
            }
          }
        ]
      }
    ]
  });

  assert.equal(viewModel.latestFileChangeTurnId, "turn-second-change");
  assert.deepEqual(
    viewModel.turns.map((turn) => [turn.id, turn.fileChanges.map((file) => file.path)]),
    [
      ["turn-first-change", ["src/one.js"]],
      ["turn-chat", []],
      ["turn-second-change", ["src/two.js"]]
    ]
  );
  assert.equal(viewModel.turns[0].fileChanges[0].additions, 2);
  assert.equal(viewModel.turns[0].fileChanges[0].deletions, 2);
});
