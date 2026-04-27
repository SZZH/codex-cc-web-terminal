import test from "node:test";
import assert from "node:assert/strict";

import { cleanHistoricalMessageText, extractHistoricalTitleCandidate } from "../src/sessions/history/historicalText.js";

test("historical text cleaning strips codex git directives from assistant content", () => {
  const text = cleanHistoricalMessageText(`
已经按功能分别提交好了，现在是这三笔：

- 0ff52c0 统一执行过程与文件变更的折叠图标

当前工作区是干净的，没有未提交改动。

::git-commit{cwd="/workspace/codex-cc-web-terminal"}
  `);

  assert.equal(
    text,
    [
      "已经按功能分别提交好了，现在是这三笔：",
      "- 0ff52c0 统一执行过程与文件变更的折叠图标",
      "当前工作区是干净的，没有未提交改动。"
    ].join("\n")
  );
});

test("historical title extraction ignores codex directives", () => {
  const title = extractHistoricalTitleCandidate(`
::git-commit{cwd="/workspace/codex-cc-web-terminal"}
修复会话历史里的 directive 泄漏
  `);

  assert.equal(title, "修复会话历史里的 directive 泄漏");
});
