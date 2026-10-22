import { buildAppServerTurnOptions } from "../shared/appServerOptions.js";
import { resolveImageAttachments } from "../shared/imageAttachments.js";

const terminal = (state) => ["completed", "failed", "interrupted", "aborted"].includes(state);
export const hasSubmissionSettings = (request) => Object.keys(request.options || {}).length > 0;

// The official queue stores input only. Keep messages with explicit settings in
// our durable request journal until they can start a new turn with that snapshot.
export class CodexSettingsDispatcher {
  constructor(service, { retryMs = 1500 } = {}) {
    this.service = service;
    this.retryMs = retryMs;
    this.timers = new Map();
  }

  defer(threadId, request) {
    const service = this.service;
    if (service.closed) return;
    if (service.requests.get(threadId, request.id)?.state !== "queued")
      service.updateRequest(threadId, request.id, { state: "queued", executionRoute: "settingsQueue", error: null });
    if (service.active.get(threadId)?.requestId === request.id) service.active.delete(threadId);
    this.schedule(threadId);
  }

  schedule(threadId) {
    if (this.service.closed || this.timers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.service.dispatchNext(threadId);
    }, this.retryMs);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  async dispatchDesktop(threadId, request, session) {
    const service = this.service;
    // Read execution, rather than inferring it from desktop ownership. A desktop
    // can retain the writer while its last turn is already completed.
    const page = await service.reader.listTurns(threadId, { limit: 1 });
    const latest = page.turns?.at(-1);
    if (latest && !terminal(latest.status)) { this.defer(threadId, request); return; }
    // Do not overtake an existing native queue or alter its settings.
    const queued = await service.queuedWriter.list(threadId);
    if (queued.length) { this.defer(threadId, request); return; }
    const owner = await service.desktopClient.discover(threadId);
    if (!owner?.supportsUntrustedAppInput) throw new Error("无法连接此会话的 Codex 桌面端，请保持桌面端运行后重试。");
    const images = resolveImageAttachments(service.config, request.input.attachments);
    const current = service.requests.get(threadId, request.id);
    if (service.closed || !["dispatching", "queued"].includes(current?.state)) return;
    // Mark the mutation durably before writing. A lost receipt is reconciled by
    // clientUserMessageId and is never automatically retried.
    service.updateRequest(threadId, request.id, { state: "dispatching", executionRoute: "desktopSettings" });
    try {
      const result = await service.desktopClient.startMessage(threadId, { owner, clientUserMessageId: request.id,
        settings: buildAppServerTurnOptions(session),
        beforeSend: async () => {
          const fresh = await service.reader.listTurns(threadId, { limit: 1 });
          const last = fresh.turns?.at(-1);
          const queue = await service.queuedWriter.list(threadId);
          return !service.closed && last?.id === latest?.id && (!last || terminal(last.status)) && !queue.length &&
            service.requests.get(threadId, request.id)?.state === "dispatching";
        }, input: [
          ...(request.input.text.trim() ? [{ type: "text", text: request.input.text, text_elements: [] }] : []),
          ...images.map((image) => ({ type: "localImage", path: image.path }))
        ] });
      if (!result?.turnId) throw Object.assign(new Error("消息的接收状态尚未确认。"), { uncertain: true });
      service.updateRequest(threadId, request.id, { state: "accepted", turnId: result.turnId, error: null });
    } catch (error) {
      if (error.code === "CODEX_DESKTOP_NOT_IDLE") { this.defer(threadId, request); return; }
      service.updateRequest(threadId, request.id, { state: error.uncertain ? "unknown" : "rejected", error: {
        code: error.uncertain ? "confirmation_required" : error.code || "desktop_send_rejected",
        message: error.uncertain ? "消息接收状态尚未确认，正在核对；不会自动重发。" : error.message
      } });
      if (!error.uncertain) service.finish(threadId, request.id);
    } finally {
      if (service.active.get(threadId)?.requestId === request.id) service.active.delete(threadId);
      service.scheduleRecovery(threadId);
    }
  }

  shutdown() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
