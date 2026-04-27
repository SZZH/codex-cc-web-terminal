function normalizeEnum(value, allowed, fallback = "") {
  const text = String(value || "").trim();
  return allowed.includes(text) ? text : fallback;
}

function hasOwn(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

export function normalizeReasoningEffort(value) {
  return normalizeEnum(value, ["low", "medium", "high", "xhigh"], "medium");
}

export function normalizePermissionMode(value) {
  return normalizeEnum(value, ["default", "auto-review", "full-access"], "default");
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
    options.reasoningEffort = normalizeReasoningEffort(input?.reasoningEffort);
  }
  if (hasOwn(input, "permissionMode")) {
    options.permissionMode = normalizePermissionMode(input?.permissionMode);
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

export function buildCodexPermissionArgs(permissionMode, config = {}) {
  if (permissionMode === "full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (permissionMode === "auto-review") {
    return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
  }
  if (config.codexFullAccess) {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  return [];
}

export function sessionRequiresJsonExec(session = {}) {
  return Boolean(
    String(session?.permissionMode || "").trim() !== "" && String(session?.permissionMode || "default").trim() !== "default"
  );
}
