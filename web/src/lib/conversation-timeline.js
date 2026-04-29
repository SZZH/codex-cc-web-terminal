import { createMessage, normalizeLine, sanitizeAssistantText } from "./session-helpers.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedPartType(value) {
  const partType = String(value || "markdown").trim().toLowerCase();
  return partType || "markdown";
}

function toTimestamp(...candidates) {
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return text;
    }
  }
  return new Date().toISOString();
}

function resolveEventSummary(event = {}, payload = {}) {
  const pieces = [
    event.summary,
    event.title,
    event.content,
    payload.summary,
    payload.message,
    payload.text,
    event.type
  ]
    .map((item) => compactText(item))
    .filter(Boolean);
  return pieces[0] || "事件";
}

function normalizeTurnProcessEvent(turn, event, turnIndex, eventIndex) {
  const payload = event && typeof event === "object" ? event.payload || {} : {};
  const rawType = compactText(payload.rawType || event?.type || "turn_event");
  const summary = resolveEventSummary(event, payload);
  const timestamp = toTimestamp(event?.ts, event?.timestamp, turn?.assistant?.startedAt, turn?.createdAt, turn?.ts);

  return createMessage("assistant", summary, timestamp, {
    source: "turn",
    partType: "event",
    payload: {
      ...payload,
      summary,
      rawType,
      turnId: String(turn?.id || `turn-${turnIndex}`),
      eventId: String(event?.id || `${turn?.id || turnIndex}-event-${eventIndex}`)
    },
    rawType
  });
}

function normalizeTurnBodyBlock(turn, block, turnIndex, blockIndex) {
  const kind = String(block?.kind || "markdown").trim().toLowerCase();
  const timestamp = toTimestamp(block?.ts, block?.timestamp, turn?.assistant?.finishedAt, turn?.assistant?.startedAt, turn?.ts);
  const basePayload = block && typeof block?.payload === "object" ? block.payload : {};

  if (kind === "image") {
    const url = String(basePayload.url || "").trim();
    if (!url) {
      return null;
    }
    const alt = String(basePayload.alt || "image").trim() || "image";
    return createMessage("assistant", `![${alt}](${url})`, timestamp, {
      source: "turn",
      partType: "image",
      payload: {
        ...basePayload,
        url,
        alt,
        turnId: String(turn?.id || `turn-${turnIndex}`),
        blockId: String(block?.id || `${turn?.id || turnIndex}-body-${blockIndex}`)
      },
      rawType: "turn_image"
    });
  }

  const text = normalizeLine(block?.text || "");
  if (!text) {
    return null;
  }

  return createMessage("assistant", text, timestamp, {
    source: "turn",
    partType: "markdown",
    payload: {
      ...basePayload,
      turnId: String(turn?.id || `turn-${turnIndex}`),
      blockId: String(block?.id || `${turn?.id || turnIndex}-body-${blockIndex}`)
    },
    rawType: "turn_body"
  });
}

export function convertTurnsToTimelineMessages(turns = []) {
  const output = [];
  asArray(turns).forEach((turn, turnIndex) => {
    const turnId = String(turn?.id || `turn-${turnIndex}`);
    const userText = normalizeLine(turn?.user?.text || "");
    if (userText) {
      output.push(
        createMessage("user", userText, toTimestamp(turn?.user?.ts, turn?.ts, turn?.createdAt), {
          source: "turn",
          partType: "text",
          payload: { turnId },
          rawType: "turn_user"
        })
      );
    }

    asArray(turn?.assistant?.process).forEach((event, eventIndex) => {
      const normalized = normalizeTurnProcessEvent(turn, event, turnIndex, eventIndex);
      if (normalized) {
        output.push(normalized);
      }
    });

    asArray(turn?.assistant?.body).forEach((block, blockIndex) => {
      const normalized = normalizeTurnBodyBlock(turn, block, turnIndex, blockIndex);
      if (normalized) {
        output.push(normalized);
      }
    });
  });

  return output;
}

function sortAgents(items = []) {
  return [...items].sort((left, right) => {
    const rightTs = Date.parse(String(right?.updatedAt || right?.finishedAt || right?.startedAt || ""));
    const leftTs = Date.parse(String(left?.updatedAt || left?.finishedAt || left?.startedAt || ""));
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });
}

export function createConversationState(input = {}) {
  return {
    sessionId: String(input?.sessionId || ""),
    threadId: String(input?.threadId || ""),
    version: Math.max(0, Number(input?.version) || 0),
    status: String(input?.status || "idle").trim() || "idle",
    updatedAt: toTimestamp(input?.updatedAt),
    turns: asArray(input?.turns),
    backgroundAgents: sortAgents(asArray(input?.backgroundAgents)),
    activeTurnId: String(input?.activeTurnId || ""),
    turnAliases: input?.turnAliases && typeof input.turnAliases === "object" ? { ...input.turnAliases } : {}
  };
}

function summarizeConversationContent(conversation = {}) {
  const normalizedConversation = createConversationState(conversation);
  let completedTurns = 0;
  let processCount = 0;
  let processChars = 0;
  let bodyCount = 0;
  let bodyChars = 0;

  for (const turn of normalizedConversation.turns) {
    const assistant = turn?.assistant || {};
    if (String(assistant.status || "").trim().toLowerCase() === "completed") {
      completedTurns += 1;
    }

    for (const event of asArray(assistant.process)) {
      processCount += 1;
      processChars += compactText(event?.summary || event?.content || event?.title || "").length;
    }

    for (const block of asArray(assistant.body)) {
      bodyCount += 1;
      bodyChars += compactText(block?.text || block?.payload?.url || block?.payload?.alt || "").length;
    }
  }

  return {
    turnCount: normalizedConversation.turns.length,
    completedTurns,
    processCount,
    processChars,
    bodyCount,
    bodyChars,
    backgroundAgentCount: normalizedConversation.backgroundAgents.length
  };
}

export function compareConversationContent(left = {}, right = {}) {
  const leftSummary = summarizeConversationContent(left);
  const rightSummary = summarizeConversationContent(right);
  const comparisonOrder = [
    "turnCount",
    "completedTurns",
    "bodyCount",
    "bodyChars",
    "processCount",
    "processChars",
    "backgroundAgentCount"
  ];

  for (const key of comparisonOrder) {
    const diff = Number(leftSummary[key] || 0) - Number(rightSummary[key] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function replaceTurn(turns, turnId, updater) {
  return turns.map((turn) => {
    if (turn.id !== turnId) {
      return turn;
    }
    return updater(turn);
  });
}

function resolveTurnAlias(state, turnId = "") {
  const targetTurnId = String(turnId || "").trim();
  if (!targetTurnId) {
    return "";
  }
  return String(state?.turnAliases?.[targetTurnId] || targetTurnId).trim();
}

function mergeAssistantState(left = {}, right = {}) {
  const leftBody = asArray(left?.body);
  const rightBody = asArray(right?.body);
  const leftProcess = asArray(left?.process);
  const rightProcess = asArray(right?.process);
  const rightStatus = String(right?.status || "").trim();
  const leftStatus = String(left?.status || "").trim();
  return {
    ...left,
    ...right,
    body: rightBody.length ? rightBody : leftBody,
    process: rightProcess.length ? rightProcess : leftProcess,
    status: rightStatus || leftStatus || "running",
    startedAt: String(left?.startedAt || right?.startedAt || ""),
    finishedAt: String(right?.finishedAt || left?.finishedAt || "")
  };
}

function aliasTurn(state, clientTurnId = "", serverTurnId = "") {
  const clientId = String(clientTurnId || "").trim();
  const serverId = String(serverTurnId || "").trim();
  if (!clientId || !serverId || clientId === serverId) {
    return state;
  }

  const aliases = { ...(state.turnAliases || {}), [clientId]: serverId, [serverId]: serverId };
  const turns = [...state.turns];
  const clientIndex = turns.findIndex((turn) => String(turn?.id || "").trim() === clientId);
  const serverIndex = turns.findIndex((turn) => String(turn?.id || "").trim() === serverId);

  if (clientIndex >= 0 && serverIndex >= 0 && clientIndex !== serverIndex) {
    const clientTurn = turns[clientIndex];
    const serverTurn = turns[serverIndex];
    turns[serverIndex] = {
      ...clientTurn,
      ...serverTurn,
      id: serverId,
      user: serverTurn?.user || clientTurn?.user || null,
      assistant: mergeAssistantState(clientTurn?.assistant || {}, serverTurn?.assistant || {})
    };
    turns.splice(clientIndex, 1);
  } else if (clientIndex >= 0) {
    turns[clientIndex] = {
      ...turns[clientIndex],
      id: serverId
    };
  }

  return {
    ...state,
    turns,
    activeTurnId: state.activeTurnId === clientId ? serverId : state.activeTurnId,
    turnAliases: aliases
  };
}

function applyTurnCreated(state, delta) {
  const serverTurnId = String(delta.turnId || "").trim();
  const clientTurnId = String(delta.clientTurnId || delta.localTurnId || "").trim();
  let baseState = state;
  if (clientTurnId && serverTurnId && clientTurnId !== serverTurnId) {
    baseState = aliasTurn(baseState, clientTurnId, serverTurnId);
  }
  const nextTurn = {
    id: resolveTurnAlias(baseState, serverTurnId),
    sessionId: String(delta.sessionId || state.sessionId || ""),
    threadId: String(delta.threadId || state.threadId || ""),
    user: delta.user || null,
    assistant: {
      body: [],
      process: [],
      status: "running",
      startedAt: delta.timestamp,
      finishedAt: ""
    }
  };
  const turns = baseState.turns.filter((turn) => turn.id !== nextTurn.id);
  return {
    ...baseState,
    turns: [...turns, nextTurn],
    activeTurnId: nextTurn.id,
    status: "running"
  };
}

function compactBodyText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function shouldTreatAsDuplicateParagraph(previousText, nextText) {
  const prev = compactBodyText(previousText);
  const next = compactBodyText(nextText);
  if (!prev || !next) {
    return false;
  }
  if (prev === next) {
    return true;
  }
  const shorter = prev.length <= next.length ? prev : next;
  const longer = prev.length > next.length ? prev : next;
  return shorter.length >= 24 && longer.includes(shorter) && shorter.length / longer.length >= 0.88;
}

function mergeStreamingMarkdownBlock(lastBlock, incoming) {
  const previousText = String(lastBlock?.text || "");
  const nextText = String(incoming?.text || "");

  if (!nextText) {
    return false;
  }
  if (!previousText || nextText === previousText) {
    lastBlock.text = nextText || previousText;
    lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }
  if (nextText.startsWith(previousText)) {
    lastBlock.text = nextText;
    lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }
  if (previousText.startsWith(nextText) && nextText.length >= 24) {
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }

  lastBlock.text = `${previousText}${nextText}`;
  lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
  lastBlock.ts = incoming.ts || lastBlock.ts;
  return true;
}

function areProcessEventsEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    String(left.type || "") === String(right.type || "") &&
    String(left.title || "") === String(right.title || "") &&
    String(left.summary || "") === String(right.summary || "") &&
    String(left.content || "") === String(right.content || "")
  );
}

function applyBodyAppended(state, delta) {
  const serverTurnId = String(delta.turnId || "").trim();
  const clientTurnId = String(delta.clientTurnId || delta.localTurnId || "").trim();
  const baseState = clientTurnId && serverTurnId ? aliasTurn(state, clientTurnId, serverTurnId) : state;
  const targetTurnId = resolveTurnAlias(baseState, serverTurnId);
  if (!targetTurnId) {
    return baseState;
  }
  return {
    ...baseState,
    turns: replaceTurn(baseState.turns, targetTurnId, (turn) => {
      const nextBody = [...(turn?.assistant?.body || [])];
      const incoming = delta.block || {};
      const incomingKind = String(incoming.kind || "markdown");
      const incomingText = String(incoming.text || "");
      const mergeMode = String(incoming.mergeMode || "paragraph").toLowerCase();
      const lastBlock = nextBody[nextBody.length - 1];
      const canMergeMarkdown =
        incomingKind === "markdown" &&
        lastBlock &&
        String(lastBlock.kind || "") === "markdown";

      if (canMergeMarkdown && mergeMode === "stream_append") {
        mergeStreamingMarkdownBlock(lastBlock, incoming);
      } else if (canMergeMarkdown && mergeMode === "stream_replace") {
        lastBlock.text = incomingText;
        lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "completed" };
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else if (
        canMergeMarkdown &&
        mergeMode === "paragraph" &&
        String(lastBlock.text || "").trim() &&
        incomingText &&
        !shouldTreatAsDuplicateParagraph(String(lastBlock.text || ""), incomingText)
      ) {
        lastBlock.text = `${String(lastBlock.text || "").trim()}\n${incomingText}`.trim();
        lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "completed" };
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else if (
        canMergeMarkdown &&
        mergeMode === "paragraph" &&
        (
          String(lastBlock.text || "").trim() === incomingText.trim() ||
          shouldTreatAsDuplicateParagraph(String(lastBlock.text || ""), incomingText)
        )
      ) {
        if (compactBodyText(incomingText).length > compactBodyText(String(lastBlock.text || "")).length) {
          lastBlock.text = incomingText;
        }
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else {
        nextBody.push(incoming);
      }

      return {
        ...turn,
        assistant: {
          ...(turn?.assistant || {}),
          body: nextBody
        }
      };
    })
  };
}

function applyProcessAppended(state, delta) {
  const serverTurnId = String(delta.turnId || "").trim();
  const clientTurnId = String(delta.clientTurnId || delta.localTurnId || "").trim();
  const baseState = clientTurnId && serverTurnId ? aliasTurn(state, clientTurnId, serverTurnId) : state;
  const targetTurnId = resolveTurnAlias(baseState, serverTurnId);
  if (!targetTurnId) {
    return baseState;
  }
  return {
    ...baseState,
    turns: replaceTurn(baseState.turns, targetTurnId, (turn) => {
      const nextProcess = [...(turn?.assistant?.process || [])];
      const incomingEvent = delta.event || {};
      const lastEvent = nextProcess[nextProcess.length - 1];
      if (areProcessEventsEquivalent(lastEvent, incomingEvent)) {
        lastEvent.ts = incomingEvent.ts || lastEvent.ts;
        lastEvent.payload = { ...(lastEvent.payload || {}), ...(incomingEvent.payload || {}) };
      } else {
        nextProcess.push(incomingEvent);
      }
      return {
        ...turn,
        assistant: {
          ...(turn?.assistant || {}),
          process: nextProcess
        }
      };
    })
  };
}

function applyTurnStatusChanged(state, delta) {
  const serverTurnId = String(delta.turnId || "").trim();
  const clientTurnId = String(delta.clientTurnId || delta.localTurnId || "").trim();
  const baseState = clientTurnId && serverTurnId ? aliasTurn(state, clientTurnId, serverTurnId) : state;
  const targetTurnId = resolveTurnAlias(baseState, serverTurnId);
  if (!targetTurnId) {
    return baseState;
  }
  const nextStatus = String(delta.status || "running");
  return {
    ...baseState,
    status: nextStatus,
    turns: replaceTurn(baseState.turns, targetTurnId, (turn) => ({
      ...turn,
      assistant: {
        ...(turn?.assistant || {}),
        status: nextStatus,
        finishedAt: nextStatus !== "running" ? String(delta.timestamp || turn?.assistant?.finishedAt || "") : turn?.assistant?.finishedAt || ""
      }
    }))
  };
}

function applyTurnCompleted(state, delta) {
  const serverTurnId = String(delta.turnId || "").trim();
  const clientTurnId = String(delta.clientTurnId || delta.localTurnId || "").trim();
  const baseState = clientTurnId && serverTurnId ? aliasTurn(state, clientTurnId, serverTurnId) : state;
  const targetTurnId = resolveTurnAlias(baseState, serverTurnId);
  if (!targetTurnId) {
    return baseState;
  }
  const nextStatus = String(delta.status || "completed");
  return {
    ...baseState,
    status: nextStatus,
    activeTurnId: baseState.activeTurnId === targetTurnId ? "" : baseState.activeTurnId,
    turns: replaceTurn(baseState.turns, targetTurnId, (turn) => ({
      ...turn,
      assistant: {
        ...(turn?.assistant || {}),
        status: nextStatus,
        finishedAt: String(delta.timestamp || turn?.assistant?.finishedAt || "")
      }
    }))
  };
}

function applyBackgroundAgentUpserted(state, delta) {
  const nextAgents = [...state.backgroundAgents];
  const agent = delta.agent || {};
  const index = nextAgents.findIndex((item) => item.agentId === agent.agentId);
  if (index >= 0) {
    nextAgents[index] = {
      ...nextAgents[index],
      ...agent,
      relatedTurnIds: Array.from(new Set([...(nextAgents[index].relatedTurnIds || []), ...(agent.relatedTurnIds || [])]))
    };
  } else {
    nextAgents.push({
      ...agent,
      relatedTurnIds: Array.from(new Set([...(agent.relatedTurnIds || [])]))
    });
  }
  return {
    ...state,
    backgroundAgents: sortAgents(nextAgents)
  };
}

function isAuthoritativeConversationDelta(delta = {}) {
  if (!delta || typeof delta !== "object" || !delta.conversation || typeof delta.conversation !== "object") {
    return false;
  }
  const kind = String(delta.kind || "").trim().toLowerCase();
  if (kind === "conversation_replaced") {
    return true;
  }
  return kind.startsWith("conversation_") && Array.isArray(delta.conversation.turns);
}

function findAuthoritativeConversationDelta(deltas = []) {
  const items = asArray(deltas);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isAuthoritativeConversationDelta(items[index])) {
      return items[index];
    }
  }
  return null;
}

function applyConversationDelta(state, delta) {
  if (isAuthoritativeConversationDelta(delta)) {
    return buildConversationStateFromPayload(delta, state);
  }
  switch (String(delta?.kind || "")) {
    case "turn_created":
      return applyTurnCreated(state, delta);
    case "body_appended":
      return applyBodyAppended(state, delta);
    case "process_appended":
      return applyProcessAppended(state, delta);
    case "turn_status_changed":
      return applyTurnStatusChanged(state, delta);
    case "turn_completed":
      return applyTurnCompleted(state, delta);
    case "background_agent_upserted":
      return applyBackgroundAgentUpserted(state, delta);
    default:
      return state;
  }
}

function messageCore(message) {
  const partType = normalizedPartType(message?.partType);
  if (partType === "image") {
    return compactText(message?.payload?.url || "");
  }
  if (partType === "event" || partType === "tool" || partType === "subagent" || partType === "reference") {
    const summary = message?.payload?.summary || message?.text || message?.payload?.message || message?.payload?.rawType;
    return compactText(summary);
  }
  return compactText(message?.text || "");
}

function areMessagesEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }
  if (String(left.role || "") !== String(right.role || "")) {
    return false;
  }
  if (normalizedPartType(left.partType) !== normalizedPartType(right.partType)) {
    return false;
  }
  const leftCore = messageCore(left);
  const rightCore = messageCore(right);
  if (!leftCore || !rightCore || leftCore !== rightCore) {
    return false;
  }

  const leftTs = Date.parse(String(left.timestamp || left.ts || ""));
  const rightTs = Date.parse(String(right.timestamp || right.ts || ""));
  if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) {
    return true;
  }
  return Math.abs(leftTs - rightTs) <= 10 * 60 * 1000;
}

function mergeByEquivalence(primary = [], secondary = []) {
  const result = [...primary];
  for (const message of secondary) {
    if (result.some((existing) => areMessagesEquivalent(existing, message))) {
      continue;
    }
    result.push(message);
  }
  return result;
}

export function buildTimelineMessages({ historyMessages = [], historyTurns = [] } = {}) {
  const fromMessages = asArray(historyMessages);
  const fromTurns = convertTurnsToTimelineMessages(historyTurns);
  if (!fromTurns.length) {
    return fromMessages;
  }
  if (!fromMessages.length) {
    return fromTurns;
  }
  const primary = fromTurns.length >= fromMessages.length ? fromTurns : fromMessages;
  const secondary = primary === fromTurns ? fromMessages : fromTurns;
  return mergeByEquivalence(primary, secondary);
}

export function buildTimelineMessagesFromConversation(conversation = {}, fallbackMessages = []) {
  const normalizedConversation = createConversationState(conversation);
  const fromTurns = convertTurnsToTimelineMessages(normalizedConversation.turns);
  if (!fromTurns.length) {
    return asArray(fallbackMessages);
  }
  const ephemeralFallback = asArray(fallbackMessages).filter(
    (message) => message?.source === "draft" || message?.streaming
  );
  if (!ephemeralFallback.length) {
    return fromTurns;
  }
  return mergeByEquivalence(fromTurns, ephemeralFallback);
}

export function reconcileTimelineWithTurns(currentMessages = [], turns = []) {
  const current = asArray(currentMessages);
  const fromTurns = convertTurnsToTimelineMessages(turns);
  if (!fromTurns.length) {
    return current;
  }
  if (!current.length) {
    return fromTurns;
  }
  const primary = fromTurns.length >= current.length ? fromTurns : current;
  const secondary = primary === fromTurns ? current : fromTurns;
  return mergeByEquivalence(primary, secondary);
}

function findLastAssistantIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

export function reconcileTimelineWithSnapshotBuffer(currentMessages = [], buffer = "") {
  const normalizedSnapshot = sanitizeAssistantText(
    normalizeLine(String(buffer || "").length > 12000 ? String(buffer || "").slice(-12000) : buffer)
  );
  if (!normalizedSnapshot) {
    return asArray(currentMessages);
  }

  const next = [...asArray(currentMessages)];
  const snapshotMessage = createMessage("assistant", normalizedSnapshot, new Date().toISOString(), {
    source: "snapshot",
    partType: "markdown",
    payload: {},
    rawType: "snapshot"
  });

  const lastAssistantIndex = findLastAssistantIndex(next);
  if (lastAssistantIndex >= 0) {
    const lastAssistant = next[lastAssistantIndex];
    if (areMessagesEquivalent(lastAssistant, snapshotMessage)) {
      return next;
    }
    if (String(lastAssistant?.source || "") === "snapshot" && !lastAssistant?.streaming) {
      next[lastAssistantIndex] = snapshotMessage;
      return next;
    }
  }

  next.push(snapshotMessage);
  return next;
}

export function buildConversationStateFromPayload(payload = {}, fallback = {}) {
  const authoritativeSource =
    payload?.conversation && typeof payload.conversation === "object"
      ? payload
      : findAuthoritativeConversationDelta(payload?.deltas);

  if (authoritativeSource?.conversation && typeof authoritativeSource.conversation === "object") {
    return createConversationState({
      ...fallback,
      ...authoritativeSource.conversation,
      sessionId:
        authoritativeSource?.conversation?.sessionId ||
        authoritativeSource?.sessionId ||
        payload?.sessionId ||
        fallback?.sessionId ||
        "",
      threadId:
        authoritativeSource?.conversation?.threadId ||
        authoritativeSource?.threadId ||
        payload?.threadId ||
        fallback?.threadId ||
        "",
      version: authoritativeSource?.conversation?.version ?? authoritativeSource?.version ?? payload?.version ?? fallback?.version ?? 0,
      status:
        authoritativeSource?.conversation?.status ||
        payload?.conversationStatus ||
        authoritativeSource?.conversationStatus ||
        authoritativeSource?.status ||
        payload?.status ||
        fallback?.status ||
        "idle",
      turns: authoritativeSource?.conversation?.turns || payload?.turns || fallback?.turns || [],
      backgroundAgents:
        authoritativeSource?.conversation?.backgroundAgents ||
        payload?.backgroundAgents ||
        authoritativeSource?.backgroundAgents ||
        fallback?.backgroundAgents ||
        [],
      activeTurnId: authoritativeSource?.conversation?.activeTurnId ?? fallback?.activeTurnId ?? "",
      updatedAt: authoritativeSource?.conversation?.updatedAt || authoritativeSource?.timestamp || payload?.timestamp || fallback?.updatedAt
    });
  }
  return createConversationState({
    ...fallback,
    sessionId: payload?.sessionId || fallback?.sessionId || "",
    threadId: payload?.threadId || fallback?.threadId || "",
    version: payload?.version || fallback?.version || 0,
    status: payload?.conversationStatus || payload?.status || fallback?.status || "idle",
    turns: payload?.turns || fallback?.turns || [],
    backgroundAgents: payload?.backgroundAgents || fallback?.backgroundAgents || [],
    updatedAt: payload?.timestamp || fallback?.updatedAt
  });
}

export function applyConversationDeltaPayload(currentConversation = {}, payload = {}) {
  const base = createConversationState(currentConversation);
  const fallbackConversation = buildConversationStateFromPayload(payload, base);
  const fromVersion = Number(payload?.fromVersion);
  const hasVersionGap = Number.isFinite(fromVersion) && fromVersion !== base.version;
  const hasAuthoritativeConversation = Boolean(
    (payload?.conversation && typeof payload.conversation === "object") || findAuthoritativeConversationDelta(payload?.deltas)
  );

  if (hasVersionGap && hasAuthoritativeConversation) {
    return {
      conversation: fallbackConversation,
      resynced: true
    };
  }

  let next = base;
  for (const delta of asArray(payload?.deltas)) {
    const previousVersion = next.version;
    next = applyConversationDelta(next, delta);
    const explicitDeltaVersion = Number(delta?.version);
    const nextVersion = isAuthoritativeConversationDelta(delta)
      ? (
          Number.isFinite(explicitDeltaVersion)
            ? explicitDeltaVersion
            : Number.isFinite(Number(delta?.conversation?.version))
              ? Number(delta.conversation.version)
              : previousVersion + 1
        )
      : Math.max(previousVersion + 1, Number.isFinite(explicitDeltaVersion) ? explicitDeltaVersion : previousVersion + 1);
    next = createConversationState({
      ...next,
      version: nextVersion,
      updatedAt: delta?.timestamp || payload?.timestamp || next.updatedAt
    });
  }

  if ((!payload?.deltas || !payload.deltas.length) && payload?.conversation) {
    next = fallbackConversation;
  } else {
    next = createConversationState({
      ...next,
      sessionId: fallbackConversation.sessionId || next.sessionId,
      threadId: fallbackConversation.threadId || next.threadId,
      status: fallbackConversation.status || next.status,
      backgroundAgents: fallbackConversation.backgroundAgents.length ? fallbackConversation.backgroundAgents : next.backgroundAgents
    });
  }

  return {
    conversation: next,
    resynced: hasVersionGap
  };
}
