import { normalizeComposerSettingsPatch } from "./composer.js";

const SETTINGS_FIELDS = ["model", "reasoningEffort", "permissionMode", "gitBranch"];

function settingsSnapshot(options = {}) {
  return Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, options[field]]));
}

export function createComposerSettingsStateController({
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
  getModels = () => [],
  getLoading,
  getCanInterrupt,
  setStatus
}) {
  const threads = new Map();
  let activeContext = { key: "", generation: 0 };

  function getRecoveryRead(thread, context) {
    const read = thread?.activeRead;
    return thread?.error && read && !read.finished &&
      read.context.generation === context.generation &&
      read.revision < thread.revision && thread.lastSuccessfulWriteRevision <= read.revision
      ? read
      : null;
  }

  function syncComposerContext() {
    const provider = String(getActiveProviderId?.() || "codex").trim().toLowerCase() || "codex";
    const threadId = String(getActiveThreadId?.() || getExpectedThreadId?.() || "").trim();
    const key = `${provider}:${threadId}`;
    if (activeContext.key !== key) {
      activeContext = { key, provider, threadId, generation: activeContext.generation + 1 };
    }
    const thread = threads.get(key);
    state.composerSaving = Boolean(thread?.pending || getRecoveryRead(thread, activeContext));
    return activeContext;
  }

  function resetComposerContext() {
    syncComposerContext();
    activeContext = { ...activeContext, generation: activeContext.generation + 1 };
  }

  function isCurrent(context) {
    const current = syncComposerContext();
    return context.key === current.key && context.generation === current.generation;
  }

  function getThread(context) {
    if (!threads.has(context.key)) {
      threads.set(context.key, {
        tail: Promise.resolve(),
        pending: 0,
        revision: 0,
        lastSuccessfulWriteRevision: 0,
        readRevision: 0,
        activeRead: null,
        fieldRevisions: {},
        confirmed: settingsSnapshot(composerOptions.value),
        error: null
      });
    }
    return threads.get(context.key);
  }

  function canReportStatus(context) {
    return isCurrent(context) && !getLoading?.() && !getCanInterrupt?.();
  }

  function clearOwnError(context, thread) {
    if (thread.error && state.statusText === thread.error.message && canReportStatus(context)) {
      setStatus("");
    }
    thread.error = null;
  }

  function confirmPayload(thread, payload) {
    thread.confirmed = {
      model: snapshotComposerStatePayload(payload).model,
      reasoningEffort: String(payload?.reasoningEffort ?? state.codexDefaults.reasoningEffort ?? "medium").trim(),
      permissionMode: String(payload?.permissionMode ?? state.codexDefaults.permissionMode ?? "default").trim(),
      gitBranch: String(payload?.git?.currentBranch ?? payload?.gitBranch ?? composerOptions.value.gitBranch ?? "").trim()
    };
  }

  function persistThreadComposerPatch(patch = {}, { silent = true, optimistic = false } = {}) {
    const context = syncComposerContext();
    const persistable = Boolean(context.threadId && context.provider === "codex");
    const thread = persistable ? getThread(context) : null;
    const nextPatch = normalizeComposerSettingsPatch(patch, composerOptions.value, getModels());
    if (thread && !thread.pending) {
      thread.confirmed = settingsSnapshot(composerOptions.value);
    }
    if (optimistic) {
      updateComposerOptions(nextPatch);
    }
    if (!thread) {
      return Promise.resolve(null);
    }

    clearOwnError(context, thread);
    const revision = ++thread.revision;
    for (const field of SETTINGS_FIELDS) {
      if (Object.hasOwn(nextPatch, field)) {
        thread.fieldRevisions[field] = revision;
      }
    }
    thread.pending += 1;
    syncComposerContext();

    // Keep each thread's writes ordered while later choices remain visible.
    const operation = thread.tail.then(async () => {
      try {
        const payload = await patchThreadComposerState(context.provider, context.threadId, nextPatch);
        thread.lastSuccessfulWriteRevision = revision;
        confirmPayload(thread, payload);
        if (isCurrent(context) && thread.revision === revision) {
          applyComposerStatePayload(payload);
        }
        clearOwnError(context, thread);
        return payload;
      } catch (error) {
        thread.error = error;
        if (optimistic && isCurrent(context)) {
          const rollback = {};
          for (const field of SETTINGS_FIELDS) {
            if (Object.hasOwn(nextPatch, field) && thread.fieldRevisions[field] === revision) {
              rollback[field] = thread.confirmed[field];
            }
          }
          updateComposerOptions(rollback);
        }
        if (!silent && canReportStatus(context)) {
          setStatus(error?.message || String(error));
        }
        throw error;
      } finally {
        thread.pending -= 1;
        syncComposerContext();
      }
    });
    thread.tail = operation.catch(() => null);
    return operation;
  }

  async function handleComposerOptionsChange(patch = {}) {
    const nextPatch = { ...patch };
    delete nextPatch.attachments;
    if (!Object.keys(nextPatch).length) {
      updateComposerOptions(patch);
      return true;
    }
    if (getLoading?.() || getCanInterrupt?.()) {
      return false;
    }
    try {
      await persistThreadComposerPatch(nextPatch, { silent: false, optimistic: true });
      return true;
    } catch {
      return false;
    }
  }

  async function waitForThreadWrites(context, thread) {
    let tail;
    do {
      tail = thread.tail;
      await tail;
      if (!isCurrent(context)) {
        return false;
      }
    } while (tail !== thread.tail);
    return true;
  }

  async function waitForComposerPersistence() {
    const context = syncComposerContext();
    const thread = threads.get(context.key);
    if (!thread?.pending && !getRecoveryRead(thread, context)) {
      return true;
    }
    let tail;
    do {
      if (!await waitForThreadWrites(context, thread)) {
        return false;
      }
      tail = thread.tail;
      const recoveryRead = getRecoveryRead(thread, context);
      if (recoveryRead) {
        await recoveryRead.promise;
        if (!isCurrent(context)) {
          return false;
        }
      }
    } while (tail !== thread.tail);
    if (thread.error) {
      throw thread.error;
    }
    return true;
  }

  async function readComposerStateForThread(provider, threadId, { silent = true } = {}) {
    const context = syncComposerContext();
    const resolvedProvider = String(provider || "codex").trim().toLowerCase() || "codex";
    const resolvedThreadId = String(threadId || "").trim();
    let readRevision = 0;
    const result = (status, details = {}) => ({ status, provider: resolvedProvider, threadId: resolvedThreadId,
      contextGeneration: context.generation, readRevision, snapshot: null, ...details });
    if (!resolvedThreadId) {
      return result("failed");
    }
    if (context.key !== `${resolvedProvider}:${resolvedThreadId}`) {
      return result("stale");
    }
    const thread = getThread(context);
    await waitForThreadWrites(context, thread);
    if (!isCurrent(context)) {
      return result("stale");
    }
    const revision = thread.revision;
    readRevision = ++thread.readRevision;
    const isCurrentRead = () => isCurrent(context) && thread.readRevision === readRevision;
    const read = { context, revision, finished: false, promise: null };
    thread.activeRead = read;
    read.promise = (async () => {
      try {
        const payload = await requestThreadComposerState(resolvedProvider, resolvedThreadId);
        const snapshot = snapshotComposerStatePayload(payload);
        if (isCurrentRead() && thread.lastSuccessfulWriteRevision <= revision) {
          confirmPayload(thread, payload);
        }
        // A failed optimistic write must roll back to the loaded thread, even if the read finished first.
        await waitForThreadWrites(context, thread);
        if (!isCurrentRead()) return result("stale");
        const applied = thread.lastSuccessfulWriteRevision <= revision && !thread.pending;
        if (applied) {
          applyComposerStatePayload(payload);
        }
        // A newer PATCH owns the visible options, while this server snapshot still owns the read baseline.
        return result(applied ? "applied" : "preserved", { snapshot });
      } catch (error) {
        if (!isCurrent(context) || thread.revision !== revision || thread.readRevision !== readRevision || thread.pending) {
          return result("stale");
        }
        if (!silent && canReportStatus(context)) {
          setStatus(error?.message || String(error));
        }
        return result("failed", { error });
      } finally {
        read.finished = true;
        syncComposerContext();
      }
    })();
    return read.promise;
  }

  async function syncComposerStateForThread(...args) {
    return (await readComposerStateForThread(...args)).status !== "failed";
  }

  return {
    syncComposerContext,
    resetComposerContext,
    persistThreadComposerPatch,
    handleComposerOptionsChange,
    waitForComposerPersistence,
    readComposerStateForThread,
    syncComposerStateForThread
  };
}
