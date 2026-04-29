import test from "node:test";
import assert from "node:assert/strict";

import { createLiveViewState, createThreadViewState } from "../web/src/lib/app-state.js";
import { createLiveSessionRuntimeController } from "../web/src/lib/live-session-runtime.js";
import { createThreadRuntimeController } from "../web/src/lib/thread-runtime.js";

function createHarness() {
  const state = {
    statusText: "等待 Codex 回复…",
    loading: true,
    liveView: createLiveViewState(),
    threadView: createThreadViewState()
  };
  const statusUpdates = [];
  const messageUpdates = [];

  const threadRuntime = createThreadRuntimeController({
    state,
    setMessages(messages) {
      state.liveView.messages = messages;
      messageUpdates.push(messages);
    },
    setStatus(message = "") {
      state.statusText = message;
      statusUpdates.push(message);
    },
    syncThreadViewFromInteraction() {}
  });

  const runtime = createLiveSessionRuntimeController({
    state,
    setStatus(message = "") {
      state.statusText = message;
      statusUpdates.push(message);
    },
    setMessages(messages) {
      state.liveView.messages = messages;
      messageUpdates.push(messages);
    },
    waitForSocketOpen() {
      return Promise.resolve();
    },
    threadRuntime,
    liveBootstrapLinePatterns: [],
    decorateSession(session) {
      return session;
    },
    stopHistorySyncLoop() {}
  });

  return { state, runtime, statusUpdates, messageUpdates };
}

test("live-session-runtime: thread.snapshot merges authoritative conversation patches into live state", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-1",
    threadId: "thread-live-1",
    version: 41,
    status: "running",
    activeTurnId: "turn-live-1",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-history-1",
        user: { text: "旧问题", ts: "2026-04-28T23:58:00.000Z" },
        assistant: {
          status: "completed",
          process: [],
          body: [{ kind: "markdown", text: "旧回复", ts: "2026-04-28T23:58:10.000Z" }]
        }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "thread.snapshot",
    partial: true,
    sessionId: "session-live-1",
    threadId: "thread-live-1",
    turnId: "turn-live-2",
    version: 42,
    status: "running",
    snapshot: {
      threadId: "thread-live-1",
      activeTurnId: "turn-live-2",
      turns: [{ id: "turn-live-2", status: "running", items: [] }]
    },
    conversation: {
      sessionId: "session-live-1",
      threadId: "thread-live-1",
      version: 42,
      status: "running",
      activeTurnId: "turn-live-2",
      turns: [
        {
          id: "turn-live-2",
          user: { text: "新问题", ts: "2026-04-29T00:00:01.000Z" },
          assistant: {
            status: "running",
            process: [{ type: "plan", summary: "开始处理", ts: "2026-04-29T00:00:02.000Z" }],
            body: [{ kind: "markdown", text: "第一段实时回复", ts: "2026-04-29T00:00:03.000Z" }]
          }
        }
      ]
    }
  });

  assert.equal(state.liveView.conversation.version, 42);
  assert.equal(state.liveView.conversation.activeTurnId, "turn-live-2");
  assert.deepEqual(
    state.liveView.conversation.turns.map((turn) => turn.id),
    ["turn-history-1", "turn-live-2"]
  );
  assert.equal(state.liveView.conversation.turns[1].assistant.body[0].text, "第一段实时回复");
  assert.equal(state.threadView.authoritativeSnapshot?.threadId, "thread-live-1");
  assert.equal(state.threadView.authoritativeSnapshot?.turns?.[0]?.id, "turn-live-2");
});

test("live-session-runtime: completed thread.snapshot settles pending input state", () => {
  const { state, runtime } = createHarness();
  state.liveView.activeInputStream = true;
  state.liveView.interruptInFlight = true;
  state.liveView.conversation = {
    sessionId: "session-live-2",
    threadId: "thread-live-2",
    version: 5,
    status: "running",
    activeTurnId: "turn-live-2",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: []
  };

  runtime.handleLivePayload({
    type: "thread.snapshot",
    partial: true,
    sessionId: "session-live-2",
    threadId: "thread-live-2",
    turnId: "turn-live-2",
    status: "completed",
    version: 6,
    snapshot: {
      threadId: "thread-live-2",
      activeTurnId: "",
      turns: [{ id: "turn-live-2", status: "completed", items: [] }]
    },
    conversation: {
      sessionId: "session-live-2",
      threadId: "thread-live-2",
      version: 6,
      status: "completed",
      activeTurnId: "",
      turns: [
        {
          id: "turn-live-2",
          assistant: {
            status: "completed",
            process: [],
            body: [{ kind: "markdown", text: "done", ts: "2026-04-29T00:00:05.000Z" }]
          }
        }
      ]
    }
  });

  assert.equal(state.liveView.activeInputStream, false);
  assert.equal(state.liveView.interruptInFlight, false);
  assert.equal(state.loading, false);
  assert.equal(state.statusText, "");
});
