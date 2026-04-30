export function createComposerRuntimeController({
  state,
  composerDraft,
  composerOptions,
  workspaceGitState,
  patchThreadComposerState,
  requestThreadComposerState,
  requestWorkspaceGit,
  requestWorkspaceGitCheckout,
  requestWorkspaceGitBranchCreate,
  wait,
  setStatus,
  createComposerOptions,
  createWorkspaceGitState,
  collectAttachmentLimitError,
  createAttachmentRecord,
  hasOnlyFileAttachments,
  validateGitBranchName,
  getActiveThreadId,
  getExpectedThreadId,
  getActiveProviderId,
  getActiveWorkspaceCwd,
  getCanInterrupt,
  getLoading,
  getGitDirtyErrorMessage
} = {}) {
  function resetComposerDraftState({ keepOptions = true } = {}) {
    composerDraft.value = "";
    composerOptions.value = keepOptions
      ? {
          ...composerOptions.value,
          attachments: []
        }
      : createComposerOptions(state.codexDefaults);
  }

  function updateComposerOptions(patch = {}) {
    composerOptions.value = {
      ...composerOptions.value,
      ...patch,
      attachments: Array.isArray(patch.attachments) ? patch.attachments : composerOptions.value.attachments
    };
  }

  async function persistThreadComposerPatch(patch = {}, { silent = true } = {}) {
    const threadId = String(getActiveThreadId?.() || getExpectedThreadId?.() || "").trim();
    const providerId = String(getActiveProviderId?.() || "codex").trim().toLowerCase() || "codex";
    if (!threadId || providerId !== "codex") {
      return null;
    }
    try {
      const payload = await patchThreadComposerState(providerId, threadId, patch);
      applyComposerStatePayload(payload);
      return payload;
    } catch (error) {
      if (!silent) {
        setStatus(error?.message || String(error));
      }
      throw error;
    }
  }

  async function handleComposerOptionsChange(patch = {}) {
    const nextPatch = { ...patch };
    delete nextPatch.attachments;
    if (!Object.keys(nextPatch).length) {
      updateComposerOptions(patch);
      return;
    }

    const previous = {
      model: composerOptions.value.model,
      reasoningEffort: composerOptions.value.reasoningEffort,
      permissionMode: composerOptions.value.permissionMode,
      gitBranch: composerOptions.value.gitBranch
    };

    updateComposerOptions(nextPatch);
    try {
      await persistThreadComposerPatch(nextPatch, { silent: false });
      setStatus("");
    } catch {
      updateComposerOptions(previous);
    }
  }

  function assignWorkspaceGitState(patch = {}) {
    workspaceGitState.value = {
      ...workspaceGitState.value,
      ...patch
    };
  }

  function applyComposerStatePayload(payload = null) {
    const git = payload?.git || {};
    composerOptions.value = {
      ...composerOptions.value,
      model: String(payload?.model || state.codexDefaults.model || "").trim(),
      reasoningEffort: String(payload?.reasoningEffort || state.codexDefaults.reasoningEffort || "medium").trim() || "medium",
      permissionMode: String(payload?.permissionMode || state.codexDefaults.permissionMode || "default").trim() || "default",
      gitBranch: String(git?.currentBranch || "").trim(),
      attachments: composerOptions.value.attachments
    };
    workspaceGitState.value = createWorkspaceGitState({
      ...git,
      available: Boolean(git && Object.keys(git).length),
      loading: false
    });
  }

  function applyHistoricalComposerValues(session = null, snapshot = null) {
    const model = String(session?.model || snapshot?.metadata?.model || "").trim();
    const reasoningEffort = String(session?.reasoningEffort || "").trim();
    const permissionMode = String(session?.permissionMode || "").trim();
    const patch = {};
    if (model) {
      patch.model = model;
    }
    if (reasoningEffort) {
      patch.reasoningEffort = reasoningEffort;
    }
    if (permissionMode) {
      patch.permissionMode = permissionMode;
    }
    if (Object.keys(patch).length > 0) {
      updateComposerOptions(patch);
    }
  }

  async function syncComposerStateForThread(provider, threadId, { silent = true } = {}) {
    const resolvedProvider = String(provider || "codex").trim().toLowerCase() || "codex";
    const resolvedThreadId = String(threadId || "").trim();
    if (!resolvedThreadId) {
      return false;
    }
    try {
      const payload = await requestThreadComposerState(resolvedProvider, resolvedThreadId);
      applyComposerStatePayload(payload);
      return true;
    } catch (error) {
      if (!silent) {
        setStatus(error?.message || String(error));
      }
      return false;
    }
  }

  async function refreshWorkspaceGit({ silent = true } = {}) {
    const cwd = getActiveWorkspaceCwd?.();
    if (!cwd) {
      workspaceGitState.value = createWorkspaceGitState();
      updateComposerOptions({ gitBranch: "" });
      return;
    }

    assignWorkspaceGitState({ loading: true, error: "" });
    try {
      const payload = await requestWorkspaceGit(cwd);
      workspaceGitState.value = createWorkspaceGitState({
        available: true,
        loading: false,
        isGitRepo: Boolean(payload?.isGitRepo),
        currentBranch: String(payload?.currentBranch || "").trim(),
        dirty: Boolean(payload?.dirty),
        branches: Array.isArray(payload?.branches) ? payload.branches : [],
        error: "",
        cwd: String(payload?.cwd || cwd).trim()
      });
      updateComposerOptions({ gitBranch: workspaceGitState.value.currentBranch });
    } catch (error) {
      workspaceGitState.value = createWorkspaceGitState({
        available: false,
        loading: false,
        error: error?.message || String(error)
      });
      updateComposerOptions({ gitBranch: "" });
      if (!silent) {
        setStatus(error?.message || String(error));
      }
    }
  }

  function setAttachmentState(attachmentId, patch = {}) {
    const nextAttachments = [...composerOptions.value.attachments];
    const index = nextAttachments.findIndex((attachment) => attachment.id === attachmentId);
    if (index < 0) {
      return;
    }
    nextAttachments[index] = {
      ...nextAttachments[index],
      ...patch
    };
    updateComposerOptions({ attachments: nextAttachments });
  }

  function addAttachments({ files = [], kindHint = "", source = "" } = {}) {
    let nextAttachments = [...composerOptions.value.attachments];
    let nonSendableFilesAdded = false;
    let statusMessage = "";

    for (const file of files) {
      const nextAttachment = createAttachmentRecord(file, { kindHint, source });
      const errorMessage = collectAttachmentLimitError(nextAttachments, nextAttachment);
      if (errorMessage) {
        statusMessage = errorMessage;
        continue;
      }
      if (nextAttachment.kind === "file") {
        nonSendableFilesAdded = true;
      }
      nextAttachments.push(nextAttachment);
    }

    updateComposerOptions({ attachments: nextAttachments });
    if (statusMessage) {
      setStatus(statusMessage);
      return;
    }
    if (nonSendableFilesAdded && !String(composerDraft.value || "").trim()) {
      setStatus("当前版本文件附件仅保存选择状态，暂不随消息发送。");
    }
  }

  function removeAttachment(attachmentId) {
    updateComposerOptions({
      attachments: composerOptions.value.attachments.filter((attachment) => attachment.id !== attachmentId)
    });
  }

  async function retryAttachment(attachmentId) {
    const target = composerOptions.value.attachments.find((attachment) => attachment.id === attachmentId);
    if (!target) {
      return;
    }
    setAttachmentState(attachmentId, {
      status: "uploading",
      error: ""
    });
    await wait(120);
    setAttachmentState(attachmentId, {
      status: "failed",
      error: "附件上传接口待后端接入"
    });
    setStatus(`${target.name} 的上传接口待后端接入，当前先保留失败态占位。`);
  }

  async function switchGitBranch(branchName) {
    const cwd = getActiveWorkspaceCwd?.();
    const branch = String(branchName || "").trim();
    if (!cwd || !branch || branch === workspaceGitState.value.currentBranch) {
      return;
    }
    if (getLoading?.() || getCanInterrupt?.()) {
      return;
    }
    if (workspaceGitState.value.dirty) {
      setStatus(getGitDirtyErrorMessage?.() || "");
      return;
    }

    assignWorkspaceGitState({ loading: true, error: "" });
    try {
      await requestWorkspaceGitCheckout(cwd, branch);
      await refreshWorkspaceGit();
      await persistThreadComposerPatch(
        {
          gitBranch: workspaceGitState.value.currentBranch,
          cwd
        },
        { silent: true }
      );
      setStatus("");
    } catch (error) {
      const message = String(error?.message || error || "").trim();
      if (/uncommitted changes/i.test(message)) {
        const dirtyMessage = getGitDirtyErrorMessage?.() || message;
        setStatus(dirtyMessage);
        assignWorkspaceGitState({ loading: false, error: dirtyMessage });
        return;
      }
      assignWorkspaceGitState({ loading: false, error: message });
      setStatus(message);
    }
  }

  async function createGitBranch(branchName) {
    const cwd = getActiveWorkspaceCwd?.();
    let branch = String(branchName || "").trim();
    if (!branch && typeof window !== "undefined") {
      branch = String(window.prompt("输入新的 Git 分支名", "") || "").trim();
    }
    const validationMessage = validateGitBranchName(branch);
    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }
    if (!cwd || getLoading?.() || getCanInterrupt?.()) {
      return;
    }

    assignWorkspaceGitState({ loading: true, error: "" });
    try {
      await requestWorkspaceGitBranchCreate(cwd, branch);
      await refreshWorkspaceGit();
      await persistThreadComposerPatch(
        {
          gitBranch: workspaceGitState.value.currentBranch,
          cwd
        },
        { silent: true }
      );
      setStatus("");
    } catch (error) {
      const message = error?.message || String(error);
      assignWorkspaceGitState({ loading: false, error: message });
      setStatus(message);
    }
  }

  return {
    resetComposerDraftState,
    updateComposerOptions,
    handleComposerOptionsChange,
    applyComposerStatePayload,
    applyHistoricalComposerValues,
    syncComposerStateForThread,
    refreshWorkspaceGit,
    addAttachments,
    removeAttachment,
    retryAttachment,
    switchGitBranch,
    createGitBranch,
    persistThreadComposerPatch
  };
}
