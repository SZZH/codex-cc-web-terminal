import { createComposerSettingsStateController } from "./composer-settings-state.js";
import { buildInputRequest, normalizeComposerSettingsPatch } from "./composer.js";

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
  request,
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
  getActivationToken,
  getModels,
  getCanInterrupt,
  getLoading,
  getGitDirtyErrorMessage
} = {}) {
  const attachmentUploads = new Map();
  let activeGitRead = null;
  let gitReadRevision = 0;
  let gitMutation = null;
  let gitConfirmation = null;
  let composerContextRevision = 0;
  const gitOwnerKey = () => JSON.stringify([getActivationToken?.(), composerContextRevision, getActiveProviderId?.(), getActiveThreadId?.(), getExpectedThreadId?.()]);
  const currentGitMutation = () => gitMutation?.owner === gitOwnerKey() ? gitMutation : null;
  const pendingGitConfirmation = () => gitConfirmation?.owner === gitOwnerKey() ? gitConfirmation : null;
  function invalidateGitReads() {
    activeGitRead = null;
    return ++gitReadRevision;
  }
  function contextKey() {
    return JSON.stringify([getActivationToken?.(), composerContextRevision, getActiveProviderId?.(), getActiveThreadId?.(), getExpectedThreadId?.(), getActiveWorkspaceCwd?.()]);
  }
  function getComposerDefaults() {
    const providerId = String(getActiveProviderId?.() || "codex").trim().toLowerCase() || "codex";
    const provider = state.providerCatalog?.find((item) => String(item?.id || "").trim().toLowerCase() === providerId);
    return createComposerOptions(providerId === "codex" ? state.codexDefaults : { model: String(provider?.defaultModel || "").trim() });
  }
  function resetComposerDraftState({ keepOptions = true } = {}) {
    if (!keepOptions) {
      composerContextRevision += 1;
      settingsState.resetComposerContext();
    }
    composerDraft.value = "";
    composerOptions.value = keepOptions
      ? {
          ...composerOptions.value,
          attachments: []
        }
      : getComposerDefaults();
  }

  function updateComposerOptions(patch = {}) {
    composerOptions.value = {
      ...composerOptions.value,
      ...patch,
      attachments: Array.isArray(patch.attachments) ? patch.attachments : composerOptions.value.attachments
    };
  }

  function assignWorkspaceGitState(patch = {}) {
    workspaceGitState.value = {
      ...workspaceGitState.value,
      ...patch
    };
  }

  function snapshotComposerStatePayload(payload = null) {
    const defaults = getComposerDefaults();
    return {
      model: String(payload?.model ?? defaults.model ?? "").trim(),
      reasoningEffort: String(payload?.reasoningEffort ?? defaults.reasoningEffort ?? "medium").trim(),
      permissionMode: String(payload?.permissionMode || defaults.permissionMode || "default").trim() || "default",
      ...(payload?.permissionPolicyUnsupported ? { permissionPolicyUnsupported: true } : {})
    };
  }

  function applyComposerStatePayload(payload = null) {
    const hasGit = payload?.git && typeof payload.git === "object";
    const git = hasGit ? payload.git : {};
    const cwd = String(payload?.cwd || git.cwd || getActiveWorkspaceCwd?.() || "").trim();
    const blocked = currentGitMutation() || pendingGitConfirmation();
    composerOptions.value = {
      ...composerOptions.value,
      ...snapshotComposerStatePayload(payload),
      gitBranch: hasGit && !blocked ? String(git.currentBranch || "").trim() : composerOptions.value.gitBranch,
      attachments: composerOptions.value.attachments
    };
    if (blocked) {
      assignWorkspaceGitState({ cwd: workspaceGitState.value.cwd || cwd, loading: Boolean(currentGitMutation()) });
    } else if (hasGit) {
      invalidateGitReads();
      workspaceGitState.value = createWorkspaceGitState({ ...git, cwd,
        available: git.available !== false && !git.error && (git.available === true || typeof git.isGitRepo === "boolean" || Boolean(git.currentBranch)),
        ...(git.available === false || git.error ? { dirty: null } : {}), loading: false });
    } else if (cwd) {
      if (workspaceGitState.value.cwd !== cwd) workspaceGitState.value = createWorkspaceGitState({ cwd });
      void refreshWorkspaceGit({ cwd, automatic: true });
    }
  }

  function applyHistoricalComposerValues(session = null, snapshot = null) {
    const model = session?.model ?? snapshot?.metadata?.model;
    const reasoningEffort = String(session?.reasoningEffort || "").trim();
    const permissionMode = String(session?.permissionMode || "").trim();
    const patch = {};
    if (model !== undefined && model !== null) {
      patch.model = String(model).trim();
    }
    if (session && Object.hasOwn(session, "reasoningEffort")) {
      patch.reasoningEffort = reasoningEffort;
    }
    if (permissionMode) {
      patch.permissionMode = permissionMode;
    }
    if (Object.keys(patch).length > 0) {
      updateComposerOptions(normalizeComposerSettingsPatch(patch, composerOptions.value, getModels?.() || []));
    }
  }

  const settingsState = createComposerSettingsStateController({
    state,
    composerOptions,
    updateComposerOptions,
    applyComposerStatePayload,
    snapshotComposerStatePayload,
    patchThreadComposerState,
    requestThreadComposerState,
    getActiveThreadId,
    getExpectedThreadId,
    getActiveProviderId,
    getModels,
    getLoading,
    getCanInterrupt,
    setStatus
  });
  const {
    syncComposerContext,
    persistThreadComposerPatch,
    handleComposerOptionsChange,
    waitForComposerPersistence,
    readComposerStateForThread,
    syncComposerStateForThread
  } = settingsState;

  function refreshWorkspaceGit({ silent = true, cwd: requestedCwd = "", automatic = false, mutation = null } = {}) {
    const writing = currentGitMutation();
    const confirmation = pendingGitConfirmation();
    if (writing && mutation !== writing || automatic && confirmation || mutation && (writing !== mutation || mutation.phase !== "confirming")) return Promise.resolve(false);
    const cwd = String(requestedCwd || getActiveWorkspaceCwd?.() || workspaceGitState.value.cwd || "").trim();
    if (!cwd) {
      workspaceGitState.value = createWorkspaceGitState();
      updateComposerOptions({ gitBranch: "" });
      return Promise.resolve(false);
    }
    assignWorkspaceGitState({ cwd });
    const context = contextKey();
    const key = JSON.stringify([context, cwd, mutation?.id || confirmation?.id || null]);
    if (activeGitRead?.key === key) return activeGitRead.promise;
    const revision = ++gitReadRevision;
    const isCurrent = () => context === contextKey() && revision === gitReadRevision;
    assignWorkspaceGitState({ loading: true, error: "" });
    const task = { key, promise: null };
    activeGitRead = task;
    task.promise = (async () => {
      try {
        const payload = await requestWorkspaceGit(cwd);
        if (!isCurrent()) return false;
        if (typeof payload?.isGitRepo !== "boolean") throw new Error("Invalid workspace Git state");
        if (payload?.available === false || payload?.error) throw new Error(payload.error || "Git state unavailable");
        workspaceGitState.value = createWorkspaceGitState({
          available: true, loading: Boolean(currentGitMutation()), isGitRepo: Boolean(payload?.isGitRepo),
          currentBranch: String(payload?.currentBranch || "").trim(), dirty: Boolean(payload?.dirty),
          branches: Array.isArray(payload?.branches) ? payload.branches : [], error: "",
          cwd: String(payload?.cwd || cwd).trim()
        });
        if (mutation) mutation.context = contextKey();
        if (confirmation && !automatic && pendingGitConfirmation() === confirmation) gitConfirmation = null;
        updateComposerOptions({ gitBranch: workspaceGitState.value.currentBranch });
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        workspaceGitState.value = createWorkspaceGitState({ cwd, available: false, loading: Boolean(currentGitMutation()), dirty: null, error: error?.message || String(error) });
        updateComposerOptions({ gitBranch: "" });
        if (!silent) setStatus(error?.message || String(error));
        return false;
      } finally {
        if (activeGitRead === task) activeGitRead = null;
      }
    })();
    return task.promise;
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

  async function uploadAttachment(target) {
    if (target.uploadedId) return target;
    if (!target.file) {
      const message = "图片文件已不可用，请移除后重新选择图片。";
      setAttachmentState(target.id, { status: "failed", error: message });
      throw new Error(message);
    }
    if (attachmentUploads.has(target.id)) {
      const uploaded = await attachmentUploads.get(target.id);
      // Progress replaces the reactive attachment object. A submission waiting on
      // that upload still owns its earlier snapshot and needs the same receipt.
      Object.assign(target, { status: "uploaded", uploadedId: uploaded.uploadedId, url: uploaded.url, error: "" });
      return target;
    }
    const context = contextKey();
    const task = (async () => {
      const patch = (value) => {
        Object.assign(target, value);
        if (context === contextKey()) setAttachmentState(target.id, value);
      };
      patch({ status: "uploading", error: "" });
      try {
        const payload = await request("/api/attachments/images", {
          method: "POST",
          body: target.file,
          headers: {
            "Content-Type": target.file?.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(target.name)
          }
        });
        if (!payload?.attachment?.id) throw new Error("图片上传未返回附件 ID。");
        patch({ status: "uploaded", uploadedId: payload.attachment.id, url: payload.attachment.url || "" });
        return target;
      } catch (error) {
        patch({ status: "failed", error: error?.message || String(error) });
        throw error;
      }
    })();
    attachmentUploads.set(target.id, task);
    try {
      return await task;
    } finally {
      attachmentUploads.delete(target.id);
    }
  }

  async function uploadImageAttachments(attachments = composerOptions.value.attachments) {
    for (const attachment of attachments) {
      if (attachment.kind === "image") await uploadAttachment(attachment);
    }
    return attachments;
  }

  async function retryAttachment(attachmentId) {
    const target = composerOptions.value.attachments.find((attachment) => attachment.id === attachmentId);
    if (!target || target.kind !== "image") return;
    const context = contextKey();
    try {
      await uploadAttachment(target);
      if (context === contextKey() && composerOptions.value.attachments.some((item) => item.id === attachmentId)) setStatus("");
    } catch (error) {
      if (context === contextKey() && composerOptions.value.attachments.some((item) => item.id === attachmentId)) setStatus(error?.message || String(error));
    }
  }

  function canWriteGit() {
    return !currentGitMutation() && !pendingGitConfirmation() && !getLoading?.() && !getCanInterrupt?.()
      && workspaceGitState.value.available !== false && !workspaceGitState.value.loading && workspaceGitState.value.isGitRepo;
  }

  async function performGitWrite(command, cwd) {
    const operation = { owner: gitOwnerKey(), context: contextKey(), cwd, id: invalidateGitReads(), phase: "writing" };
    gitMutation = operation;
    const isCurrent = () => gitMutation === operation && operation.owner === gitOwnerKey() && operation.context === contextKey();
    assignWorkspaceGitState({ loading: true, available: false, error: "" });
    let writeSucceeded = false;
    try {
      await command();
      writeSucceeded = true;
      if (!isCurrent()) return;
      operation.phase = "confirming";
      invalidateGitReads();
      const refreshed = await refreshWorkspaceGit({ cwd, automatic: true, mutation: operation });
      if (!isCurrent()) return;
      if (!refreshed) throw Object.assign(new Error(workspaceGitState.value.error || "Git state refresh failed"), { executionState: "applied" });
      await persistThreadComposerPatch({ gitBranch: workspaceGitState.value.currentBranch, cwd }, { silent: true });
      if (isCurrent()) setStatus("");
    } catch (error) {
      if (!isCurrent()) return;
      if (!error?.executionState) error = Object.assign(new Error(error?.message || String(error)), { executionState: writeSucceeded ? "applied" : "unknown" });
      gitConfirmation = { owner: operation.owner, id: invalidateGitReads() };
      const dirty = /uncommitted changes/i.test(error?.message || "");
      const message = dirty ? getGitDirtyErrorMessage?.() || error.message : gitWriteErrorMessage(error);
      assignWorkspaceGitState({ loading: false, available: false, dirty: dirty ? true : null, cwd, error: message });
      setStatus(message);
    } finally {
      if (gitMutation === operation) {
        const owned = operation.owner === gitOwnerKey();
        const current = isCurrent();
        gitMutation = null;
        if (owned) {
          const revision = invalidateGitReads();
          if (!current) {
            gitConfirmation = { owner: operation.owner, id: revision };
            const message = "工作区目录已变化，请刷新确认 Git 状态";
            assignWorkspaceGitState({ available: false, dirty: null, error: message,
              cwd: getActiveWorkspaceCwd?.() || workspaceGitState.value.cwd || cwd });
            setStatus(message);
          }
          assignWorkspaceGitState({ loading: false });
        }
      }
    }
  }

  async function switchGitBranch(branchName) {
    const cwd = getActiveWorkspaceCwd?.();
    const branch = String(branchName || "").trim();
    if (!cwd || !branch || branch === workspaceGitState.value.currentBranch || !canWriteGit()) return;
    if (workspaceGitState.value.dirty) {
      setStatus(getGitDirtyErrorMessage?.() || "");
      return;
    }
    return performGitWrite(() => requestWorkspaceGitCheckout(cwd, branch), cwd);
  }

  async function createGitBranch(branchName) {
    const cwd = getActiveWorkspaceCwd?.();
    let branch = String(branchName || "").trim();
    if (!branch && typeof window !== "undefined") branch = String(window.prompt("输入新的 Git 分支名", "") || "").trim();
    const validationMessage = validateGitBranchName(branch);
    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }
    if (!cwd || !canWriteGit()) return;
    return performGitWrite(() => requestWorkspaceGitBranchCreate(cwd, branch), cwd);
  }

  function gitWriteErrorMessage(error) {
    const message = error?.message || String(error);
    if (error?.executionState === "applied") return "操作已完成，状态刷新失败，请刷新确认：" + message;
    if (error?.executionState === "unknown") return "执行状态待确认，请刷新工作区后再操作：" + message;
    return message;
  }

  return {
    resetComposerDraftState,
    updateComposerOptions,
    handleComposerOptionsChange,
    syncComposerContext,
    waitForComposerPersistence,
    applyComposerStatePayload,
    applyHistoricalComposerValues,
    readComposerStateForThread,
    syncComposerStateForThread,
    refreshWorkspaceGit,
    addAttachments,
    removeAttachment,
    retryAttachment,
    uploadImageAttachments,
    switchGitBranch,
    createGitBranch,
    persistThreadComposerPatch
  };
}

export function createComposerSubmissionController({
  state,
  composerDraft,
  composerOptions,
  getContext,
  isContextCurrent,
  getCanSend,
  waitForComposerPersistence,
  uploadImageAttachments,
  ensureLiveSession,
  attachLiveSocket,
  requestSessionInput,
  requestThreadInput,
  applyInputResponse,
  createUserMessage,
  setMessages,
  finalizeAssistantStream,
  setStatus,
  syncActiveThreadSession,
  startHistorySyncLoop
} = {}) {
  async function submitInput() {
    const context = getContext();
    const isCurrent = () => isContextCurrent(context);
    let optimisticMessage = null;
    let fingerprint = "";
    let draft = "";
    let attachments = [];
    let ownsLoading = false;
    try {
      if (!await waitForComposerPersistence() || !isCurrent() || !getCanSend() || state.loading) return;
      draft = String(composerDraft.value || "");
      attachments = [...composerOptions.value.attachments];
      const text = draft.trim() ? draft : "";
      fingerprint = JSON.stringify({ activation: context.activation, provider: context.provider, threadId: context.expectedThreadId || context.threadId || context.liveSessionId,
        text, attachments: attachments.filter((item) => item.kind === "image").map((item) => item.id) });
      if (fingerprint === state.lastSubmitText && Date.now() - Number(state.lastSubmitAt || 0) < 2500) return;
      state.loading = true;
      ownsLoading = true;
      setStatus("正在发送…");
      await uploadImageAttachments(attachments);
      if (!isCurrent()) return;
      const requestBody = buildInputRequest({ text, composerOptions: { ...composerOptions.value, attachments } });
      if (!text && !requestBody.attachments.length) return;
      if (context.expectedThreadId && context.threadId && context.expectedThreadId !== context.threadId) {
        throw new Error("会话线程不一致，请返回列表后重新打开该会话。");
      }
      const liveSessionId = await ensureLiveSession();
      if (!isCurrent()) return;
      if (!state.liveView.socket || Number(state.liveView.socket.readyState) > 1 || state.liveView.liveSessionId !== liveSessionId) {
        await attachLiveSocket(liveSessionId);
      }
      if (!isCurrent()) return;
      const current = getContext();
      const targetThreadId = current.expectedThreadId || current.threadId || state.liveView.sessionMeta?.resumeSessionId || "";
      optimisticMessage = text ? createUserMessage(text) : null;
      if (optimisticMessage) setMessages([...state.liveView.messages, optimisticMessage]);
      finalizeAssistantStream();
      state.liveView.activeInputStream = true;
      state.lastSubmitText = fingerprint;
      state.lastSubmitAt = Date.now();
      setStatus("等待 Codex 回复…");
      const payload = targetThreadId
        ? await requestThreadInput(current.provider, targetThreadId, requestBody)
        : await requestSessionInput(liveSessionId, requestBody);
      if (!isCurrent()) return;
      applyInputResponse(payload);
      const responseSessionId = String(payload?.session?.id || liveSessionId).trim();
      if (composerDraft.value === draft) composerDraft.value = "";
      composerOptions.value = {
        ...composerOptions.value,
        attachments: composerOptions.value.attachments.filter((item) => !attachments.some((submitted) => submitted.id === item.id))
      };
      if (responseSessionId !== liveSessionId) {
        try {
          await attachLiveSocket(responseSessionId);
        } catch (error) {
          if (isCurrent()) setStatus(`消息已发送，实时连接失败：${error?.message || String(error)}`);
        }
      }
      return payload;
    } catch (error) {
      if (!isCurrent()) return;
      if (ownsLoading) state.liveView.activeInputStream = false;
      if (state.lastSubmitText === fingerprint) state.lastSubmitText = "";
      if (optimisticMessage) setMessages(state.liveView.messages.filter((message) => message.id !== optimisticMessage.id));
      setStatus(error?.message || String(error));
    } finally {
      if (ownsLoading && isCurrent()) {
        state.loading = false;
        await syncActiveThreadSession({ silent: true }).catch(() => {});
        if (isCurrent()) startHistorySyncLoop();
      }
    }
  }

  async function interruptActiveSession() {
    const context = getContext();
    if (!(context.liveSessionId || context.expectedThreadId || context.threadId) || state.liveView.interruptInFlight) return;
    state.liveView.interruptInFlight = true;
    setStatus("已发送中断指令。");
    try {
      const body = { type: "interrupt", reason: "user_interrupt" };
      const threadId = context.expectedThreadId || context.threadId;
      if (threadId) await requestThreadInput(context.provider, threadId, body);
      else await requestSessionInput(context.liveSessionId, body);
      if (isContextCurrent(context)) {
        state.liveView.activeInputStream = false;
        setStatus("当前流程已中断。");
        await syncActiveThreadSession({ silent: true }).catch(() => {});
      }
    } catch (error) {
      if (isContextCurrent(context)) setStatus(error?.message || String(error));
    } finally {
      if (isContextCurrent(context)) state.liveView.interruptInFlight = false;
    }
  }

  return { submitInput, interruptActiveSession };
}
