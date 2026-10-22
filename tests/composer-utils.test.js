import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInputRequest,
  buildSessionCreateRequest,
  canSendComposerMessage,
  collectAttachmentLimitError,
  formatComposerContextSummary,
  getModelReasoningEffortOptions,
  getProviderModelOptions,
  normalizeComposerSettingsPatch,
  validateGitBranchName
} from "../web/src/lib/composer.js";

test("getProviderModelOptions does not invent codex models when provider catalog is empty", () => {
  const models = getProviderModelOptions([], "codex");
  assert.deepEqual(models, []);
});

test("getProviderModelOptions keeps the current model when provider catalog is unavailable", () => {
  const models = getProviderModelOptions([], "codex", "gpt-5");
  assert.deepEqual(models, [{ value: "gpt-5", label: "gpt-5" }]);
});

test("model options retain supported reasoning efforts and model defaults", () => {
  const models = [{
    value: "model-a",
    label: "Model A",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high"
  }];
  assert.deepEqual(getProviderModelOptions([{ id: "codex", models }], "codex"), models);
  assert.deepEqual(getModelReasoningEffortOptions(models, "model-a"), [
    { value: "low", label: "低" },
    { value: "high", label: "高" }
  ]);
});

test("switching models retains a supported effort or selects the model default", () => {
  const models = [{ value: "model-a", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }];
  assert.deepEqual(normalizeComposerSettingsPatch({ model: "model-a" }, { reasoningEffort: "low" }, models), { model: "model-a" });
  assert.deepEqual(normalizeComposerSettingsPatch({ model: "model-a" }, { reasoningEffort: "xhigh" }, models), {
    model: "model-a", reasoningEffort: "high"
  });
  assert.deepEqual(normalizeComposerSettingsPatch({ reasoningEffort: "medium" }, { model: "model-a" }, models), { reasoningEffort: "high" });
  assert.deepEqual(normalizeComposerSettingsPatch(
    { model: "model-b" },
    { reasoningEffort: "xhigh" },
    [{ value: "model-b", supportedReasoningEfforts: ["low", "medium"] }]
  ), { model: "model-b", reasoningEffort: "low" });
});

test("missing model metadata retains legacy efforts while an empty capability clears effort", () => {
  assert.deepEqual(getModelReasoningEffortOptions([{ value: "legacy" }], "legacy").map((option) => option.value), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(normalizeComposerSettingsPatch({ model: "legacy" }, { reasoningEffort: "" }, [{ value: "legacy" }]), { model: "legacy", reasoningEffort: "medium" });
  const models = [{ value: "plain", supportedReasoningEfforts: [] }];
  assert.deepEqual(getModelReasoningEffortOptions(models, "plain"), []);
  assert.deepEqual(normalizeComposerSettingsPatch({ model: "plain" }, { reasoningEffort: "high" }, models), { model: "plain", reasoningEffort: "" });
  assert.equal(buildInputRequest({ text: "hello", composerOptions: { reasoningEffort: "" } }).reasoningEffort, "");
  assert.equal(buildSessionCreateRequest({ composerOptions: { reasoningEffort: "" } }).reasoningEffort, "");
});

test("formatComposerContextSummary keeps fixed three-part summary", () => {
  const summary = formatComposerContextSummary(
    {
      model: "gpt-5.4",
      reasoningEffort: "high",
      gitBranch: "feature/composer-enhancement"
    },
    [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" }
    ]
  );

  assert.equal(summary, "GPT-5.4 · 高 · feature/composer-enhancement");
});

test("canSendComposerMessage allows image-only submission but blocks file-only submission", () => {
  assert.equal(canSendComposerMessage("", [{ kind: "image", status: "pending" }]), true);
  assert.equal(canSendComposerMessage("", [{ kind: "file", status: "pending" }]), false);
  assert.equal(canSendComposerMessage("有文字", [{ kind: "file", status: "pending" }]), true);
});

test("buildInputRequest only serializes uploaded image IDs", () => {
  const payload = buildInputRequest({
    text: "hello",
    composerOptions: {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      permissionMode: "default",
      attachments: [
        {
          id: "image-1",
          kind: "image",
          name: "screen.png",
          status: "uploaded",
          uploadedId: "persisted-image-1",
          file: { type: "image/png", size: 1024 }
        },
        {
          id: "file-1",
          kind: "file",
          name: "trace.log",
          status: "pending",
          file: { type: "text/plain", size: 2048 }
        }
      ]
    }
  });

  assert.equal(payload.data, "hello\n");
  assert.equal(payload.attachments.length, 1);
  assert.deepEqual(payload.attachments, [{ id: "persisted-image-1" }]);
});

test("buildInputRequest preserves leading indentation, blank lines and trailing newlines", () => {
  const text = "    first()\n\n    second()\n";
  assert.equal(buildInputRequest({ text }).data, `${text}\n`);
});

test("collectAttachmentLimitError enforces per-kind count and size limit", () => {
  const existingImages = Array.from({ length: 6 }, (_, index) => ({
    id: `image-${index}`,
    kind: "image",
    name: `image-${index}.png`,
    file: { size: 100 }
  }));

  const countError = collectAttachmentLimitError(existingImages, {
    kind: "image",
    name: "extra.png",
    file: { size: 100 }
  });
  assert.equal(countError, "图片附件最多 6 张。");

  const sizeError = collectAttachmentLimitError([], {
    kind: "file",
    name: "huge.zip",
    file: { size: 21 * 1024 * 1024 }
  });
  assert.equal(sizeError, "huge.zip 超过 20MB 限制。");
});

test("validateGitBranchName rejects unsupported names", () => {
  assert.equal(validateGitBranchName("feature/composer-ui"), "");
  assert.equal(validateGitBranchName("feature bad"), "分支名格式不合法。");
  assert.equal(validateGitBranchName(""), "请输入分支名。");
});
