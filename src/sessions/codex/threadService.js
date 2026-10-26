import { randomUUID } from "node:crypto";
import { CodexRequestStore, REQUEST_TERMINAL_STATES } from "./requestStore.js";
import { CodexSettingsDispatcher, hasSubmissionSettings } from "./settingsDispatcher.js";
import { CodexTurnController } from "./turnController.js";
import { DesktopQueuePromotion } from "./desktopQueuePromotion.js";
import { CodexQueuedWriter } from "./queuedWriter.js";
import { DesktopQueueSync } from "./desktopQueueSync.js";
import { CodexDesktopClient } from "./desktopClient.js";
import { DesktopQuestionResponder } from "./desktopQuestionResponder.js";
import { DesktopQuestionRecovery } from "./desktopQuestionRecovery.js";
import { DesktopQueueObserver, matchesDesktopQueueTurn, observedDesktopQueueTurn, requestTerminalTurn } from "./desktopQueueObserver.js";
import { CodexHistoryReader } from "./historyReader.js";
import { presentCodexItem } from "./itemPresentation.js";
import { CodexThreadStateStore } from "../state/CodexThreadStateStore.js";
import { normalizeCodexComposerPatch } from "../shared/composerOptions.js";
import { readCodexDesktopDefaults } from "../shared/codexDesktopConfig.js";
import { buildAppServerThreadOptions, buildAppServerTurnOptions } from "../shared/appServerOptions.js";
import { normalizeImageAttachmentReferences, resolveImageAttachments } from "../shared/imageAttachments.js";
import { latestActivityTimestamp } from "../history/sessionActivity.js";
import { CodexInteractionService } from "./interactions/service.js";

const failure = (message, status = 400, code = "invalid_request") => Object.assign(new Error(message), { status, code });
const terminal = (status) => ["completed", "failed", "interrupted", "aborted"].includes(String(status));
const turnState = (status) => status === "aborted" ? "interrupted" : status;
const threadIdOf = (params) => String(params?.threadId || params?.thread_id || params?.thread?.id || "");

export class CodexThreadService {
  constructor({ config, bridge, sessionManager, reader, requests, desktopClient, pollMs = 3000, desktopPollMs = 1000, recoveryMs = 5000, queueRecoveryMs = 15000 }) {
    this.config = config;
    this.bridge = bridge;
    this.sessionManager = sessionManager;
    this.reader = reader || new CodexHistoryReader({ bridge, config, sessionManager });
    this.requests = requests || new CodexRequestStore({ dataDir: config.dataDir });
    this.queuedWriter = new CodexQueuedWriter({ bridge });
    this.queuePromotion = new DesktopQueuePromotion(this);
    this.desktopQueueObserver = new DesktopQueueObserver({ reader: this.reader, publish: (threadId, type, payload) => this.publish(threadId, type, payload) });
    this.epoch = randomUUID();
    this.streams = new Map();
    this.active = new Map();
    this.loaded = new Set();
    this.createdThreads = new Map();
    this.terminalTurns = new Map();
    this.closed = false;
    this.desktopClient = desktopClient || new CodexDesktopClient({ config });
    this.settingsDispatcher = new CodexSettingsDispatcher(this);
    this.turnController = new CodexTurnController(this);
    this.desktopQuestions = new DesktopQuestionResponder({ client: this.desktopClient, reader: this.reader, requests: this.requests,
      update: (id, requestId, patch) => this.updateRequest(id, requestId, patch),
      finish: (id, requestId) => this.finish(id, requestId), isClosed: () => this.closed });
    this.desktopQuestionRecovery = new DesktopQuestionRecovery({ reader: this.reader,
      reconcileItems: (...args) => this.reconcileItems(...args), isClosed: () => this.closed });
    this.interactions = new CodexInteractionService({ bridge,
      ownsThread: (threadId) => !this.closed && (this.loaded.has(threadId) || this.active.has(threadId)
        && !["desktopQueue", "desktopSettings", "desktopSteer"].includes(this.requests.get(threadId, this.active.get(threadId).requestId)?.executionRoute)),
      publish: (threadId, type, payload) => { this.publish(threadId, type, payload); this.releaseStream(threadId); } });
    const pendingThreadIds = this.requests.pendingThreadIds?.() || [];
    this.trackedRequests = new Set(pendingThreadIds);
    this.pendingByThread = new Map();
    for (const id of pendingThreadIds) for (const request of this.requests.list(id)) this.trackPending(request);
    this.desktopQueueSync = new DesktopQueueSync({ writer: this.queuedWriter,
      pending: (id) => this.pendingReceipts(id), current: (id, requestId) => this.requests.get(id, requestId),
      update: (id, requestId, patch) => this.updateRequest(id, requestId, patch),
      finish: (id, requestId) => this.finish(id, requestId) });
    this.recoveryTimers = new Map();
    this.recoveryPositions = new Map();
    this.recoveryTurnCursors = new Map();
    this.queueRecoveryCursors = new Map();
    this.queueRecoveryExhausted = new Map();
    this.recoveryMs = recoveryMs;
    this.queueRecoveryMs = queueRecoveryMs;
    this.pollMs = pollMs;
    this.desktopPollMs = desktopPollMs;
    this.onNotification = (notification) => {
      try { this.handleNotification(notification); }
      catch (error) {
        const threadId = threadIdOf(notification.params);
        if (threadId && this.streams.has(threadId)) this.publish(threadId, "thread.updated", { thread: { id: threadId, syncError: error.message } });
      }
    };
    this.onDisconnect = () => this.handleDisconnect();
    bridge?.on("notification", this.onNotification);
    bridge?.on("disconnected", this.onDisconnect);
    queueMicrotask(() => {
      if (!this.closed) for (const id of this.requests.pendingThreadIds?.() || []) {
        for (const request of this.requests.list(id)) if (request.state === "received" && request.mode === "steer") this.dispatchSteer(id, request.id);
        this.dispatchNext(id);
        void this.syncQueue(id);
        this.scheduleRecovery(id);
      }
    });
  }

  stream(threadId) {
    if (!this.streams.has(threadId)) this.streams.set(threadId, { epoch: randomUUID(), seq: 0, events: [], bytes: 0, subscribers: new Set(), polling: false, timer: null, signature: "" });
    return this.streams.get(threadId);
  }

  publish(threadId, type, payload) {
    const stream = this.stream(threadId);
    const event = { schemaVersion: 2, threadId, epoch: stream.epoch, seq: ++stream.seq, type, payload };
    const encoded = JSON.stringify(event);
    stream.events.push({ event, bytes: Buffer.byteLength(encoded) });
    stream.bytes += Buffer.byteLength(encoded);
    while (stream.events.length > 256 || stream.bytes > 1024 * 1024) stream.bytes -= stream.events.shift().bytes;
    for (const send of stream.subscribers) { try { send(event); } catch { /* Closed observers do not cancel execution. */ } }
    return event;
  }

  subscribe(threadId, send, { epoch = "", after = 0 } = {}) {
    const stream = this.stream(threadId);
    stream.subscribers.add(send);
    const firstSeq = stream.events[0]?.event.seq ?? stream.seq + 1;
    if (epoch === stream.epoch && Number(after) >= firstSeq - 1 && Number(after) <= stream.seq) {
      for (const { event } of stream.events) if (event.seq > Number(after)) send(event);
    } else {
      send({ schemaVersion: 2, threadId, epoch: stream.epoch, seq: stream.seq, type: "sync.required", payload: {} });
    }
    const firstSubscriber = !stream.timer;
    this.ensurePolling(threadId);
    if (firstSubscriber) this.pollHistory(threadId);
    return () => {
      stream.subscribers.delete(send);
      if (!stream.subscribers.size) { clearInterval(stream.timer); stream.timer = null; this.releaseStream(threadId); }
    };
  }

  updateRequest(threadId, id, patch) {
    const request = this.requests.update(threadId, id, patch);
    this.trackPending(request);
    this.publish(threadId, "request.updated", { request });
    if (["unknown", "queued"].includes(request.state) || ["desktopQueue", "desktopQuestion", "desktopSteer"].includes(request.executionRoute)
      && ["accepted", "running"].includes(request.state)) this.scheduleRecovery(threadId);
    this.ensurePolling(threadId);
    return request;
  }

  syncQueue(threadId, options) { return this.desktopQueueSync.sync(threadId, options); }

  trackPending(request) {
    const threadId = request.threadId;
    if (REQUEST_TERMINAL_STATES.has(request.state)) {
      const pending = this.pendingByThread.get(threadId);
      pending?.delete(request.id);
      if (pending && !pending.size) this.pendingByThread.delete(threadId);
      return;
    }
    let pending = this.pendingByThread.get(threadId);
    this.trackedRequests.add(threadId);
    if (!pending) { pending = new Map(); this.pendingByThread.set(threadId, pending); }
    pending.set(request.id, request);
  }

  pendingReceipts(threadId) { return [...(this.pendingByThread.get(threadId)?.values() || [])]; }

  ensurePolling(threadId) {
    const stream = this.streams.get(threadId);
    if (this.closed || !stream?.subscribers.size) return;
    const desktopPending = this.pendingReceipts(threadId).some((request) => ["desktopQueue", "desktopSteer"].includes(request.executionRoute) &&
      !REQUEST_TERMINAL_STATES.has(request.state));
    const intervalMs = desktopPending ? this.desktopPollMs : this.pollMs;
    if (stream.timer && stream.intervalMs === intervalMs) return;
    clearInterval(stream.timer);
    stream.intervalMs = intervalMs;
    stream.timer = setInterval(() => this.pollHistory(threadId), intervalMs);
    stream.timer.unref?.();
  }

  async getThread(threadId, options) {
    const [thread, owner] = await Promise.all([this.reader.getThread(threadId, options),
      this.desktopClient.discover(threadId, options).catch(() => null)]);
    return { ...this.createdThreads.get(threadId), ...thread,
      capabilities: { ...thread.capabilities, desktopQuestionAnswers: Boolean(owner?.clientId && owner.supportsUntrustedAppInput),
        desktopQueuedSteer: Boolean(owner?.clientId && typeof this.desktopClient.steerMessage === "function"),
        desktopInterrupt: Boolean(owner?.clientId) } };
  }

  getThreadActivity(threadId) {
    const active = this.active.get(threadId);
    if (!active && !this.trackedRequests.has(threadId)) {
      // Historical ownership is not proof that another runtime has stayed idle.
      return null;
    }
    const requests = this.requests.list(threadId);
    const confirmed = active?.turnId && requests.some((request) => request.id === active.requestId &&
      !["desktopQueue", "desktopSettings", "desktopSteer"].includes(request.executionRoute) && ["accepted", "running"].includes(request.state));
    const uncertain = requests.some((request) => ["dispatching", "queued", "accepted", "running", "unknown"].includes(request.state));
    return { activityState: !this.closed && confirmed ? "running" : !this.closed && this.loaded.has(threadId) && !uncertain ? "idle" : "unknown",
      lastActivityAt: latestActivityTimestamp(requests.map((request) => request.createdAt),
        [...this.terminalTurns].filter(([key]) => key.startsWith(`${threadId}:`)).map(([, turn]) => turn.startedAt)) };
  }

  async createThread(body = {}) {
    if (!this.bridge) throw failure("Codex app-server 未启用。", 503);
    const defaults = readCodexDesktopDefaults(this.config);
    const options = normalizeCodexComposerPatch(body, defaults, this.sessionManager.codexModelCatalog?.() || []);
    const session = { ...defaults, ...options, cwd: this.sessionManager.resolveCwd(body.cwd || this.config.defaultCwd) };
    const projectId = body.projectId ? this.sessionManager.codexSidebarService.resolveProjectId(body.projectId) : "";
    await this.bridge.ensureReady();
    const result = await this.bridge.request("thread/start", { ...buildAppServerThreadOptions(session),
      ...(projectId ? { projectId } : {}),
      config: { "features.default_mode_request_user_input": true,
        ...(session.reasoningEffort ? { model_reasoning_effort: session.reasoningEffort } : {}) }, experimentalRawEvents: false });
    const thread = result?.thread;
    if (!thread?.id) throw failure("Codex 未返回新线程。", 502);
    if (String(body.name || "").trim()) {
      await this.bridge.request("thread/name/set", { threadId: thread.id, name: String(body.name).trim() });
      thread.name = String(body.name).trim();
    }
    this.loaded.add(thread.id);
    const metadata = { ...thread, turns: [], model: session.model, reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode, cwd: session.cwd };
    // An empty official thread has not yet recorded turn-level composer fields.
    // Persist the user's explicit creation choices so opening it cannot replace them with model defaults.
    new CodexThreadStateStore(this.config).patchThreadComposerState(thread.id, {
      model: session.model, reasoningEffort: session.reasoningEffort, permissionMode: session.permissionMode
    }, { models: this.sessionManager.codexModelCatalog?.() || [] });
    this.createdThreads.set(thread.id, metadata);
    return metadata;
  }

  submit(threadId, body = {}) {
    if (!this.bridge) throw failure("Codex app-server 未启用。", 503);
    const input = { text: String(body.input?.text ?? ""), attachments: normalizeImageAttachmentReferences(body.input?.attachments || []) };
    if (!input.text.trim() && !input.attachments.length) throw failure("请输入消息或添加图片。");
    resolveImageAttachments(this.config, input.attachments);
    const options = Object.fromEntries(["model", "reasoningEffort", "permissionMode"].filter((key) => body.options?.[key] != null).map((key) => [key, body.options[key]]));
    const requestedMode = body.mode || "queue";
    if (!["queue", "steer"].includes(requestedMode)) throw failure("不支持的发送方式。");
    const mode = Object.keys(options).length ? "queue" : requestedMode;
    const expectedTurnId = mode === "steer" ? String(body.expectedTurnId || "").trim() : null;
    if (mode === "steer" && !expectedTurnId) throw failure("立即引导需要明确的当前回复编号。");
    if (!this.requests.get(threadId, body.clientRequestId) && this.requests.list(threadId).filter((entry) => !REQUEST_TERMINAL_STATES.has(entry.state)).length >= (this.config.maxQueuedInputs || 200)) {
      throw failure("待处理消息过多，请等待当前回复完成。", 429);
    }
    let request = this.requests.receive(threadId, { clientRequestId: body.clientRequestId, input, options, mode, expectedTurnId });
    if (request.state === "received" && hasSubmissionSettings(request) && !request.executionRoute) {
      request = this.updateRequest(threadId, request.id, { executionRoute: "settingsQueue" });
    }
    if (!REQUEST_TERMINAL_STATES.has(request.state)) { this.trackedRequests.add(threadId); this.trackPending(request); }
    if (request.state === "received") queueMicrotask(() => mode === "steer" ? this.dispatchSteer(threadId, request.id) : this.dispatchNext(threadId));
    return request;
  }

  promoteQueuedRequest(threadId, requestId, { expectedTurnId } = {}) {
    if (!this.bridge || this.closed) throw failure("Codex chat service is unavailable", 503);
    const targetTurnId = String(expectedTurnId || "").trim();
    if (!targetTurnId) throw failure("立即引导需要明确的当前回复编号。");
    const request = this.requests.get(threadId, requestId);
    if (!request) throw failure("Request not found", 404);
    if (request.executionRoute === "desktopSteer" || request.executionRoute === "desktopQueue" && request.state === "queued") {
      return this.queuePromotion.promote(threadId, requestId, targetTurnId);
    }
    if (request.mode === "steer") {
      if (request.expectedTurnId !== targetTurnId) throw failure("这条消息已用于引导另一轮回复。", 409, "steer_target_conflict");
      return request;
    }
    if (hasSubmissionSettings(request) || request.state !== "received" || request.mode !== "queue" || request.turnId) {
      throw failure("这条消息已开始发送，不能再转为引导。", 409, "request_not_queued");
    }
    if (this.requests.list(threadId).some((entry) => entry.state === "unknown")) {
      throw failure("上一条消息的接收状态尚未确认，请等待自动核对后再引导。", 409, "confirmation_required");
    }
    const active = this.active.get(threadId);
    if (!active?.turnId || active.turnId !== targetTurnId || !this.loaded.has(threadId)
      || ["desktopQueue", "desktopSettings", "desktopSteer"].includes(this.requests.get(threadId, active.requestId)?.executionRoute)) {
      throw failure("目标回复已结束或当前不由网页持有，消息仍保留在队列中。", 409, "turn_not_active");
    }
    resolveImageAttachments(this.config, request.input.attachments);
    // Validation and the durable mode change are synchronous: the queue dispatcher
    // cannot claim this request between them. Keep its original submission fingerprint.
    const promoted = this.updateRequest(threadId, requestId, { mode: "steer", expectedTurnId: targetTurnId });
    this.trackedRequests.add(threadId);
    queueMicrotask(() => this.dispatchSteer(threadId, requestId));
    return promoted;
  }

  cancelQueuedRequest(threadId, requestId) {
    return this.queuePromotion.run(threadId, requestId, "cancel", () => this.cancelQueuedRequestOnce(threadId, requestId));
  }

  async cancelQueuedRequestOnce(threadId, requestId) {
    const request = this.requests.get(threadId, requestId);
    if (!request) throw failure("Request not found", 404);
    if (request.state === "cancelled") return request;
    if (["received", "queued"].includes(request.state) && request.executionRoute === "settingsQueue" && !request.turnId) {
      const cancelled = this.updateRequest(threadId, requestId, { state: "cancelled", error: null });
      this.finish(threadId, requestId);
      return cancelled;
    }
    if (!["desktopQueue", "desktopSettings", "desktopSteer"].includes(request.executionRoute) || request.state !== "queued" || !request.upstreamQueueId) {
      throw failure("这条消息已经开始执行或尚未确认入队，不能撤回。", 409, "request_not_queued");
    }
    const queued = await this.queuedWriter.find(threadId, requestId);
    if (!queued || queued.id !== request.upstreamQueueId || !await this.queuedWriter.delete(threadId, queued.id)) {
      throw failure("桌面已开始处理这条消息，请等待状态同步。", 409, "queue_already_started");
    }
    const current = this.requests.get(threadId, requestId);
    if (current.state !== "queued") return current;
    const cancelled = this.updateRequest(threadId, requestId, { state: "cancelled", error: null });
    this.finish(threadId, requestId);
    return cancelled;
  }

  async dispatchNext(threadId) {
    if (this.closed || this.active.has(threadId)) return;
    const pending = this.requests.list(threadId).filter((request) => !REQUEST_TERMINAL_STATES.has(request.state));
    if (pending.some((request) => request.mode === "steer" && request.executionRoute !== "desktopQuestion")) return;
    const request = pending.find((entry) => entry.mode !== "steer" &&
      !(entry.executionRoute === "desktopQueue" && ["queued", "accepted", "running"].includes(entry.state)));
    if (!request || request.state !== "received" && !(request.state === "queued" && request.executionRoute === "settingsQueue")) return;
    this.active.set(threadId, { requestId: request.id, turnId: null, sent: false });
    if (request.state !== "queued") this.updateRequest(threadId, request.id, { state: "dispatching" });
    if (pending.some((entry) => entry.id !== request.id && entry.executionRoute === "desktopQueue"
      && ["queued", "accepted", "running"].includes(entry.state) && entry.order < request.order)) {
      await this.dispatchQueued(threadId, request);
      return;
    }
    let sentTurn = false;
    try {
      const thread = await this.getThread(threadId);
      if (String(thread.status?.type || thread.status) === "active" && !(hasSubmissionSettings(request) && thread.capabilities?.desktopQuestionAnswers)) throw failure("该会话仍有正在执行的回复，请完成或停止后再发送。", 409, "thread_busy");
      const stored = new CodexThreadStateStore(this.config).getThreadComposerState(threadId);
      if (stored?.permissionPolicyUnsupported && !request.options.permissionMode) throw failure("当前线程使用自定义权限，请先在输入设置中明确选择权限。", 409, "unsupported_permissions");
      const baseline = { ...readCodexDesktopDefaults(this.config), ...this.createdThreads.get(threadId), ...stored };
      const options = normalizeCodexComposerPatch(request.options, baseline, this.sessionManager.codexModelCatalog?.() || []);
      const session = { ...baseline, ...options, cwd: stored?.cwd || thread.cwd || this.config.defaultCwd };
      if (hasSubmissionSettings(request) && thread.capabilities?.desktopQuestionAnswers && !this.loaded.has(threadId)) {
        await this.settingsDispatcher.dispatchDesktop(threadId, request, session);
        return;
      }
      await this.bridge.ensureReady();
      if (!this.loaded.has(threadId)) {
        await this.bridge.request("thread/resume", { threadId, ...buildAppServerThreadOptions(session),
          config: { "features.default_mode_request_user_input": true }, excludeTurns: true });
        this.loaded.add(threadId);
      }
      const images = resolveImageAttachments(this.config, request.input.attachments);
      sentTurn = true;
      const dispatch = this.active.get(threadId);
      if (dispatch?.requestId !== request.id) return;
      dispatch.sent = true;
      if (request.state === "queued") this.updateRequest(threadId, request.id, { state: "dispatching" });
      const result = await this.bridge.request("turn/start", { threadId, clientUserMessageId: request.id,
        ...buildAppServerTurnOptions(session), input: [
          ...(request.input.text.trim() ? [{ type: "text", text: request.input.text, text_elements: [] }] : []),
          ...images.map((image) => ({ type: "localImage", path: image.path }))
        ] });
      const acknowledged = result?.turn;
      const turn = this.terminalTurns.get(`${threadId}:${acknowledged?.id}`) || acknowledged;
      if (!turn?.id) throw failure("Codex 接收状态尚未确认。", 502, "confirmation_required");
      const active = this.active.get(threadId);
      if (active?.requestId === request.id) active.turnId = turn.id;
      const current = this.requests.get(threadId, request.id);
      if (REQUEST_TERMINAL_STATES.has(current.state)) return;
      this.updateRequest(threadId, request.id, { state: terminal(turn.status) ? turnState(turn.status) : "accepted", turnId: turn.id, error: turn.error || null });
      this.publish(threadId, "turn.upsert", { turn: this.presentTurn(turn, session.cwd, threadId) });
      if (terminal(turn.status)) this.finish(threadId, request.id);
    } catch (cause) {
      if (REQUEST_TERMINAL_STATES.has(this.requests.get(threadId, request.id)?.state)) return;
      if (cause.code === "thread_busy" || cause.rpcError && /already has an active writer/i.test(cause.message || "")) {
        await this.dispatchQueued(threadId, request);
        return;
      }
      const uncertain = sentTurn && !cause.rpcError;
      const occupied = /already has an active writer|thread-store conflict/.test(cause.message || "");
      this.updateRequest(threadId, request.id, { state: uncertain ? "unknown" : "rejected", error: {
        code: occupied ? "thread_in_use" : uncertain ? "confirmation_required" : cause.code || "request_rejected",
        message: occupied ? "该会话的写入权被其他 Codex 运行时占用，当前消息尚未发出。原文和附件已保留，请在原端继续发送。"
          : uncertain ? "连接中断，尚不能确认 Codex 是否已接收。原消息已保留，正在核对；不会自动重发。" : cause.message || "Codex 拒绝了这条消息。"
      } });
      if (this.active.get(threadId)?.requestId === request.id) this.active.delete(threadId);
      if (!uncertain) this.finish(threadId, request.id);
      else this.releaseStream(threadId);
    }
  }

  async dispatchQueued(threadId, request) {
    try {
      if (hasSubmissionSettings(request)) {
        this.settingsDispatcher.defer(threadId, request);
        return;
      }
      this.updateRequest(threadId, request.id, { executionRoute: "desktopQueue" });
      const images = resolveImageAttachments(this.config, request.input.attachments);
      const input = [
        ...(request.input.text.trim() ? [{ type: "text", text: request.input.text, text_elements: [] }] : []),
        ...images.map((image) => ({ type: "localImage", path: image.path }))
      ];
      const queued = await this.queuedWriter.enqueue(threadId, request.id, input);
      const current = this.requests.get(threadId, request.id);
      if (REQUEST_TERMINAL_STATES.has(current?.state)) return;
      this.updateRequest(threadId, request.id, { ...(!current.turnId ? { state: "queued" } : {}), upstreamQueueId: queued.id, error: null });
    } catch (cause) {
      const current = this.requests.get(threadId, request.id);
      if (REQUEST_TERMINAL_STATES.has(current?.state) || current?.turnId) return;
      const uncertain = Boolean(cause.uncertain);
      this.updateRequest(threadId, request.id, { state: uncertain ? "unknown" : "rejected", error: {
        code: uncertain ? "confirmation_required" : cause.code || "queue_rejected",
        message: uncertain ? "桌面队列的接收状态尚未确认，正在核对；不会重复发送。" : cause.message || "桌面队列未接收这条消息。"
      } });
      if (!uncertain) this.finish(threadId, request.id);
    } finally {
      if (this.active.get(threadId)?.requestId === request.id) this.active.delete(threadId);
      if (!hasSubmissionSettings(request)) queueMicrotask(() => this.dispatchNext(threadId));
      this.releaseStream(threadId);
    }
  }

  presentTurn(turn, cwd = "", threadId = "") {
    if (Array.isArray(turn.items) && this.reader.presentTurn) return this.reader.presentTurn(turn, cwd, false, threadId);
    return { ...turn, ...(Array.isArray(turn.items) ? { items: turn.items.map((item) => presentCodexItem(item, { cwd, threadId, turnId: turn.id })) } : {}) };
  }

  async dispatchSteer(threadId, requestId) {
    if (this.closed) return;
    const request = this.requests.get(threadId, requestId);
    if (!request || request.state !== "received") return;
    if (request.questionReply) {
      this.updateRequest(threadId, requestId, { state: "rejected", error: { code: "answer_not_dispatched",
        message: "服务在发送回答前重启，请重新提交回答。" } });
      this.finish(threadId, requestId);
      return;
    }
    const active = this.active.get(threadId);
    if (!active?.turnId || active.turnId !== request.expectedTurnId || !this.loaded.has(threadId)) {
      this.updateRequest(threadId, requestId, { state: "rejected", error: { code: "turn_not_active",
        message: "目标回复已结束或当前不由网页持有。补充内容已保留，可恢复后作为下一条消息发送。" } });
      this.finish(threadId, requestId);
      return;
    }
    this.updateRequest(threadId, requestId, { state: "dispatching" });
    try {
      const images = resolveImageAttachments(this.config, request.input.attachments);
      const result = await this.bridge.request("turn/steer", { threadId, expectedTurnId: request.expectedTurnId,
        clientUserMessageId: request.id, input: [
          ...(request.input.text.trim() ? [{ type: "text", text: request.input.text, text_elements: [] }] : []),
          ...images.map((image) => ({ type: "localImage", path: image.path }))
        ] });
      const turnId = String(result?.turnId || "");
      if (turnId !== request.expectedTurnId) throw failure("Codex 引导消息的接收状态尚未确认。", 502);
      const finished = this.terminalTurns.get(`${threadId}:${turnId}`);
      this.updateRequest(threadId, requestId, { state: finished ? turnState(finished.status) : "accepted", turnId, error: finished?.error || null });
      if (finished) this.finish(threadId, requestId);
    } catch (cause) {
      if (REQUEST_TERMINAL_STATES.has(this.requests.get(threadId, requestId)?.state)) return;
      this.updateRequest(threadId, requestId, { state: cause.rpcError ? "rejected" : "unknown", error: {
        code: cause.rpcError ? "steer_rejected" : "confirmation_required",
        message: cause.rpcError ? `引导未被接收：${cause.message}` : "尚不能确认引导是否已接收，正在自动核对；不会重复发送。"
      } });
      if (cause.rpcError) this.finish(threadId, requestId);
      this.releaseStream(threadId);
    }
  }

  finish(threadId, requestId) {
    if (this.active.get(threadId)?.requestId === requestId) this.active.delete(threadId);
    this.publish(threadId, "history.changed", {});
    queueMicrotask(() => this.dispatchNext(threadId));
    if (!this.requests.list(threadId).some((request) => !REQUEST_TERMINAL_STATES.has(request.state))) this.trackedRequests.delete(threadId);
    if (!this.recoveryRequests(threadId).length) {
      this.desktopQuestionRecovery.forget(threadId);
      clearTimeout(this.recoveryTimers.get(threadId)); this.recoveryTimers.delete(threadId);
      this.recoveryTurnCursors.delete(threadId);
      this.queueRecoveryCursors.delete(threadId);
      this.queueRecoveryExhausted.delete(threadId);
      for (const key of this.recoveryPositions.keys()) if (key.startsWith(`${threadId}:`)) this.recoveryPositions.delete(key);
    }
    this.releaseStream(threadId);
  }

  releaseStream(threadId) {
    const stream = this.streams.get(threadId);
    if (stream && !stream.subscribers.size && !this.active.has(threadId)) {
      clearInterval(stream.timer);
      this.streams.delete(threadId);
      this.desktopQueueObserver.forget(threadId);
    }
  }

  handleNotification({ method, params = {} } = {}) {
    const threadId = threadIdOf(params);
    if (!threadId) return;
    if (!this.streams.has(threadId) && !this.active.has(threadId) && !this.trackedRequests.has(threadId)) {
      const clientId = params.item?.clientId;
      if (!["item/started", "item/completed"].includes(method) || params.item?.type !== "userMessage"
        || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientId || "")
        || this.requests.get(threadId, clientId)?.state !== "removed") return;
    }
    if (method === "thread/queue/changed") {
      void this.syncQueue(threadId, { invalidate: true });
      return;
    }
    const active = this.active.get(threadId);
    const turnId = String(params.turnId || params.turn_id || params.turn?.id || active?.turnId || "");
    if (method === "thread/closed") { this.loaded.delete(threadId); return; }
    if (method === "thread/status/changed") { this.publish(threadId, "thread.updated", { thread: { id: threadId, status: params.status } }); return; }
    if (method === "thread/name/updated") { this.publish(threadId, "thread.updated", { thread: { id: threadId, name: params.threadName || params.name } }); return; }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = params.turn || { id: turnId, status: method === "turn/started" ? "inProgress" : "completed" };
      const known = this.requests.list(threadId).filter((request) => request.turnId === turn.id);
      const matched = known.length ? known : active?.turnId === turn.id ? [this.requests.get(threadId, active.requestId)] : [];
      if (terminal(turn.status)) {
        this.terminalTurns.set(`${threadId}:${turn.id}`, { id: turn.id, status: turn.status, error: turn.error,
          startedAt: turn.startedAt, completedAt: turn.completedAt, statusSource: "notification" });
        while (this.terminalTurns.size > 128) this.terminalTurns.delete(this.terminalTurns.keys().next().value);
      }
      for (const request of matched) if (request) this.updateRequest(threadId, request.id, { turnId: turn.id, state: terminal(turn.status) ? turnState(turn.status) : "running", error: turn.error || null });
      const confirmedStatus = known.find((request) => REQUEST_TERMINAL_STATES.has(request.state))?.state || turn.status;
      this.publish(threadId, "turn.upsert", { turn: this.presentTurn({ ...turn, status: confirmedStatus }, "", threadId) });
      if (terminal(turn.status)) for (const request of matched) if (request) this.finish(threadId, request.id);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && params.item?.id && turnId) {
      const item = presentCodexItem({ ...params.item, status: params.item.status || (method === "item/completed" ? "completed" : "inProgress") }, { threadId, turnId });
      this.publish(threadId, "item.upsert", { turnId, item });
      const clientId = params.item.clientId;
      if (params.item.type === "userMessage" && clientId) {
        const request = this.requests.get(threadId, clientId);
        if (request) {
          if (active?.requestId === request.id && !["desktopQueue", "desktopSettings", "desktopSteer"].includes(request.executionRoute)) active.turnId = turnId;
          const finished = requestTerminalTurn(this.terminalTurns.get(`${threadId}:${turnId}`), request);
          this.updateRequest(threadId, request.id, { turnId, userItemId: item.id, state: finished ? turnState(finished.status) : "running", error: finished?.error || null });
          if (finished) this.finish(threadId, request.id);
        }
      }
      return;
    }
    const fields = { "item/agentMessage/delta": "text", "item/reasoning/summaryTextDelta": "summary", "item/reasoning/textDelta": "summary", "item/commandExecution/outputDelta": "aggregatedOutput" };
    if (fields[method] && turnId && (params.itemId || params.item_id)) {
      this.publish(threadId, "item.delta", { turnId, itemId: String(params.itemId || params.item_id), field: fields[method], text: String(params.delta || "") });
    }
  }

  async pollHistory(threadId) {
    const stream = this.streams.get(threadId);
    if (this.closed || !stream || stream.polling || !stream.subscribers.size) return;
    void this.syncQueue(threadId);
    stream.polling = true;
    try {
      const pending = this.pendingReceipts(threadId);
      const desktopPending = pending.filter((request) => ["desktopQueue", "desktopSteer"].includes(request.executionRoute) &&
        !REQUEST_TERMINAL_STATES.has(request.state));
      const page = await this.reader.listTurns(threadId, { limit: 2 });
      if (this.closed || this.streams.get(threadId) !== stream || !stream.subscribers.size) return;
      const turnSignatures = new Map();
      for (const turn of page.turns || []) {
        // Latest-only client refreshes cannot reconcile the preceding turn after a transition.
        // Send its metadata even on the first poll, without promoting sparse summaries to live items.
        const { items, itemsView, itemsTruncated, hasMoreItems, ...metadata } = turn;
        const turnSignature = JSON.stringify(metadata);
        turnSignatures.set(turn.id, turnSignature);
        // Pending desktop submissions already have their own status observer and item stream.
        if (!matchesDesktopQueueTurn(turn, desktopPending) && stream.turnSignatures?.get(turn.id) !== turnSignature) {
          this.publish(threadId, "turn.metadata", { turn: metadata });
        }
        if (this.closed || this.streams.get(threadId) !== stream || !stream.subscribers.size) return;
      }
      stream.turnSignatures = turnSignatures;
      const signature = JSON.stringify(page.turns);
      if (stream.signature && signature !== stream.signature) this.publish(threadId, "history.changed", {});
      if (this.closed || this.streams.get(threadId) !== stream || !stream.subscribers.size) return;
      stream.signature = signature;
      this.reconcileRequests(threadId, page.turns || [], pending);
      await this.desktopQueueObserver.observe(threadId, page.turns || [], desktopPending,
        () => !this.closed && this.streams.get(threadId) === stream && stream.subscribers.size > 0);
      if (this.closed || this.streams.get(threadId) !== stream || !stream.subscribers.size) return;
      if (stream.lastError) {
        stream.lastError = "";
        this.publish(threadId, "thread.updated", { thread: { id: threadId, syncError: "" } });
      }
    } catch (error) {
      if (this.closed || this.streams.get(threadId) !== stream || !stream.subscribers.size) return;
      // The observer remains connected; the next read retries without any write or resume.
      if (stream.lastError !== error.message) this.publish(threadId, "thread.updated", { thread: { id: threadId, syncError: error.message } });
      stream.lastError = error.message;
    } finally { stream.polling = false; }
  }

  reconcileRequests(threadId, turns, requests = this.requests.list(threadId)) {
    // Removed queue receipts are no longer pending. Exact official identities
    // can still reveal consumption, including after the recent journal window.
    const matched = new Map(requests.map((request) => [request.id, request]));
    for (const turn of turns) for (const item of turn.items || []) {
      if (item.type !== "userMessage" || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.clientId || "") || matched.has(item.clientId)) continue;
      const receipt = this.requests.get(threadId, item.clientId);
      if (receipt?.state === "removed") matched.set(receipt.id, receipt);
    }
    requests = [...matched.values()];
    turns = turns.map((turn) => matchesDesktopQueueTurn(turn, requests) ? observedDesktopQueueTurn(turn) : turn);
    for (const turn of turns) {
      const key = `${threadId}:${turn.id}`, cached = this.terminalTurns.get(key);
      if (cached?.statusSource === "notification") continue;
      if (terminal(turn.status)) this.terminalTurns.set(key, { id: turn.id, status: turn.status,
        error: turn.error, completedAt: turn.completedAt, statusSource: "history" });
      else if (cached && observedDesktopQueueTurn(cached).status === "unknown") this.terminalTurns.delete(key);
    }
    while (this.terminalTurns.size > 128) this.terminalTurns.delete(this.terminalTurns.keys().next().value);
    const pending = requests.filter((request) => request.state === "removed" || !REQUEST_TERMINAL_STATES.has(request.state));
    for (const request of pending) {
      const turn = turns.find((entry) => entry.id === request.turnId || entry.items?.some((item) => item.type === "userMessage" && item.clientId === request.id));
      if (!turn) continue;
      const user = turn.items?.find((item) => item.type === "userMessage" && item.clientId === request.id);
      if (turn.status === "unknown") {
        if (["desktopQueue", "desktopSteer"].includes(request.executionRoute) && (user || request.turnId === turn.id)) {
          const state = ["accepted", "running"].includes(request.state) ? "unknown" :
            ["received", "dispatching", "queued", "removed"].includes(request.state) && user ? "accepted" : request.state;
          if (state !== request.state || request.turnId !== turn.id || user && request.userItemId !== user.id) {
            this.updateRequest(threadId, request.id, { state, turnId: turn.id, userItemId: user?.id || request.userItemId,
              error: state === "unknown" ? { code: "confirmation_required",
                message: "暂时无法确认桌面执行状态，正在继续核对；消息不会重复发送。" } : null });
          }
        }
        continue;
      }
      const state = terminal(turn.status) ? turnState(turn.status) : "running";
      if (request.state !== state || request.turnId !== turn.id || user && request.userItemId !== user.id) {
        this.updateRequest(threadId, request.id, { state, turnId: turn.id, userItemId: user?.id || request.userItemId, error: turn.error || null });
        if (terminal(turn.status)) this.finish(threadId, request.id);
      }
    }
  }

  reconcileItems(threadId, turnId, items) {
    const requests = this.requests.list(threadId);
    const cached = this.terminalTurns.get(`${threadId}:${turnId}`);
    for (const item of items) {
      if (item.type !== "userMessage" || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.clientId || "")) continue;
      const request = requests.find((entry) => entry.id === item.clientId) || this.requests.get(threadId, item.clientId);
      if (!request || request.state !== "removed" && REQUEST_TERMINAL_STATES.has(request.state)) continue;
      const finished = requestTerminalTurn(cached, request) ||
        requests.find((entry) => entry.turnId === turnId && terminal(entry.state));
      const state = finished ? turnState(finished.status || finished.state) : ["desktopQueue", "desktopSteer"].includes(request.executionRoute)
        ? ["received", "dispatching", "queued", "removed"].includes(request.state) ? "accepted" : request.state : "running";
      if (request.state === state && request.turnId === turnId && request.userItemId === item.id) continue;
      this.updateRequest(threadId, request.id, { turnId, userItemId: item.id,
        state, error: finished?.error || (state === "unknown" ? request.error : null) });
      if (finished) this.finish(threadId, request.id);
    }
  }

  recoveryRequests(threadId) {
    return this.requests.list(threadId).filter((request) => ["unknown", "queued"].includes(request.state) &&
      !(request.state === "queued" && request.executionRoute === "settingsQueue")
      || (!this.active.has(threadId) || request.executionRoute === "desktopSteer") && ["dispatching", "accepted", "running"].includes(request.state));
  }

  scheduleRecovery(threadId) {
    if (this.closed || this.recoveryTimers.has(threadId) || !this.recoveryRequests(threadId).length) return;
    const timer = setTimeout(async () => {
      try {
        await this.syncQueue(threadId);
        if (this.closed || !this.recoveryRequests(threadId).length) return;
        const page = await this.reader.listTurns(threadId, { limit: 5 });
        if (this.closed) return;
        this.reconcileRequests(threadId, page.turns || []);
        await this.desktopQuestionRecovery.recover(threadId, this.recoveryRequests(threadId)
          .filter((request) => ["desktopQuestion", "desktopSteer"].includes(request.executionRoute) && request.state === "unknown" && !request.turnId));
        if (this.closed) return;
        if (this.recoveryRequests(threadId).some((request) => ["desktopQueue", "desktopSteer"].includes(request.executionRoute) && !request.turnId)) {
          const latestTurnId = page.turns?.at(-1)?.id || "";
          if (this.queueRecoveryExhausted.get(threadId) !== latestTurnId) {
            const cursor = this.queueRecoveryCursors.get(threadId) || page.olderCursor;
            if (cursor) {
              const older = await this.reader.listTurns(threadId, { limit: 5, cursor });
              if (this.closed) return;
              this.reconcileRequests(threadId, older.turns || []);
              if (older.olderCursor) this.queueRecoveryCursors.set(threadId, older.olderCursor);
              else {
                this.queueRecoveryCursors.delete(threadId);
                this.queueRecoveryExhausted.set(threadId, latestTurnId);
              }
            } else this.queueRecoveryExhausted.set(threadId, latestTurnId);
          }
        } else {
          this.queueRecoveryCursors.delete(threadId);
          this.queueRecoveryExhausted.delete(threadId);
        }
        // A recovered request can refer to a turn older than the latest page.
        // Walk one bounded older page per retry until its official status is found.
        const missingStatus = this.recoveryRequests(threadId).some((request) => {
          const target = request.turnId || request.expectedTurnId;
          if (["desktopQueue", "desktopSteer"].includes(request.executionRoute) && !target) return false;
          return !target || !this.terminalTurns.has(`${threadId}:${target}`)
            && !(page.turns || []).some((turn) => turn.id === target);
        });
        const olderCursor = this.recoveryTurnCursors.get(threadId) || page.olderCursor;
        if (missingStatus && olderCursor) {
          const older = await this.reader.listTurns(threadId, { limit: 5, cursor: olderCursor });
          if (this.closed) return;
          this.reconcileRequests(threadId, older.turns || []);
          if (older.olderCursor) this.recoveryTurnCursors.set(threadId, older.olderCursor);
          else this.recoveryTurnCursors.delete(threadId);
        } else if (!missingStatus) this.recoveryTurnCursors.delete(threadId);
        const targets = new Set(this.recoveryRequests(threadId)
          .filter((request) => !["desktopQuestion", "desktopSteer"].includes(request.executionRoute) || request.turnId)
          .map((request) => request.turnId || request.expectedTurnId).filter(Boolean));
        for (const turnId of targets) {
          if (!this.reader.listItems || this.closed) break;
          const key = `${threadId}:${turnId}`;
          const options = this.recoveryPositions.get(key) || {};
          const items = await this.reader.listItems(threadId, turnId, { limit: 30, ...options });
          if (this.closed) return;
          this.reconcileItems(threadId, turnId, items.items || []);
          if (this.recoveryRequests(threadId).some((request) => (request.turnId || request.expectedTurnId) === turnId)) {
            this.recoveryPositions.set(key, items.nextCursor ? { cursor: items.nextCursor }
              : items.latestItemId ? { after: items.latestItemId } : {});
          } else this.recoveryPositions.delete(key);
        }
      } catch { /* Keep uncertainty visible; never resend when confirmation cannot be read. */ }
      finally {
        this.recoveryTimers.delete(threadId);
        this.releaseStream(threadId);
        this.scheduleRecovery(threadId);
      }
    }, this.recoveryRequests(threadId).every((request) => request.state === "queued")
      ? this.queueRecoveryMs : this.recoveryMs);
    timer.unref?.();
    this.recoveryTimers.set(threadId, timer);
  }

  interrupt(threadId, body) { return this.turnController.interrupt(threadId, body); }

  handleDisconnect() {
    this.desktopQueueSync.disconnect();
    this.loaded.clear();
    for (const threadId of this.trackedRequests) {
      for (const request of this.requests.list(threadId)) if (["dispatching", "accepted", "running"].includes(request.state)) {
        this.updateRequest(threadId, request.id, { state: "unknown", error: { code: "confirmation_required", message: "Codex 连接已断开，正在核对消息状态。不会自动重发。" } });
      }
    }
    this.active.clear();
    for (const threadId of this.streams.keys()) this.releaseStream(threadId);
  }

  shutdown() {
    this.closed = true;
    this.desktopQueueSync.shutdown();
    this.settingsDispatcher.shutdown();
    this.desktopClient.shutdown();
    this.desktopQuestionRecovery.shutdown();
    this.interactions.shutdown();
    this.bridge?.off("notification", this.onNotification);
    this.bridge?.off("disconnected", this.onDisconnect);
    for (const stream of this.streams.values()) { clearInterval(stream.timer); stream.timer = null; }
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    this.handleDisconnect();
  }

  stats() {
    return { activeThreads: this.active.size, subscribedThreads: [...this.streams.values()].filter((stream) => stream.subscribers.size).length,
      unresolvedThreads: this.trackedRequests.size };
  }
}
