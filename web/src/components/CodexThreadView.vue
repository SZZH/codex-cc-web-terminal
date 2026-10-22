<script setup>
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import ChatView from "./ChatView.vue";
import InterfaceState from "./InterfaceState.js";
import CodexSubmissionFeedback from "./composer/CodexSubmissionFeedback.vue";
import CodexQueuedMessages from "./composer/CodexQueuedMessages.vue";
import CodexInteractionPanel from "./composer/interactions/CodexInteractionPanel.vue";
import { request, supportsInitialHistory, recheckInitialHistorySupport, patchThreadComposerState, requestThreadComposerState, requestWorkspaceGit,
  requestWorkspaceGitCheckout, requestWorkspaceGitBranchCreate } from "../lib/api.js";
import { createCodexComposerPreferences } from "../lib/codex-composer-preferences.js";
import { createComposerRuntimeController } from "../lib/composer-runtime.js";
import { createComposerOptions, createWorkspaceGitState, collectAttachmentLimitError,
  createAttachmentRecord, hasOnlyFileAttachments, validateGitBranchName,
  canSendComposerMessage, getProviderModelOptions, CODEX_PERMISSION_MODE_OPTIONS } from "../lib/composer.js";
import { activeCodexTurnId, createCodexChatStore, isCodexTerminal, isCodexRequestDismissedMissing } from "../lib/codex-chat-store.js";
import { createCodexChatRuntime } from "../lib/codex-chat-runtime.js";
import { codexRequestLabel, codexRequestError, codexSubmissionFeedbackRequest, createCodexChatPresenter, presentCodexQueue } from "../lib/codex-chat-presentation.js";
import { createThreadViewModelBuilder } from "../lib/thread-view-model.js";
import { buildQuestionAnswer } from "../lib/codex-question-history.js";

const props = defineProps({ threadId: { type: String, required: true }, initialTitle: { type: String, default: "" }, initialCwd: { type: String, default: "" }, loadConfig: { type: Function, default: () => request("/api/config") } });
const emit = defineEmits(["back", "status"]);
const active = shallowRef(null);
const state = computed(() => active.value?.store.state);
const composerOptions = computed(() => active.value?.options.value || createComposerOptions());
const models = computed(() => active.value?.models.value || []);
const gitState = computed(() => active.value?.git.value || createWorkspaceGitState());
const snapshot = computed(() => state.value ? active.value.presentSnapshot(state.value) : null);
const queuedMessages = computed(() => state.value ? presentCodexQueue(state.value) : []);
const pendingSettings = computed(() => {
  const context = active.value;
  if (!context?.initialOptions.value) return false;
  const baseline = context.executionOptions.value || context.initialOptions.value;
  const selected = composerOptions.value;
  const preferences = context.preferences?.snapshot() || {};
  return Boolean(baseline.permissionPolicyUnsupported && Object.hasOwn(preferences, "permissionMode")) ||
    Object.keys(preferences).some((key) => selected[key] !== baseline[key]);
});
const receipts = computed(() => (state.value?.requestOrder || []).map((id) => state.value.requests[id])
  .filter((receipt) => receipt.state !== "completed"));
const unconfirmed = computed(() => receipts.value.some((receipt) => receipt.state === "unknown" && !isCodexRequestDismissedMissing(receipt)));
const submissionRequest = computed(() => codexSubmissionFeedbackRequest(state.value, active.value?.lastSubmittedRequestId.value));
const submissionPending = computed(() => Boolean(active.value?.preparing.value || state.value?.submitting));
const submissionInQueue = computed(() => queuedMessages.value.some((message) => message.id === submissionRequest.value?.id));
const submissionBusy = computed(() => Boolean(active.value?.actions[`dismiss:${submissionRequest.value?.id}`] ||
  active.value?.actions[`restore:${submissionRequest.value?.id}`]));
const canInterrupt = computed(() => Boolean(active.value?.running.value ||
  state.value && activeCodexTurnId(state.value) && state.value.thread?.capabilities?.desktopInterrupt));
const runningTask = computed(() => Boolean(state.value && activeCodexTurnId(state.value)));
const loading = computed(() => Boolean(active.value?.preparing.value || active.value?.initializing.value || state.value?.submitting));
const canSubmit = computed(() => !loading.value && Boolean(active.value?.initialOptions.value) && Boolean(state.value?.requestListReady) && !unconfirmed.value && !active.value?.optionError.value);
const canAnswerQuestions = computed(() => canSubmit.value &&
  (active.value?.running.value || state.value?.thread?.capabilities?.desktopQuestionAnswers === true));
const canSend = computed(() => canSubmit.value &&
  canSendComposerMessage(state.value?.draft.text, composerOptions.value.attachments));
const statusText = computed(() => state.value?.persistenceError || active.value?.optionError.value || state.value?.requestListError ||
  (state.value?.errorOwner === "older" && active.value?.olderError.value ? "" : state.value?.error) || state.value?.historyReadError ||
  state.value?.thread?.syncError || active.value?.notice.value || active.value?.configError.value || (state.value?.connection === "offline" ? "实时连接恢复中，消息与发送状态会自动同步。" : ""));
const canRetryReads = computed(() => Boolean(state.value?.historyReadError || state.value?.requestListError ||
  active.value?.optionError.value || active.value?.configError.value));
const displayModel = computed(() => active.value?.buildDisplayModel(snapshot.value || {}, { assistantName: "Codex" }) || { turns: [] });
const hasDisplayItems = computed(() => displayModel.value.turns.some((turn) =>
  turn.segments.some((segment) => (segment.visibleItems || segment.items || []).length)));
const pendingInitialTurns = computed(() => hasDisplayItems.value ? [] : Object.values(state.value?.turns || {})
  .filter((turn) => turn.itemsLatestRequested && !turn.itemsLatestLoaded));
const initialHistoryError = computed(() => state.value?.historyReadError || pendingInitialTurns.value.find((turn) => turn.itemsError)?.itemsError || "");
const initialHistoryLoading = computed(() => !state.value?.initialized || pendingInitialTurns.value.length > 0);
const visibleDetailItems = computed(() => displayModel.value.turns.flatMap((turn) => turn.segments.flatMap((segment) => {
  const expanded = active.value?.expandedProcesses[segment.id] ?? active.value?.expandedProcesses[turn.id] ?? !segment.defaultCollapsed;
  return segment.kind === "process" && !expanded ? [] : (segment.visibleItems || segment.items).map((item) => ({ turnId: turn.id, itemId: item.id }));
})));
watch(visibleDetailItems, (items) => active.value?.runtime.setDetailVisibility(items), { flush: "post" });

function notify(context, message) {
  if (context.disposed) return;
  context.notice.value = String(message || "");
  if (active.value === context) emit("status", context.notice.value);
}

function createContext(threadId) {
  let storage = null;
  try { storage = window.localStorage; } catch { /* The store reports storage failures before sending. */ }
  const store = createCodexChatStore(threadId, { storage, reactive });
  const context = { store, options: ref(createComposerOptions({ attachments: store.state.draft.attachments })),
    presentSnapshot: createCodexChatPresenter(), buildDisplayModel: createThreadViewModelBuilder(),
    git: ref(createWorkspaceGitState()), models: ref([]), notice: ref(""), preparing: ref(false),
    initializing: ref(true), optionError: ref(""), configError: ref(""), olderError: ref(""), actions: reactive({}), expandedProcesses: reactive({}),
    initialOptions: ref(null), executionOptions: ref(null), executionRevision: 0, followUpMode: ref("steer"), lastSubmittedRequestId: ref(""), disposed: false };
  const settings = reactive({ codexDefaults: {}, composerSaving: false });
  const appliedSettings = new Set();
  context.stopSettings = watch(() => store.state.requestOrder.map((id) => store.state.requests[id]), (receipts) => {
    for (const receipt of receipts) {
      if (appliedSettings.has(receipt.id) || !receipt.turnId || !Object.keys(receipt.options || {}).length ||
        !["accepted", "running", "completed", "failed", "interrupted"].includes(receipt.state)) continue;
      appliedSettings.add(receipt.id);
      context.executionRevision += 1;
      context.executionOptions.value = { ...context.executionOptions.value, ...receipt.options,
        ...(receipt.options.permissionMode ? { permissionPolicyUnsupported: false } : {}) };
    }
  }, { immediate: true });
  let optionFailureRevision = 0;
  let optionReadRevision = 0;
  let configReadRevision = 0;
  let followUpReadRevision = 0;
  let configFollowUpMode = "steer", composerHasFollowUpMode = false;
  context.running = computed(() => {
    const turnId = activeCodexTurnId(store.state);
    return Boolean(turnId && ["inProgress", "running"].includes(store.state.turns[turnId]?.status) &&
      store.state.requestOrder.some((id) => {
        const receipt = store.state.requests[id];
        return !["desktopQueue", "desktopQuestion", "desktopSettings"].includes(receipt?.executionRoute) && ["accepted", "running"].includes(receipt?.state) && receipt.turnId === turnId;
      }));
  });
  context.runtime = createCodexChatRuntime({ store, request, createSocket: (url) => new WebSocket(url),
    supportsInitialHistory, checkInitialHistorySupport: recheckInitialHistorySupport,
    onForeground: () => { void context.readOptions().catch((error) => notify(context, error.message)); } });
  context.updateTurnVisibility = ({ turnId, visible }) => {
    if (!context.disposed) return context.runtime.setTurnVisibility(turnId, visible);
  };
  context.readOlder = async () => {
    if (context.disposed || context.actions.older || !context.runtime.hasOlderHistory()) return false;
    context.actions.older = true; context.olderError.value = "";
    try {
      const succeeded = await context.runtime.loadOlder();
      if (context.disposed) return false;
      if (!succeeded) context.olderError.value = store.state.errorOwner === "older" && store.state.error || "更早消息暂时无法读取，请重试。";
      return succeeded;
    } finally { context.actions.older = false; }
  };
  context.composer = createComposerRuntimeController({
    state: settings, composerDraft: computed({ get: () => store.state.draft.text, set: (text) => store.setDraft({ text }) }),
    composerOptions: context.options, workspaceGitState: context.git,
    patchThreadComposerState: async (...args) => {
      try { return await patchThreadComposerState(...args); }
      catch (error) { optionFailureRevision += 1; context.optionError.value = error.message; throw error; }
    }, requestThreadComposerState: async (provider, requestedThreadId) => {
      const readRevision = ++followUpReadRevision;
      const payload = await requestThreadComposerState(provider, requestedThreadId);
      if (!context.disposed && requestedThreadId === threadId && readRevision === followUpReadRevision) {
        composerHasFollowUpMode = ["queue", "steer"].includes(payload?.followUpQueueMode);
        context.followUpMode.value = composerHasFollowUpMode ? payload.followUpQueueMode : configFollowUpMode;
      }
      return payload;
    }, requestWorkspaceGit,
    requestWorkspaceGitCheckout, requestWorkspaceGitBranchCreate, request,
    setStatus: (message) => notify(context, message), createComposerOptions, createWorkspaceGitState,
    collectAttachmentLimitError, createAttachmentRecord, hasOnlyFileAttachments, validateGitBranchName,
    getActiveThreadId: () => threadId, getExpectedThreadId: () => threadId,
    getActiveProviderId: () => "codex", getActiveWorkspaceCwd: () => store.state.thread?.cwd || context.git.value.cwd || "",
    getActivationToken: () => context.disposed ? "closed" : threadId,
    getModels: () => context.models.value,
    getCanInterrupt: () => context.running.value,
    getLoading: () => context.preparing.value || store.state.submitting,
    getGitDirtyErrorMessage: () => "工作区有未提交变更，请先处理后再切换分支。"
  });
  context.preferences = createCodexComposerPreferences({ threadId, storage,
    getOptions: () => context.options.value, getModels: () => context.models.value,
    apply: (patch) => context.composer.updateComposerOptions(patch) });
  context.stopAttachments = watch(() => context.options.value.attachments,
    (attachments) => store.setDraft({ attachments }), { deep: true, flush: "sync" });
  context.dispose = () => {
    context.disposed = true; context.stopAttachments(); context.stopSettings(); context.runtime.dispose();
  };
  let providers = [];
  const updateModels = () => {
    const current = context.options.value.model || store.state.thread?.model;
    const models = getProviderModelOptions(providers, "codex", current);
    if (current && !models.some((model) => model.value === current)) {
      models.push(...getProviderModelOptions([], "codex", current));
    }
    context.models.value = models;
  };
  context.refreshConfig = async ({ force = false } = {}) => {
    const readRevision = ++configReadRevision;
    try {
      const config = await props.loadConfig({ force });
      if (context.disposed || readRevision !== configReadRevision || !config) return;
      settings.codexDefaults = config.codexDefaults || {};
      configFollowUpMode = config.codexFollowUpQueueMode === "queue" ? "queue" : "steer";
      if (!composerHasFollowUpMode) context.followUpMode.value = configFollowUpMode;
      providers = config.providers || [];
      updateModels();
      context.configError.value = "";
    } catch (error) {
      if (!context.disposed && readRevision === configReadRevision) context.configError.value = `模型目录加载失败：${error.message}`;
    }
  };
  context.readOptions = async () => {
    const readRevision = ++optionReadRevision;
    const failureRevision = optionFailureRevision;
    const executionRevision = context.executionRevision;
    const result = await context.composer.readComposerStateForThread("codex", threadId, { silent: true });
    if (context.disposed || readRevision !== optionReadRevision || result.status === "stale") return false;
    const synced = result.status === "applied" || result.status === "preserved";
    if (failureRevision === optionFailureRevision) context.optionError.value = synced ? "" : "会话设置读取失败，请重新载入后发送。";
    if (synced) {
      context.initialOptions.value = result.snapshot;
      context.executionOptions.value = executionRevision === context.executionRevision ? result.snapshot
        : { ...result.snapshot, ...context.executionOptions.value };
      context.preferences.restore();
    }
    updateModels();
    return synced;
  };
  context.initialize = async () => {
    void context.refreshConfig();
    try {
      const results = await Promise.allSettled([context.runtime.open(), context.readOptions()]);
      if (context.disposed) return;
      if (results[1].status === "rejected") context.optionError.value = "会话设置读取失败，请重新载入后发送。";
    } catch (error) { notify(context, error.message); }
    finally { context.initializing.value = false; }
  };
  return context;
}

watch(() => props.threadId, (threadId) => {
  active.value?.dispose();
  const context = createContext(threadId);
  active.value = context;
  void context.initialize();
}, { immediate: true });
onBeforeUnmount(() => active.value?.dispose());

async function submit({ mode: requestedMode } = {}) {
  const context = active.value;
  if (!context || !canSend.value || context.preparing.value) return;
  const activeTurnId = activeCodexTurnId(context.store.state);
  const mode = activeTurnId && !pendingSettings.value ? requestedMode || context.followUpMode.value : "queue";
  if (mode === "steer" && !context.running.value) {
    notify(context, "当前任务由桌面执行，网页暂时无法立即引导；可在发送方式中选择加入队列。");
    return;
  }
  const expectedTurnId = mode === "steer" ? activeTurnId : undefined;
  context.lastSubmittedRequestId.value = "";
  context.preparing.value = true;
  try {
    if (!await context.composer.waitForComposerPersistence() || context.disposed) return;
    if (context.optionError.value) throw new Error(context.optionError.value);
    const text = context.store.state.draft.text;
    const attachments = [...context.options.value.attachments];
    await context.composer.uploadImageAttachments(attachments);
    if (context.disposed) return;
    const options = pendingSettings.value ? Object.fromEntries(["model", "reasoningEffort", "permissionMode"]
      .map((key) => [key, context.options.value[key]])) : {};
    if (context.initialOptions.value?.permissionPolicyUnsupported && !Object.hasOwn(context.preferences.snapshot(), "permissionMode"))
      delete options.permissionMode;
    const submission = context.runtime.submit({ mode, expectedTurnId, input: { text,
      attachments: attachments.filter((item) => item.kind === "image").map((item) => ({ id: item.uploadedId })) }, options });
    context.composer.updateComposerOptions({ attachments: context.store.state.draft.attachments });
    const receipt = await submission;
    if (active.value === context && !context.disposed && context.store.state.requests[receipt?.id]) {
      context.lastSubmittedRequestId.value = receipt.id;
    }
    notify(context, "");
  } catch (error) { notify(context, error.message); }
  finally { context.preparing.value = false; }
}
function liveQuestion(context, callId, index) {
  if (active.value !== context || context.disposed || typeof callId !== "string" || !callId || !Number.isInteger(index) || index < 0) return null;
  for (const turn of snapshot.value?.turns || []) {
    if (!context.store.state.thread?.capabilities?.desktopQuestionAnswers && turn.id !== activeCodexTurnId(context.store.state)) continue;
    const question = turn.items.find((item) => item.question?.callId === callId)?.question;
    if (question?.status === "pending" && question.delivery === "async" && question.source === "desktop" &&
      !question.pendingResponse && !question.truncated && question.canRespond !== false && question.questions?.[index] &&
      !question.pendingResponses?.[question.questions[index].id] &&
      !Object.hasOwn(question.answers || {}, question.questions[index].id)) return { ...question, turnId: turn.id };
  }
  return null;
}
async function answerQuestion({ question: submittedQuestion, index, answer } = {}) {
  const context = active.value;
  if (!context || !canAnswerQuestions.value || typeof answer !== "string" || !answer.trim() ||
    !liveQuestion(context, submittedQuestion?.callId, index)) return;
  context.preparing.value = true;
  context.lastSubmittedRequestId.value = "";
  try {
    if (!await context.composer.waitForComposerPersistence() || context.disposed || active.value !== context ||
      context.optionError.value || !context.initialOptions.value || !context.store.state.requestListReady ||
      context.store.state.submitting || unconfirmed.value) return;
    const question = liveQuestion(context, submittedQuestion.callId, index);
    if (!question) return;
    const desktop = !context.running.value || question.turnId !== activeCodexTurnId(context.store.state);
    const receipt = await context.runtime.submit({ mode: "steer", expectedTurnId: question.turnId, options: {}, preserveDraft: true,
      ...(desktop ? { questionReply: { callId: question.callId, index, answer } } : {}),
      input: { text: buildQuestionAnswer(question, index, answer), attachments: [] } });
    if (active.value === context && !context.disposed && context.store.state.requests[receipt?.id]) {
      context.lastSubmittedRequestId.value = receipt.id;
      notify(context, "");
    }
  } catch (error) { notify(context, error.message); }
  finally { context.preparing.value = false; }
}
function updateOptions(patch) {
  const context = active.value;
  if (!context || context.disposed || context.preparing.value || context.store.state.submitting) return;
  try {
    if (Array.isArray(patch.attachments)) context.composer.updateComposerOptions({ attachments: patch.attachments });
    context.preferences.change(patch); notify(context, "");
  }
  catch (error) { notify(context, error.message); }
}
async function addAttachments(payload) {
  const context = active.value;
  context.composer.addAttachments(payload);
  try { await context.composer.uploadImageAttachments(); }
  catch (error) { notify(context, error.message); }
  finally { if (!context.disposed) context.store.setDraft({ attachments: context.options.value.attachments }); }
}
async function restoreRequest(id) {
  const context = active.value;
  return perform(`restore:${id}`, async (runtime) => {
    if (!runtime.restoreRequest(id)) return;
    if (context.lastSubmittedRequestId.value === id) context.lastSubmittedRequestId.value = "";
    context.composer.updateComposerOptions({ attachments: context.store.state.draft.attachments });
    const options = context.store.state.requests[id]?.options || {};
    const changed = Object.fromEntries(["model", "reasoningEffort", "permissionMode"].filter((key) =>
      options[key] !== undefined && options[key] !== context.options.value[key]).map((key) => [key, options[key]]));
    if (Object.keys(changed).length) context.preferences.change(changed);
  });
}
function checkSubmission(id) {
  const receipt = active.value?.store.state.requests[id];
  if (receipt?.state !== "unknown" || isCodexRequestDismissedMissing(receipt)) return;
  return perform(`dismiss:${id}`, (runtime) => receipt.error?.code === "receipt_not_found"
    ? runtime.dismissUnknownReceipt(id) : runtime.checkRequest(id));
}
async function reload() {
  const context = active.value;
  await perform("reload", async (runtime) => {
    await Promise.all([context.refreshConfig({ force: true }), runtime.refreshLatest().then(() => {
      if (!context.disposed) return context.readOptions();
    })]);
  });
}
async function perform(key, operation) {
  const context = active.value;
  if (context.actions[key]) return;
  context.actions[key] = true;
  try { await operation(context.runtime); }
  finally { context.actions[key] = false; }
}
function toggleProcess({ turnId, segmentId, expanded }) {
  const context = active.value;
  context.expandedProcesses[segmentId || turnId] = expanded;
  void context.runtime.setProcessExpanded(turnId, processIsExpanded(turnId) || !segmentId && expanded);
}
function processIsExpanded(turnId) {
  const context = active.value;
  const turn = displayModel.value.turns.find((candidate) => candidate.id === turnId);
  return Boolean(turn?.segments.some((segment) => segment.kind === "process" &&
    (context.expandedProcesses[segment.id] ?? context.expandedProcesses[turnId] ?? !segment.defaultCollapsed))
    || context.expandedProcesses[turnId]);
}
function showRequestFooter(request, turnId) {
  if (!request || request.state === "completed") return false;
  return Boolean(request.error) || !state.value?.turns[turnId] || !["accepted", "running"].includes(request.state);
}
</script>

<template>
  <section v-if="state" class="codex-thread-view">
    <ChatView :key="threadId" class="codex-thread-chat" :session-key="threadId" :thread-id="threadId" :expected-thread-id="threadId"
      :title="state.thread?.name || initialTitle || 'Codex 会话'" :thread-snapshot="snapshot" :thread-view-model="displayModel" :workspace-cwd="state.thread?.cwd || initialCwd"
      :draft="state.draft.text" :composer-options="composerOptions" :models="models" :git-state="gitState"
      :permission-mode-options="CODEX_PERMISSION_MODE_OPTIONS"
      :can-send="canSend" :can-interrupt="canInterrupt" :loading="loading" :status-text="statusText"
      :running-task="runningTask" :follow-up-mode="pendingSettings ? 'queue' : active.followUpMode.value"
      :can-answer-questions="canAnswerQuestions" @question-answer="answerQuestion"
      :history-loading="initialHistoryLoading && !hasDisplayItems"
      :has-older="active.runtime.hasOlderHistory()" :loading-older="Boolean(active.actions.older)" :on-reach-top="active.readOlder"
      allow-followups :can-steer="active.running.value && !unconfirmed && !pendingSettings" :interrupting="state.interrupting"
      :process-expanded="active.expandedProcesses" @process-toggle="toggleProcess"
      @turn-visibility="active.updateTurnVisibility"
      @back="emit('back')" @status="notify(active, $event)" @update:draft="active.store.setDraft({ text: $event })"
      @submit="submit" @interrupt="active.runtime.interrupt()" @update:composer-options="updateOptions"
      @add-attachments="addAttachments" @remove-attachment="active.composer.removeAttachment($event)"
      @retry-attachment="active.composer.retryAttachment($event)"
      @refresh-git="active.composer.refreshWorkspaceGit()">
      <template #composer-top>
        <CodexInteractionPanel :state="state.interactionState"
          @draft="({ id, patch }) => active.store.interactions.setDraft(id, patch)"
          @respond="({ id, response }) => active.runtime.interactions.respond(id, response)"
          @check="active.runtime.interactions.check($event)" @refresh="active.runtime.interactions.refresh()" />
        <CodexSubmissionFeedback :request="submissionInQueue ? null : submissionRequest" :pending="submissionPending && !runningTask && !queuedMessages.length" :busy="submissionBusy"
          @restore="restoreRequest" @check="checkSubmission" />
        <div v-if="canRetryReads || active.actions.reload" class="codex-recovery-actions">
          <button type="button" :disabled="active.actions.reload" :aria-busy="Boolean(active.actions.reload)" @click="reload">
            {{ active.actions.reload ? '正在重试…' : '重试连接' }}
          </button>
        </div>
        <CodexQueuedMessages :messages="queuedMessages" :can-guide="active.running.value" :running-task="runningTask" :guide-disabled="unconfirmed" :actions="active.actions"
          @guide="(id) => perform(`steer:${id}`, (runtime) => runtime.promoteQueuedRequest(id))"
          @cancel="(id) => perform(`cancel:${id}`, (runtime) => runtime.cancelQueuedRequest(id))"
          @restore="restoreRequest" @check="checkSubmission" />
      </template>
      <template #history-start="{ loadOlder }">
        <InterfaceState v-if="initialHistoryLoading || initialHistoryError && !hasDisplayItems"
          :kind="initialHistoryError ? 'error' : 'loading'" :title="initialHistoryError ? '消息暂时没有读取成功' : '正在加载消息…'"
          :detail="initialHistoryError || ''" :layout="hasDisplayItems ? 'inline' : 'messages'"
          :action-label="initialHistoryError ? '重试加载' : ''" :disabled="Boolean(active.actions.reload)" @action="reload" />
        <InterfaceState v-else-if="!displayModel.turns.length" kind="empty" title="从一个想法开始" detail="描述你的任务，或添加一张图片。" />
        <div v-if="active.actions.older || active.olderError.value" class="codex-history-actions">
          <InterfaceState v-if="active.actions.older" title="正在加载更早消息…" layout="inline" mood="reading" />
          <template v-else>
            <span class="codex-history-status" role="status">{{ active.olderError.value }}</span>
            <button type="button" @click="loadOlder">重试加载</button>
          </template>
        </div>
      </template>
      <template #turn-footer="{ turnId }">
        <p v-if="state.turns[turnId]?.itemsLoading && processIsExpanded(turnId)" class="codex-detail-note" role="status">正在读取执行过程…</p>
        <p v-if="state.turns[turnId]?.itemsError && processIsExpanded(turnId)" class="codex-detail-note" role="status">{{ state.turns[turnId].itemsError }} 正在自动重试。</p>
        <template v-if="state.turns[turnId]?.itemsTruncated && !processIsExpanded(turnId)">
          <p v-if="state.turns[turnId].itemsLoading" class="codex-detail-note" role="status">正在读取完整消息…</p>
          <p v-else-if="state.turns[turnId].itemsError" class="codex-detail-note" role="status">完整消息读取失败：{{ state.turns[turnId].itemsError }} 正在自动重试。</p>
        </template>
      </template>
      <template #item-footer="{ turnId, item }">
        <div v-if="showRequestFooter(item.raw.request, turnId)" class="codex-request" role="status"
          :aria-live="submissionRequest?.id === item.raw.request.id ? 'off' : 'polite'">
          <span>{{ codexRequestLabel(item.raw.request) }}</span>
          <span v-if="item.raw.request.error" class="codex-request-error">{{ codexRequestError(item.raw.request) }}</span>
          <button v-if="item.raw.request.state === 'queued'" type="button" title="撤回尚未执行的消息"
            :disabled="active.actions[`cancel:${item.raw.request.id}`]"
            @click="perform(`cancel:${item.raw.request.id}`, (runtime) => runtime.cancelQueuedRequest(item.raw.request.id))">撤回</button>
          <button v-else-if="item.raw.request.state === 'received' && item.raw.request.mode === 'queue' && active.running.value"
            type="button" title="将这条消息引导到当前回复"
            :aria-label="`引导排队消息：${item.raw.text || '图片'}`"
            :disabled="unconfirmed || active.actions[`steer:${item.raw.request.id}`]"
            @click="perform(`steer:${item.raw.request.id}`, (runtime) => runtime.promoteQueuedRequest(item.raw.request.id))">引导</button>
          <button v-if="isCodexTerminal(item.raw.request.state) && item.raw.request.state !== 'completed' && item.raw.request.executionRoute !== 'desktopQuestion'" type="button"
            :disabled="active.actions[`restore:${item.raw.request.id}`]" :aria-busy="Boolean(active.actions[`restore:${item.raw.request.id}`])"
            @click="restoreRequest(item.raw.request.id)">恢复到输入框</button>
          <button v-if="item.raw.request.state === 'unknown' && item.raw.request.error?.code === 'receipt_not_found' && !item.raw.request.confirmationDismissed"
            type="button" title="再次核对后解除锁定；原消息不会自动重发，再次手动发送可能重复"
            :disabled="active.actions[`dismiss:${item.raw.request.id}`]"
            :aria-busy="Boolean(active.actions[`dismiss:${item.raw.request.id}`])"
            @click="checkSubmission(item.raw.request.id)">核对并解除锁定</button>
          <button v-else-if="item.raw.request.state === 'unknown' && !isCodexRequestDismissedMissing(item.raw.request)"
            type="button" title="只核对原消息的发送状态" :disabled="active.actions[`dismiss:${item.raw.request.id}`]"
            :aria-busy="Boolean(active.actions[`dismiss:${item.raw.request.id}`])"
            @click="checkSubmission(item.raw.request.id)">再次核对</button>
        </div>
        <p v-if="item.raw.detailError" class="codex-detail-error" role="status">详情读取失败：{{ item.raw.detailError }}{{ item.raw.detailRetryable ? '，正在自动重试。' : '' }}</p>
        <p v-else-if="item.raw.detailsLoaded && item.raw.truncated" class="codex-detail-note">内容较长，已显示部分</p>
      </template>
    </ChatView>
  </section>
</template>

<style scoped>
.codex-thread-view { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
.codex-thread-chat { flex: 1; width: 100%; height: 100%; min-height: 0; min-width: 0; }
.codex-execution-note { margin: 0 24px 8px; color: #7b6755; font-size: 12px; line-height: 1.5; }
.codex-thread-chat :deep(.thread-turn-card[data-status="sending"] > .thread-turn-footer),
.codex-thread-chat :deep(.thread-turn-card[data-status="received"] > .thread-turn-footer),
.codex-thread-chat :deep(.thread-turn-card[data-status="queued"] > .thread-turn-footer) { display: none; }
.codex-history-actions { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px 10px; padding: 0 0 8px; }
.codex-history-status { color: #7b6755; font-size: 12px; line-height: 1.5; }
.codex-recovery-actions { display: flex; padding: 0 20px 4px; }
.codex-history-actions button, .codex-recovery-actions button, .codex-inline-action, .codex-request button { border: 0; background: transparent; color: #79634f; font-size: 12px; padding: 6px 4px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.codex-inline-action { align-self: flex-start; }
.codex-request { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; align-self: flex-end; padding: 4px 0; color: #79634f; font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
.codex-request-error { color: #a23535; }
.codex-detail-note { color: #79634f; font-size: 12px; margin: 4px 0; }
.codex-detail-error { color: #a23535; font-size: 12px; margin: 4px 0; overflow-wrap: anywhere; }
button:disabled { opacity: .55; cursor: wait; }
</style>
