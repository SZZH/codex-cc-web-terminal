import test from "node:test";
import assert from "node:assert/strict";

import {
  createCanonicalEvent,
  reduceCanonicalEvents,
  getActiveTurnLiveOverlay,
  projectTurnSegments
} from "../src/threads/index.js";
import { buildDisplayedThreadSnapshot, shouldSyncPersistedThread } from "../web/src/lib/thread-display-state.js";
import { resolveInitialAuthBootstrap } from "../web/src/lib/auth-bootstrap.js";

function event(input) {
  return createCanonicalEvent({
    threadId: "thread-contract",
    eventTs: input.eventTs ?? "2026-04-21T12:00:00.000Z",
    ...input
  });
}

test("thread-item reducer contract: chronological items preserve process -> primary -> process ordering", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "reasoning_summary_recorded", payload: { summary: "先检查链路" } }),
    event({ seq: 3, turnId: "turn-1", eventType: "agent_message_recorded", payload: { text: "这是正文", source: "primary_output_text" } }),
    event({
      seq: 4,
      turnId: "turn-1",
      eventType: "command_execution_completed",
      payload: { callId: "cmd-1", name: "exec_command", output: "npm test 通过", status: "completed" }
    })
  ]);

  const turn = snapshot.turns[0];
  assert.deepEqual(turn.items.map((item) => item.kind), ["Reasoning", "AgentMessage", "CommandExecution"]);

  const segments = projectTurnSegments(turn);
  assert.deepEqual(segments.map((segment) => segment.kind), ["process", "primary", "process"]);
});

test("thread-item reducer contract: realtime visibility shows fallback final answer immediately but converges to one committed primary item", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({
      seq: 2,
      turnId: "turn-1",
      eventType: "agent_message_recorded",
      payload: { text: "先给出一个可见答复", source: "fallback_final_answer" }
    })
  ]);

  const liveOverlay = getActiveTurnLiveOverlay(snapshot);
  assert.equal(liveOverlay?.text, "先给出一个可见答复");

  const committed = reduceCanonicalEvents(
    [
      event({
        seq: 3,
        turnId: "turn-1",
        eventType: "agent_message_recorded",
        payload: { text: "先给出一个可见答复", source: "primary_output_text" }
      }),
      event({ seq: 4, turnId: "turn-1", eventType: "turn_completed" })
    ],
    { snapshot }
  );

  const turn = committed.turns[0];
  const agentItems = turn.items.filter((item) => item.kind === "AgentMessage");
  assert.equal(agentItems.length, 1);
  assert.equal(agentItems[0].text, "先给出一个可见答复");
});

test("thread-item reducer contract: late-arriving tool completion routes by turnId instead of active turn", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-2", eventType: "turn_started" }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "mcp_tool_call_completed",
      payload: { callId: "tool-1", name: "mcp__demo", output: "ok", status: "completed" }
    })
  ]);

  const turn1 = snapshot.turns.find((turn) => turn.id === "turn-1");
  const turn2 = snapshot.turns.find((turn) => turn.id === "turn-2");
  assert.equal(turn1.items.filter((item) => item.kind === "McpToolCall").length, 1);
  assert.equal(turn2.items.filter((item) => item.kind === "McpToolCall").length, 0);
});

test("thread-item reducer contract: legacy importer degrades safely when only commentary/final_answer records exist", () => {
  const snapshot = reduceCanonicalEvents([
    event({
      seq: 1,
      turnId: "turn-legacy",
      eventType: "reasoning_summary_recorded",
      payload: { summary: "正在分析", source: "commentary" }
    }),
    event({
      seq: 2,
      turnId: "turn-legacy",
      eventType: "agent_message_recorded",
      payload: { text: "最终答案", source: "fallback_final_answer" }
    }),
    event({ seq: 3, turnId: "turn-legacy", eventType: "turn_completed" })
  ]);

  const turn = snapshot.turns[0];
  assert.equal(turn.items.some((item) => item.kind === "Reasoning"), true);
  assert.equal(turn.items.some((item) => item.kind === "AgentMessage"), true);
  assert.equal(turn.items.filter((item) => item.kind === "AgentMessage").length, 1);
});

test("thread-item presentation contract: frontend only segments adjacent process items and never reorders historical items", () => {
  const snapshot = reduceCanonicalEvents([
    event({ seq: 1, turnId: "turn-1", eventType: "turn_started" }),
    event({ seq: 2, turnId: "turn-1", eventType: "reasoning_summary_recorded", payload: { summary: "想一想" } }),
    event({
      seq: 3,
      turnId: "turn-1",
      eventType: "command_execution_started",
      payload: { callId: "cmd-1", name: "exec_command", args: { cmd: "pwd" } }
    }),
    event({ seq: 4, turnId: "turn-1", eventType: "agent_message_recorded", payload: { text: "正文", source: "primary_output_text" } }),
    event({
      seq: 5,
      turnId: "turn-1",
      eventType: "file_change_completed",
      payload: { callId: "patch-1", name: "apply_patch", status: "completed" }
    })
  ]);

  const segments = projectTurnSegments(snapshot.turns[0]);
  assert.deepEqual(segments.map((segment) => segment.kind), ["process", "primary", "process"]);
  assert.deepEqual(
    segments.flatMap((segment) => segment.items.map((item) => item.kind)),
    ["Reasoning", "CommandExecution", "AgentMessage", "FileChange"]
  );
});

test("single-thread app contract: opening a persisted thread hydrates its historical snapshot and still mounts an interactive composer", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-contract",
      metadata: { name: "历史 thread", preview: "旧预览" },
      turns: [
        {
          id: "history-turn-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "历史问题" },
            { id: "a1", kind: "AgentMessage", text: "历史回答" }
          ]
        }
      ],
      version: 1,
      updatedAt: "2026-04-21T12:00:00.000Z"
    },
    runtimeMessages: [],
    threadId: "thread-contract",
    threadMeta: {
      resumeSessionId: "thread-contract",
      displayTitle: "历史 thread",
      displayPreview: "旧预览"
    }
  });

  assert.equal(snapshot.threadId, "thread-contract");
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items[0].text, "历史问题");
  assert.equal(snapshot.turns[0].items[1].text, "历史回答");
});

test("single-thread app contract: continuing an existing thread appends new turns through continuation state without mutating the persisted historical base on hydrate", () => {
  const persisted = {
    threadId: "thread-contract",
    metadata: { name: "历史 thread" },
    turns: [
      {
        id: "history-turn-1",
        status: "completed",
        items: [
          { id: "u1", kind: "UserMessage", text: "历史问题" },
          { id: "a1", kind: "AgentMessage", text: "历史回答" }
        ]
      }
    ],
    version: 1,
    updatedAt: "2026-04-21T12:00:00.000Z"
  };

  const displayed = buildDisplayedThreadSnapshot({
    persistedSnapshot: persisted,
    liveConversation: {
      turns: [
        {
          id: "live-turn-2",
          user: { text: "新问题", ts: "2026-04-21T12:01:00.000Z" },
          assistant: { status: "running", body: [] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-2",
        role: "user",
        text: "新问题",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-21T12:01:00.000Z"
      }
    ],
    threadId: "thread-contract",
    liveSessionMeta: { resumeSessionId: "thread-contract" },
    threadMeta: { resumeSessionId: "thread-contract" }
  });

  assert.equal(persisted.turns.length, 1);
  assert.equal(displayed.turns.length, 2);
  assert.equal(displayed.turns[0].items[0].text, "历史问题");
  assert.equal(displayed.turns[1].items[0].text, "新问题");
  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-contract",
      threadMeta: { resumeSessionId: "thread-contract" },
      liveSessionId: "live-1",
      liveSessionMeta: { resumeSessionId: "thread-contract" },
      hasAuthoritativeLiveData: true
    }),
    false
  );
});

test("auth/restart contract: when a stale auth cookie survives a server restart, the client exits loading state and lands in a recoverable unauthenticated flow", async () => {
  let workspaceBootstrapped = false;
  let autoLoginTriggered = false;

  const result = await resolveInitialAuthBootstrap({
    savedToken: "persisted-token",
    autoLoginTried: false,
    requestAuthSession: async () => ({ authenticated: false, reason: "session_not_found" }),
    bootstrapWorkspace: async () => {
      workspaceBootstrapped = true;
    },
    handleAutoLogin: async () => {
      autoLoginTriggered = true;
    },
    routeName: "chat"
  });

  assert.equal(result.ready, true);
  assert.equal(result.isAuthenticated, false);
  assert.equal(result.accessToken, "persisted-token");
  assert.equal(result.rememberToken, true);
  assert.equal(workspaceBootstrapped, false);
  assert.equal(autoLoginTriggered, false);
});

test("authenticated bootstrap resolves without loading model config and preserves an explicit recovered login", async () => {
  const authenticated = await resolveInitialAuthBootstrap({
    savedToken: "saved",
    requestAuthSession: async () => ({ authenticated: true }),
    bootstrapWorkspace: () => assert.fail("config must not hold authenticated rendering")
  });
  assert.equal(authenticated.isAuthenticated, true);
  assert.equal(authenticated.accessToken, "");
  const recovered = await resolveInitialAuthBootstrap({
    savedToken: "saved",
    requestAuthSession: async () => { throw new Error("transient auth failure"); },
    handleAutoLogin: async () => ({ isAuthenticated: true, accessToken: "", rememberToken: true })
  });
  assert.equal(recovered.isAuthenticated, true);
  assert.equal(recovered.accessToken, "");
  assert.equal(recovered.rememberToken, true);
});

test("failed auto login never restores its rejected token or treats a swallowed error as success", async () => {
  for (const returned of [undefined, { isAuthenticated: false, accessToken: "", rememberToken: false }]) {
    const result = await resolveInitialAuthBootstrap({
      savedToken: "invalid",
      requestAuthSession: async () => { throw new Error("unauthorized"); },
      handleAutoLogin: async () => returned
    });
    assert.equal(result.isAuthenticated, false);
    assert.equal(result.accessToken, "");
    assert.equal(result.rememberToken, false);
  }
});

test("auth read timeout opens login with the saved token and a retry message without automatic login", async () => {
  for (const autoLoginTried of [false, true]) {
    const result = await resolveInitialAuthBootstrap({
      savedToken: " saved-token ",
      autoLoginTried,
      requestAuthSession: async () => {
        throw Object.assign(new Error("读取超时，请重试。"), { code: "READ_TIMEOUT" });
      },
      handleAutoLogin: () => assert.fail("a timed out read must not start another unbounded login")
    });
    assert.deepEqual(result, {
      accessToken: "saved-token", rememberToken: true, isAuthenticated: false, ready: true,
      autoLoginTried, statusText: "读取超时，请重试。"
    });
  }
});

test("invalidated auth checks and auto login continuations cannot revive the old login", async () => {
  for (const phase of ["auth", "auto-login"]) {
    let resolve, current = true, autoCalls = 0;
    const pending = new Promise((yes) => { resolve = yes; });
    const boot = resolveInitialAuthBootstrap({
      savedToken: "old",
      isCurrent: () => current,
      requestAuthSession: () => phase === "auth" ? pending : Promise.reject(new Error("transient")),
      handleAutoLogin: async () => { autoCalls += 1; return pending; }
    });
    await Promise.resolve();
    current = false;
    resolve(phase === "auth" ? { authenticated: true } : { isAuthenticated: true });
    assert.equal(await boot, null);
    assert.equal(autoCalls, phase === "auth" ? 0 : 1);
  }
});

test("legacy compatibility contract: persisted legacy thread remains the historical base while continuation runtime appends only the new turn", () => {
  const persisted = {
    threadId: "thread-legacy",
    metadata: { name: "Legacy Thread" },
    turns: [
      {
        id: "legacy-turn-1",
        status: "completed",
        items: [
          { id: "reasoning-1", kind: "Reasoning", text: "先分析一下" },
          { id: "agent-1", kind: "AgentMessage", text: "历史答案" }
        ]
      }
    ],
    version: 1,
    updatedAt: "2026-04-21T12:00:00.000Z"
  };

  const displayed = buildDisplayedThreadSnapshot({
    persistedSnapshot: persisted,
    liveConversation: {
      turns: [
        {
          id: "live-turn-2",
          user: { text: "继续追问", ts: "2026-04-21T12:01:00.000Z" },
          assistant: { status: "completed", body: [{ text: "继续后的答案" }] }
        }
      ]
    },
    runtimeMessages: [],
    threadId: "thread-legacy",
    liveSessionMeta: { resumeSessionId: "thread-legacy" },
    threadMeta: { resumeSessionId: "thread-legacy" }
  });

  assert.equal(persisted.turns.length, 1);
  assert.equal(displayed.turns.length, 2);
  assert.equal(displayed.turns[0].id, "legacy-turn-1");
  assert.equal(displayed.turns[0].items.at(-1).text, "历史答案");
  assert.equal(displayed.turns[1].items[0].text, "继续追问");
  assert.equal(displayed.turns[1].items[1].text, "继续后的答案");
});
