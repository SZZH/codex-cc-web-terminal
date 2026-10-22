import { readCodexDesktopDefaults } from "../sessions/shared/codexDesktopConfig.js";
import { CodexThreadStateStore } from "../sessions/state/CodexThreadStateStore.js";
import { normalizeCodexComposerPatch } from "../sessions/shared/composerOptions.js";
import { resolveProviderId } from "../providers/registry.js";
import { readCodexFollowUpQueueMode } from "../sessions/shared/codexFollowUpMode.js";

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

export function getCodexThreadStateStore(runtime) {
  return new CodexThreadStateStore(runtime.config);
}

async function listComposerGitState(workspaceChangesInternals, cwd = "") {
  const normalizedCwd = String(cwd || "").trim();
  if (!normalizedCwd) {
    return emptyGitState("");
  }
  try {
    const payload = await workspaceChangesInternals.listGitBranches(normalizedCwd);
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
      dirty: null,
      code: error?.code,
      error: error?.message || String(error)
    };
  }
}

export async function buildThreadComposerState(runtime, workspaceChangesInternals, providerId, threadId, { includeGit = true } = {}) {
  const normalizedProviderId = resolveProviderId(providerId, "codex");
  const provider = runtime.sessionManager.getProvider?.(normalizedProviderId);
  const resolvedProviderId = provider?.id || normalizedProviderId;
  const resolvedThreadId = String(threadId || "").trim();
  if (!resolvedThreadId) {
    throw new Error("threadId is required");
  }

  const isCodex = resolvedProviderId === "codex";
  const defaults = isCodex ? readCodexDesktopDefaults(runtime.config) : {
    model: (provider || runtime.sessionManager.providerCatalog?.().find((item) => item.id === resolvedProviderId))?.defaultModel || "",
    reasoningEffort: "medium",
    permissionMode: "default"
  };
  const storedState =
    isCodex
      ? getCodexThreadStateStore(runtime).getThreadComposerState(resolvedThreadId)
      : null;
  const liveSession = runtime.sessionManager.findLiveSessionByThreadId?.(resolvedThreadId, { providerId: resolvedProviderId });
  const threadState = storedState || liveSession;
  const cwd = String(threadState?.cwd || runtime.config.defaultCwd || "").trim();
  const model = String(threadState?.model || defaults.model || "").trim();
  let reasoningEffort = String(threadState?.reasoningEffort ?? defaults.reasoningEffort ?? "medium").trim();
  const permissionMode = String(threadState?.permissionMode || defaults.permissionMode || "default").trim() || "default";
  if (isCodex) {
    const models = runtime.sessionManager.providerCatalog?.().find((item) => item.id === resolvedProviderId)?.models || [];
    const modelDefaults = normalizeCodexComposerPatch({ model }, { model: "", reasoningEffort }, models);
    reasoningEffort = modelDefaults.reasoningEffort ?? reasoningEffort;
  }

  const [followUpQueueMode, git] = await Promise.all([
    isCodex ? readCodexFollowUpQueueMode({ config: runtime.config, bridge: runtime.sessionManager.appServerBridge, cwd }) : null,
    includeGit ? listComposerGitState(runtime.workspace || workspaceChangesInternals, cwd) : null
  ]);
  return {
    provider: resolvedProviderId,
    threadId: resolvedThreadId,
    model,
    reasoningEffort,
    permissionMode,
    ...(threadState?.permissionPolicyUnsupported ? { permissionPolicyUnsupported: true } : {}),
    ...(isCodex ? { followUpQueueMode } : {}),
    cwd,
    ...(includeGit ? { git } : {}),
    source: storedState ? "thread_state" : liveSession ? "live_session" : "defaults"
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
