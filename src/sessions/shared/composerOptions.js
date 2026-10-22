function normalizeEnum(value, allowed, fallback = "") {
  const text = String(value || "").trim();
  return allowed.includes(text) ? text : fallback;
}

function hasOwn(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

export const CODEX_REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function normalizeReasoningEffort(value) {
  return normalizeEnum(value, CODEX_REASONING_EFFORTS, "medium");
}

export function normalizePermissionMode(value) {
  return normalizeEnum(value, ["default", "manual-review", "auto-review", "full-access"], "default");
}

export function assertPermissionModeSupported(value, { providerId = "codex", runnerMode = "" } = {}) {
  if (normalizePermissionMode(value) !== "manual-review") return;
  if (providerId !== "codex") {
    throw new Error("人工审批仅支持 Codex App Server，不能用于其他提供方。");
  }
  if (runnerMode === "json_exec") {
    throw new Error("人工审批需要 Codex App Server，json_exec 不支持审批响应。");
  }
}

export function extractComposerOptions(input = {}) {
  return {
    model: String(input?.model || "").trim(),
    reasoningEffort: normalizeReasoningEffort(input?.reasoningEffort),
    permissionMode: normalizePermissionMode(input?.permissionMode)
  };
}

export function extractComposerOptionOverrides(input = {}) {
  const options = {};
  if (hasOwn(input, "model")) {
    options.model = String(input?.model || "").trim();
  }
  if (hasOwn(input, "reasoningEffort")) {
    options.reasoningEffort = String(input?.reasoningEffort || "").trim();
  }
  if (hasOwn(input, "permissionMode")) {
    options.permissionMode = normalizePermissionMode(input?.permissionMode);
  }
  return options;
}

export function normalizeCodexComposerPatch(patch = {}, current = {}, models = []) {
  const options = extractComposerOptionOverrides(patch);
  const model = options.model || String(current.model || "").trim();
  const metadata = models.find((item) => item && typeof item === "object" && item.value === model);
  const hasDeclaredEfforts = Array.isArray(metadata?.supportedReasoningEfforts);
  const declaredEfforts = hasDeclaredEfforts
    ? metadata.supportedReasoningEfforts.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const supportedEfforts = hasDeclaredEfforts ? declaredEfforts : CODEX_REASONING_EFFORTS;
  const defaultEffort = supportedEfforts.includes(metadata?.defaultReasoningEffort)
    ? metadata.defaultReasoningEffort
    : hasDeclaredEfforts ? supportedEfforts[0] || "" : "medium";
  if (hasOwn(options, "reasoningEffort")) {
    if (options.reasoningEffort && !supportedEfforts.includes(options.reasoningEffort)) {
      throw new Error(`Model ${model || "default"} does not support reasoning effort: ${options.reasoningEffort}`);
    }
    if (!options.reasoningEffort) {
      options.reasoningEffort = defaultEffort;
    }
  } else if (options.model) {
    const currentEffort = String(current.reasoningEffort || "").trim();
    if (!supportedEfforts.includes(currentEffort)) {
      options.reasoningEffort = defaultEffort;
    }
  }
  return options;
}

export function applyComposerOptions(session = {}, input = {}) {
  const options = extractComposerOptions(input);
  if (options.model) {
    session.model = options.model;
  }
  session.reasoningEffort = options.reasoningEffort;
  session.permissionMode = options.permissionMode;
  return session;
}

export function applyComposerOptionOverrides(session = {}, input = {}) {
  const options = extractComposerOptionOverrides(input);
  if (hasOwn(options, "model") && options.model) {
    session.model = options.model;
  }
  if (hasOwn(options, "reasoningEffort")) {
    session.reasoningEffort = options.reasoningEffort;
  }
  if (hasOwn(options, "permissionMode")) {
    session.permissionMode = options.permissionMode;
  }
  return session;
}

export function buildCodexPermissionArgs(permissionMode) {
  if (permissionMode === "full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox", "-c", 'approvals_reviewer="user"'];
  }
  if (permissionMode === "auto-review") {
    return ["--approve-for-me"];
  }
  if (permissionMode === "manual-review") {
    return ["--sandbox", "read-only", "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="user"'];
  }
  return ["--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", 'approvals_reviewer="user"'];
}
