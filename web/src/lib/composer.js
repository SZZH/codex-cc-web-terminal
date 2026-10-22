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
    label: "只读",
    description: "仅可读取文件"
  },
  {
    value: "auto-review",
    label: "自动审核",
    description: "工作区读写，额外权限由 Codex 审核"
  },
  {
    value: "full-access",
    label: "完全访问权限",
    description: "跳过审批和沙箱，仅 Codex 生效"
  }
];

export const CODEX_PERMISSION_MODE_OPTIONS = [
  PERMISSION_MODE_OPTIONS[0],
  { value: "manual-review", label: "人工审批", description: "默认只读，额外权限由你审批" },
  ...PERMISSION_MODE_OPTIONS.slice(1)
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
  const labels = { none: "关闭", minimal: "最低", max: "最高", ultra: "极致" };
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label || labels[value] || String(value || "未启用");
}

export function getModelReasoningEffortOptions(models = [], model = "") {
  const selectedModel = models.find((option) => option.value === model);
  if (!Array.isArray(selectedModel?.supportedReasoningEfforts)) {
    return REASONING_EFFORT_OPTIONS;
  }
  return selectedModel.supportedReasoningEfforts.map((value) => ({
    value,
    label: getReasoningEffortLabel(value)
  }));
}

export function normalizeComposerSettingsPatch(patch = {}, options = {}, models = []) {
  const normalized = { ...patch };
  if (!Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "reasoningEffort")) {
    return normalized;
  }
  const model = Object.hasOwn(patch, "model") ? patch.model : options.model;
  const selectedModel = models.find((option) => option.value === model);
  const efforts = getModelReasoningEffortOptions(models, model).map((option) => option.value);
  const effort = Object.hasOwn(patch, "reasoningEffort") ? patch.reasoningEffort : options.reasoningEffort;
  if (!efforts.includes(effort)) {
    normalized.reasoningEffort = efforts.includes(selectedModel?.defaultReasoningEffort)
      ? selectedModel.defaultReasoningEffort
      : Array.isArray(selectedModel?.supportedReasoningEfforts) ? efforts[0] || "" : "medium";
  }
  return normalized;
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
        label: String(item?.label || value).trim() || value,
        ...(typeof item?.capabilitiesKnown === "boolean" ? { capabilitiesKnown: item.capabilitiesKnown } : {}),
        ...(Array.isArray(item?.inputModalities) ? { inputModalities: [...item.inputModalities] } : {}),
        ...(Array.isArray(item?.supportedReasoningEfforts)
          ? { supportedReasoningEfforts: [...new Set(item.supportedReasoningEfforts.map((effort) => String(effort || "").trim()).filter(Boolean))] }
          : {}),
        ...(String(item?.defaultReasoningEffort || "").trim()
          ? { defaultReasoningEffort: String(item.defaultReasoningEffort).trim() }
          : {})
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
      attachment?.kind === "image"
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
    .filter((attachment) => attachment?.kind === "image" && attachment?.status === "uploaded" && attachment?.uploadedId)
    .map((attachment) => ({
      id: String(attachment.uploadedId)
    }));
}

export function buildSessionCreateRequest({
  provider = "codex",
  cwd = "",
  projectId = "",
  name = "",
  resumeSessionId = "",
  composerOptions = {}
} = {}) {
  return {
    provider,
    cwd,
    ...(projectId ? { projectId } : {}),
    ...(name ? { name } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    model: String(composerOptions.model || "").trim(),
    reasoningEffort: String(composerOptions.reasoningEffort ?? "medium").trim(),
    permissionMode: String(composerOptions.permissionMode || "default").trim() || "default"
  };
}

export function buildInputRequest({
  text = "",
  composerOptions = {}
} = {}) {
  const source = String(text || "");
  return {
    type: "input",
    data: source.trim() ? `${source}\n` : "",
    model: String(composerOptions.model || "").trim(),
    reasoningEffort: String(composerOptions.reasoningEffort ?? "medium").trim(),
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
