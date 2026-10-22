import { nowIso } from "../shared/text.js";

const idText = (value) => String(value || "").trim();

export function appServerTurnId(params = {}) {
  return idText(params.turnId || params.turn_id || params.turn?.id || params.turn?.turnId || params.turn?.turn_id || params.item?.turnId || params.item?.turn_id);
}

function turnIds(session, turnId) {
  const ids = new Set([idText(turnId)]);
  for (const [localId, serverId] of session.turnIdAliases || []) {
    if (ids.has(idText(localId)) || ids.has(idText(serverId))) {
      ids.add(idText(localId));
      ids.add(idText(serverId));
    }
  }
  ids.delete("");
  return ids;
}

export function beginRunnerTurn(session) {
  const control = {
    localTurnId: idText(session.currentTurnId),
    serverTurnId: "",
    interruptRequested: false,
    interruptAcknowledged: false,
    interrupted: false,
    settled: false,
    process: null,
    interruptPromise: null,
    resolveInterrupt: null,
    rpcPending: false,
    confirmationTimer: null
  };
  session.runnerTurnControl = control;
  return control;
}

function matchesTurn(session, control, turnId) {
  return Boolean(control && turnIds(session, control.localTurnId).has(idText(turnId)));
}

export function isInterruptedTurn(session, params = {}) {
  const turnId = appServerTurnId(params);
  return Boolean(turnId && session.interruptedTurnIds?.has(turnId));
}

function clearCompletionTimer(session) {
  if (session.pendingTurnCompletion) {
    clearTimeout(session.pendingTurnCompletion.timer);
    session.pendingTurnCompletion = null;
  }
}

export function settleRunnerTurn(session, turnId, status) {
  const control = session.runnerTurnControl;
  if (!matchesTurn(session, control, turnId)) {
    return;
  }
  control.settled = true;
  clearTimeout(control.confirmationTimer);
  control.resolveInterrupt?.(status === "interrupted");
  control.resolveInterrupt = null;
  session.runnerTurnControl = null;
}

function resumeQueuedTurns(manager, session) {
  if (session.runnerMode === "app_server") {
    manager.maybeStartAppServerTurn(session);
  } else if (session.runnerMode === "json_exec") {
    manager.maybeStartJsonExecRun(session);
  }
}

function finalizeInterruptedTurn(manager, session, control) {
  if (control.settled || session.runnerTurnControl !== control) {
    return false;
  }
  const turnId = control.serverTurnId || idText(session.turnIdAliases?.get(control.localTurnId)) || control.localTurnId;
  session.updatedAt = nowIso();
  clearCompletionTimer(session);
  if (!control.interrupted) {
    control.interrupted = true;
    session.interruptedTurnIds ||= new Set();
    for (const id of turnIds(session, control.localTurnId)) {
      session.interruptedTurnIds.add(id);
    }
    manager.finalizeConversationTurn(session, "interrupted", session.updatedAt, { turnId });
    manager.broadcast(session, {
      type: "turn.interrupted",
      sessionId: session.id,
      threadId: idText(session.resumeSessionId),
      turnId,
      status: "interrupted",
      ts: session.updatedAt
    });
    manager.scheduleConversationHistoryResync(session);
  }
  control.resolveInterrupt?.(true);
  control.resolveInterrupt = null;
  session.turnRunning = false;
  settleRunnerTurn(session, turnId, "interrupted");
  manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
  resumeQueuedTurns(manager, session);
  return true;
}

function reportInterruptFailure(manager, session, control, error, code = "turn_interrupt_failed") {
  if (control.settled || control.interrupted) {
    return;
  }
  const message = `中断 Codex 失败：${error?.message || String(error)}`;
  const turnId = control.serverTurnId || control.localTurnId;
  control.interruptRequested = code === "turn_interrupt_confirmation_timeout";
  control.interruptAcknowledged = false;
  clearTimeout(control.confirmationTimer);
  control.resolveInterrupt?.(false);
  control.resolveInterrupt = null;
  control.interruptPromise = null;
  session.updatedAt = nowIso();
  manager.broadcast(session, {
    type: "transport.error",
    sessionId: session.id,
    threadId: idText(session.resumeSessionId),
    turnId,
    code,
    message,
    ts: session.updatedAt
  });
  manager.applyConversationRecord(session, {
    type: "message_part",
    role: "system",
    part: { type: "event", rawType: "error", summary: message, payload: { message } },
    phase: "final",
    timestamp: session.updatedAt
  }, { turnId });
  manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
}

function scheduleInterruptConfirmation(manager, session, control) {
  clearTimeout(control.confirmationTimer);
  const timeoutMs = Math.max(1, Number(manager.config.codexAppServerRequestTimeoutMs) || 15000);
  control.confirmationTimer = setTimeout(() => {
    reportInterruptFailure(manager, session, control, new Error("等待运行结束确认超时，当前执行仍未确认结束，可再次尝试中断。"), "turn_interrupt_confirmation_timeout");
  }, timeoutMs);
  control.confirmationTimer.unref?.();
}

function dispatchAppServerInterrupt(manager, session, control) {
  if (!control.serverTurnId || !control.interruptRequested || control.interruptAcknowledged || control.rpcPending || control.interrupted || control.settled) {
    return;
  }
  control.rpcPending = true;
  Promise.resolve()
    .then(() => {
      if (!control.settled && control.interruptRequested) {
        return manager.appServerBridge.interruptTurn(session, control.serverTurnId);
      }
    })
    .then(() => {
      control.rpcPending = false;
      if (control.settled) {
        return;
      }
      control.interruptAcknowledged = true;
      control.resolveInterrupt?.(true);
      control.resolveInterrupt = null;
      scheduleInterruptConfirmation(manager, session, control);
    })
    .catch((error) => {
      control.rpcPending = false;
      reportInterruptFailure(manager, session, control, error);
    });
}

export function observeAppServerTurn(manager, session, params = {}) {
  const control = session.runnerTurnControl;
  const serverTurnId = appServerTurnId(params);
  if (!control || control.settled || !serverTurnId || !matchesTurn(session, control, serverTurnId)) {
    return;
  }
  control.serverTurnId = serverTurnId;
  dispatchAppServerInterrupt(manager, session, control);
}

export function completeAppServerInterruption(manager, session, params = {}) {
  const control = session.runnerTurnControl;
  const turnId = appServerTurnId(params);
  const status = idText(params.turn?.status || params.status).toLowerCase();
  const error = params.turn?.error || params.error;
  if (control && matchesTurn(session, control, turnId) && (status === "interrupted" || status === "aborted")) {
    if (error) {
      return false;
    }
    return finalizeInterruptedTurn(manager, session, control);
  }
  return isInterruptedTurn(session, params);
}

export function completeJsonExecInterruption(manager, session, child, control) {
  if (!control?.interruptRequested || control.process !== child || session.runnerTurnControl !== control) {
    return false;
  }
  return finalizeInterruptedTurn(manager, session, control);
}

function cancelQueuedTurns(manager, session) {
  const queuedTurnIds = session.queuedTurnIds?.splice(0) || [];
  session.queuedInputs?.splice(0);
  session.interruptedTurnIds ||= new Set();
  for (const turnId of queuedTurnIds) {
    session.interruptedTurnIds.add(idText(turnId));
    manager.finalizeConversationTurn(session, "interrupted", nowIso(), { turnId });
  }
}

export function interruptSession(manager, session) {
  if (session.provider !== "codex" && !["app_server", "json_exec"].includes(session.runnerMode)) {
    session.shell.write("\u001b");
    session.updatedAt = nowIso();
    return true;
  }
  if (!["app_server", "json_exec"].includes(session.runnerMode)) {
    throw new Error("当前 Codex 会话不支持中断控制。");
  }
  cancelQueuedTurns(manager, session);
  if (!session.turnRunning && !session.runningProcess) {
    return false;
  }
  const control = session.runnerTurnControl || beginRunnerTurn(session);
  if (control.interruptPromise) {
    return control.interruptPromise;
  }
  control.interruptRequested = true;
  control.interruptAcknowledged = false;
  control.interruptPromise = new Promise((resolve) => { control.resolveInterrupt = resolve; });
  const completion = control.interruptPromise;
  if (session.runnerMode === "app_server") {
    scheduleInterruptConfirmation(manager, session, control);
    const mappedTurnId = idText(session.turnIdAliases?.get(control.localTurnId));
    const knownServerTurnId = [...(session.turnIdAliases?.values() || [])].map(idText).includes(control.localTurnId);
    control.serverTurnId ||= mappedTurnId || (knownServerTurnId ? control.localTurnId : "");
    dispatchAppServerInterrupt(manager, session, control);
  } else {
    control.process = session.runningProcess;
    try {
      if (!control.process?.kill("SIGINT")) {
        throw new Error("无法向当前进程发送中断信号。");
      }
      if (!control.settled) {
        scheduleInterruptConfirmation(manager, session, control);
      }
    } catch (error) {
      reportInterruptFailure(manager, session, control, error);
    }
  }
  return completion;
}
