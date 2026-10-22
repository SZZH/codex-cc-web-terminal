import { presentDesktopQuestion } from "./questionPresentation.js";

const fail = (message, code = "question_unavailable", status = 409) => Object.assign(new Error(message), { code, status });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const active = (turn) => ["inProgress", "running"].includes(turn?.status);
const identity = (callId, index) => JSON.stringify(["request_user_input_async", callId, index]);

function validate(callId, body) {
  if (!/^call_[\w-]{1,500}$/.test(callId || "") || !body ||
    Object.keys(body).some((key) => !["clientRequestId", "expectedTurnId", "index", "answer"].includes(key)) ||
    !/^[\w-]{8,128}$/.test(body.clientRequestId || "") || typeof body.expectedTurnId !== "string" ||
    !body.expectedTurnId.trim() || body.expectedTurnId.length > 512 || !Number.isInteger(body.index) || body.index < 0 || body.index >= 12 ||
    typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 10_000) {
    throw fail("问题或回答格式无效，请刷新后重试。", "invalid_question_answer", 400);
  }
  return { callId, index: body.index, answer: body.answer.trim(), expectedTurnId: body.expectedTurnId };
}

function hasAnswer(item, questionId) {
  if (!["userMessage", "steeringUserMessage"].includes(item.type)) return false;
  const text = item.presentation?.text ?? item.text ?? (item.content || []).filter((part) => ["text", "inputText", "input_text"].includes(part.type)).map((part) => part.text || "").join("\n\n");
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return false;
  try { return JSON.parse(match[1]).some((entry) => entry.questionItemId === questionId && typeof entry.answer === "string"); }
  catch { return false; }
}

/** Translates a validated question reply only; never exposes arbitrary desktop IPC. */
export class DesktopQuestionResponder {
  constructor({ client, reader, requests, update, finish, isClosed }) {
    Object.assign(this, { client, reader, requests, update, finish, isClosed });
    this.preparing = new Map();
    this.sending = new Set();
  }

  async respond(threadId, callId, body) {
    const reply = validate(callId, body);
    const key = JSON.stringify([threadId, callId, reply.index]);
    const existing = this.requests.get(threadId, body.clientRequestId);
    if (existing) {
      if (existing.executionRoute !== "desktopQuestion" || !same(existing.questionReply, reply)) throw fail("这个请求编号已用于不同内容。", "question_answer_conflict");
      return existing;
    }
    if (this.preparing.has(key)) {
      await this.preparing.get(key).catch(() => {});
      return this.respond(threadId, callId, body);
    }
    const promise = this.prepare(threadId, reply, body.clientRequestId);
    this.preparing.set(key, promise);
    try { return await promise; }
    finally { if (this.preparing.get(key) === promise) this.preparing.delete(key); }
  }

  async prepare(threadId, reply, clientRequestId) {
    if (this.isClosed()) throw fail("服务正在重启，请稍后重试。", "service_unavailable", 503);
    const duplicate = this.requests.list(threadId).find((entry) => entry.questionReply?.callId === reply.callId &&
      entry.questionReply.index === reply.index && !["rejected", "failed", "cancelled"].includes(entry.state));
    if (duplicate) throw fail("这个问题已经提交回答，正在同步结果。", "question_answer_conflict");
    const signal = AbortSignal.timeout(8_000);
    const [owner, source, page] = await Promise.all([
      this.client.discover(threadId, { signal }),
      this.reader.rawItem(threadId, reply.expectedTurnId, reply.callId, { signal }),
      this.reader.listTurns(threadId, { limit: 5, signal })
    ]);
    if (!owner?.clientId || !owner.supportsUntrustedAppInput) throw fail("暂时无法连接此任务的 Codex 桌面端，请保持桌面端运行后重试。", "desktop_unavailable");
    if (!Array.isArray(page.turns) || !page.turns.length) throw fail("会话状态尚未确认，请刷新后回答。", "question_turn_changed");
    const question = presentDesktopQuestion(source.item);
    const entry = question?.questions?.[reply.index];
    if (!question || question.callId !== reply.callId || question.truncated || !entry) throw fail("问题已不可用，请刷新会话。核实后再回答。");
    await this.assertUnanswered(threadId, reply, page, signal);
    const latest = await this.reader.listTurns(threadId, { limit: 1, signal });
    const latestTurn = latest.turns?.at(-1);
    if (latestTurn?.id !== page.turns.at(-1)?.id)
      throw fail("会话刚刚有新回复，请稍后重新提交回答。", "question_history_changed");
    if (!latestTurn || !["inProgress", "running", "completed", "failed", "interrupted", "aborted"].includes(latestTurn.status))
      throw fail("会话状态尚未确认，请刷新后回答。", "question_turn_changed");
    if (this.isClosed()) throw fail("服务正在重启，请稍后重试。", "service_unavailable", 503);
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: identity(reply.callId, reply.index), question: entry.title, answer: reply.answer }])}\n</send_user_message_question_reply>`;
    const receipt = this.requests.receive(threadId, { clientRequestId, input: { text, attachments: [] }, options: {},
      mode: "steer", expectedTurnId: reply.expectedTurnId, questionReply: reply });
    this.update(threadId, receipt.id, { executionRoute: "desktopQuestion", error: null });
    // The durable dispatch marker precedes all IPC writes, including after restart.
    const dispatching = this.update(threadId, receipt.id, { state: "dispatching" });
    void this.dispatch(dispatching, owner, active(latestTurn));
    return dispatching;
  }

  async assertUnanswered(threadId, reply, page, signal) {
    // Replies remain valid after their source turn ends, and their accepted
    // user message can belong to any subsequent turn. Scan only on submission.
    const turnCursors = new Set();
    for (;;) {
      for (const turn of [...(page.turns || [])].reverse()) {
        let cursor;
        const seen = new Set();
        for (;;) {
          const tail = await this.reader.listItems(threadId, turn.id, { limit: 30, signal,
            ...(cursor ? { cursor } : turn.id === reply.expectedTurnId ? { after: reply.callId } : {}) });
          for (const preview of tail.items || []) {
            if (!["userMessage", "steeringUserMessage"].includes(preview.type)) continue;
            const item = preview.truncated || preview.hasDetails
              ? (await this.reader.rawItem(threadId, turn.id, preview.id, { signal })).item : preview;
            if (hasAnswer(item, identity(reply.callId, reply.index)))
              throw fail("这个问题已在另一端回答，请刷新会话。", "question_already_answered");
          }
          signal.throwIfAborted();
          if (!tail.hasMore) break;
          if (!tail.nextCursor || seen.has(tail.nextCursor)) throw fail("问题状态尚未读取完整，请稍后重试。", "question_history_incomplete");
          cursor = tail.nextCursor;
          seen.add(cursor);
        }
        if (turn.id === reply.expectedTurnId) return;
      }
      if (!page.hasMore || !page.olderCursor || turnCursors.has(page.olderCursor))
        throw fail("问题状态尚未读取完整，请稍后重试。", "question_history_incomplete");
      turnCursors.add(page.olderCursor);
      page = await this.reader.listTurns(threadId, { limit: 5, cursor: page.olderCursor, signal });
    }
  }

  async dispatch(receipt, owner, running) {
    const key = JSON.stringify([receipt.threadId, receipt.id]);
    if (this.sending.has(key)) return;
    this.sending.add(key);
    try {
      const send = running ? this.client.steer.bind(this.client) : this.client.startQuestion.bind(this.client);
      const result = await send(receipt.threadId, { owner, clientUserMessageId: receipt.id,
        expectedTurnId: receipt.expectedTurnId, input: [{ type: "text", text: receipt.input.text, text_elements: [] }] });
      if (!result?.turnId) throw Object.assign(fail("回答接收状态尚未确认。"), { uncertain: true });
      const current = this.requests.get(receipt.threadId, receipt.id);
      if (!["dispatching", "unknown"].includes(current?.state)) return;
      this.update(receipt.threadId, receipt.id, { state: "accepted", turnId: result.turnId, error: null });
    } catch (error) {
      const current = this.requests.get(receipt.threadId, receipt.id);
      if (!["dispatching", "unknown"].includes(current?.state)) return;
      const uncertain = Boolean(error.uncertain);
      this.update(receipt.threadId, receipt.id, { state: uncertain ? "unknown" : "rejected", error: {
        code: uncertain ? "confirmation_required" : error.code || "desktop_answer_rejected",
        message: uncertain ? "回答已发出，但接收状态尚未确认，正在同步；请勿重复提交。" : "回答未被接收。请保持 Codex 桌面端运行并刷新后重试。"
      } });
      if (!uncertain) this.finish(receipt.threadId, receipt.id);
    } finally { this.sending.delete(key); }
  }
}
