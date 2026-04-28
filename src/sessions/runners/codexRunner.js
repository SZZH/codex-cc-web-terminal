import { spawn } from "node:child_process";

import { buildEventPartFromItem } from "../history/historicalPayloads.js";
import { extractAgentTextFromItem, extractTurnItems, isAgentMessageType, normalizeSymbolToken, nowIso } from "../shared/text.js";
import { buildCodexPermissionArgs } from "../shared/composerOptions.js";

const STDERR_NOISE_PATTERNS = [
  /codex_core_plugins?::manifest:/i,
  /ignoring interface\.defaultPrompt:/i,
  /prompt must be at most 128 characters/i,
  /maximum of 3 prompts is supported/i,
  /\[MODULE_TYPELESS_PACKAGE_JSON]/i
];

function emitNoReplyFallback(manager, session) {
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
  manager.applyConversationRecord(session, {
    type: "message_part",
    role: "system",
    part: { type: "event", rawType: "system", summary: "本轮未返回可展示文本。", payload: { message: "本轮未返回可展示文本。" } },
    phase: "final",
    timestamp: nowIso()
  });
}

function normalizeAppServerErrorMessage(error = {}) {
  const primary = String(error?.message || "").trim();
  const extra = String(error?.additionalDetails || "").trim();
  if (primary && extra && !extra.includes(primary)) {
    return `${primary} ${extra}`.trim();
  }
  return primary || extra || "未知错误";
}

function emitAppServerError(manager, session, error = {}, timestamp = nowIso()) {
  const details = normalizeAppServerErrorMessage(error);
  const text = `Codex 执行失败：${details}`;
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
  const text = String(data || "");
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "";
  }

  const queueLimit = Math.max(1, Number(manager.config.maxQueuedInputs) || 200);
  if (session.queuedInputs.length + lines.length > queueLimit) {
    throw new Error(`当前会话待处理消息过多（上限 ${queueLimit}），请稍后重试。`);
  }

  let lastTurnId = "";
  for (const line of lines) {
    session.queuedInputs.push(line);
    if (session.provider === "codex") {
      const turnId = manager.createConversationTurn(session, line, nowIso());
      session.queuedTurnIds.push(turnId);
      lastTurnId = turnId;
    }
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
  if (!prompt) {
    return;
  }
  session.turnRunning = true;
  session.turnHadVisibleOutput = false;
  session.turnNoReplyNotified = false;
  session.updatedAt = nowIso();
  manager.updateConversationTurnStatus(session, "running", session.updatedAt);
  try {
    const result = await manager.appServerBridge.startTurn(session, prompt);
    handleAppServerTurnResult(manager, session, result);
  } catch (error) {
    session.turnRunning = false;
    session.updatedAt = nowIso();
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
    manager.finalizeConversationTurn(session, "failed", session.updatedAt);
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
    const text = extractAgentTextFromItem(item);
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
    session.turnHadVisibleOutput = true;
    manager.pushSessionBuffer(session, `${text}\n`);
    manager.broadcast(session, {
      type: "message_part",
      role: "assistant",
      part: { type: "text", text, format: "markdown" },
      phase: "final",
      timestamp: nowIso()
    });
    manager.applyConversationRecord(session, {
      type: "message_part",
      role: "assistant",
      part: { type: "text", text, format: "markdown" },
      phase: "final",
      timestamp: nowIso()
    });
  }
  if (!hadOutput) {
    console.warn(`[conversation] app-server turn items had no assistant text sessionId=${session?.id || ""} items=${summarizeTurnResult(items)}`);
  }
  return hadOutput;
}

export function buildCodexJsonExecArgs(manager, session, prompt) {
  const args = ["exec"];
  const isResume = Boolean(String(session.resumeSessionId || "").trim());
  if (session.resumeSessionId) {
    args.push("resume", "--all", session.resumeSessionId);
  }
  args.push("--json", "--skip-git-repo-check");
  const model = String(session.model || "").trim();
  if (model) {
    args.push("--model", model);
  }
  if (manager.config.codexProfile) {
    args.push("--profile", manager.config.codexProfile);
  }
  if (!isResume) {
    args.push(...buildCodexPermissionArgs(session.permissionMode || "default", manager.config));
  }
  if (Array.isArray(manager.config.codexExtraArgs) && manager.config.codexExtraArgs.length > 0) {
    args.push(...manager.config.codexExtraArgs);
  }
  args.push(prompt);
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
    const text = extractAgentTextFromItem(item);
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
    manager.pushSessionBuffer(session, `${text}\n`);
    manager.broadcast(session, {
      type: "message_part",
      role: "assistant",
      part: { type: "text", text, format: "markdown" },
      phase: "final",
      timestamp: nowIso()
    });
    manager.applyConversationRecord(session, {
      type: "item.completed",
      item,
      timestamp: nowIso()
    });
    return true;
  }
  return false;
}

export function startJsonExecRun(manager, session) {
  if (!session || session.runnerMode !== "json_exec" || session.runningProcess) {
    return;
  }
  const prompt = session.queuedInputs.shift();
  session.currentTurnId = session.queuedTurnIds.shift() || session.currentTurnId || "";
  if (!prompt) {
    return;
  }

  const args = buildCodexJsonExecArgs(manager, session, prompt);
  const child = spawn(manager.config.codexBin, args, {
    cwd: session.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  session.runningProcess = child;
  session.updatedAt = nowIso();
  manager.updateConversationTurnStatus(session, "running", session.updatedAt);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let emittedAssistant = false;
  const parseLine = (line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      return;
    }
    try {
      const event = JSON.parse(trimmed);
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
    if (stdoutBuffer.trim()) {
      parseLine(stdoutBuffer.trim());
    }
    session.runningProcess = null;
    session.updatedAt = nowIso();
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
      manager.finalizeConversationTurn(session, "failed", session.updatedAt);
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
    } else {
      manager.finalizeConversationTurn(session, "completed", session.updatedAt);
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
    session.updatedAt = nowIso();
    if (method === "item/agentMessage/delta" || normalizedMethod === "itemagentmessagedelta") {
      const delta = String(params?.delta || "");
      if (!delta.trim()) {
        continue;
      }
      session.turnHadVisibleOutput = true;
      manager.pushSessionBuffer(session, delta);
      manager.broadcast(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text: delta, format: "markdown" },
        phase: "streaming",
        timestamp: nowIso()
      });
      manager.applyConversationRecord(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text: delta, format: "markdown" },
        phase: "streaming",
        timestamp: nowIso()
      });
      continue;
    }
    if (method === "item/completed" || normalizedMethod === "itemcompleted") {
      const item = params?.item || {};
      if (!isAgentMessageType(item?.type) && normalizeSymbolToken(item?.type) !== "functioncalloutput") {
        continue;
      }
      const text = extractAgentTextFromItem(item);
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
        continue;
      }
      session.turnHadVisibleOutput = true;
      manager.pushSessionBuffer(session, `${text}\n`);
      manager.broadcast(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text, format: "markdown" },
        phase: "final",
        timestamp: nowIso()
      });
      manager.applyConversationRecord(session, {
        type: "item.completed",
        item,
        timestamp: nowIso()
      });
      continue;
    }
    if (method === "turn/completed" || normalizedMethod === "turncompleted") {
      const turn = params?.turn || {};
      const turnStatus = normalizeSymbolToken(turn?.status || "");
      const turnError = turn?.error && typeof turn.error === "object" ? turn.error : null;
      const completedAt = nowIso();
      session.turnRunning = false;
      session.updatedAt = completedAt;
      if (turnStatus === "failed" || turnError) {
        emitAppServerError(manager, session, turnError || { message: "turn failed" }, completedAt);
        manager.finalizeConversationTurn(session, "failed", completedAt);
        manager.scheduleConversationHistoryResync(session);
        manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
        startAppServerTurn(manager, session);
        continue;
      }
      if (!session.turnHadVisibleOutput) {
        emitNoReplyFallback(manager, session);
      }
      manager.finalizeConversationTurn(session, "completed", completedAt);
      manager.scheduleConversationHistoryResync(session);
      manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
      startAppServerTurn(manager, session);
      continue;
    }
    if (method === "thread/status/changed" || normalizedMethod === "threadstatuschanged") {
      manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
    }
  }
}
