const MAX_ATTACHMENT_COUNT_PER_KIND = 6;
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

export const REASONING_EFFORT_OPTIONS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中等" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" }
];

export const PERMISSION_MODE_OPTIONS = [
  {
    value: "default",
    label: "默认权限",
    description: "沿用当前项目配置"
  },
  {
    value: "auto-review",
    label: "自动审查",
    description: "写入工作区，必要时请求确认"
  },
  {
    value: "full-access",
    label: "完全访问权限",
    description: "跳过审批和沙箱，仅 Codex 生效"
  }
];

export function createComposerOptions(overrides = {}) {
  return {
    model: "",
    reasoningEffort: "medium",
    permissionMode: "default",
    gitBranch: "",
    attachments: [],
    ...overrides
  };
}

export function createWorkspaceGitState(overrides = {}) {
  return {
    available: false,
    loading: false,
    isGitRepo: false,
    currentBranch: "",
    dirty: false,
    branches: [],
    error: "",
    ...overrides
  };
}

export function getReasoningEffortLabel(value) {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label || "中等";
}

export function getProviderModelOptions(providers = [], providerId = "codex", currentModel = "") {
  const normalizedProviderId = String(providerId || "codex").trim().toLowerCase() || "codex";
  const provider = (Array.isArray(providers) ? providers : []).find(
    (item) => String(item?.id || "").trim().toLowerCase() === normalizedProviderId
  );

  const sourceModels = Array.isArray(provider?.models) && provider.models.length > 0
    ? provider.models
    : String(currentModel || provider?.defaultModel || "").trim()
      ? [String(currentModel || provider?.defaultModel || "").trim()]
      : [];

  return sourceModels
    .map((item) => {
      const value = String(item?.value || item || "").trim();
      if (!value) {
        return null;
      }
      return {
        value,
        label: String(item?.label || value).trim() || value
      };
    })
    .filter(Boolean);
}

export function formatComposerContextSummary(options, modelOptions = []) {
  const modelLabel =
    modelOptions.find((item) => item.value === options?.model)?.label ||
    String(options?.model || "").trim() ||
    "未选择模型";

  return [
    modelLabel,
    getReasoningEffortLabel(options?.reasoningEffort),
    String(options?.gitBranch || "").trim() || "未选择分支"
  ].join(" · ");
}

export function hasImageAttachment(attachments = []) {
  return (attachments || []).some(
    (attachment) =>
      attachment?.kind === "image" &&
      attachment?.status !== "failed"
  );
}

export function hasOnlyFileAttachments(attachments = []) {
  const items = Array.isArray(attachments) ? attachments : [];
  return items.length > 0 && items.every((attachment) => attachment?.kind === "file");
}

export function canSendComposerMessage(draft = "", attachments = []) {
  return Boolean(String(draft || "").trim()) || hasImageAttachment(attachments);
}

export function normalizeAttachmentKind(file, kindHint = "") {
  if (String(kindHint || "").trim() === "image") {
    return "image";
  }
  return String(file?.type || "").startsWith("image/") ? "image" : "file";
}

function createAttachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `attachment-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createAttachmentRecord(file, { kindHint = "", source = "" } = {}) {
  const kind = normalizeAttachmentKind(file, kindHint);
  return {
    id: createAttachmentId(),
    kind,
    name: String(file?.name || "").trim() || (kind === "image" ? "未命名图片" : "未命名文件"),
    file,
    status: "pending",
    url: "",
    error: "",
    source: String(source || "").trim()
  };
}

export function collectAttachmentLimitError(records = [], nextRecord) {
  const items = [...records];
  const kind = nextRecord?.kind;
  const size = Number(nextRecord?.file?.size || 0);
  const kindCount = items.filter((item) => item.kind === kind).length;

  if (kindCount >= MAX_ATTACHMENT_COUNT_PER_KIND) {
    return kind === "image" ? "图片附件最多 6 张。" : "文件附件最多 6 个。";
  }
  if (size > MAX_ATTACHMENT_SIZE_BYTES) {
    return `${nextRecord.name} 超过 20MB 限制。`;
  }
  return "";
}

export function serializeImageAttachmentsForRequest(attachments = []) {
  return (attachments || [])
    .filter((attachment) => attachment?.kind === "image" && attachment?.status !== "failed")
    .map((attachment) => ({
      id: String(attachment.id || ""),
      kind: "image",
      name: String(attachment.name || ""),
      mimeType: String(attachment.file?.type || ""),
      size: Number(attachment.file?.size || 0),
      status: String(attachment.status || "pending")
    }));
}

export function buildSessionCreateRequest({
  provider = "codex",
  cwd = "",
  name = "",
  resumeSessionId = "",
  composerOptions = {}
} = {}) {
  return {
    provider,
    cwd,
    ...(name ? { name } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    model: String(composerOptions.model || "").trim(),
    reasoningEffort: String(composerOptions.reasoningEffort || "medium").trim() || "medium",
    permissionMode: String(composerOptions.permissionMode || "default").trim() || "default"
  };
}

export function buildInputRequest({
  text = "",
  composerOptions = {}
} = {}) {
  const trimmed = String(text || "").trim();
  return {
    type: "input",
    data: trimmed ? `${trimmed}\n` : "",
    model: String(composerOptions.model || "").trim(),
    reasoningEffort: String(composerOptions.reasoningEffort || "medium").trim() || "medium",
    permissionMode: String(composerOptions.permissionMode || "default").trim() || "default",
    attachments: serializeImageAttachmentsForRequest(composerOptions.attachments || [])
  };
}

export function validateGitBranchName(value = "") {
  const branch = String(value || "").trim();
  if (!branch) {
    return "请输入分支名。";
  }
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) {
    return "分支名格式不合法。";
  }
  if (
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("\\") ||
    branch.includes("//") ||
    /[\s~^:?*\[]/.test(branch) ||
    branch.endsWith(".lock")
  ) {
    return "分支名格式不合法。";
  }
  return "";
}
