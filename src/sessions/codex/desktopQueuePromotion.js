import { resolveImageAttachments } from "../shared/imageAttachments.js";
import { REQUEST_TERMINAL_STATES } from "./requestStore.js";

const fail = (message, code = "request_not_queued", status = 409) => Object.assign(new Error(message), { code, status });
const running = (turn) => ["inProgress", "running"].includes(turn?.status);

// Serialize phone queue actions and journal every irreversible boundary. Never
// retry a delete or delivery whose acknowledgement was lost.
export class DesktopQueuePromotion {
  constructor(service) { this.service = service; this.operations = new Map(); }

  run(threadId, requestId, kind, action) {
    const pending = this.operations.get(threadId);
    if (pending) return pending.requestId === requestId && pending.kind === kind ? pending.promise
      : Promise.reject(fail("正在处理另一条排队消息，请稍后再试。", "queue_action_pending"));
    const promise = Promise.resolve().then(action).finally(() => this.operations.delete(threadId));
    this.operations.set(threadId, { requestId, kind, promise });
    return promise;
  }

  promote(threadId, requestId, expectedTurnId) {
    return this.run(threadId, requestId, "steer", () => this.dispatch(threadId, requestId, expectedTurnId));
  }

  async targetIsCurrent(threadId, expectedTurnId) {
    if (this.service.closed) return false;
    const page = await this.service.reader.listTurns(threadId, { limit: 1 });
    return !this.service.closed && page.turns?.at(-1)?.id === expectedTurnId && running(page.turns.at(-1));
  }

  async dispatch(threadId, requestId, expectedTurnId) {
    const s = this.service;
    let request = s.requests.get(threadId, requestId);
    if (request?.executionRoute === "desktopSteer") return request;
    if (!expectedTurnId || request?.state !== "queued" || request.executionRoute !== "desktopQueue" ||
      request.mode !== "queue" || request.turnId || !request.upstreamQueueId || Object.keys(request.options || {}).length) {
      throw fail("这条消息尚未确认入队、已开始执行或包含下一轮设置，不能引导。");
    }
    if (s.requests.list(threadId).some((item) => item.state === "unknown")) {
      throw fail("请先核对未确认消息的状态。", "confirmation_required");
    }
    const images = resolveImageAttachments(s.config, request.input.attachments);
    const input = [...(request.input.text.trim() ? [{ type: "text", text: request.input.text }] : []),
      ...images.map((image) => ({ type: "localImage", path: image.path }))];
    const owner = await s.desktopClient.discover(threadId);
    if (!owner?.clientId || typeof s.desktopClient.steerMessage !== "function") {
      throw fail("暂时无法连接桌面端，消息仍在队列中。", "desktop_unavailable", 503);
    }
    if (!await this.targetIsCurrent(threadId, expectedTurnId)) throw fail("当前回复已变化，消息仍在队列中。", "turn_not_active");
    const queued = await s.queuedWriter.find(threadId, requestId);
    request = s.requests.get(threadId, requestId);
    if (!queued || queued.id !== request.upstreamQueueId || request.state !== "queued" || s.closed) {
      throw fail("桌面已开始处理这条消息，请等待状态同步。", "queue_already_started");
    }
    s.updateRequest(threadId, requestId, { state: "dispatching", mode: "steer", executionRoute: "desktopSteer",
      expectedTurnId, promotionPhase: "claiming", error: null });
    let claimed = false, sending = false;
    try {
      claimed = await s.queuedWriter.delete(threadId, queued.id);
      if (!claimed) throw fail("排队消息可能已开始执行，请等待状态同步。", "queue_claim_unknown");
      s.updateRequest(threadId, requestId, { promotionPhase: "claimed" });
      const result = await s.desktopClient.steerMessage(threadId, { owner, input, clientUserMessageId: requestId,
        beforeSend: async () => {
          if (!await this.targetIsCurrent(threadId, expectedTurnId)) return false;
          if (s.requests.get(threadId, requestId)?.state !== "dispatching") return false;
          s.updateRequest(threadId, requestId, { promotionPhase: "sending" });
          sending = true;
          return true;
        } });
      if (!sending || typeof result?.turnId !== "string" || !result.turnId) {
        throw Object.assign(new Error("引导回执尚未确认。"), { uncertain: true });
      }
      const current = s.requests.get(threadId, requestId);
      if (!REQUEST_TERMINAL_STATES.has(current.state)) s.updateRequest(threadId, requestId, {
        state: current.state === "running" ? "running" : "accepted", turnId: result.turnId,
        promotionPhase: "accepted", error: null
      });
      // Native follower v1 chooses the current turn. Preserve its actual receipt,
      // including a turn transition, rather than retrying the previous target.
    } catch (error) {
      const current = s.requests.get(threadId, requestId);
      if (["dispatching", "unknown"].includes(current.state) && !current.turnId) {
        const uncertain = !claimed || sending && error.uncertain !== false;
        s.updateRequest(threadId, requestId, { state: uncertain ? "unknown" : "rejected", error: {
          code: uncertain ? "confirmation_required" : "steer_rejected",
          message: uncertain ? "引导结果尚未确认，正在核对原消息，不会重复发送。"
            : `引导未发送：${error.message} 原文已保留，可恢复到输入框。`
        } });
        if (!uncertain) s.finish(threadId, requestId);
      }
    }
    return s.requests.get(threadId, requestId);
  }
}
