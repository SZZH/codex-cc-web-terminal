const QUEUE_PAGE_SIZE = 50;
// Codex currently caps each thread's durable queue at 100 submissions.
const MAX_QUEUE_PAGES = 2;

export class CodexQueuedWriter {
  constructor({ bridge }) {
    this.bridge = bridge;
  }

  async enqueue(threadId, clientRequestId, input) {
    await this.bridge.ensureReady();
    const result = await this.bridge.request("thread/queue/add", {
      threadId,
      input,
      clientUserMessageId: clientRequestId
    });
    const submission = result?.queuedSubmission;
    if (typeof submission?.id !== "string" || !submission.id.trim()
      || submission.clientUserMessageId !== clientRequestId) {
      throw Object.assign(new Error("Codex queue acknowledgement is invalid"), { uncertain: true });
    }
    return submission;
  }

  async find(threadId, clientRequestId) {
    await this.bridge.ensureReady();
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
      const result = await this.bridge.request("thread/queue/list", {
        threadId,
        cursor,
        limit: QUEUE_PAGE_SIZE
      });
      if (!Array.isArray(result?.data) || (result.nextCursor !== null && typeof result.nextCursor !== "string")) {
        throw new Error("Codex queue list response is invalid");
      }
      const found = result.data.find((submission) => submission?.clientUserMessageId === clientRequestId);
      if (found) return found;
      cursor = result.nextCursor;
      if (cursor === null) return null;
      if (!cursor || seen.has(cursor)) throw new Error("Codex queue pagination cursor is invalid");
      seen.add(cursor);
    }
    throw new Error("Codex queue pagination exceeded its 100-item capacity");
  }

  async list(threadId, { signal } = {}) {
    await this.bridge.ensureReady();
    signal?.throwIfAborted();
    // Read the full (at most 100-item) queue in one page. Offset pagination over
    // a changing queue can skip entries and incorrectly report them as removed.
    const result = await this.bridge.request("thread/queue/list", {
      threadId, cursor: null, limit: QUEUE_PAGE_SIZE * MAX_QUEUE_PAGES
    }, { signal });
    signal?.throwIfAborted();
    if (!Array.isArray(result?.data) || result.nextCursor !== null || result.data.length > 100
      || result.data.some((item) => typeof item?.id !== "string" || !item.id.trim()
        || item.clientUserMessageId != null && typeof item.clientUserMessageId !== "string")
      || new Set(result.data.map((item) => item.id)).size !== result.data.length
      || new Set(result.data.map((item) => item.clientUserMessageId).filter(Boolean)).size
        !== result.data.filter((item) => item.clientUserMessageId).length) {
      throw new Error("Codex queue snapshot is incomplete or invalid");
    }
    return result.data;
  }

  async delete(threadId, queueId) {
    await this.bridge.ensureReady();
    const result = await this.bridge.request("thread/queue/delete", { threadId, queuedSubmissionId: queueId });
    return result?.deleted === true;
  }
}
