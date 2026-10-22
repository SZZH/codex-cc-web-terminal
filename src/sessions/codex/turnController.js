const activeTurn = (turn) => ["inProgress", "running"].includes(turn?.status);
const terminalTurn = (turn) => ["completed", "failed", "interrupted", "aborted"].includes(turn?.status);
const failure = (message, status = 409, code = "turn_not_active") => Object.assign(new Error(message), { status, code });

// Route stop to the runtime that owns execution. A desktop stop always names
// the turn the user saw; a late click must never stop its successor.
export class CodexTurnController {
  constructor(service) { this.service = service; this.pending = new Map(); }

  interrupt(threadId, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body) || body.expectedTurnId != null &&
      (typeof body.expectedTurnId !== "string" || !body.expectedTurnId.trim() || body.expectedTurnId.length > 512)) {
      return Promise.reject(failure("停止请求缺少有效的回复编号，请刷新后重试。", 400, "invalid_turn_id"));
    }
    const service = this.service;
    const owned = service.active.get(threadId);
    const isOwned = owned?.turnId && !["desktopQueue", "desktopQuestion", "desktopSettings"]
      .includes(service.requests.get(threadId, owned.requestId)?.executionRoute);
    // Older clients may omit the ID only for a known web-owned turn.
    const expectedTurnId = body.expectedTurnId ?? (isOwned ? owned.turnId : null);
    if (!expectedTurnId) return Promise.reject(failure("当前回复状态尚未确认，请刷新后停止。"));
    const key = `${threadId}:${expectedTurnId}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.dispatch(threadId, expectedTurnId, isOwned ? owned : null)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async dispatch(threadId, expectedTurnId, owned) {
    const service = this.service;
    if (service.closed) throw failure("服务正在重启，请稍后重试。", 503, "service_unavailable");
    if (owned) {
      if (owned.turnId !== expectedTurnId) throw failure("当前回复已变化，请刷新后再停止。");
      await service.bridge.request("turn/interrupt", { threadId, turnId: expectedTurnId });
      return { ok: true, turnId: expectedTurnId };
    }
    const [page, owner] = await Promise.all([
      service.reader.listTurns(threadId, { limit: 1 }), service.desktopClient.discover(threadId)
    ]);
    const latest = page.turns?.at(-1);
    if (!latest || latest.id !== expectedTurnId || terminalTurn(latest)) return { ok: true, turnId: null };
    if (!activeTurn(latest)) throw failure("当前回复状态尚未确认，请稍后重试。");
    if (!owner?.clientId) throw failure("暂时无法连接 Codex 桌面端，请保持桌面端运行后重试。", 503, "desktop_unavailable");
    if (service.closed) throw failure("服务正在重启，请稍后重试。", 503, "service_unavailable");
    try {
      return await service.desktopClient.interruptTurn(threadId, { owner, expectedTurnId });
    } catch (error) {
      if (error.uncertain) throw failure("停止请求的结果尚未确认，正在同步任务状态。", 503, "interrupt_unconfirmed");
      throw error;
    }
  }
}
