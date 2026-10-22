import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
const CACHE_MS = 2000;
const QUESTION_OPEN = "<send_user_message_question_reply>";
const QUESTION_CLOSE = "</send_user_message_question_reply>";
const MESSAGE_SETTING_KEYS = ["model", "effort", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"];

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, uncertain: false, ...details });
}

function aborted() {
  return Object.assign(failure("CODEX_DESKTOP_ABORTED", "Desktop discovery was cancelled."), { name: "AbortError" });
}

function cancellable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) throw failure("CODEX_DESKTOP_PROTOCOL", "Desktop request exceeds the frame limit.");
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length);
  body.copy(result, 4);
  return result;
}

function questionText(input) {
  const text = input?.length === 1 && input[0]?.type === "text" ? input[0].text : null;
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_REPLY_BYTES ||
      !text.startsWith(QUESTION_OPEN) || !text.endsWith(QUESTION_CLOSE)) {
    throw failure("CODEX_DESKTOP_INVALID_REPLY", "Only native async question answers can be sent through desktop IPC.");
  }
  let answers;
  try { answers = JSON.parse(text.slice(QUESTION_OPEN.length, -QUESTION_CLOSE.length)); } catch {}
  if (!Array.isArray(answers) || !answers.length || answers.some((answer) => {
    if (!answer || typeof answer.question !== "string" || typeof answer.answer !== "string") return true;
    try {
      const id = JSON.parse(answer.questionItemId);
      return !Array.isArray(id) || id.length !== 3 || id[0] !== "request_user_input_async" ||
        typeof id[1] !== "string" || !id[1] || !Number.isInteger(id[2]) || id[2] < 0;
    } catch { return true; }
  })) throw failure("CODEX_DESKTOP_INVALID_REPLY", "The native question answer identity is invalid.");
  return text;
}

function messageInput(input) {
  const invalid = () => failure("CODEX_DESKTOP_INVALID_MESSAGE", "Desktop messages require text or absolute local image paths.");
  if (!Array.isArray(input) || !input.length) throw invalid();
  const nativeInput = input.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text, text_elements: [] };
    }
    if (item?.type === "localImage" && typeof item.path === "string" && path.isAbsolute(item.path) && !item.path.includes("\0")) {
      return { type: "localImage", path: item.path };
    }
    throw invalid();
  });
  if (!nativeInput.some((item) => item.type === "localImage" || item.text.trim())) throw invalid();
  return nativeInput;
}

function messageSettings(settings) {
  if (!settings || MESSAGE_SETTING_KEYS.some((key) => !Object.hasOwn(settings, key)) ||
      Object.keys(settings).some((key) => !MESSAGE_SETTING_KEYS.includes(key)) ||
      ["model", "effort"].some((key) => settings[key] !== null && (typeof settings[key] !== "string" || !settings[key].trim())) ||
      !["never", "on-request"].includes(settings.approvalPolicy) || !["user", "auto_review"].includes(settings.approvalsReviewer) ||
      !["dangerFullAccess", "workspaceWrite", "readOnly"].includes(settings.sandboxPolicy?.type)) {
    throw failure("CODEX_DESKTOP_INVALID_SETTINGS", "Desktop messages require complete model, effort and permission settings.");
  }
  return structuredClone(Object.fromEntries(MESSAGE_SETTING_KEYS.map((key) => [key, settings[key]])));
}

// Keep explicit entry points for discovery, replies, submitted messages and
// interruption of an identified turn. No generic RPC entry point is exposed.
export class CodexDesktopClient {
  #connection = null;
  #connecting = null;
  #generation = 0;
  #closed = false;
  #discoveries = new Map();
  #cache = new Map();
  #interruptions = new Map();

  constructor({ config = {}, socketPath, timeoutMs } = {}) {
    this.socketPath = socketPath ?? (config.codexConfigPath
      ? path.join(path.dirname(config.codexConfigPath), "ipc", "ipc.sock") : null);
    this.readTimeoutMs = timeoutMs ?? 1000;
    this.steerTimeoutMs = timeoutMs ?? 20000;
    if (!Number.isFinite(this.readTimeoutMs) || this.readTimeoutMs <= 0) throw new TypeError("timeoutMs must be positive.");
  }

  discover(threadId, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    const cached = this.#cache.get(threadId);
    if (!this.#closed && this.#connection?.clientId && cached && cached.expires > Date.now() && cached.generation === this.#connection.generation) {
      return cancellable(Promise.resolve(cached.owner), signal);
    }
    let pending = this.#discoveries.get(threadId);
    if (!pending) {
      pending = this.#discoverOwner(threadId).then((owner) => {
        this.#cache.set(threadId, { owner, expires: Date.now() + CACHE_MS, generation: this.#connection?.generation });
        while (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value);
        return owner;
      }).finally(() => { if (this.#discoveries.get(threadId) === pending) this.#discoveries.delete(threadId); });
      this.#discoveries.set(threadId, pending);
    }
    return cancellable(pending, signal);
  }

  async steer(threadId, { owner, clientUserMessageId, input, expectedTurnId } = {}) {
    if (expectedTurnId != null && (typeof expectedTurnId !== "string" || !expectedTurnId)) {
      throw failure("CODEX_DESKTOP_INVALID_REPLY", "A stable reply identity is required.");
    }
    // The follower API chooses its active turn and has no atomic expected-turn
    // guard. Return the actual receipt without retrying a different turn.
    return this.#answer(threadId, { owner, clientUserMessageId, input }, false);
  }

  async startQuestion(threadId, { owner, clientUserMessageId, input } = {}) {
    return this.#answer(threadId, { owner, clientUserMessageId, input }, true);
  }

  async interruptTurn(threadId, { owner, expectedTurnId } = {}) {
    if (typeof expectedTurnId !== "string" || !expectedTurnId.trim() || expectedTurnId !== expectedTurnId.trim() ||
        /[\u0000-\u001f\u007f]/.test(expectedTurnId)) {
      throw failure("CODEX_DESKTOP_INVALID_INTERRUPT", "A stable target turn ID is required to stop desktop execution.");
    }
    const ownerClientId = owner?.clientId;
    const key = JSON.stringify([threadId, ownerClientId, expectedTurnId]);
    let pending = this.#interruptions.get(key);
    if (!pending) {
      pending = (async () => {
        const current = await this.#discoverOwner(threadId);
        if (!ownerClientId || current.clientId !== ownerClientId) {
          throw failure("CODEX_DESKTOP_OWNER_CHANGED", "The desktop conversation owner changed. Refresh before stopping.");
        }
        const response = await this.#request(this.#connection, "thread-follower-interrupt-turn", {
          conversationId: threadId, mode: "user-stop", expectedTurnId,
        }, { targetClientId: current.clientId, timeoutMs: this.steerTimeoutMs, mutation: true, expectedTurnId });
        // Unlike start/steer, interruption fields are directly in the IPC result.
        const result = response.result;
        if (result?.ok !== true || result.interruptedTurnId !== null && result.interruptedTurnId !== expectedTurnId ||
            result.goalPauseError != null && typeof result.goalPauseError !== "string") {
          throw failure("CODEX_DESKTOP_DELIVERY_UNCERTAIN", "Desktop did not return a verifiable stop receipt; refresh the target turn before trying again.",
            { uncertain: true, requestId: response.requestId, expectedTurnId });
        }
        // A null receipt means the requested turn is no longer active, even if
        // another turn has started. Never retry without the original target.
        return { ok: true, turnId: result.interruptedTurnId,
          ...(result.goalPauseError != null ? { goalPauseError: result.goalPauseError } : {}) };
      })().finally(() => { this.#interruptions.delete(key); });
      this.#interruptions.set(key, pending);
    }
    return pending;
  }

  async startMessage(threadId, { owner, clientUserMessageId, input, settings, beforeSend } = {}) {
    const nativeInput = messageInput(input);
    const submittedSettings = messageSettings(settings);
    if (typeof clientUserMessageId !== "string" || !clientUserMessageId.trim()) {
      throw failure("CODEX_DESKTOP_INVALID_MESSAGE", "A stable message identity is required.");
    }
    const current = await this.#discoverOwner(threadId);
    if (!owner?.clientId || current.clientId !== owner.clientId) {
      throw failure("CODEX_DESKTOP_OWNER_CHANGED", "The desktop conversation owner changed. Refresh before sending.");
    }
    if (!current.supportsUntrustedAppInput) {
      throw failure("CODEX_DESKTOP_UNSUPPORTED", "This desktop owner does not support submitted message settings.");
    }
    if (beforeSend && !await beforeSend()) {
      throw failure("CODEX_DESKTOP_NOT_IDLE", "Desktop activity changed before sending; keep this message queued.");
    }
    const text = nativeInput.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const restoreMessage = {
      id: clientUserMessageId, text, createdAt: Date.now(),
      context: { prompt: text, addedFiles: [], fileAttachments: [],
        imageAttachments: nativeInput.filter((item) => item.type === "localImage")
          .map((item, index) => ({ id: `${clientUserMessageId}:${index}`, src: item.path })),
        ideContext: null, workspaceRoots: [], turnTrigger: "composer" },
    };
    const response = await this.#request(this.#connection, "thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: {
        request: { threadId, clientUserMessageId, input: nativeInput, turnTrigger: "composer", ...submittedSettings },
        context: { restoreMessage, attachments: [], inheritThreadSettings: false,
          useAppServerPermissionDefault: false, usePermissionSelection: false },
      },
    }, { targetClientId: current.clientId, timeoutMs: this.steerTimeoutMs, mutation: true, clientUserMessageId });
    const turnId = response.result?.result?.turn?.id;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw failure("CODEX_DESKTOP_DELIVERY_UNCERTAIN", "Desktop did not return a verifiable message receipt.",
        { uncertain: true, requestId: response.requestId, clientUserMessageId });
    }
    return { turnId };
  }

  async #answer(threadId, { owner, clientUserMessageId, input }, start) {
    const text = questionText(input);
    if (typeof clientUserMessageId !== "string" || !clientUserMessageId) {
      throw failure("CODEX_DESKTOP_INVALID_REPLY", "A stable reply identity is required.");
    }
    // Never trust the metadata cache when sending. A changed owner must be
    // surfaced to the caller instead of routing a stale request elsewhere.
    const current = await this.#discoverOwner(threadId);
    if (!owner?.clientId || current.clientId !== owner.clientId) {
      throw failure("CODEX_DESKTOP_OWNER_CHANGED", "The desktop conversation owner changed. Refresh before answering.");
    }
    const restoreMessage = {
      id: clientUserMessageId, text, createdAt: Date.now(),
      context: { prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [],
        ideContext: null, workspaceRoots: [], turnTrigger: "send_user_message_async_question" },
    };
    const nativeInput = [{ type: "text", text, text_elements: [] }];
    const params = start ? {
      conversationId: threadId,
      turnStart: {
        request: { threadId, clientUserMessageId, input: nativeInput, turnTrigger: "send_user_message_async_question" },
        context: { restoreMessage, attachments: [], inheritThreadSettings: true },
      },
    } : {
      conversationId: threadId,
      clientUserMessageId,
      input: nativeInput, attachments: [], restoreMessage,
    };
    const response = await this.#request(this.#connection, start ? "thread-follower-start-turn" : "thread-follower-steer-turn", params,
      { targetClientId: current.clientId, timeoutMs: this.steerTimeoutMs, mutation: true, clientUserMessageId });
    const nativeResult = response.result?.result;
    const result = start ? { turnId: nativeResult?.turn?.id } : nativeResult;
    if (!result || typeof result.turnId !== "string" || !result.turnId) {
      throw failure("CODEX_DESKTOP_DELIVERY_UNCERTAIN", "Desktop did not return a verifiable answer receipt.",
        { uncertain: true, requestId: response.requestId, clientUserMessageId });
    }
    return result;
  }

  shutdown() {
    this.#closed = true;
    this.#cache.clear();
    if (this.#connection) this.#disconnect(this.#connection, failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop client was shut down."));
  }

  async #discoverOwner(threadId) {
    if (typeof threadId !== "string" || !threadId) throw failure("CODEX_DESKTOP_UNAVAILABLE", "A conversation ID is required.");
    const deadline = Date.now() + this.readTimeoutMs;
    const connection = await this.#ensureConnected();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop discovery timed out.");
    const response = await this.#request(connection, "thread-owner-discovery", { hostId: "local", conversationId: threadId }, { timeoutMs: remaining });
    if (typeof response.handledByClientId !== "string" || !response.handledByClientId) {
      throw failure("CODEX_DESKTOP_PROTOCOL", "Desktop owner discovery returned an invalid owner.");
    }
    return { clientId: response.handledByClientId, supportsUntrustedAppInput: response.result?.supportsUntrustedAppInput === true };
  }

  async #validateSocket() {
    if (this.#closed || !this.socketPath || !path.isAbsolute(this.socketPath) || typeof process.getuid !== "function") {
      throw failure("CODEX_DESKTOP_UNAVAILABLE", "A local desktop IPC socket is not configured on this host.");
    }
    try {
      const [directory, socket] = await Promise.all([lstat(path.dirname(this.socketPath)), lstat(this.socketPath)]);
      const uid = process.getuid();
      if (!directory.isDirectory() || !socket.isSocket() || directory.uid !== uid || socket.uid !== uid ||
          (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) {
        throw failure("CODEX_DESKTOP_UNSAFE_SOCKET", "Desktop IPC must be a private socket owned by the current user.");
      }
    } catch (error) {
      if (error.code === "CODEX_DESKTOP_UNSAFE_SOCKET") throw error;
      throw failure("CODEX_DESKTOP_UNAVAILABLE", "The desktop IPC socket is unavailable.");
    }
  }

  async #ensureConnected() {
    if (this.#closed) throw failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop client was shut down.");
    if (this.#connection?.clientId && !this.#connection.socket.destroyed) return this.#connection;
    if (this.#connecting) return this.#connecting;
    const opening = this.#open();
    this.#connecting = opening;
    try { return await opening; } finally { if (this.#connecting === opening) this.#connecting = null; }
  }

  async #open() {
    const deadline = Date.now() + this.readTimeoutMs;
    await this.#validateSocket();
    if (this.#closed) throw failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop client was shut down.");
    const socket = net.createConnection(this.socketPath);
    const connection = { socket, generation: ++this.#generation, pending: new Map(), buffer: Buffer.alloc(0), clientId: null };
    this.#connection = connection;
    socket.on("data", (chunk) => this.#read(connection, chunk));
    socket.on("error", () => this.#disconnect(connection, failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC connection failed.")));
    socket.on("close", () => this.#disconnect(connection, failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC disconnected.")));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC connection timed out.")), Math.max(1, deadline - Date.now()));
        const connected = () => done();
        const closed = () => done(failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC connection closed."));
        const done = (error) => { clearTimeout(timer); socket.off("connect", connected); socket.off("close", closed); error ? reject(error) : resolve(); };
        socket.once("connect", connected);
        socket.once("close", closed);
      });
      const response = await this.#request(connection, "initialize", { clientType: "codex-web-terminal" }, { timeoutMs: Math.max(1, deadline - Date.now()) });
      if (typeof response.result?.clientId !== "string" || !response.result.clientId) throw failure("CODEX_DESKTOP_PROTOCOL", "Desktop IPC initialization failed.");
      connection.clientId = response.result.clientId;
      return connection;
    } catch (error) { this.#disconnect(connection, error); throw error; }
  }

  #request(connection, method, params, { timeoutMs, targetClientId, mutation = false, clientUserMessageId, expectedTurnId } = {}) {
    if (!connection || connection !== this.#connection || connection.socket.destroyed || this.#closed) {
      return Promise.reject(failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC is not connected."));
    }
    const requestId = randomUUID();
    const message = { type: "request", requestId, sourceClientId: connection.clientId ?? "initializing-client",
      version: method === "initialize" ? 0 : method === "thread-follower-start-turn" ? 2
        : method === "thread-follower-interrupt-turn" ? 4 : 1,
      method, params, timeoutMs, ...(targetClientId ? { targetClientId } : {}) };
    return new Promise((resolve, reject) => {
      const pending = { method, targetClientId, mutation, clientUserMessageId, expectedTurnId, resolve, reject, dispatched: false };
      pending.timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(this.#requestError(failure("CODEX_DESKTOP_UNAVAILABLE", "Desktop IPC request timed out."), pending, requestId));
      }, timeoutMs);
      connection.pending.set(requestId, pending);
      try { const encoded = frame(message); pending.dispatched = true; connection.socket.write(encoded); }
      catch (error) {
        clearTimeout(pending.timer); connection.pending.delete(requestId);
        reject(this.#requestError(error, pending, requestId));
      }
    });
  }

  #requestError(error, pending, requestId) {
    if (!pending.mutation || !pending.dispatched) return error;
    if (pending.method === "thread-follower-interrupt-turn") {
      return failure("CODEX_DESKTOP_DELIVERY_UNCERTAIN", "Desktop stop acknowledgement was lost; refresh the target turn before trying again.",
        { uncertain: true, requestId, expectedTurnId: pending.expectedTurnId });
    }
    return failure("CODEX_DESKTOP_DELIVERY_UNCERTAIN", "Desktop answer acknowledgement was lost; do not resend automatically.",
      { uncertain: true, requestId, clientUserMessageId: pending.clientUserMessageId });
  }

  #read(connection, chunk) {
    if (connection !== this.#connection) return;
    try {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      while (connection.buffer.length >= 4) {
        const length = connection.buffer.readUInt32LE(0);
        if (!length || length > MAX_FRAME_BYTES) throw failure("CODEX_DESKTOP_PROTOCOL", "Desktop IPC frame length is invalid.");
        if (connection.buffer.length < length + 4) return;
        const message = JSON.parse(connection.buffer.subarray(4, length + 4).toString("utf8"));
        connection.buffer = connection.buffer.subarray(length + 4);
        if (message?.type === "client-discovery-request" && typeof message.requestId === "string") {
          connection.socket.write(frame({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }));
        } else if (message?.type === "response") this.#respond(connection, message);
      }
    } catch (error) { this.#disconnect(connection, failure("CODEX_DESKTOP_PROTOCOL", "Desktop IPC returned an invalid frame.")); }
  }

  #respond(connection, response) {
    const pending = connection.pending.get(response.requestId);
    if (!pending) return;
    connection.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.resultType === "error") {
      const reason = typeof response.error === "string" ? response.error : "unknown-desktop-error";
      const error = failure("CODEX_DESKTOP_REJECTED", `Desktop rejected the request: ${reason}`, { reason });
      pending.reject(/timeout|disconnected|server-closed|destroyed|disposed/.test(reason)
        ? this.#requestError(error, pending, response.requestId) : error);
    } else if (response.resultType !== "success" || response.method !== pending.method ||
        (pending.targetClientId && response.handledByClientId !== pending.targetClientId)) {
      pending.reject(this.#requestError(failure("CODEX_DESKTOP_PROTOCOL", "Desktop IPC response identity does not match."), pending, response.requestId));
    } else pending.resolve(response);
  }

  #disconnect(connection, error) {
    if (connection === this.#connection) { this.#connection = null; this.#cache.clear(); }
    for (const [requestId, pending] of connection.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.#requestError(error, pending, requestId));
    }
    connection.pending.clear();
    connection.buffer = Buffer.alloc(0);
    connection.socket.destroy();
  }
}
