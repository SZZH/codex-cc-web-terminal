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

test("live-session-runtime: thread.overlay appends assistant content into the active conversation turn immediately", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-3",
    threadId: "thread-live-3",
    version: 10,
    status: "running",
    activeTurnId: "turn-live-3",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-3",
        user: { text: "看一下这个接口怎么改", ts: "2026-04-29T00:00:00.000Z" },
        assistant: {
          status: "running",
          process: [],
          body: []
        }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "thread.overlay",
    threadId: "thread-live-3",
    sessionId: "session-live-3",
    turnId: "turn-live-3",
    role: "assistant",
    phase: "final",
    timestamp: "2026-04-29T00:00:05.000Z",
    parts: [
      {
        type: "text",
        text: "先按接口说明改这一处。"
      }
    ]
  });

  assert.equal(state.liveView.conversation.turns.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.body.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.body[0].text, "先按接口说明改这一处。");
  assert.equal(state.liveView.conversation.turns[0].assistant.status, "completed");
  assert.equal(state.threadView.authoritativeSnapshot?.turns?.[0]?.id, "turn-live-3");
});

test("live-session-runtime: thread.overlay stays fallback-only once typed content already materialized for the turn", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-overlay-fallback",
    threadId: "thread-live-overlay-fallback",
    version: 11,
    status: "running",
    activeTurnId: "turn-live-overlay-fallback",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-overlay-fallback",
        user: { text: "测试 overlay fallback", ts: "2026-04-29T00:00:00.000Z" },
        assistant: {
          status: "running",
          process: [],
          body: [{ id: "message-1", kind: "markdown", text: "typed 已经到达", ts: "2026-04-29T00:00:01.000Z" }]
        }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "thread.overlay",
    threadId: "thread-live-overlay-fallback",
    sessionId: "session-live-overlay-fallback",
    turnId: "turn-live-overlay-fallback",
    role: "assistant",
    phase: "final",
    timestamp: "2026-04-29T00:00:05.000Z",
    parts: [
      {
        type: "text",
        text: "overlay 不该覆盖 typed"
      }
    ]
  });

  assert.equal(state.liveView.conversation.turns[0].assistant.body.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.body[0].text, "typed 已经到达");
  assert.equal(state.liveView.liveOverlay?.turnId, "turn-live-overlay-fallback");
  assert.equal(state.liveView.hasConversationDelta, false);
});

test("live-session-runtime: message.delta and message.completed materialize assistant text in order", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-4",
    threadId: "thread-live-4",
    version: 20,
    status: "running",
    activeTurnId: "turn-live-4",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-4",
        user: { text: "测试增量", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "message.delta",
    sessionId: "session-live-4",
    threadId: "thread-live-4",
    turnId: "turn-live-4",
    role: "assistant",
    text: "第一段",
    ts: "2026-04-29T00:00:01.000Z"
  });
  assert.equal(state.liveView.conversation.turns[0].assistant.body[0].text, "第一段");
  assert.equal(state.liveView.conversation.turns[0].assistant.status, "running");

  runtime.handleLivePayload({
    type: "message.completed",
    sessionId: "session-live-4",
    threadId: "thread-live-4",
    turnId: "turn-live-4",
    role: "assistant",
    text: "第一段第二段",
    ts: "2026-04-29T00:00:02.000Z"
  });
  assert.equal(state.liveView.conversation.turns[0].assistant.body[0].text, "第一段第二段");
  assert.equal(state.liveView.conversation.turns[0].assistant.status, "completed");
});

test("live-session-runtime: turn.completed settles the active turn without waiting for snapshot backfill", () => {
  const { state, runtime } = createHarness();
  state.liveView.activeInputStream = true;
  state.liveView.interruptInFlight = true;
  state.liveView.conversation = {
    sessionId: "session-live-5",
    threadId: "thread-live-5",
    version: 30,
    status: "running",
    activeTurnId: "turn-live-5",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-5",
        user: { text: "测试完成", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [{ kind: "markdown", text: "done" }] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "turn.completed",
    sessionId: "session-live-5",
    threadId: "thread-live-5",
    turnId: "turn-live-5",
    status: "completed",
    ts: "2026-04-29T00:00:03.000Z"
  });

  assert.equal(state.liveView.conversation.turns[0].assistant.status, "completed");
  assert.equal(state.liveView.conversation.activeTurnId, "");
  assert.equal(state.liveView.activeInputStream, false);
  assert.equal(state.loading, false);
});

test("live-session-runtime: process.completed materializes process items in the active turn immediately", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-6",
    threadId: "thread-live-6",
    version: 40,
    status: "running",
    activeTurnId: "turn-live-6",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-6",
        user: { text: "测试过程事件", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "process.completed",
    sessionId: "session-live-6",
    threadId: "thread-live-6",
    turnId: "turn-live-6",
    processType: "command_execution",
    summary: "exec_command completed",
    payload: { command: "pwd" },
    ts: "2026-04-29T00:00:04.000Z"
  });

  assert.equal(state.liveView.conversation.turns[0].assistant.process.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.process[0].summary, "exec_command completed");
  assert.equal(state.threadView.authoritativeSnapshot?.turns?.[0]?.id, "turn-live-6");
});

test("live-session-runtime: process.started seeds a process item and process.completed updates the same item", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-7",
    threadId: "thread-live-7",
    version: 50,
    status: "running",
    activeTurnId: "turn-live-7",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-7",
        user: { text: "测试开始结束过程", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "process.started",
    sessionId: "session-live-7",
    threadId: "thread-live-7",
    turnId: "turn-live-7",
    processId: "proc-1",
    processType: "command_execution",
    summary: "exec_command started",
    payload: { command: "pwd" },
    ts: "2026-04-29T00:00:01.000Z"
  });
  assert.equal(state.liveView.conversation.turns[0].assistant.process.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.process[0].summary, "exec_command started");

  runtime.handleLivePayload({
    type: "process.completed",
    sessionId: "session-live-7",
    threadId: "thread-live-7",
    turnId: "turn-live-7",
    processId: "proc-1",
    processType: "command_execution",
    summary: "exec_command completed",
    payload: { command: "pwd" },
    ts: "2026-04-29T00:00:03.000Z"
  });
  assert.equal(state.liveView.conversation.turns[0].assistant.process.length, 1);
  assert.equal(state.liveView.conversation.turns[0].assistant.process[0].summary, "exec_command completed");
});

test("live-session-runtime: process started/delta/completed stays on one process item in order", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-8",
    threadId: "thread-live-8",
    version: 60,
    status: "running",
    activeTurnId: "turn-live-8",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-8",
        user: { text: "测试过程增量顺序", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "process.started",
    sessionId: "session-live-8",
    threadId: "thread-live-8",
    turnId: "turn-live-8",
    processId: "proc-seq-1",
    processType: "command_execution",
    summary: "npm run check",
    payload: { command: "npm run check" },
    ts: "2026-04-29T00:00:01.000Z"
  });
  runtime.handleLivePayload({
    type: "process.delta",
    sessionId: "session-live-8",
    threadId: "thread-live-8",
    turnId: "turn-live-8",
    processId: "proc-seq-1",
    processType: "command_execution",
    summary: "src/sessionManager.js",
    payload: { chunk: "src/sessionManager.js" },
    ts: "2026-04-29T00:00:02.000Z"
  });
  runtime.handleLivePayload({
    type: "process.completed",
    sessionId: "session-live-8",
    threadId: "thread-live-8",
    turnId: "turn-live-8",
    processId: "proc-seq-1",
    processType: "command_execution",
    summary: "done",
    payload: { exitCode: 0 },
    ts: "2026-04-29T00:00:03.000Z"
  });

  const processItems = state.liveView.conversation.turns[0].assistant.process;
  assert.equal(processItems.length, 1);
  assert.equal(processItems[0].id, "proc-seq-1");
  assert.equal(processItems[0].summary, "done");
  assert.deepEqual(processItems[0].payload, { exitCode: 0 });
  assert.equal(processItems[0].ts, "2026-04-29T00:00:03.000Z");
});

test("live-session-runtime: overlay fallback seeds content but typed completion does not duplicate it", () => {
  const { state, runtime } = createHarness();
  state.liveView.conversation = {
    sessionId: "session-live-9",
    threadId: "thread-live-9",
    version: 70,
    status: "running",
    activeTurnId: "turn-live-9",
    updatedAt: "2026-04-29T00:00:00.000Z",
    backgroundAgents: [],
    turns: [
      {
        id: "turn-live-9",
        user: { text: "先走 overlay 再走 typed", ts: "2026-04-29T00:00:00.000Z" },
        assistant: { status: "running", process: [], body: [] }
      }
    ]
  };

  runtime.handleLivePayload({
    type: "thread.overlay",
    threadId: "thread-live-9",
    sessionId: "session-live-9",
    turnId: "turn-live-9",
    role: "assistant",
    phase: "streaming",
    timestamp: "2026-04-29T00:00:01.000Z",
    parts: [{ type: "text", text: "第一段 typed 前兜底" }]
  });
  runtime.handleLivePayload({
    type: "message.completed",
    sessionId: "session-live-9",
    threadId: "thread-live-9",
    turnId: "turn-live-9",
    role: "assistant",
    text: "第一段 typed 前兜底",
    ts: "2026-04-29T00:00:02.000Z"
  });

  const body = state.liveView.conversation.turns[0].assistant.body;
  assert.equal(body.length, 1);
  assert.equal(body[0].text, "第一段 typed 前兜底");
  assert.equal(state.liveView.conversation.turns[0].assistant.status, "completed");
});
