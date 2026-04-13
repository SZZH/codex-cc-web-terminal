import { spawn } from "node:child_process";

import { buildEventPartFromItem } from "../history/historicalPayloads.js";
import { extractTurnItems, isAgentMessageType, normalizeSymbolToken, nowIso } from "../shared/text.js";

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
}

export function enqueueRunnerInput(manager, session, data) {
  const text = String(data || "");
  if (!text) {
    return;
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return;
  }

  const queueLimit = Math.max(1, Number(manager.config.maxQueuedInputs) || 200);
  if (session.queuedInputs.length + lines.length > queueLimit) {
    throw new Error(`当前会话待处理消息过多（上限 ${queueLimit}），请稍后重试。`);
  }

  for (const line of lines) {
    session.queuedInputs.push(line);
  }
  session.updatedAt = nowIso();
  if (session.runnerMode === "app_server") {
    return startAppServerTurn(manager, session);
  }
  return startJsonExecRun(manager, session);
}

export async function startAppServerTurn(manager, session) {
  if (!session || session.runnerMode !== "app_server" || session.turnRunning) {
    return;
  }
  const prompt = session.queuedInputs.shift();
  if (!prompt) {
    return;
  }
  session.turnRunning = true;
  session.turnHadVisibleOutput = false;
  session.turnNoReplyNotified = false;
  session.updatedAt = nowIso();
  try {
    const result = await manager.appServerBridge.startTurn(session, prompt);
    handleAppServerTurnResult(manager, session, result);
    session.turnRunning = false;
    session.updatedAt = nowIso();
    manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
    startAppServerTurn(manager, session);
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
    startAppServerTurn(manager, session);
  }
}

export function handleAppServerTurnResult(manager, session, result) {
  const items = extractTurnItems(result);
  if (!items.length) {
    return false;
  }
  let hadOutput = false;
  for (const item of items) {
    if (!isAgentMessageType(item?.type)) {
      const eventPart = buildEventPartFromItem(item);
      if (eventPart) {
        manager.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: eventPart,
          phase: "final",
          timestamp: nowIso()
        });
      }
      continue;
    }
    const text = String(item?.text || "").trim();
    if (!text) {
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
  }
  return hadOutput;
}

export function buildCodexJsonExecArgs(manager, session, prompt) {
  const args = ["exec"];
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
  if (manager.config.codexFullAccess) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
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
  if (event.type === "thread.started" && event.thread_id && !session.resumeSessionId) {
    session.resumeSessionId = String(event.thread_id || "").trim() || session.resumeSessionId;
    session.updatedAt = nowIso();
    manager.broadcast(session, {
      type: "session_updated",
      session: manager.serialize(session)
    });
  }
  if (event.type === "item.completed") {
    const item = event.item || {};
    if (String(item.type || "").trim() !== "agent_message") {
      const eventPart = buildEventPartFromItem(item);
      if (eventPart) {
        manager.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: eventPart,
          phase: "final",
          timestamp: nowIso()
        });
      }
      return false;
    }
    const text = String(item.text || "").trim();
    if (!text) {
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
    return true;
  }
  return false;
}

export function startJsonExecRun(manager, session) {
  if (!session || session.runnerMode !== "json_exec" || session.runningProcess) {
    return;
  }
  const prompt = session.queuedInputs.shift();
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
      const concise = String(stderrBuffer || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      manager.broadcast(session, {
        type: "message_part",
        role: "system",
        part: { type: "text", text: concise ? `Codex 执行失败（exit=${code}）：${concise}` : `Codex 执行失败（exit=${code}）` },
        phase: "final",
        timestamp: nowIso()
      });
    } else if (!emittedAssistant) {
      const concise = String(stderrBuffer || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      manager.broadcast(session, {
        type: "message_part",
        role: "system",
        part: { type: "text", text: concise ? `本轮无可展示回复：${concise}` : "本轮未返回可展示文本。" },
        phase: "final",
        timestamp: nowIso()
      });
    }
    startJsonExecRun(manager, session);
  });
}

export function handleAppServerNotification(manager, msg) {
  const method = String(msg?.method || "");
  const normalizedMethod = normalizeSymbolToken(method);
  const params = msg?.params || {};
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
      continue;
    }
    if (method === "item/completed" || normalizedMethod === "itemcompleted") {
      const item = params?.item || {};
      if (!isAgentMessageType(item?.type)) {
        const eventPart = buildEventPartFromItem(item);
        if (eventPart) {
          manager.broadcast(session, {
            type: "message_part",
            role: "assistant",
            part: eventPart,
            phase: "final",
            timestamp: nowIso()
          });
        }
        continue;
      }
      const text = String(item?.text || "").trim();
      if (!text) {
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
      continue;
    }
    if (method === "turn/completed" || normalizedMethod === "turncompleted") {
      if (!session.turnHadVisibleOutput) {
        emitNoReplyFallback(manager, session);
      }
      continue;
    }
    if (method === "thread/status/changed" || normalizedMethod === "threadstatuschanged") {
      manager.broadcast(session, { type: "session_updated", session: manager.serialize(session) });
    }
  }
}
