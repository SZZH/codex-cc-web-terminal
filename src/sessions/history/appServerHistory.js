import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createHistoryPayloadResolver } from "../../routes/historyPayloads.js";
import {
  THREAD_ITEM_KIND,
  canonicalizeRawRecords,
  createCanonicalizerState,
  createRawRecord,
  createThreadItem,
  createThreadSnapshot,
  createTurn,
  deriveConversationStateFromThreadSnapshot,
  reduceCanonicalEvents
} from "../../threads/index.js";

const managerCaches = new WeakMap();
const MAX_CACHED_THREADS = 32;
const CACHE_TTL_MS = 5_000;
const ITEM_KINDS = new Map(Object.values(THREAD_ITEM_KIND).map((kind) => [kind[0].toLowerCase() + kind.slice(1), kind]));

function iso(value) {
  if (value == null || value === "") return "";
  const time = typeof value === "number" ? value * 1000 : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function readThreadMetadata(manager, threadId) {
  const config = manager.config || {};
  const dbPath = config.codexStateDbPath || (config.home ? path.join(config.home, ".codex", "state_5.sqlite") : "");
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const escapedId = threadId.replaceAll("'", "''");
  const output = execFileSync("sqlite3", ["-readonly", "-json", dbPath, `select * from threads where id = '${escapedId}' limit 1`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024, timeout: 3_000
  });
  return JSON.parse(String(output || "[]").trim() || "[]")[0] || null;
}

function isRunningStatus(status) {
  return ["active", "running", "inprogress", "in_progress"].includes(String(status?.type || status || "").toLowerCase());
}

function hasRunningContinuation(manager, threadId) {
  const sessions = manager.sessions?.values?.() || [];
  return [...sessions].some((session) => String(session?.resumeSessionId || "") === threadId &&
    (session.turnRunning || session.currentTurnId || isRunningStatus(session.conversation?.status)));
}

function normalizeUserItem(item, threadId, turnId, timestamp) {
  const content = (item.content || []).map((part) => {
    if (part.type === "text") return { ...part, type: "input_text" };
    if (part.type === "localImage") return { ...part, type: "input_image", image_url: part.path };
    if (part.type === "image") return { ...part, type: "input_image", image_url: part.url };
    return part;
  });
  const raw = createRawRecord({
    id: item.id, threadId, turnId, seq: 1, recordTs: timestamp,
    raw: { type: "event_msg", payload: { type: "user_message", turn_id: turnId, content,
      message: content.filter((part) => part.type === "input_text").map((part) => part.text || "").join("\n") } }
  });
  const snapshot = reduceCanonicalEvents(canonicalizeRawRecords([raw], createCanonicalizerState()), { threadId });
  return { ...snapshot.turns[0].items.find((value) => value.kind === THREAD_ITEM_KIND.USER_MESSAGE), id: item.id };
}

function normalizeItem(item, threadId, turnId, timestamp) {
  if (!item || !String(item.id || "").trim()) throw new Error(`Invalid history item in turn ${turnId}`);
  if (item.type === "userMessage") return normalizeUserItem(item, threadId, turnId, timestamp);
  let kind = ITEM_KINDS.get(item.type) || THREAD_ITEM_KIND.UNKNOWN;
  if (item.type === "subAgentActivity") kind = THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL;
  const payload = { ...item };
  let text = String(item.text || "");
  let summary = text;
  if (item.type === "agentMessage") {
    const record = createRawRecord({ id: item.id, threadId, turnId, seq: 1, recordTs: timestamp, raw: { type: "item.completed", item } });
    text = canonicalizeRawRecords([record], createCanonicalizerState())[0]?.payload?.text || "";
    summary = text;
  } else if (item.type === "reasoning") {
    text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].join("\n");
    summary = text;
  } else if (item.type === "commandExecution") {
    text = String(item.aggregatedOutput || "");
    summary = String(item.command || "执行命令");
    payload.output = text;
  } else if (item.type === "fileChange") {
    summary = (item.changes || []).map((change) => change.path || "").filter(Boolean).join("\n") || "文件变更";
    text = (item.changes || []).map((change) => change.diff || "").filter(Boolean).join("\n");
  } else if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
    summary = [item.server, item.tool].filter(Boolean).join(" · ");
    text = typeof item.result === "string" ? item.result : JSON.stringify(item.result || item.contentItems || item.agentsStates || item.error || "");
  } else if (item.type === "imageView" || item.type === "imageGeneration") {
    payload.url = String(item.savedPath || item.path || item.result || "").trim();
    if (item.type === "imageGeneration" && payload.url && !/^(?:data:|https?:|\/)/.test(payload.url)) payload.url = `data:image/png;base64,${payload.url}`;
    payload.alt = String(item.revisedPrompt || "image");
    summary = item.type === "imageView" ? "查看图片" : "生成图片";
  } else if (item.type === "webSearch") {
    summary = String(item.query || "网页搜索");
  } else if (item.type === "functionCallOutput") {
    summary = String(item.name || "工具输出");
    text = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
  } else if (item.type === "hookPrompt") {
    text = (item.fragments || []).map((fragment) => fragment.text || "").filter(Boolean).join("\n");
    summary = text;
  } else {
    summary ||= String(item.review || item.kind || item.type || "过程事件");
  }
  return createThreadItem({ id: item.id, kind, text, summary, payload, status: item.status || "completed",
    createdAt: timestamp, updatedAt: timestamp, source: "app_server_history" });
}

function buildPayload(thread, turns, row = {}) {
  const threadId = thread.id;
  const sessionId = `history:codex:${threadId}`;
  const normalizedTurns = turns.map((turn) => {
    if (!turn?.id || !turn.status || !Array.isArray(turn.items) || (turn.itemsView && turn.itemsView !== "full")) {
      throw new Error(`Incomplete history turn for ${threadId}`);
    }
    const status = turn.status === "interrupted" ? "aborted" : turn.status;
    const timestamp = iso(turn.startedAt) || iso(thread.createdAt);
    return createTurn({ ...turn, status, startedAt: timestamp, completedAt: iso(turn.completedAt),
      items: turn.items.map((item) => normalizeItem(item, threadId, turn.id, timestamp)), assistant: { status } });
  });
  const session = {
    id: sessionId, provider: "codex", providerLabel: "Codex", cliLabel: "Codex CLI", kind: "history",
    resumeSessionId: threadId, status: row.archived ? "archived" : "saved", name: String(thread.name || row.title || ""),
    cwd: String(thread.cwd || row.cwd || ""), model: String(thread.model || row.model || ""),
    reasoningEffort: String(thread.reasoningEffort ?? row.reasoning_effort ?? ""),
    inputPreview: String(thread.preview || row.first_user_message || ""),
    createdAt: iso(thread.createdAt || row.created_at), updatedAt: iso(thread.updatedAt || row.updated_at),
    sessionType: thread.parentThreadId || thread.agentRole ? "subagent" : "main", parentThreadId: thread.parentThreadId || "",
    agentRole: thread.agentRole || "", agentNickname: thread.agentNickname || ""
  };
  const threadSnapshot = createThreadSnapshot({ threadId, turns: normalizedTurns,
    activeTurnId: normalizedTurns.findLast((turn) => isRunningStatus(turn.status))?.id || null,
    updatedAt: session.updatedAt, version: normalizedTurns.length,
    metadata: { name: session.name, preview: session.inputPreview, cwd: session.cwd, model: session.model, source: "codex" }
  });
  const conversation = deriveConversationStateFromThreadSnapshot(threadSnapshot, { sessionId, threadId });
  const messages = conversation.turns.flatMap((turn) => [
    ...(turn.user?.text ? [{ role: "user", text: turn.user.text, timestamp: turn.user.ts }] : []),
    ...turn.assistant.body.map((part) => ({ role: "assistant", text: part.text || "", timestamp: part.ts,
      ...(part.kind === "image" ? { partType: "image", payload: part.payload } : {}) }))
  ]);
  return { session, messages, conversation, turns: conversation.turns, backgroundAgents: conversation.backgroundAgents,
    threadSnapshot, liveOverlay: null, conversationSnapshot: { type: "conversation.snapshot", session, sessionId, threadId,
      conversation, turns: conversation.turns, backgroundAgents: conversation.backgroundAgents } };
}

async function readAppServerHistory(manager, threadId, row) {
  const bridge = manager.appServerBridge;
  if (!bridge) throw new Error(`Codex app-server is required to read stored history: ${threadId}`);
  await bridge.ensureReady();
  const { thread } = await bridge.request("thread/read", { threadId, includeTurns: false });
  if (!thread || String(thread.id) !== threadId) throw new Error(`App-server returned a different history thread: ${threadId}`);
  const turns = new Map();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await bridge.request("thread/turns/list", { threadId, limit: 50, itemsView: "full", sortDirection: "asc", ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error(`Invalid history page for ${threadId}`);
    for (const turn of page.data) {
      if (!turn?.id) throw new Error(`Invalid history turn for ${threadId}`);
      turns.set(turn.id, turn);
    }
    cursor = page.nextCursor || null;
    if (cursor && seenCursors.has(cursor)) throw new Error(`Repeated history cursor for ${threadId}`);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { payload: buildPayload(thread, [...turns.values()], row), running: isRunningStatus(thread.status) || [...turns.values()].some((turn) => isRunningStatus(turn.status)) };
}

function resolverWithPayload(manager, provider, threadId, payload) {
  const facade = Object.create(manager);
  facade.getHistoricalMessages = (source, id) => source === provider && id === threadId ? payload : manager.getHistoricalMessages(source, id);
  facade.getThreadSnapshotBundle = (source, id) => source === provider && id === threadId ? payload : manager.getThreadSnapshotBundle(source, id);
  return createHistoryPayloadResolver(facade);
}

export async function createAppServerHistoryPayloadResolver(manager, provider, resumeSessionId) {
  const threadId = String(resumeSessionId || "").trim();
  if (provider !== "codex" || !threadId) return createHistoryPayloadResolver(manager);
  const row = readThreadMetadata(manager, threadId);
  if (row && row.history_mode !== "paginated" && row.rollout_path && fs.existsSync(row.rollout_path)) {
    return createHistoryPayloadResolver(manager);
  }
  if (!row) {
    if (!manager.appServerBridge) return createHistoryPayloadResolver(manager);
    try {
      const payload = manager.getHistoricalMessages(provider, threadId);
      if (payload) return createHistoryPayloadResolver(manager);
    } catch (error) {
      if (!manager.appServerBridge) throw error;
    }
  }
  let cache = managerCaches.get(manager);
  if (!cache) { cache = { entries: new Map(), pending: new Map() }; managerCaches.set(manager, cache); }
  const signature = JSON.stringify(row || {});
  const key = `${threadId}:${signature}`;
  const running = hasRunningContinuation(manager, threadId);
  const cached = cache.entries.get(threadId);
  if (!running && cached?.signature === signature && Date.now() - cached.storedAt < CACHE_TTL_MS) {
    return resolverWithPayload(manager, provider, threadId, cached.payload);
  }
  let task = cache.pending.get(key);
  if (!task) {
    task = readAppServerHistory(manager, threadId, row || {});
    cache.pending.set(key, task);
  }
  try {
    const result = await task;
    if (!running && !result.running && !hasRunningContinuation(manager, threadId) && JSON.stringify(readThreadMetadata(manager, threadId) || {}) === signature) {
      cache.entries.delete(threadId);
      cache.entries.set(threadId, { signature, storedAt: Date.now(), payload: result.payload });
      while (cache.entries.size > MAX_CACHED_THREADS) cache.entries.delete(cache.entries.keys().next().value);
    } else cache.entries.delete(threadId);
    return resolverWithPayload(manager, provider, threadId, result.payload);
  } catch (error) {
    cache.entries.delete(threadId);
    throw error;
  } finally {
    if (cache.pending.get(key) === task) cache.pending.delete(key);
  }
}
