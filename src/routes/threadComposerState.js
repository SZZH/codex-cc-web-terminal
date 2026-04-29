import { readCodexDesktopDefaults } from "../sessions/shared/codexDesktopConfig.js";
import { CodexThreadStateStore } from "../sessions/state/CodexThreadStateStore.js";

function emptyGitState(cwd = "") {
  return {
    available: false,
    loading: false,
    isGitRepo: false,
    currentBranch: "",
    dirty: false,
    branches: [],
    error: "",
    cwd: String(cwd || "").trim()
  };
}

function getCodexThreadStateStore(runtime) {
  return new CodexThreadStateStore(runtime.config);
}

function listComposerGitState(workspaceChangesInternals, cwd = "") {
  const normalizedCwd = String(cwd || "").trim();
  if (!normalizedCwd) {
    return emptyGitState("");
  }
  try {
    const payload = workspaceChangesInternals.listGitBranches(normalizedCwd);
    return {
      available: true,
      loading: false,
      isGitRepo: Boolean(payload?.isGitRepo),
      currentBranch: String(payload?.currentBranch || "").trim(),
      dirty: Boolean(payload?.dirty),
      branches: Array.isArray(payload?.branches) ? payload.branches : [],
      error: "",
      cwd: String(payload?.cwd || normalizedCwd).trim()
    };
  } catch (error) {
    return {
      ...emptyGitState(normalizedCwd),
      error: error?.message || String(error)
    };
  }
}

export function buildThreadComposerState(runtime, workspaceChangesInternals, providerId, threadId) {
  const resolvedProviderId = String(providerId || "codex").trim().toLowerCase() || "codex";
  const resolvedThreadId = String(threadId || "").trim();
  if (!resolvedThreadId) {
    throw new Error("threadId is required");
  }

  const codexDefaults = readCodexDesktopDefaults(runtime.config);
  const threadState =
    resolvedProviderId === "codex"
      ? getCodexThreadStateStore(runtime).getThreadComposerState(resolvedThreadId)
      : null;
  const cwd = String(threadState?.cwd || runtime.config.defaultCwd || "").trim();
  const model = String(threadState?.model || codexDefaults.model || "").trim();
  const reasoningEffort = String(threadState?.reasoningEffort || codexDefaults.reasoningEffort || "medium").trim() || "medium";
  const permissionMode = String(threadState?.permissionMode || codexDefaults.permissionMode || "default").trim() || "default";

  return {
    provider: resolvedProviderId,
    threadId: resolvedThreadId,
    model,
    reasoningEffort,
    permissionMode,
    cwd,
    git: listComposerGitState(workspaceChangesInternals, cwd),
    source: threadState ? "thread_state" : "defaults"
  };
}

export function buildSessionCreatePayloadFromThreadState(body, threadComposerState) {
  return {
    ...threadComposerState,
    ...body,
    cwd: String(body?.cwd || "").trim() || threadComposerState.cwd,
    model: String(body?.model || "").trim() || threadComposerState.model,
    reasoningEffort: String(body?.reasoningEffort || "").trim() || threadComposerState.reasoningEffort,
    permissionMode: String(body?.permissionMode || "").trim() || threadComposerState.permissionMode
  };
}
