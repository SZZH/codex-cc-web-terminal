export async function handleHistoryRoute(ctx, runtime) {
  function getThreadBundle(provider, resumeSessionId) {
    const snapshotBundle = runtime.sessionManager.getThreadSnapshotBundle(provider, resumeSessionId) || {};
    const continuation =
      runtime.sessionManager.getThreadContinuationRuntime?.(provider, resumeSessionId) ||
      runtime.sessionManager.getLiveHistoryContinuation?.(provider, resumeSessionId) ||
      null;
    const liveOverlay = continuation?.liveOverlay || snapshotBundle.liveOverlay || null;
    return {
      ...snapshotBundle,
      session: snapshotBundle.session || continuation?.session || null,
      threadSnapshot: snapshotBundle.threadSnapshot || continuation?.threadSnapshot || null,
      conversation: snapshotBundle.conversation || continuation?.conversation || null,
      continuation: continuation || null,
      thread: {
        snapshot: snapshotBundle.threadSnapshot || continuation?.threadSnapshot || null,
        continuation: continuation || null
      },
      liveOverlay
    };
  }

  function getThreadConversationPayload(provider, resumeSessionId) {
    const bundle = getThreadBundle(provider, resumeSessionId);
    return {
      ...(bundle.conversationSnapshot || bundle.conversation || {}),
      threadSnapshot: bundle.threadSnapshot || null,
      continuation: bundle.continuation || null,
      thread: bundle.thread,
      liveOverlay: bundle.liveOverlay || null
    };
  }

  function getThreadMessagesPayload(provider, resumeSessionId) {
    let historicalPayload = null;
    let historicalError = null;
    try {
      historicalPayload = runtime.sessionManager.getHistoricalMessages(provider, resumeSessionId);
    } catch (err) {
      historicalError = err;
    }

    const bundle = getThreadBundle(provider, resumeSessionId);
    if (historicalPayload) {
      const authoritativeSession = bundle.continuation
        ? bundle.continuation.session || historicalPayload.session || bundle.session || null
        : historicalPayload.session || bundle.session || null;
      const authoritativeSnapshot = bundle.continuation
        ? bundle.continuation.threadSnapshot || historicalPayload?.threadSnapshot || bundle.threadSnapshot || null
        : historicalPayload?.threadSnapshot || bundle.threadSnapshot || null;
      const authoritativeConversation = bundle.continuation
        ? bundle.continuation.conversation || historicalPayload?.conversation || bundle.conversation || null
        : historicalPayload?.conversation || bundle.conversation || null;
      const authoritativeTurns = bundle.continuation
        ? authoritativeConversation?.turns || historicalPayload?.turns || []
        : historicalPayload?.turns || authoritativeConversation?.turns || [];
      const authoritativeBackgroundAgents = bundle.continuation
        ? authoritativeConversation?.backgroundAgents || historicalPayload?.backgroundAgents || []
        : historicalPayload?.backgroundAgents || authoritativeConversation?.backgroundAgents || [];
      return {
        ...historicalPayload,
        session: authoritativeSession,
        turns: authoritativeTurns,
        backgroundAgents: authoritativeBackgroundAgents,
        conversation: authoritativeConversation,
        conversationSnapshot:
          historicalPayload?.conversationSnapshot ||
          (authoritativeConversation
            ? {
                type: "conversation.snapshot",
                session: authoritativeSession,
                sessionId: authoritativeConversation.sessionId || authoritativeSession?.id || "",
                threadId: authoritativeConversation.threadId || resumeSessionId,
                conversation: authoritativeConversation,
                turns: authoritativeConversation.turns || [],
                backgroundAgents: authoritativeConversation.backgroundAgents || []
              }
            : null),
        threadSnapshot: authoritativeSnapshot,
        continuation: bundle.continuation || null,
        thread: bundle.thread,
        liveOverlay: historicalPayload?.liveOverlay || bundle.liveOverlay || null
      };
    }

    if (bundle.continuation) {
      const conversation = bundle.conversation || null;
      const session =
        bundle.session || {
          id: `history:${provider}:${resumeSessionId}`,
          provider,
          resumeSessionId,
          kind: "thread",
          status: "saved"
        };
      return {
        session,
        messages: [],
        turns: conversation?.turns || [],
        backgroundAgents: conversation?.backgroundAgents || [],
        conversation,
        conversationSnapshot: conversation
          ? {
              type: "conversation.snapshot",
              session,
              sessionId: conversation.sessionId || session.id || "",
              threadId: conversation.threadId || resumeSessionId,
              conversation,
              turns: conversation.turns || [],
              backgroundAgents: conversation.backgroundAgents || []
            }
          : null,
        threadSnapshot: bundle.threadSnapshot || null,
        continuation: bundle.continuation || null,
        thread: bundle.thread,
        liveOverlay: bundle.liveOverlay || null
      };
    }

    throw historicalError || new Error(`Historical session not found: ${provider}/${resumeSessionId}`);
  }

  if (ctx.path === "/api/history-messages" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const url = new URL(ctx.url, "http://localhost");
      const provider = String(url.searchParams.get("provider") || "codex");
      const resumeSessionId = String(url.searchParams.get("resumeSessionId") || "");
      runtime.json(ctx, 200, getThreadMessagesPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/messages") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      runtime.json(ctx, 200, getThreadMessagesPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/conversation") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      runtime.json(ctx, 200, getThreadConversationPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/thread") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      runtime.json(ctx, 200, getThreadBundle(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/continuation") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      const continuation =
        runtime.sessionManager.getThreadContinuationRuntime?.(provider, resumeSessionId) ||
        runtime.sessionManager.getLiveHistoryContinuation?.(provider, resumeSessionId) ||
        null;
      runtime.json(ctx, 200, {
        continuation: continuation || null,
        hasLiveContinuation: Boolean(continuation)
      });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/threads/") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length < 5 || parts.length > 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    const suffix = String(parts[5] || "").trim();

    try {
      if (!suffix) {
        runtime.json(ctx, 200, getThreadBundle(provider, resumeSessionId));
        return true;
      }
      if (suffix === "conversation") {
        runtime.json(ctx, 200, getThreadConversationPayload(provider, resumeSessionId));
        return true;
      }
      if (suffix === "continuation") {
        const continuation =
          runtime.sessionManager.getThreadContinuationRuntime?.(provider, resumeSessionId) ||
          runtime.sessionManager.getLiveHistoryContinuation?.(provider, resumeSessionId) ||
          null;
        runtime.json(ctx, 200, {
          continuation: continuation || null,
          hasLiveContinuation: Boolean(continuation)
        });
        return true;
      }
      runtime.json(ctx, 404, { error: "Not Found" });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions/archive" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const session = runtime.sessionManager.archiveHistoricalSession(body.provider, body.resumeSessionId);
      runtime.json(ctx, 200, { session });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions/restore" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const session = runtime.sessionManager.restoreHistoricalSession(body.provider, body.resumeSessionId);
      runtime.json(ctx, 200, { session });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions" && ctx.method === "DELETE") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, {
        ok: runtime.sessionManager.deleteHistoricalSession(body.provider, body.resumeSessionId)
      });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
