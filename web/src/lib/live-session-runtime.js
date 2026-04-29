import { buildConversationStateFromPayload, applyConversationDeltaPayload } from "./conversation-timeline.js";
import { normalizeServerPayload } from "./normalize-events.js";
import { createMessage, filterTerminalNoise, compactLine, normalizeLine, sanitizeAssistantText } from "./session-helpers.js";

export function createLiveSessionRuntimeController({
  state,
  setStatus,
  setMessages,
  waitForSocketOpen,
  threadRuntime,
  liveBootstrapLinePatterns,
  decorateSession,
  stopHistorySyncLoop
} = {}) {
  let replaySuppressionLines = new Set();

  function clearPendingReplyStatus() {
    if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
      setStatus("");
    }
  }

  function isTerminalTurnStatus(status = "") {
    const normalized = String(status || "").trim().toLowerCase();
    return normalized === "completed" || normalized === "failed" || normalized === "aborted" || normalized === "interrupted";
  }

  function rebuildReplaySuppressionLines(messages) {
    replaySuppressionLines = new Set();
    for (const message of messages || []) {
      const lines = String(message?.text || "")
        .split("\n")
        .map((line) => compactLine(line))
        .filter(Boolean);
      for (const line of lines) {
        replaySuppressionLines.add(line);
      }
    }
  }

  function pruneLiveBootstrapNoise(value) {
    const lines = String(value || "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const filtered = lines.filter((line) => {
      const compact = compactLine(line);
      if (!compact) {
        return false;
      }
      if (liveBootstrapLinePatterns.some((pattern) => pattern.test(compact))) {
        return false;
      }
      if (/[\u2500-\u257f]/.test(compact) && compact.length < 120) {
        return false;
      }
      if (/[\[\];?]m/.test(compact) || /\?25h/.test(compact)) {
        return false;
      }
      if (replaySuppressionLines.has(compact)) {
        return false;
      }
      return true;
    });

    return filtered.join("\n").trim();
  }

  function pruneMessagePartNoise(value) {
    const lines = String(value || "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const filtered = lines.filter((line) => {
      const compact = compactLine(line);
      if (!compact) {
        return false;
      }
      if (/^[\u2500-\u257f\s]+$/.test(compact)) {
        return false;
      }
      if (
        /openai codex|^model:|^directory:|new try the codex app|\/feedback|conversation interrupted|esc to interrupt/i.test(
          compact
        )
      ) {
        return false;
      }
      return true;
    });

    return filtered.join("\n").trim();
  }

  function finalizeAssistantStream() {
    if (!state.liveView.streamBuffer) {
      return;
    }
    const messages = [...state.liveView.messages];
    const last = messages[messages.length - 1];
    if (last?.streaming) {
      last.streaming = false;
      last.text = sanitizeAssistantText(normalizeLine(last.text));
      if (!last.text) {
        messages.pop();
      }
      setMessages(messages);
    }
    state.liveView.streamBuffer = "";
  }

  function discardPendingAssistantStream() {
    state.liveView.streamBuffer = "";
    const messages = [...state.liveView.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      messages.pop();
      setMessages(messages);
    }
  }

  function appendAssistantChunk(chunk, { source = "normalized", detectSystemFailureText, isDisposableAssistantFragment } = {}) {
    let normalized = "";
    if (source === "message_part") {
      normalized = pruneMessagePartNoise(normalizeLine(chunk || ""));
    } else {
      normalized = pruneLiveBootstrapNoise(filterTerminalNoise(chunk || ""));
    }
    if (!normalized) {
      return;
    }

    if (state.liveView.replayGuardActive) {
      state.liveView.replayGuardActive = false;
      state.liveView.replayGuardPrompt = "";
      state.liveView.replayGuardUntil = 0;
    }

    const systemFailure = detectSystemFailureText?.(normalized);
    if (systemFailure) {
      discardPendingAssistantStream();
      setStatus(systemFailure);
      return;
    }

    if (state.statusText === "等待 Codex 回复…") {
      setStatus("");
    }

    const previousBuffer = normalizeLine(state.liveView.streamBuffer || "");
    if (!previousBuffer) {
      state.liveView.streamBuffer = normalized;
    } else if (normalized === previousBuffer) {
      state.liveView.streamBuffer = previousBuffer;
    } else if (normalized.startsWith(previousBuffer)) {
      state.liveView.streamBuffer = normalized;
    } else if (previousBuffer.startsWith(normalized) && normalized.length >= 24) {
      state.liveView.streamBuffer = previousBuffer;
    } else {
      state.liveView.streamBuffer = `${state.liveView.streamBuffer}${normalized}`;
    }
    let mergedText = sanitizeAssistantText(normalizeLine(state.liveView.streamBuffer));
    const lastUserMessage = [...state.liveView.messages].reverse().find((message) => message.role === "user")?.text || "";
    if (lastUserMessage && mergedText.startsWith(lastUserMessage)) {
      const tail = mergedText.slice(lastUserMessage.length).trim();
      if (!tail || /^[>›)\]}\-_=:.~|/\\\dA-Za-z]{1,24}$/.test(tail)) {
        mergedText = "";
        state.liveView.streamBuffer = "";
      }
    }
    if (!mergedText || isDisposableAssistantFragment?.(mergedText)) {
      if (isDisposableAssistantFragment?.(mergedText)) {
        discardPendingAssistantStream();
      }
      return;
    }

    const messages = [...state.liveView.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      last.text = mergedText;
    } else {
      messages.push(createMessage("assistant", mergedText, new Date().toISOString(), { streaming: true, source: "live" }));
    }
    setMessages(messages);
  }

  function appendNormalizedParts(parts = [], { detectSystemFailureText, isDisposableAssistantFragment } = {}) {
    if (!Array.isArray(parts) || parts.length === 0) {
      return;
    }
    let messages = [...state.liveView.messages];
    let touched = false;
    let hasStreamingUpdate = false;

    for (const part of parts) {
      const partType = String(part?.partType || "").trim();
      const role = part?.role === "user" ? "user" : part?.role === "assistant" ? "assistant" : "system";
      const ts = part?.ts || new Date().toISOString();
      const phase = String(part?.phase || "final");
      const payload = part?.payload || {};

      if (partType === "markdown" || partType === "text") {
        const text = sanitizeAssistantText(normalizeLine(String(payload.text || "")));
        if (!text) {
          continue;
        }
        if (role === "assistant" && phase === "streaming") {
          appendAssistantChunk(text, { source: part?.source || "normalized", detectSystemFailureText, isDisposableAssistantFragment });
          touched = true;
          hasStreamingUpdate = true;
          continue;
        }
        if (role === "assistant") {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage?.role === "assistant" && lastMessage?.streaming) {
            lastMessage.text = text;
            lastMessage.streaming = false;
            touched = true;
            continue;
          }
          if (lastMessage?.role === "assistant" && normalizeLine(String(lastMessage.text || "")) === text) {
            continue;
          }
        }
        messages.push(createMessage(role, text, ts, { source: part?.source || "normalized", partType, payload, rawType: part?.rawType || "" }));
        touched = true;
        continue;
      }

      if (partType === "tool" || partType === "subagent" || partType === "reference" || partType === "event") {
        const summary = sanitizeAssistantText(
          normalizeLine(String(payload.summary || payload.text || payload.message || "").trim() || String(payload.rawType || partType))
        );
        if (!summary) {
          continue;
        }
        finalizeAssistantStream();
        messages.push(createMessage(role === "system" ? "system" : "assistant", summary, ts, { source: part?.source || "normalized", partType, payload, rawType: part?.rawType || String(payload.rawType || "") }));
        touched = true;
        continue;
      }

      if (partType === "image") {
        const url = String(payload.url || "").trim();
        if (!url) {
          continue;
        }
        const alt = String(payload.alt || "image").trim() || "image";
        finalizeAssistantStream();
        messages.push(createMessage(role, `![${alt}](${url})`, ts, { source: part?.source || "normalized", partType: "image", payload: { url, alt }, rawType: part?.rawType || "" }));
        touched = true;
        continue;
      }

      if (partType === "error") {
        const errorText = sanitizeAssistantText(normalizeLine(String(payload.message || payload.text || "系统事件，请稍后重试。")));
        if (!errorText) {
          continue;
        }
        messages.push(createMessage("system", errorText, ts, { source: part?.source || "normalized", partType, payload, rawType: part?.rawType || "" }));
        touched = true;
      }
    }

    if (touched) {
      if (hasStreamingUpdate) {
        messages = [...state.liveView.messages];
      }
      setMessages(messages);
    }
  }

  function settleAuthoritativeInputState() {
    state.liveView.activeInputStream = false;
    state.liveView.interruptInFlight = false;
    state.loading = false;
    clearPendingReplyStatus();
  }

  function handleLivePayload(payload, deps = {}) {
    const { activeThreadId, detectSystemFailureText, isDisposableAssistantFragment } = deps;
    if (payload.type === "message.delta" || payload.type === "message.completed") {
      if (state.liveView.hasReducerConversationDelta) {
        return;
      }
      const text = String(payload?.text || "").trim();
      const turnId = String(payload?.turnId || "").trim();
      if (text && turnId) {
        const nextConversation = threadRuntime.appendMessageEventToConversation(state.liveView.conversation, {
          turnId,
          messageId: payload?.messageId || "",
          phase: payload.type === "message.delta" ? "streaming" : "final",
          ts: payload?.ts || new Date().toISOString(),
          text
        });
        threadRuntime.setConversation(nextConversation, {
          fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
          force: true
        });
        threadRuntime.setLiveThreadSnapshot(
          threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
            conversation: nextConversation,
            fallbackThreadId: payload?.threadId || activeThreadId
          }),
          state.liveView.liveOverlay
        );
      }
      return;
    }

    if (payload.type === "process.started" || payload.type === "process.delta" || payload.type === "process.completed") {
      if (state.liveView.hasReducerConversationDelta) {
        return;
      }
      const turnId = String(payload?.turnId || "").trim();
      const summary = String(payload?.summary || "").trim();
      if (turnId && summary) {
        const nextConversation = threadRuntime.appendProcessEventToConversation(state.liveView.conversation, payload);
        threadRuntime.setConversation(nextConversation, {
          fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
          force: true
        });
        threadRuntime.setLiveThreadSnapshot(
          threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
            conversation: nextConversation,
            fallbackThreadId: payload?.threadId || activeThreadId
          }),
          state.liveView.liveOverlay
        );
      }
      return;
    }

    if (payload.type === "turn.completed") {
      if (state.liveView.hasReducerConversationDelta) {
        const turnId = String(payload?.turnId || "").trim();
        const activeTurn = (Array.isArray(state.liveView.conversation?.turns) ? state.liveView.conversation.turns : []).find(
          (turn) => String(turn?.id || "").trim() === turnId
        );
        if (activeTurn && (isTerminalTurnStatus(activeTurn?.assistant?.status) || isTerminalTurnStatus(payload?.status))) {
          settleAuthoritativeInputState();
        }
        return;
      }
      const turnId = String(payload?.turnId || "").trim();
      if (turnId) {
        const nextConversation = threadRuntime.mergeConversationPatch(state.liveView.conversation, {
          turns: [
            {
              id: turnId,
              assistant: {
                status: "completed",
                finishedAt: String(payload?.ts || new Date().toISOString())
              }
            }
          ],
          activeTurnId: "",
          status: "completed"
        });
        threadRuntime.setConversation(nextConversation, {
          fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
          force: true
        });
        threadRuntime.setLiveThreadSnapshot(
          threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
            conversation: nextConversation,
            fallbackThreadId: payload?.threadId || activeThreadId
          }),
          state.liveView.liveOverlay
        );
      }
      settleAuthoritativeInputState();
      return;
    }

    if (payload.type === "thread.snapshot") {
      stopHistorySyncLoop?.();
      if (String(payload?.session?.id || "").trim()) {
        state.liveView.sessionId = String(payload.session.id).trim();
      }
      if (payload.session) {
        state.liveView.sessionMeta = payload.session;
      }
      if (payload?.threadId) {
        state.threadView.threadId = String(payload.threadId || "").trim();
      }
      if (payload.session?.status) {
        state.liveView.sessionMeta = {
          ...(state.liveView.sessionMeta || {}),
          ...payload.session
        };
      }
      const conversationPatch = buildConversationStateFromPayload(
        {
          conversation: payload?.conversation || {},
          sessionId: payload?.sessionId || "",
          threadId: payload?.threadId || "",
          threadSnapshot:
            threadRuntime.resolvePayloadValue(payload, "snapshot", null) ||
            threadRuntime.resolvePayloadValue(payload, "threadSnapshot", null),
          liveOverlay: payload?.liveOverlay || null,
          timestamp: payload?.timestamp || ""
        },
        state.liveView.conversation
      );
      const nextConversation =
        payload.partial === true
          ? threadRuntime.mergeConversationPatch(state.liveView.conversation, conversationPatch)
          : conversationPatch;
      const appliedConversation = threadRuntime.setConversation(nextConversation, {
        fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
        force: true
      });
      const resolvedSnapshot =
        threadRuntime.resolvePayloadValue(payload, "snapshot", null) ||
        threadRuntime.resolvePayloadValue(payload, "threadSnapshot", null);
      if (resolvedSnapshot || payload.liveOverlay !== undefined) {
        threadRuntime.setLiveThreadSnapshot(resolvedSnapshot, threadRuntime.resolvePayloadValue(payload, "liveOverlay", state.liveView.liveOverlay), {
          partial: payload.partial === true
        });
      }
      if (appliedConversation || resolvedSnapshot || payload.liveOverlay !== undefined) {
        state.liveView.hasConversationSnapshot = true;
      }
      state.liveView.hasConversationDelta = true;
      const trackedTurnId = String(payload?.turnId || nextConversation?.activeTurnId || "").trim();
      const authoritativeTurn =
        (Array.isArray(nextConversation?.turns) ? nextConversation.turns : []).find(
          (turn) => String(turn?.id || "").trim() === trackedTurnId
        ) || null;
      const authoritativeAssistantStatus = String(authoritativeTurn?.assistant?.status || "").trim().toLowerCase();
      if (isTerminalTurnStatus(payload?.status) || isTerminalTurnStatus(authoritativeAssistantStatus)) {
        settleAuthoritativeInputState();
      }
      return;
    }

    if (payload.type === "thread.overlay") {
      stopHistorySyncLoop?.();
      threadRuntime.setLiveOverlay(payload);
      if (state.liveView.hasReducerConversationDelta) {
        return;
      }
      const hasTypedConversation =
        Array.isArray(state.liveView.conversation?.turns) &&
        state.liveView.conversation.turns.some((turn) => {
          if (String(turn?.id || "").trim() !== String(payload?.turnId || "").trim()) {
            return false;
          }
          return (
            (Array.isArray(turn?.assistant?.body) && turn.assistant.body.length > 0) ||
            (Array.isArray(turn?.assistant?.process) && turn.assistant.process.length > 0)
          );
        });
      if (!hasTypedConversation) {
        const nextConversation = threadRuntime.appendOverlayPartsToConversation(state.liveView.conversation, payload);
        threadRuntime.setConversation(nextConversation, {
          fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
          force: true
        });
        threadRuntime.setLiveThreadSnapshot(
          threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
            conversation: nextConversation,
            fallbackThreadId: payload?.threadId || activeThreadId
          }),
          payload
        );
        state.liveView.hasConversationSnapshot = true;
        state.liveView.hasConversationDelta = true;
      }
      return;
    }

    if (payload.type === "session.updated") {
      handleLivePayload(
        {
          type: "session_updated",
          session: payload.session || null
        },
        deps
      );
      return;
    }

    if (payload.type === "transport.error") {
      const errorText = String(payload.error || "会话发生未知错误。").trim();
      clearPendingReplyStatus();
      appendNormalizedParts(
        [
          {
            role: "system",
            partType: "text",
            payload: { text: errorText },
            ts: new Date().toISOString(),
            phase: "final",
            source: "transport.error",
            rawType: "error"
          }
        ],
        { detectSystemFailureText, isDisposableAssistantFragment }
      );
      setStatus(errorText);
      return;
    }

    if (payload.type === "conversation.snapshot") {
      clearPendingReplyStatus();
      const nextConversation = buildConversationStateFromPayload(payload, state.liveView.conversation);
      const applied = threadRuntime.setConversation(nextConversation, {
        fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages),
        force: true
      });
      threadRuntime.setLiveThreadSnapshot(
        threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
          threadSnapshot: payload?.threadSnapshot || null,
          conversation: nextConversation,
          fallbackThreadId: payload?.threadId || activeThreadId
        }),
        payload?.liveOverlay || null
      );
      if (applied) {
        state.liveView.hasConversationSnapshot = true;
      }
      state.liveView.hasReducerConversationDelta = true;
      return;
    }

    if (payload.type === "conversation.delta") {
      clearPendingReplyStatus();
      const previousActiveTurnId = String(state.liveView.conversation?.activeTurnId || "").trim();
      const applied = applyConversationDeltaPayload(state.liveView.conversation, payload);
      const updated = threadRuntime.setConversation(applied.conversation, {
        fallbackMessages: threadRuntime.collectConversationFallbackMessages(state.liveView.messages)
      });
      threadRuntime.setLiveThreadSnapshot(
        threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
          threadSnapshot: threadRuntime.resolvePayloadValue(payload, "threadSnapshot", null),
          conversation: applied.conversation,
          fallbackThreadId: payload?.threadId || activeThreadId
        }),
        threadRuntime.resolvePayloadValue(payload, "liveOverlay", state.liveView.liveOverlay)
      );
      if (updated) {
        state.liveView.hasConversationSnapshot = true;
        state.liveView.hasConversationDelta = true;
      }
      state.liveView.hasReducerConversationDelta = true;
      const terminalDeltaTurnId = (Array.isArray(payload?.deltas) ? payload.deltas : [])
        .filter((delta) => delta?.kind === "turn_completed" || delta?.kind === "turn_status_changed")
        .reverse()
        .find((delta) => isTerminalTurnStatus(delta?.status))?.turnId;
      const trackedTurnId = String(terminalDeltaTurnId || previousActiveTurnId || applied.conversation?.activeTurnId || "").trim();
      const trackedTurn = (Array.isArray(applied.conversation?.turns) ? applied.conversation.turns : []).find(
        (turn) => String(turn?.id || "").trim() === trackedTurnId
      );
      if (isTerminalTurnStatus(trackedTurn?.assistant?.status)) {
        settleAuthoritativeInputState();
      }
      return;
    }

    if (payload.type === "snapshot" || payload.type === "conversation_snapshot") {
      if (state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta) {
        return;
      }
      const nextConversation = buildConversationStateFromPayload(payload, state.liveView.conversation);
      const applied = threadRuntime.setConversation(nextConversation, {
        fallbackMessages: state.liveView.messages,
        buffer: payload?.buffer || ""
      });
      threadRuntime.setLiveThreadSnapshot(
        threadRuntime.resolveAuthoritativeLiveThreadSnapshot({
          threadSnapshot: payload?.threadSnapshot || null,
          conversation: nextConversation,
          fallbackThreadId: payload?.threadId || activeThreadId
        }),
        payload?.liveOverlay || null
      );
      if (applied) {
        state.liveView.hasConversationSnapshot = true;
      }
      return;
    }

    if (payload.type === "session_updated" && payload.session) {
      const updated = decorateSession(payload.session);
      state.liveView.sessionMeta = updated;
      if (state.liveView.sessionId === updated.id) {
        state.liveView.liveSessionId = updated.id;
      }
      if (state.threadView.threadId && String(updated.resumeSessionId || "").trim() === state.threadView.threadId) {
        state.threadView.meta = {
          ...(state.threadView.meta || {}),
          ...updated,
          kind: "thread",
          id: state.threadView.sessionId || `history:${updated.provider}:${updated.resumeSessionId}`
        };
      }
      const index = state.sessions.findIndex((item) => item.id === updated.id);
      if (index >= 0) {
        const next = [...state.sessions];
        next[index] = updated;
        state.sessions = next;
      }
      return;
    }

    if (payload.type === "data" || payload.type === "message_part" || payload.type === "event_msg" || payload.type === "response_item") {
      if (state.liveView.hasConversationDelta) {
        return;
      }
      if (
        (payload.type === "data" && payload.data && String(payload.data).trim()) ||
        (payload.type === "message_part" && payload?.part?.type === "text" && String(payload?.part?.text || "").trim())
      ) {
        clearPendingReplyStatus();
      }
      appendNormalizedParts(normalizeServerPayload(payload, state.liveView.sessionId), { detectSystemFailureText, isDisposableAssistantFragment });
      return;
    }

    if (payload.type === "error") {
      const errorText = String(payload.error || "会话发生未知错误。").trim();
      clearPendingReplyStatus();
      appendNormalizedParts([{ role: "system", partType: "text", payload: { text: errorText }, ts: new Date().toISOString(), phase: "final", source: "ws_error", rawType: "error" }], { detectSystemFailureText, isDisposableAssistantFragment });
      setStatus(errorText);
      return;
    }

    if (payload.type === "exit") {
      finalizeAssistantStream();
      const exitCode = Number(payload.exitCode ?? 0);
      if (state.statusText === "已发送中断指令。") {
        setStatus("当前流程已中断。");
        return;
      }
      if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
        setStatus(exitCode === 0 ? "本轮回复已结束。" : `Codex 会话异常退出（${exitCode}），请重试一次。`);
        return;
      }
      if (exitCode !== 0) {
        setStatus(`Codex 会话异常退出（${exitCode}），请重试一次。`);
      }
    }
  }

  function attachLiveSocket(sessionId, { closeSocket, resolveWsUrl, detectSystemFailureText, isDisposableAssistantFragment } = {}) {
    closeSocket({ silent: true });
    finalizeAssistantStream();
    state.liveView.liveSessionId = sessionId;
    state.liveView.streamBuffer = "";
    state.liveView.hasConversationSnapshot = false;
    state.liveView.hasConversationDelta = false;
    state.liveView.hasReducerConversationDelta = false;
    state.liveView.muteSocketLifecycleStatus = false;
    const socket = new WebSocket(resolveWsUrl(sessionId));
    state.liveView.socket = socket;

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      handleLivePayload(payload, {
        activeThreadId: state.threadView.threadId,
        detectSystemFailureText,
        isDisposableAssistantFragment
      });
    });

    socket.addEventListener("close", () => {
      const silentClose = state.liveView.muteSocketLifecycleStatus;
      state.liveView.muteSocketLifecycleStatus = false;
      if (state.liveView.socket === socket) {
        state.liveView.socket = null;
      }
      finalizeAssistantStream();
      if (silentClose) {
        return;
      }
      if (state.statusText === "已发送中断指令。") {
        setStatus("当前流程已中断。");
        return;
      }
      if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
        setStatus("会话连接已关闭，请重试一次。");
      }
    });

    socket.addEventListener("error", () => {
      if (state.liveView.muteSocketLifecycleStatus) {
        return;
      }
      if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
        setStatus("会话连接失败，请重试一次。");
      }
    });

    return waitForSocketOpen(socket);
  }

  return {
    rebuildReplaySuppressionLines,
    finalizeAssistantStream,
    discardPendingAssistantStream,
    appendAssistantChunk,
    appendNormalizedParts,
    clearPendingReplyStatus,
    isTerminalTurnStatus,
    settleAuthoritativeInputState,
    handleLivePayload,
    attachLiveSocket
  };
}
