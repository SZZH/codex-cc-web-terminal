import {
  buildConversationStateFromPayload,
  createConversationState
} from "./conversation-timeline.js";
import { normalizeHistoryMessages, wait } from "./session-helpers.js";
import { cacheKey } from "./session-list.js";

export async function hydrateHistoricalSession(
  session,
  {
    includeMessages = false,
    silent = false,
    forceRefresh = false,
    sessionCache,
    pendingHydrations,
    historyApiAvailable,
    requestHistoryMessages,
    onError
  } = {}
) {
  if (!session || session.kind === "live" || !session.resumeSessionId) {
    return null;
  }

  const key = cacheKey(session);
  const cached = sessionCache[key];
  if (!forceRefresh && cached?.hydrated && (!includeMessages || cached.messages)) {
    return cached;
  }

  if (pendingHydrations.has(key)) {
    if (!includeMessages && !forceRefresh) {
      return cached || null;
    }
    while (pendingHydrations.has(key)) {
      await wait(80);
    }
    return sessionCache[key] || null;
  }

  const task = (async () => {
    const payload = await requestHistoryMessages(session, historyApiAvailable);
    if (!payload) {
      const nextValue = {
        hydrated: true,
        title: String(session?.name || "").trim(),
        preview: String(session?.inputPreview || "").trim(),
        messages: [],
        turns: [],
        backgroundAgents: [],
        conversation: createConversationState({
          threadId: String(session?.resumeSessionId || "")
        }),
        threadSnapshot: null,
        liveOverlay: null,
        session: null
      };
      sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
      return sessionCache[key];
    }

    const messages = normalizeHistoryMessages(payload.messages || []);
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const backgroundAgents = Array.isArray(payload.backgroundAgents) ? payload.backgroundAgents : [];
    const conversation = buildConversationStateFromPayload(payload, {
      threadId: String(session?.resumeSessionId || ""),
      turns,
      backgroundAgents
    });
    const title = String(payload.session?.name || session.name || "").trim();
    const preview = String(payload.session?.inputPreview || session.inputPreview || "").trim();
    const nextValue = {
      hydrated: true,
      title,
      preview,
      messages,
      turns,
      backgroundAgents,
      conversation,
      threadSnapshot: payload.threadSnapshot || null,
      liveOverlay: payload.liveOverlay || null,
      session: payload.session || null
    };
    sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
    return sessionCache[key];
  })();

  pendingHydrations.set(key, task);
  try {
    return await task;
  } catch (error) {
    if (!silent && typeof onError === "function") {
      onError(error);
    }
    return sessionCache[key] || null;
  } finally {
    pendingHydrations.delete(key);
  }
}
