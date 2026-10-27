import { createHash, randomUUID } from "node:crypto";
import { INTERACTION_METHODS, capabilityError, validateInteractionParams, validateInteractionResponse } from "./responses.js";
import { canonical, dangerousKey, fields, invalid, object, safeObject } from "./validation.js";
import { latestActivityTimestamp } from "../../history/sessionActivity.js";

const terminal = new Set(["resolved", "unavailable"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const common = ["threadId", "turnId", "itemId", "startedAtMs"];
const displayFields = {
  "item/tool/requestUserInput": [...common, "questions", "isBlocking"],
  "item/commandExecution/requestApproval": [...common, "command", "cwd", "reason", "approvalId", "kind", "environmentId", "commandActions", "additionalPermissions", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"],
  "item/fileChange/requestApproval": [...common, "reason", "grantRoot"],
  "item/permissions/requestApproval": [...common, "cwd", "reason", "permissions", "environmentId"],
  "mcpServer/elicitation/request": [...common, "serverName", "mode", "message", "requestedSchema", "url", "elicitationId", "title", "description"]
};
/** Volatile callback state is separate from the durable journal of user messages. */
export class CodexInteractionService {
  constructor({ bridge, ownsThread, publish = () => {}, maxPending = 128, maxPerThread = 32, maxTerminal = 256 } = {}) {
    this.bridge = bridge;
    this.ownsThread = ownsThread || (() => false);
    this.publish = publish;
    this.epoch = randomUUID();
    this.revision = 0;
    this.records = new Map();
    this.evidence = new Map();
    this.maxPending = maxPending;
    this.maxPerThread = maxPerThread;
    this.maxTerminal = maxTerminal;
    this.closed = false;
    this.onResolved = (request) => this.end(request, "resolved");
    this.onInvalidated = (request, reason) => this.end(request, "unavailable", { code: reason, message: "This request is no longer available on its original Codex connection." });
    this.onNotification = (message) => this.handleNotification(message);
    this.onDisconnect = () => bridge?.inbound?.invalidate();
    this.releaseHandler = bridge?.inbound?.setHandler((request) => this.receive(request));
    bridge?.inbound?.on("resolved", this.onResolved);
    bridge?.inbound?.on("invalidated", this.onInvalidated);
    bridge?.on("notification", this.onNotification);
    bridge?.on("disconnected", this.onDisconnect);
  }

  dto(record) { return structuredClone(record.public); }
  envelope(record) { return { interaction: this.dto(record), epoch: this.epoch, revision: this.revision }; }

  list(threadId) {
    return { interactions: [...this.records.values()].filter((record) => record.public.threadId === threadId).map((record) => this.dto(record)), epoch: this.epoch, revision: this.revision };
  }

  record(threadId, id) {
    const record = this.records.get(id);
    if (!record || record.public.threadId !== threadId) throw invalid("Interaction not found", "interaction_not_found", 404);
    return record;
  }

  get(threadId, id) { return this.envelope(this.record(threadId, id)); }

  update(record, patch = {}) {
    const current = record.public;
    record.public = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    this.revision += 1;
    try { this.publish(current.threadId, "interaction.updated", this.envelope(record)); }
    catch { /* Observers do not determine callback ownership or execution. */ }
    this.prune();
  }

  receive(request) {
    if (this.closed || !INTERACTION_METHODS.has(request.method) || !this.ownsThread(request.params.threadId)) return false;
    const { method, params } = request;
    if (Buffer.byteLength(JSON.stringify(params)) > 512 * 1024) {
      request.reject(-32602, "User interaction exceeds the 512 KiB limit").catch(() => {});
      return true;
    }
    const pending = [...this.records.values()].filter((record) => !terminal.has(record.public.status));
    if (pending.length >= this.maxPending || pending.filter((record) => record.public.threadId === params.threadId).length >= this.maxPerThread) {
      request.reject(-32001, "Too many pending user interactions; existing requests remain available").catch(() => {});
      return true;
    }
    try { safeObject(params); }
    catch { request.reject(-32602, "Invalid user interaction fields").catch(() => {}); return true; }
    if (typeof params.threadId !== "string" || !params.threadId || params.turnId != null && typeof params.turnId !== "string") {
      request.reject(-32602, "Invalid user interaction identity").catch(() => {});
      return true;
    }
    try { validateInteractionParams(method, params); }
    catch { request.reject(-32602, "Invalid original user interaction parameters").catch(() => {}); return true; }
    const toolInputInvalid = method === "item/tool/requestUserInput" && (typeof params.isBlocking !== "boolean"
      || !Array.isArray(params.questions) || params.questions.some((question) => typeof question.id !== "string" || !question.id || dangerousKey(question.id))
      || new Set(params.questions.map((question) => question.id)).size !== params.questions.length);
    if (method !== "mcpServer/elicitation/request" && (!params.turnId || typeof params.itemId !== "string" || !params.itemId)
      || method === "item/permissions/requestApproval" && !object(params.permissions) || toolInputInvalid) {
      request.reject(-32602, "Invalid user interaction parameters").catch(() => {});
      return true;
    }
    const now = new Date().toISOString();
    const projected = Object.fromEntries(displayFields[method].filter((key) => Object.hasOwn(params, key)).map((key) => [key, structuredClone(params[key])]));
    const record = { request, claim: null, public: { id: request.id, threadId: params.threadId, turnId: params.turnId || null,
      itemId: params.itemId || null, method, params: projected, status: "pending", version: 0, createdAt: now, updatedAt: now } };
    const error = capabilityError(method, params);
    if (error) record.public.error = error;
    const evidence = this.evidence.get(this.evidenceKey(record.public));
    if (evidence) record.public.item = structuredClone(evidence);
    this.records.set(request.id, record);
    this.update(record);
    return true;
  }

  async respond(threadId, id, body) {
    fields(body, ["responseId", "response"]);
    if (!uuid.test(body.responseId || "")) throw invalid("A UUID response ID is required");
    if (Buffer.byteLength(JSON.stringify(body.response) || "") > 1024 * 1024) throw invalid("Interaction response exceeds the 1 MiB limit", "interaction_response_too_large", 413);
    const record = this.record(threadId, id);
    const response = validateInteractionResponse(record.public.method, record.public.params, body.response);
    const digest = createHash("sha256").update(JSON.stringify(canonical(response))).digest("hex");
    if (record.claim) {
      if (record.claim.responseId !== body.responseId || record.claim.digest !== digest) throw invalid("This interaction has already been handled", "interaction_response_conflict", 409);
      await record.completion;
      return this.envelope(record);
    }
    if (this.closed || record.public.status !== "pending" || !record.request.isCurrent()) throw invalid("This interaction is no longer available", "interaction_unavailable", 409);
    const request = record.request;
    record.claim = { responseId: body.responseId, digest };
    this.update(record, { status: "submitting", error: undefined });
    if (record.public.status !== "submitting" || !request.isCurrent()) return this.envelope(record);
    record.completion = request.respond(response).then(() => {
      if (record.public.status === "submitting") this.update(record, { status: "submitted" });
    }, () => {
      if (record.public.status === "submitting") this.update(record, { status: "unknown", error: { code: "response_delivery_uncertain", message: "The response delivery could not be confirmed. Check this request without resubmitting." } });
    });
    await record.completion;
    return this.envelope(record);
  }

  end(request, status, error) {
    const record = this.records.get(request.id);
    if (!record || terminal.has(record.public.status)) return;
    record.request = null;
    this.update(record, { status, error });
  }

  reconcileTurns(threadId, turns) {
    if (this.closed) return;
    const completed = new Set(turns.filter((turn) =>
      typeof turn.id === "string" && turn.id && (turn.threadId == null || turn.threadId === threadId)
      && turn.statusConfirmed !== false && turn.statusSource !== "unconfirmed-history"
      && (["completed", "failed"].includes(turn.status)
        || ["interrupted", "aborted", "cancelled"].includes(turn.status) && latestActivityTimestamp(turn.completedAt)))
      .map((turn) => turn.id));
    // A terminal history read proves the callback is obsolete, not that its answer was received.
    for (const record of this.records.values()) {
      if (record.public.threadId !== threadId || !completed.has(record.public.turnId) || terminal.has(record.public.status)) continue;
      this.bridge.inbound?.invalidateRequest(record.request, "turn_completed");
    }
  }

  evidenceKey({ threadId, turnId, itemId }) { return JSON.stringify([threadId, turnId, itemId]); }

  handleNotification({ method, params = {} } = {}) {
    if (this.closed) return;
    if (method === "serverRequest/resolved") { this.bridge.inbound?.resolve(params); return; }
    const threadId = params.threadId;
    if (["item/started", "item/completed"].includes(method) && params.item?.type === "fileChange") {
      const item = Object.fromEntries(["id", "type", "status", "changes"].filter((key) => Object.hasOwn(params.item, key)).map((key) => [key, structuredClone(params.item[key])]));
      if (Buffer.byteLength(JSON.stringify(item)) <= 1024 * 1024) {
        const identity = { threadId, turnId: params.turnId, itemId: item.id };
        this.evidence.set(this.evidenceKey(identity), item);
        while (this.evidence.size > 32) this.evidence.delete(this.evidence.keys().next().value);
        for (const record of this.records.values()) if (!terminal.has(record.public.status) && this.evidenceKey(record.public) === this.evidenceKey(identity)) this.update(record, { item });
      }
    }
    if (method !== "thread/closed" && method !== "turn/completed") return;
    const turnId = params.turn?.id || params.turnId;
    for (const record of this.records.values()) {
      if (record.public.threadId !== threadId || terminal.has(record.public.status)) continue;
      if (method === "turn/completed" && (!record.public.turnId || record.public.turnId !== turnId)) continue;
      this.bridge.inbound?.invalidateRequest(record.request, method === "thread/closed" ? "thread_closed" : "turn_completed");
    }
  }

  prune() {
    const completed = [...this.records].filter(([, record]) => terminal.has(record.public.status));
    for (const [id] of completed.slice(0, Math.max(0, completed.length - this.maxTerminal))) this.records.delete(id);
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.releaseHandler?.();
    this.bridge?.off("notification", this.onNotification);
    this.bridge?.off("disconnected", this.onDisconnect);
    for (const record of this.records.values()) if (!terminal.has(record.public.status)) this.bridge?.inbound?.invalidateRequest(record.request, "service_shutdown");
    this.bridge?.inbound?.off("resolved", this.onResolved);
    this.bridge?.inbound?.off("invalidated", this.onInvalidated);
    this.evidence.clear();
  }
}
