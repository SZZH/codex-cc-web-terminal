import { spawn, spawnSync } from "node:child_process";

import { buildEventPartFromItem } from "../history/historicalPayloads.js";
import { extractAgentTextFromItem, extractTurnItems, isAgentMessageType, normalizeSymbolToken, nowIso } from "../shared/text.js";
import { assertPermissionModeSupported, buildCodexPermissionArgs } from "../shared/composerOptions.js";
import { normalizeRunnerInput } from "../shared/imageAttachments.js";
import {
  beginRunnerTurn,
  completeAppServerInterruption,
  completeJsonExecInterruption,
  isInterruptedTurn,
  observeAppServerTurn,
  settleRunnerTurn
} from "../control/sessionInterrupt.js";

const STDERR_NOISE_PATTERNS = [
  /codex_core_plugins?::manifest:/i,
  /ignoring interface\.defaultPrompt:/i,
  /prompt must be at most 128 characters/i,
  /maximum of 3 prompts is supported/i,
  /\[MODULE_TYPELESS_PACKAGE_JSON]/i
];

const imageCliSupport = new Map();

function extractOutputText(item) {
  const text = extractAgentTextFromItem(item);
  return text && typeof item?.text === "string" ? item.text : text;
}

function assertCliImageSupport(manager, session) {
  const args = ["exec", ...(session.resumeSessionId ? ["resume"] : []), "--help"];
  const key = JSON.stringify([manager.config.codexBin, args]);
  if (!imageCliSupport.has(key)) {
    const result = spawnSync(manager.config.codexBin, args, { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
    imageCliSupport.set(key, result.status === 0 && /--image\b/.test(String(result.stdout || "")));
  }
  if (!imageCliSupport.get(key)) {
    throw new Error("Installed Codex CLI does not support image attachments in this exec mode. Upgrade Codex or enable app-server.");
  }
}

function emitNoReplyFallback(manager, session, turnId = "") {
  if (!session || session.turnNoReplyNotified) {
    return;
  }
  session.turnNoReplyNotified = true;
  manager.broadcast(session, {
    type: "message_part",
    role: "system",
    part: { type: "text", text: "本轮未返回可展示文本。" },
    phase: "final",
    timestamp: nowIso()
  });
  const targetTurnId = String(turnId || session.currentTurnId || session.threadSnapshot?.activeTurnId || session.conversationState?.activeTurnId || "").trim();
  manager.applyConversationRecord(session, {
    type: "message_part",
    role: "system",
    part: { type: "event", rawType: "system", summary: "本轮未返回可展示文本。", payload: { message: "本轮未返回可展示文本。" } },
    phase: "final",
    timestamp: nowIso()
  }, { turnId: targetTurnId });
  const targetTurn = Array.isArray(session.threadSnapshot?.turns)
    ? session.threadSnapshot.turns.find((item) => String(item?.id || "").trim() === targetTurnId)
    : null;
  if (targetTurn) {
    targetTurn.items ||= [];
    if (!targetTurn.items.some((item) => String(item?.id || "") === `no-reply:${targetTurnId}`)) {
      targetTurn.items.push({
        id: `no-reply:${targetTurnId}`,
        kind: "SystemEvent",
        status: "completed",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: "session_manager",
        summary: "本轮未返回可展示文本。",
        text: "本轮未返回可展示文本。",
        payload: { message: "本轮未返回可展示文本。" },
        meta: {}
      });
      manager.syncConversationStateFromThreadSnapshot(session);
      manager.broadcastConversationSnapshot(session);
    }
  }
}

function nestedErrorMessage(value, depth = 0) {
  if (depth > 5 || value == null) return "";
  if (typeof value === "object") {
    return nestedErrorMessage(value.error, depth + 1) || nestedErrorMessage(value.message, depth + 1);
  }
  const text = String(value).trim();
  try {
    const start = text.indexOf("{");
    const parsed = JSON.parse(start >= 0 ? text.slice(start) : text);
    return typeof parsed === "object" ? nestedErrorMessage(parsed, depth + 1) : "";
  } catch {
    return text.startsWith("{") ? "" : text;
  }
}

export function normalizeAppServerErrorMessage(error = {}) {
  const primary = nestedErrorMessage(error?.message) || String(error?.message || "").trim();
  const extra = String(error?.additionalDetails || "").trim();
  const readableExtra = nestedErrorMessage(extra) || extra;
  if (primary && readableExtra && !readableExtra.includes(primary)) {
    return `${primary} ${readableExtra}`.trim();
  }
  return primary || readableExtra || nestedErrorMessage(error?.error) || "未知错误";
}

function normalizeExecutionError(error = {}) {
  const rawMessage = String(error?.message || (typeof error === "string" ? error : "")).trim();
  const message = normalizeAppServerErrorMessage(typeof error === "string" ? { message: error } : error);
  return {
    ...(error && typeof error === "object" ? error : {}),
    message,
    ...(rawMessage && rawMessage !== message ? { rawMessage } : {})
  };
}

function normalizeTurnResultStatus(result = {}) {
  return normalizeSymbolToken(result?.turn?.status || result?.status || "");
}

function normalizeTurnResultError(result = {}) {
  const error = result?.turn?.error || result?.error || null;
  return error && typeof error === "object" ? error : null;
}

function emitAppServerError(manager, session, error = {}, timestamp = nowIso()) {
  const details = normalizeAppServerErrorMessage(error);
  const text = `Codex 执行失败：${details}`;
  broadcastTypedTransportError(manager, session, {}, {
    message: text,
    code: String(error?.code || "app_server_error"),
    payload: error
  });
  manager.broadcast(session, {
    type: "message_part",
    role: "system",
    part: { type: "text", text },
    phase: "final",
    timestamp
  });
  manager.applyConversationRecord(session, {
    type: "message_part",
    role: "system",
    part: {
      type: "event",
      rawType: "error",
      summary: text,
      payload: {
        message: details,
        ...(error && typeof error === "object" ? error : {})
      }
    },
    phase: "final",
    timestamp
  });
}

function summarizeTurnResult(result) {
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return String(result || "").slice(0, 2000);
  }
}

function summarizeNotification(msg) {
  try {
    return JSON.stringify(msg).slice(0, 2000);
  } catch {
    return String(msg || "").slice(0, 2000);
  }
}

function summarizeRawNotificationPayload(params = {}) {
  return String(
    params?.delta ||
    params?.output ||
    params?.chunk ||
    params?.text ||
    params?.message ||
    params?.summary ||
    params?.content ||
    params?.name ||
    params?.status ||
    ""
  ).trim();
}

function clearPendingTurnCompletion(session) {
  if (!session?.pendingTurnCompletion) {
    return;
  }
  clearTimeout(session.pendingTurnCompletion.timer);
  session.pendingTurnCompletion = null;
}

function schedulePendingTurnCompletion(manager, session, params = {}, { status = "completed", error = null, delayMs = 1200 } = {}) {
  if (!manager || !session) {
    return;
  }
  const explicitTurnId = String(params?.turnId || params?.turn_id || params?.turn?.id || "").trim();
  const turnId = String(
    explicitTurnId ||
      session.currentTurnId ||
      session.threadSnapshot?.activeTurnId ||
      session.conversationState?.activeTurnId ||
      ""
  ).trim();
  if (!turnId) {
    return;
  }
  const existingTurn = session.threadSnapshot?.turns?.find((turn) => String(turn.id) === turnId);
  if (existingTurn && ["completed", "failed", "aborted", "interrupted"].includes(String(existingTurn.status))) {
    return;
  }
  const failure = status === "failed" || error ? normalizeExecutionError(error || { message: "turn failed" }) : null;
  if (completeAppServerInterruption(manager, session, { ...params, turnId, status, error })) {
    return;
  }
  clearPendingTurnCompletion(session);
  const completeTurn = () => {
    session.pendingTurnCompletion = null;
    if (completeAppServerInterruption(manager, session, { ...params, turnId, status, error })) {
      return;
    }
    const completedAt = nowIso();
    session.updatedAt = completedAt;
    const knownExplicitTurn = !explicitTurnId || manager.hasConversationTurn?.(session, turnId);
    const completesActiveTurn =
      !explicitTurnId ||
      [session.currentTurnId, session.activePendingTurnId, session.threadSnapshot?.activeTurnId, session.conversationState?.activeTurnId]
        .map((value) => String(value || "").trim())
        .includes(turnId);

    if (explicitTurnId && !knownExplicitTurn) {
      broadcastTypedTurnLifecycle(manager, session, { ...params, turnId }, {
        type: status === "failed" || error ? "turn.failed" : "turn.completed",
        status: status === "failed" || error ? "failed" : "completed",
        error: failure
      });
      manager.scheduleConversationHistoryResync(session);
      manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
      return;
    }

    if (completesActiveTurn) {
      session.turnRunning = false;
      settleRunnerTurn(session, turnId, status === "failed" || error ? "failed" : "completed");
    }
    const finalizeOptions = explicitTurnId ? { turnId } : {};
    if (status === "failed" || error) {
      broadcastTypedTurnLifecycle(manager, session, { ...params, turnId }, {
        type: "turn.failed",
        status: "failed",
        error: failure
      });
      emitAppServerError(manager, session, failure, completedAt);
      manager.finalizeConversationTurn(session, "failed", completedAt, { ...finalizeOptions, error: failure });
    } else {
      const shouldEmitNoReplyFallback = !session.turnHadVisibleOutput;
      broadcastTypedTurnLifecycle(manager, session, { ...params, turnId }, {
        type: "turn.completed",
        status: "completed"
      });
      const finalized = manager.finalizeConversationTurn(session, "completed", completedAt, finalizeOptions);
      if (finalized && shouldEmitNoReplyFallback) {
        emitNoReplyFallback(manager, session, turnId);
      }
    }
    manager.scheduleConversationHistoryResync(session);
    manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
    startAppServerTurn(manager, session);
  };
  if (Number(delayMs) <= 0) {
    completeTurn();
    return;
  }
  session.pendingTurnCompletion = {
    turnId,
    status,
    error,
    timer: setTimeout(completeTurn, Math.max(0, Number(delayMs) || 0))
  };
  session.pendingTurnCompletion.timer.unref?.();
}

function extendPendingTurnCompletion(manager, session, params = {}, delayMs = 1200) {
  if (!session?.pendingTurnCompletion) {
    return;
  }
  const pendingTurnId = String(session.pendingTurnCompletion.turnId || "").trim();
  const resolvedTurnId = String(
    params?.turnId ||
      params?.turn_id ||
      session.currentTurnId ||
      session.threadSnapshot?.activeTurnId ||
      session.conversationState?.activeTurnId ||
      ""
  ).trim();
  if (!pendingTurnId || !resolvedTurnId || pendingTurnId !== resolvedTurnId) {
    return;
  }
  schedulePendingTurnCompletion(manager, session, { ...params, turnId: resolvedTurnId }, {
    status: session.pendingTurnCompletion.status,
    error: session.pendingTurnCompletion.error,
    delayMs
  });
}

function resolveSessionThreadId(session, params = {}) {
  return String(
    params?.threadId ||
    params?.thread_id ||
    session.resumeSessionId ||
    session.threadSnapshot?.threadId ||
    session.conversationState?.threadId ||
    ""
  ).trim();
}

function resolveSessionTurnId(session, params = {}) {
  return String(
    params?.turnId ||
    params?.turn_id ||
    session.currentTurnId ||
    session.threadSnapshot?.activeTurnId ||
    session.conversationState?.activeTurnId ||
    ""
  ).trim();
}

function resolveAppServerTurnId(manager, session, params = {}) {
  const serverTurnId = String(
    params?.turnId ||
      params?.turn_id ||
      params?.turn?.id ||
      params?.turn?.turnId ||
      params?.turn?.turn_id ||
      params?.item?.turnId ||
      params?.item?.turn_id ||
      ""
  ).trim();
  const activePendingTurnId = String(session?.activePendingTurnId || "").trim();
  const currentTurnId = String(session?.currentTurnId || "").trim();
  const pendingLocalTurnIds = session?.pendingLocalTurnIds instanceof Set ? session.pendingLocalTurnIds : new Set();
  if (!serverTurnId) {
    if (session?.turnRunning && activePendingTurnId && activePendingTurnId === currentTurnId && pendingLocalTurnIds.has(activePendingTurnId)) {
      return { turnId: activePendingTurnId, clientTurnId: "", aliasSource: "active-pending-turn-fallback" };
    }
    return { turnId: "", clientTurnId: "", aliasSource: "" };
  }

  if (activePendingTurnId && activePendingTurnId === currentTurnId && pendingLocalTurnIds.has(activePendingTurnId)) {
    if (activePendingTurnId !== serverTurnId && session?.turnRunning) {
      const bound = manager.bindConversationTurnAlias?.(session, activePendingTurnId, serverTurnId, {
        source: "active-pending-turn"
      });
      if (bound) {
        observeAppServerTurn(manager, session, { turnId: serverTurnId });
      }
      return bound ? { turnId: serverTurnId, clientTurnId: activePendingTurnId, aliasSource: "active-pending-turn" } : { turnId: "", clientTurnId: "", aliasSource: "" };
    }
  }
  observeAppServerTurn(manager, session, { turnId: serverTurnId });
  return { turnId: serverTurnId, clientTurnId: "", aliasSource: "" };
}

function applyAppServerConversationRecord(manager, session, params = {}, record = null) {
  const resolved = resolveAppServerTurnId(manager, session, params);
  if (!resolved.turnId || !record) {
    return false;
  }
  manager.applyConversationRecord(
    session,
    {
      ...record,
      clientTurnId: resolved.clientTurnId,
      aliasSource: resolved.aliasSource
    },
    { turnId: resolved.turnId }
  );
  return true;
}

function broadcastTypedEvent(manager, session, payload = null) {
  if (!manager || !session || !payload || typeof payload !== "object") {
    return false;
  }
  manager.broadcast(session, payload);
  return true;
}

function buildTypedEventContext(session, params = {}) {
  return {
    sessionId: String(session?.id || "").trim(),
    threadId: resolveSessionThreadId(session, params),
    turnId: resolveSessionTurnId(session, params),
    ts: nowIso()
  };
}

function broadcastTypedMessage(manager, session, params = {}, {
  type = "message.completed",
  text = "",
  role = "assistant",
  format = "markdown",
  phase = "completed"
} = {}) {
  const { sessionId, threadId, turnId, ts } = buildTypedEventContext(session, params);
  const normalizedText = String(text ?? "");
  if (!sessionId || !threadId || !turnId || !normalizedText) {
    return false;
  }
  return broadcastTypedEvent(manager, session, {
    type,
    sessionId,
    threadId,
    turnId,
    role,
    text: normalizedText,
    format,
    ts,
    phase
  });
}

function splitStreamingText(text = "", chunkSize = 80) {
  const chars = Array.from(String(text || ""));
  const size = Math.max(20, Number(chunkSize) || 80);
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks.filter((chunk) => chunk.length);
}

function streamCompletedMessageAsDeltas(manager, session, params = {}, text = "") {
  const chunks = splitStreamingText(text);
  if (chunks.length <= 1) {
    return false;
  }
  for (const chunk of chunks) {
    applyAppServerConversationRecord(manager, session, params, {
      type: "message_part",
      role: "assistant",
      part: { type: "text", text: chunk, format: "markdown" },
      messageId: params?.itemId || params?.item_id || params?.item?.id || "",
      phase: "streaming",
      timestamp: nowIso()
    });
  }
  return true;
}

function broadcastTypedTurnLifecycle(manager, session, params = {}, {
  type = "turn.completed",
  status = "",
  error = null
} = {}) {
  const { sessionId, threadId, turnId, ts } = buildTypedEventContext(session, params);
  if (!sessionId || !threadId || !turnId) {
    return false;
  }
  return broadcastTypedEvent(manager, session, {
    type,
    sessionId,
    threadId,
    turnId,
    status: String(status || "").trim() || undefined,
    error: error && typeof error === "object" ? error : undefined,
    ts
  });
}

function broadcastTypedThreadState(manager, session, params = {}, {
  type = "thread.status.updated",
  status = "",
  metrics = null,
  payload = null
} = {}) {
  const { sessionId, threadId, turnId, ts } = buildTypedEventContext(session, params);
  if (!sessionId || !threadId) {
    return false;
  }
  return broadcastTypedEvent(manager, session, {
    type,
    sessionId,
    threadId,
    turnId: turnId || undefined,
    status: String(status || "").trim() || undefined,
    metrics: metrics && typeof metrics === "object" ? metrics : undefined,
    payload: payload && typeof payload === "object" ? payload : undefined,
    ts
  });
}

function broadcastTypedTransportError(manager, session, params = {}, {
  message = "",
  code = "",
  payload = null
} = {}) {
  const { sessionId, threadId, turnId, ts } = buildTypedEventContext(session, params);
  const normalizedMessage = String(message || "").trim();
  if (!sessionId || !threadId || !normalizedMessage) {
    return false;
  }
  return broadcastTypedEvent(manager, session, {
    type: "transport.error",
    sessionId,
    threadId,
    turnId: turnId || undefined,
    message: normalizedMessage,
    code: String(code || "").trim() || undefined,
    payload: payload && typeof payload === "object" ? payload : undefined,
    ts
  });
}

function broadcastTypedProcess(manager, session, params = {}, {
  type = "process.completed",
  processType = "event",
  processId = "",
  summary = "",
  payload = null,
  phase = "completed"
} = {}) {
  const { sessionId, threadId, turnId, ts } = buildTypedEventContext(session, params);
  const text = String(summary || summarizeRawNotificationPayload(params)).trim();
  if (!sessionId || !turnId || !threadId || !text) {
    return false;
  }
  return broadcastTypedEvent(manager, session, {
    type,
    sessionId,
    threadId,
    turnId,
    processId: String(processId || params?.id || params?.itemId || params?.item_id || processType).trim(),
    processType,
    summary: text,
    payload: payload || params,
    ts,
    phase
  });
}

function applyTypedProcessToConversation(manager, session, params = {}, processEvent = null) {
  if (!processEvent?.summary) {
    return false;
  }
  const partType = String(processEvent.processType || "event").includes("tool") ? "tool" : "event";
  return applyAppServerConversationRecord(manager, session, params, {
    type: "message_part",
    role: "assistant",
    part: {
      type: partType,
      rawType: processEvent.processType || "event",
      summary: String(processEvent.summary || ""),
      text: String(processEvent.summary || ""),
      payload: processEvent.payload || params
    },
    phase: processEvent.phase || "completed",
    timestamp: nowIso()
  });
}

function classifyTypedProcessFromNotification(method = "", normalizedMethod = "", params = {}) {
  const run = params?.run || {};
  const item = params?.item || {};

  if (method === "hook/started" || normalizedMethod === "hookstarted") {
    return {
      type: "process.started",
      processType: "hook",
      processId: String(run?.id || "hook"),
      summary: `${String(run?.eventName || "hook")} started`,
      payload: run,
      phase: "streaming"
    };
  }
  if (method === "hook/completed" || normalizedMethod === "hookcompleted") {
    return {
      type: "process.completed",
      processType: "hook",
      processId: String(run?.id || "hook"),
      summary: `${String(run?.eventName || "hook")} completed`,
      payload: run,
      phase: "completed"
    };
  }
  if (method === "item/started" || normalizedMethod === "itemstarted") {
    const itemType = normalizeSymbolToken(item?.type || "");
    if (!itemType || itemType === "usermessage" || itemType === "agentmessage" || itemType === "reasoning") {
      return null;
    }
    return {
      type: "process.started",
      processType: itemType,
      processId: String(item?.id || itemType),
      summary: `${String(item?.type || "item")} started`,
      payload: item,
      phase: "streaming"
    };
  }
  if (method === "item/completed" || normalizedMethod === "itemcompleted") {
    const itemType = normalizeSymbolToken(item?.type || "");
    if (!itemType || itemType === "usermessage" || itemType === "agentmessage" || itemType === "reasoning") {
      return null;
    }
    return {
      type: "process.completed",
      processType: itemType,
      processId: String(item?.id || itemType),
      summary: summarizeRawNotificationPayload(item) || `${String(item?.type || "item")} completed`,
      payload: item,
      phase: "completed"
    };
  }
  if (normalizedMethod.includes("commandexecutionoutputdelta")) {
    return {
      type: "process.delta",
      processType: "command_execution",
      processId: String(params?.itemId || params?.item_id || params?.processId || params?.process_id || "command_execution"),
      summary: String(params?.delta || "").trim(),
      payload: params,
      phase: "streaming"
    };
  }
  if (normalizedMethod.includes("commandexecutionterminalinteraction")) {
    return {
      type: "process.delta",
      processType: "command_execution",
      processId: String(params?.itemId || params?.item_id || params?.processId || params?.process_id || "command_execution"),
      summary: String(params?.stdin || "").trim() || "terminal interaction",
      payload: params,
      phase: "streaming"
    };
  }
  if (normalizedMethod.includes("reasoning") && normalizedMethod.includes("delta")) {
    return {
      type: "reasoning.delta",
      processType: "reasoning",
      processId: String(params?.id || params?.itemId || params?.item_id || "reasoning"),
      summary: summarizeRawNotificationPayload(params),
      payload: params,
      phase: "streaming"
    };
  }
  if (normalizedMethod.includes("reasoning") && (normalizedMethod.includes("done") || normalizedMethod.includes("completed"))) {
    return {
      type: "reasoning.completed",
      processType: "reasoning",
      processId: String(params?.id || params?.itemId || params?.item_id || "reasoning"),
      summary: summarizeRawNotificationPayload(params),
      payload: params,
      phase: "completed"
    };
  }
  if (normalizedMethod.includes("tool") && normalizedMethod.includes("delta")) {
    return {
      type: "process.delta",
      processType: "tool",
      processId: String(params?.callId || params?.call_id || params?.id || "tool"),
      summary: summarizeRawNotificationPayload(params),
      payload: params,
      phase: "streaming"
    };
  }
  return null;
}

function classifyTypedDirectEventFromNotification(method = "", normalizedMethod = "", params = {}) {
  const item = params?.item || {};
  const itemType = normalizeSymbolToken(item?.type || "");
  const itemPhase = normalizeSymbolToken(item?.phase || "");

  if (method === "turn/started" || normalizedMethod === "turnstarted") {
    return { type: "turn.started", status: "running", payload: params };
  }
  if (method === "thread/status/changed" || normalizedMethod === "threadstatuschanged") {
    return {
      type: "thread.status.updated",
      status: String(params?.status || params?.thread?.status || "").trim() || "updated",
      payload: params
    };
  }
  if (method === "thread/tokenUsage/updated" || normalizedMethod === "threadtokenusageupdated") {
    return {
      type: "thread.metrics.updated",
      metrics: params?.usage && typeof params.usage === "object" ? params.usage : params,
      payload: params
    };
  }
  if (method === "warning" || normalizedMethod === "warning") {
    return {
      type: "transport.error",
      message: summarizeRawNotificationPayload(params) || "app-server warning",
      code: "warning",
      payload: params
    };
  }
  if (method === "error" || normalizedMethod === "error") {
    return {
      type: "transport.error",
      message: summarizeRawNotificationPayload(params) || normalizeAppServerErrorMessage(params) || "app-server error",
      code: String(params?.code || "error"),
      payload: params
    };
  }
  if (method === "item/started" || normalizedMethod === "itemstarted") {
    if (itemType === "agentmessage") {
      return {
        type: itemPhase === "commentary" ? "reasoning.started" : "message.started",
        processId: String(item?.id || "agentmessage"),
        summary: summarizeRawNotificationPayload(item) || `${String(item?.type || "item")} started`,
        payload: item
      };
    }
    if (itemType === "reasoning") {
      return {
        type: "reasoning.started",
        processId: String(item?.id || "reasoning"),
        summary: summarizeRawNotificationPayload(item) || "reasoning started",
        payload: item
      };
    }
    return null;
  }
  if (method === "item/completed" || normalizedMethod === "itemcompleted") {
    if (itemType === "agentmessage") {
      return {
        type: itemPhase === "commentary" ? "reasoning.completed" : "message.completed",
        processId: String(item?.id || "agentmessage"),
        summary: summarizeRawNotificationPayload(item),
        payload: item
      };
    }
    if (itemType === "reasoning") {
      return {
        type: "reasoning.completed",
        processId: String(item?.id || "reasoning"),
        summary: summarizeRawNotificationPayload(item) || "reasoning completed",
        payload: item
      };
    }
  }
  return null;
}

function broadcastTypedStructuredEvent(manager, session, params = {}, event = null) {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (event.type === "turn.started" || event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
    return broadcastTypedTurnLifecycle(manager, session, params, event);
  }
  if (event.type === "message.started") {
    const itemId = String(event.processId || event.payload?.id || "").trim();
    if (itemId) {
      session.activeTypedItems?.set(itemId, "message");
    }
    return true;
  }
  if (event.type === "message.completed") {
    return broadcastTypedMessage(manager, session, params, {
      type: "message.completed",
      text: String(event.payload?.text || event.summary || "").trim(),
      phase: "final"
    });
  }
  if (event.type === "thread.status.updated" || event.type === "thread.metrics.updated") {
    return broadcastTypedThreadState(manager, session, params, event);
  }
  if (event.type === "transport.error") {
    return broadcastTypedTransportError(manager, session, params, event);
  }
  if (event.type === "reasoning.started" || event.type === "reasoning.delta" || event.type === "reasoning.completed") {
    const itemId = String(event.processId || event.payload?.id || "").trim();
    if (event.type === "reasoning.started" && itemId) {
      session.activeTypedItems?.set(itemId, "reasoning");
    }
    return broadcastTypedEvent(manager, session, {
      ...buildTypedEventContext(session, params),
      type: event.type,
      processId: event.processId,
      summary: event.summary,
      payload: event.payload || params,
      phase: event.phase || (event.type.endsWith(".completed") ? "completed" : "streaming")
    });
  }
  return false;
}

export function summarizeRelevantStderr(stderr = "") {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line)));

  return lines
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function buildJsonExecFailurePresentation(code, stderr = "") {
  const concise = summarizeRelevantStderr(stderr);
  if (!concise) {
    return {
      text: `Codex 执行未完成（exit=${code}），请重试。`,
      summary: `Codex 执行未完成（exit=${code}）`,
      rawType: "status",
      payload: { message: "" }
    };
  }
  return {
    text: `Codex 执行失败（exit=${code}）：${concise}`,
    summary: `Codex 执行失败（exit=${code}）：${concise}`,
    rawType: "error",
    payload: { message: concise }
  };
}

export function enqueueRunnerInput(manager, session, data) {
  const input = normalizeRunnerInput(data);
  // A trailing newline is the legacy submit delimiter; all message lines stay in one turn.
  const text = input.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!text.trim() && !input.images.length) {
    return "";
  }
  if (session.runnerMode === "json_exec") {
    if (input.images.length) {
      assertCliImageSupport(manager, session);
    }
    buildCodexJsonExecArgs(manager, session, text, input.images);
  }

  const queueLimit = Math.max(1, Number(manager.config.maxQueuedInputs) || 200);
  if (session.queuedInputs.length >= queueLimit) {
    throw new Error(`当前会话待处理消息过多（上限 ${queueLimit}），请稍后重试。`);
  }

  session.queuedInputs.push(input.images.length ? { text, images: input.images } : text);
  let lastTurnId = "";
  if (session.provider === "codex") {
    lastTurnId = manager.createConversationTurn(session, text, nowIso(), { activate: false, images: input.images });
    session.queuedTurnIds.push(lastTurnId);
  }
  session.updatedAt = nowIso();
  if (session.runnerMode === "app_server") {
    startAppServerTurn(manager, session);
    return lastTurnId;
  }
  startJsonExecRun(manager, session);
  return lastTurnId;
}

export async function startAppServerTurn(manager, session) {
  if (!session || session.runnerMode !== "app_server" || session.turnRunning) {
    return;
  }
  const prompt = session.queuedInputs.shift();
  session.currentTurnId = session.queuedTurnIds.shift() || session.currentTurnId || "";
  session.activePendingTurnId = session.currentTurnId || "";
  if (!prompt) {
    session.activePendingTurnId = "";
    return;
  }
  session.turnRunning = true;
  const control = beginRunnerTurn(session);
  session.turnHadVisibleOutput = false;
  session.turnNoReplyNotified = false;
  session.updatedAt = nowIso();
  manager.updateConversationTurnStatus(session, "running", session.updatedAt);
  try {
    const input = normalizeRunnerInput(prompt);
    const result = await manager.appServerBridge.startTurn(session, input.text, input.images);
    if (control.settled || session.runnerTurnControl !== control) {
      return;
    }
    const resultParams = result?.turn ? { turn: result.turn } : result || {};
    resolveAppServerTurnId(manager, session, resultParams);
    const hadOutput = handleAppServerTurnResult(manager, session, result);
    const resultStatus = normalizeTurnResultStatus(result);
    const resultError = normalizeTurnResultError(result);
    if (resultStatus === "inprogress" || resultStatus === "running") {
      return;
    }
    if (resultStatus === "failed" || resultError) {
      schedulePendingTurnCompletion(manager, session, result?.turn ? { turn: result.turn } : {}, {
        status: "failed",
        error: resultError || { message: "turn failed" },
        delayMs: 0
      });
      return;
    }
    schedulePendingTurnCompletion(manager, session, result?.turn ? { turn: result.turn } : {}, {
      status: "completed",
      delayMs: hadOutput ? 0 : 1200
    });
  } catch (error) {
    if (control.settled || session.runnerTurnControl !== control) {
      return;
    }
    session.turnRunning = false;
    session.updatedAt = nowIso();
    settleRunnerTurn(session, session.currentTurnId || control.localTurnId, "failed");
    manager.broadcast(session, {
      type: "message_part",
      role: "system",
      part: { type: "text", text: `Codex app-server 执行失败：${error?.message || String(error)}` },
      phase: "final",
      timestamp: nowIso()
    });
    manager.applyConversationRecord(session, {
      type: "message_part",
      role: "system",
      part: { type: "event", rawType: "error", summary: `Codex app-server 执行失败：${error?.message || String(error)}`, payload: { message: error?.message || String(error) } },
      phase: "final",
      timestamp: nowIso()
    });
    manager.finalizeConversationTurn(session, "failed", session.updatedAt, { error: normalizeExecutionError(error) });
    manager.scheduleConversationHistoryResync(session);
    startAppServerTurn(manager, session);
  }
}

export function handleAppServerTurnResult(manager, session, result) {
  const items = extractTurnItems(result);
  if (!items.length) {
    console.warn(`[conversation] app-server turn returned no items sessionId=${session?.id || ""} result=${summarizeTurnResult(result)}`);
    return false;
  }
  let hadOutput = false;
  for (const item of items) {
    const text = extractOutputText(item);
    if (!text) {
      const eventPart = buildEventPartFromItem(item);
      if (eventPart) {
        manager.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: eventPart,
          phase: "final",
          timestamp: nowIso()
        });
        manager.applyConversationRecord(session, {
          type: "message_part",
          role: "assistant",
          part: eventPart,
          phase: "final",
          timestamp: nowIso()
        });
      }
      continue;
    }
    hadOutput = true;
    const streamedCompletion = !session.turnHadVisibleOutput
      ? streamCompletedMessageAsDeltas(manager, session, { turnId: session.currentTurnId }, text)
      : false;
    session.turnHadVisibleOutput = true;
    manager.pushSessionBuffer(session, `${text}\n`);
    if (!streamedCompletion) {
      manager.applyConversationRecord(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text, format: "markdown" },
        phase: "final",
        timestamp: nowIso()
      });
    }
  }
  if (!hadOutput) {
    console.warn(`[conversation] app-server turn items had no assistant text sessionId=${session?.id || ""} items=${summarizeTurnResult(items)}`);
  }
  return hadOutput;
}

function sessionCompatibleExtraArgs(extraArgs, model) {
  const permissionFlags = ["--sandbox", "-s", "--ask-for-approval", "-a", "--approve-for-me", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo"];
  const result = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = String(extraArgs[index]);
    const permissionFlag = permissionFlags.find((flag) => argument === flag || argument.startsWith(`${flag}=`) || (flag.length === 2 && argument.startsWith(flag)));
    const configValue = argument === "-c" || argument === "--config"
      ? String(extraArgs[index + 1] || "")
      : argument.startsWith("--config=") ? argument.slice(9) : argument.startsWith("-c") ? argument.slice(2) : "";
    const configKey = configValue.split("=", 1)[0].trim().replace(/^["']|["']$/g, "");
    if (permissionFlag || ["approval_policy", "sandbox_mode", "approvals_reviewer"].includes(configKey)) {
      throw new Error(`Codex extra argument conflicts with the selected access permissions: ${argument}`);
    }
    if (configKey === "model_reasoning_effort") {
      if (argument === "-c" || argument === "--config") {
        index += 1;
      }
    } else if (model && (argument === "--model" || argument === "-m")) {
      index += 1;
    } else if (!(model && (argument.startsWith("--model=") || argument.startsWith("-m")))) {
      result.push(argument);
    }
  }
  return result;
}

export function buildCodexJsonExecArgs(manager, session, prompt, images = []) {
  assertPermissionModeSupported(session.permissionMode, { runnerMode: "json_exec" });
  const input = normalizeRunnerInput(prompt, images);
  const args = [...buildCodexPermissionArgs(session.permissionMode || "default"), "exec"];
  args.push("--json", "--skip-git-repo-check");
  if (manager.config.codexProfile) {
    args.push("--profile", manager.config.codexProfile);
  }
  const model = String(session.model || "").trim();
  args.push(...sessionCompatibleExtraArgs(manager.config.codexExtraArgs || [], model));
  if (model) {
    args.push("--model", model);
  }
  const effort = String(session.reasoningEffort || "").trim();
  if (effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (String(session.resumeSessionId || "").trim()) {
    args.push("resume", "--all", session.resumeSessionId);
  }
  for (const image of input.images) {
    args.push("--image", image.path);
  }
  if (input.images.length || input.text.startsWith("-")) {
    args.push("--");
  }
  args.push(input.text);
  return args;
}

export function handleCodexJsonEvent(manager, session, event) {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (event.type === "thread.started" && event.thread_id) {
    const startedThreadId = String(event.thread_id || "").trim();
    if (startedThreadId && startedThreadId !== String(session.resumeSessionId || "").trim()) {
      session.resumeSessionId = startedThreadId;
    }
    if (session.conversationState && startedThreadId && startedThreadId !== String(session.conversationState.threadId || "").trim()) {
      session.conversationState.threadId = startedThreadId;
    }
    session.updatedAt = nowIso();
    manager.broadcastConversationSnapshot(session);
    manager.broadcast(session, {
      type: "session_updated",
      session: manager.serialize(session)
    });
  }
  if (event.type === "item.completed") {
    const item = event.item || {};
    const text = extractOutputText(item);
    if (!text) {
      const eventPart = buildEventPartFromItem(item);
      if (eventPart) {
        manager.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: eventPart,
          phase: "final",
          timestamp: nowIso()
        });
        manager.applyConversationRecord(session, {
          type: "item.completed",
          item,
          timestamp: nowIso()
        });
      }
      return false;
    }
    const streamedCompletion = !session.turnHadVisibleOutput
      ? streamCompletedMessageAsDeltas(manager, session, { turnId: session.currentTurnId }, text)
      : false;
    session.turnHadVisibleOutput = true;
    manager.pushSessionBuffer(session, `${text}\n`);
    if (!streamedCompletion) {
      manager.applyConversationRecord(session, {
        type: "item.completed",
        item,
        timestamp: nowIso()
      });
    }
    return true;
  }
  return false;
}

export function startJsonExecRun(manager, session) {
  if (!session || session.runnerMode !== "json_exec" || session.turnRunning || session.runningProcess) {
    return;
  }
  const prompt = session.queuedInputs[0];
  const args = prompt ? buildCodexJsonExecArgs(manager, session, prompt) : null;
  session.queuedInputs.shift();
  session.currentTurnId = session.queuedTurnIds.shift() || session.currentTurnId || "";
  session.activePendingTurnId = session.currentTurnId || "";
  if (!prompt) {
    session.activePendingTurnId = "";
    return;
  }

  const control = beginRunnerTurn(session);
  session.turnRunning = true;

  const child = spawn(manager.config.codexBin, args, {
    cwd: session.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  session.runningProcess = child;
  session.updatedAt = nowIso();
  manager.updateConversationTurnStatus(session, "running", session.updatedAt);
  manager.scheduleConversationHistoryResync(session, {
    attempts: 60,
    delayMs: 500
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let emittedAssistant = false;
  const parseLine = (line) => {
    if (control.settled || session.runningProcess !== child || session.runnerTurnControl !== control) {
      return;
    }
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      return;
    }
    try {
      const event = JSON.parse(trimmed);
      if (control.interruptRequested && event.type !== "thread.started") {
        return;
      }
      if (handleCodexJsonEvent(manager, session, event)) {
        emittedAssistant = true;
      }
    } catch {
      // Ignore non-json diagnostic lines.
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk || "");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      parseLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += String(chunk || "");
    if (stderrBuffer.length > 10000) {
      stderrBuffer = stderrBuffer.slice(-10000);
    }
  });

  child.on("close", (code) => {
    if (session.runningProcess !== child) {
      return;
    }
    if (stdoutBuffer.trim()) {
      parseLine(stdoutBuffer.trim());
    }
    session.runningProcess = null;
    session.updatedAt = nowIso();
    if (completeJsonExecInterruption(manager, session, child, control)) {
      return;
    }
    session.turnRunning = false;
    settleRunnerTurn(session, session.currentTurnId || control.localTurnId, code && code !== 0 ? "failed" : "completed");
    if (code && code !== 0) {
      const failure = buildJsonExecFailurePresentation(code, stderrBuffer);
      manager.broadcast(session, {
        type: "message_part",
        role: "system",
        part: { type: "text", text: failure.text },
        phase: "final",
        timestamp: nowIso()
      });
      manager.applyConversationRecord(session, {
        type: "message_part",
        role: "system",
        part: {
          type: "event",
          rawType: failure.rawType,
          summary: failure.summary,
          payload: failure.payload
        },
        phase: "final",
        timestamp: nowIso()
      });
      manager.finalizeConversationTurn(session, "failed", session.updatedAt, { error: { ...failure.payload, message: failure.text } });
      manager.scheduleConversationHistoryResync(session);
    } else if (!emittedAssistant) {
      const concise = summarizeRelevantStderr(stderrBuffer);
      manager.broadcast(session, {
        type: "message_part",
        role: "system",
        part: { type: "text", text: concise ? `本轮无可展示回复：${concise}` : "本轮未返回可展示文本。" },
        phase: "final",
        timestamp: nowIso()
      });
      manager.applyConversationRecord(session, {
        type: "message_part",
        role: "system",
        part: { type: "event", rawType: "status", summary: concise ? `本轮无可展示回复：${concise}` : "本轮未返回可展示文本。", payload: { message: concise } },
        phase: "final",
        timestamp: nowIso()
      });
      manager.finalizeConversationTurn(session, "completed", session.updatedAt);
      manager.scheduleConversationHistoryResync(session);
    } else {
      manager.finalizeConversationTurn(session, "completed", session.updatedAt);
      manager.scheduleConversationHistoryResync(session);
    }
    startJsonExecRun(manager, session);
  });
}

export function handleAppServerNotification(manager, msg) {
  const method = String(msg?.method || "");
  const normalizedMethod = normalizeSymbolToken(method);
  const params = msg?.params || {};
  if (method) {
    console.log(`[conversation] app-server notification method=${method} payload=${summarizeNotification(msg)}`);
  }
  const threadId = String(params?.threadId || params?.thread_id || "").trim();
  if (!threadId) {
    return;
  }
  const targets = [...manager.sessions.values()].filter(
    (session) => session.provider === "codex" && String(session.resumeSessionId || "").trim() === threadId
  );
  if (!targets.length) {
    return;
  }

  for (const session of targets) {
    if (isInterruptedTurn(session, params)) {
      if (method === "turn/completed" || normalizedMethod === "turncompleted") {
        completeAppServerInterruption(manager, session, params);
      }
      continue;
    }
    session.updatedAt = nowIso();
    if (!(method === "turn/completed" || normalizedMethod === "turncompleted")) {
      extendPendingTurnCompletion(manager, session, params);
    }
    const directEvent = classifyTypedDirectEventFromNotification(method, normalizedMethod, params);
    if (directEvent?.type === "turn.started") {
      const resolved = resolveAppServerTurnId(manager, session, params);
      if (resolved.turnId) {
        manager.applyConversationDeltas(session, [
          {
            kind: "turn_status_changed",
            turnId: resolved.turnId,
            clientTurnId: resolved.clientTurnId,
            aliasSource: resolved.aliasSource,
            status: "running",
            timestamp: nowIso()
          }
        ]);
      }
    }
    if (directEvent?.type === "message.completed") {
      const item = params?.item || directEvent.payload || {};
      const text = extractOutputText(item) || String(directEvent.payload?.text || directEvent.summary || "");
      const streamedCompletion = !session.turnHadVisibleOutput && text
        ? streamCompletedMessageAsDeltas(manager, session, params, text)
        : false;
      if (
        !streamedCompletion &&
        !applyAppServerConversationRecord(manager, session, params, {
          type: "item.completed",
          item,
          timestamp: nowIso()
        })
      ) {
        continue;
      }
      if (text) {
        session.turnHadVisibleOutput = true;
        manager.pushSessionBuffer(session, `${text}\n`);
      }
      continue;
    }
    if (String(directEvent?.type || "").startsWith("reasoning.")) {
      if (!applyTypedProcessToConversation(manager, session, params, directEvent)) {
        continue;
      }
    }
    if (broadcastTypedStructuredEvent(manager, session, params, directEvent)) {
      if (directEvent?.type === "thread.status.updated") {
        manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
      }
      continue;
    }
    const processEvent = classifyTypedProcessFromNotification(method, normalizedMethod, params);
    if (String(processEvent?.type || "").startsWith("reasoning.")) {
      if (!applyTypedProcessToConversation(manager, session, params, processEvent)) {
        continue;
      }
      if (broadcastTypedStructuredEvent(manager, session, params, processEvent)) {
        continue;
      }
    }
    if (processEvent?.summary) {
      if (!applyTypedProcessToConversation(manager, session, params, processEvent)) {
        continue;
      }
      if (broadcastTypedProcess(manager, session, params, processEvent)) {
        continue;
      }
    }
    if (method === "item/agentMessage/delta" || normalizedMethod === "itemagentmessagedelta") {
      const delta = String(params?.delta || "");
      if (!delta.length) {
        continue;
      }
      const itemId = String(params?.itemId || params?.item_id || "").trim();
      const typedKind = itemId ? session.activeTypedItems?.get(itemId) : "";
      if (typedKind === "reasoning") {
        const applied = applyTypedProcessToConversation(manager, session, params, {
          type: "reasoning.delta",
          processType: "reasoning",
          processId: itemId || "reasoning",
          summary: delta,
          payload: params,
          phase: "streaming"
        });
        if (!applied) {
          continue;
        }
        session.turnHadVisibleOutput = true;
        manager.pushSessionBuffer(session, delta);
        broadcastTypedStructuredEvent(manager, session, params, {
          type: "reasoning.delta",
          processId: itemId || "reasoning",
          summary: delta,
          payload: params,
          phase: "streaming"
        });
      } else {
        const applied = applyAppServerConversationRecord(manager, session, params, {
          type: "message_part",
          role: "assistant",
          part: { type: "text", text: delta, format: "markdown" },
          messageId: itemId,
          phase: "streaming",
          timestamp: nowIso()
        });
        if (!applied) {
          continue;
        }
        session.turnHadVisibleOutput = true;
        manager.pushSessionBuffer(session, delta);
        broadcastTypedMessage(manager, session, params, {
          type: "message.delta",
          text: delta,
          phase: "streaming"
        });
      }
      continue;
    }
    if (method === "item/completed" || normalizedMethod === "itemcompleted") {
      const item = params?.item || {};
      if (!isAgentMessageType(item?.type) && normalizeSymbolToken(item?.type) !== "functioncalloutput") {
        continue;
      }
      const text = extractOutputText(item) || summarizeRawNotificationPayload(item);
      if (!text) {
        const eventPart = buildEventPartFromItem(item);
        if (eventPart) {
          manager.broadcast(session, {
            type: "message_part",
            role: "assistant",
            part: eventPart,
            phase: "final",
            timestamp: nowIso()
          });
          if (!applyAppServerConversationRecord(manager, session, params, {
            type: "item.completed",
            item,
            timestamp: nowIso()
          })) {
            continue;
          }
        }
        continue;
      }
      const streamedCompletion = !session.turnHadVisibleOutput
        ? streamCompletedMessageAsDeltas(manager, session, params, text)
        : false;
      if (
        !streamedCompletion &&
        !applyAppServerConversationRecord(manager, session, params, {
          type: "item.completed",
          item,
          timestamp: nowIso()
        })
      ) {
        continue;
      }
      session.turnHadVisibleOutput = true;
      manager.pushSessionBuffer(session, `${text}\n`);
      continue;
    }
    if (method === "turn/started" || normalizedMethod === "turnstarted") {
      manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
      continue;
    }
    if (method === "turn/completed" || normalizedMethod === "turncompleted") {
      const turn = params?.turn || {};
      const turnStatus = normalizeSymbolToken(turn?.status || "");
      const turnError = turn?.error && typeof turn.error === "object" ? turn.error : null;
      const resolved = resolveAppServerTurnId(manager, session, params);
      const completionParams = resolved.turnId
        ? {
            ...params,
            turnId: resolved.turnId,
            clientTurnId: resolved.clientTurnId,
            aliasSource: resolved.aliasSource
          }
        : params;
      if (turnStatus === "failed" || turnError) {
        schedulePendingTurnCompletion(manager, session, completionParams, {
          status: "failed",
          error: turnError || { message: "turn failed" },
          delayMs: 0
        });
        continue;
      }
      schedulePendingTurnCompletion(manager, session, completionParams, {
        status: "completed",
        delayMs: 0
      });
      continue;
    }
  }
}
