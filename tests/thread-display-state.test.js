import test from "node:test";
import assert from "node:assert/strict";

import { buildDisplayedThreadSnapshot, shouldSyncPersistedThread } from "../web/src/lib/thread-display-state.js";

test("display state appends optimistic user draft before live session is ready", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [],
      version: 0,
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    runtimeMessages: [
      {
        id: "draft-user-1",
        role: "user",
        text: "回复：世界3-0422-imm",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:01.000Z"
      }
    ],
    threadId: "thread-1",
    threadMeta: {
      resumeSessionId: "thread-1",
      displayTitle: "会话"
    }
  });

  const lastTurn = snapshot.turns.at(-1);
  assert.equal(lastTurn.items[0].text, "回复：世界3-0422-imm");
  assert.equal(lastTurn.status, "inProgress");
});

test("display state appends runtime assistant text from legacy normalized messages without waiting for refresh", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [],
      version: 0,
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    runtimeMessages: [
      {
        id: "draft-user-1",
        role: "user",
        text: "回复：世界3-0422-imm",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:01.000Z"
      },
      {
        id: "legacy-assistant-1",
        role: "assistant",
        text: "世界3-0422-imm",
        source: "normalized",
        partType: "markdown",
        timestamp: "2026-04-22T00:00:02.000Z"
      }
    ],
    threadId: "thread-1",
    threadMeta: {
      resumeSessionId: "thread-1",
      displayTitle: "会话"
    }
  });

  const lastTurn = snapshot.turns.at(-1);
  assert.deepEqual(
    lastTurn.items.map((item) => item.text),
    ["回复：世界3-0422-imm", "世界3-0422-imm"]
  );
  assert.equal(lastTurn.status, "completed");
});

test("display state prefers persisted and live conversation turns, but still keeps an unfinished runtime draft turn", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "history-turn-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "旧问题" },
            { id: "a1", kind: "AgentMessage", text: "旧回答" }
          ]
        }
      ],
      version: 1,
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "live-turn-1",
          user: { text: "新问题", ts: "2026-04-22T00:00:03.000Z" },
          assistant: { status: "completed", body: [{ text: "新回答" }] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-2",
        role: "user",
        text: "还在吗",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:04.000Z"
      }
    ],
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 3);
  assert.equal(snapshot.turns[0].items[1].text, "旧回答");
  assert.equal(snapshot.turns[1].items[1].text, "新回答");
  assert.equal(snapshot.turns[2].items[0].text, "还在吗");
  assert.equal(snapshot.turns[2].status, "inProgress");
});

test("persisted thread polling stops once the same thread has an attached live continuation", () => {
  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-1",
      threadMeta: { resumeSessionId: "thread-1" },
      liveSessionId: "live-1",
      liveSessionMeta: { resumeSessionId: "thread-1" },
      hasAuthoritativeLiveData: true
    }),
    false
  );

  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-1",
      threadMeta: { resumeSessionId: "thread-1" },
      liveSessionId: "",
      liveSessionMeta: null
    }),
    true
  );

  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-1",
      threadMeta: { resumeSessionId: "thread-1" },
      liveSessionId: "live-2",
      liveSessionMeta: { resumeSessionId: "thread-2" }
    }),
    true
  );

  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-1",
      threadMeta: { resumeSessionId: "thread-1" },
      liveSessionId: "live-1",
      liveSessionMeta: { resumeSessionId: "thread-1" },
      hasAuthoritativeLiveData: false
    }),
    true
  );
});

test("display state keeps persisted historical base while appending same-thread continuation runtime without duplicating the in-progress turn", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "live-turn-2",
          user: { text: "继续追问", ts: "2026-04-22T00:00:03.000Z" },
          assistant: { status: "inProgress", body: [] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-live-2",
        role: "user",
        text: "继续追问",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:03.000Z"
      }
    ],
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.threadId, "thread-1");
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].id, "history-turn-1");
  assert.equal(snapshot.turns[1].id, "live-turn-2");
  assert.equal(snapshot.turns.filter((turn) => turn.id === "live-turn-2").length, 1);
  assert.equal(snapshot.turns[1].items[0].text, "继续追问");
});

test("display state contract: same-thread continuation keeps runtime assistant text visible without refresh while preserving a single live turn", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "live-turn-2",
          user: { text: "继续追问", ts: "2026-04-22T00:00:03.000Z" },
          assistant: { status: "inProgress", body: [] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-live-2",
        role: "user",
        text: "继续追问",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:03.000Z"
      },
      {
        id: "draft-assistant-live-2",
        role: "assistant",
        text: "实时回复",
        source: "normalized",
        partType: "markdown",
        timestamp: "2026-04-22T00:00:04.000Z"
      }
    ],
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].id, "live-turn-2");
  assert.deepEqual(
    snapshot.turns[1].items.map((item) => item.text),
    ["继续追问", "实时回复"]
  );
});

test("display state prefers authoritative snapshot over stale live conversation for the same thread", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "history-turn-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "历史问题" },
            { id: "a1", kind: "AgentMessage", text: "历史回答" }
          ]
        },
        {
          id: "live-turn-3",
          status: "inProgress",
          items: [
            { id: "u-live-3", kind: "UserMessage", text: "新的追问" },
            { id: "a-live-3", kind: "AgentMessage", text: "已经开始回复" }
          ]
        }
      ],
      version: 2,
      updatedAt: "2026-04-22T00:00:05.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "live-turn-3",
          user: { text: "新的追问", ts: "2026-04-22T00:00:03.000Z" },
          assistant: { status: "running", body: [] }
        }
      ]
    },
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].id, "live-turn-3");
  assert.deepEqual(
    snapshot.turns[1].items.map((item) => item.text),
    ["新的追问", "已经开始回复"]
  );
});

test("display state keeps the current user turn visible when authoritative snapshot is behind but live delta already created the turn", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:05.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "live-turn-4",
          user: { text: "刚发出去的新问题", ts: "2026-04-22T00:00:06.000Z" },
          assistant: { status: "inProgress", body: [] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-live-4",
        role: "user",
        text: "刚发出去的新问题",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:06.000Z"
      }
    ],
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].id, "live-turn-4");
  assert.equal(snapshot.turns[1].items[0].text, "刚发出去的新问题");
  assert.equal(snapshot.turns.filter((turn) => turn.id === "runtime-draft:thread-1").length, 0);
});

test("display state keeps authoritative current turn stable when runtime draft still exists locally", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    persistedSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
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
      updatedAt: "2026-04-22T00:00:00.000Z"
    },
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "history-turn-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "历史问题" },
            { id: "a1", kind: "AgentMessage", text: "历史回答" }
          ]
        },
        {
          id: "live-turn-5",
          status: "inProgress",
          items: [{ id: "u-live-5", kind: "UserMessage", text: "当前输入" }]
        }
      ],
      version: 2,
      updatedAt: "2026-04-22T00:00:07.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "history-turn-1",
          user: { text: "历史问题", ts: "2026-04-22T00:00:00.000Z" },
          assistant: { status: "completed", body: [{ text: "历史回答" }] }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-live-5",
        role: "user",
        text: "当前输入",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:07.000Z"
      }
    ],
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].id, "live-turn-5");
  assert.equal(snapshot.turns[1].items[0].text, "当前输入");
  assert.equal(snapshot.turns.filter((turn) => turn.id === "runtime-draft:thread-1").length, 0);
});

test("display state deduplicates same historical turn when live conversation carries a different legacy turn id", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "thread-turn-1",
          status: "completed",
          startedAt: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:10.000Z",
          items: [
            { id: "u1", kind: "UserMessage", text: "看一下这个接口怎么改" },
            { id: "a1", kind: "AgentMessage", text: "先看现有实现，再改这一处。" }
          ]
        },
        {
          id: "thread-turn-2",
          status: "completed",
          startedAt: "2026-04-22T00:01:00.000Z",
          completedAt: "2026-04-22T00:01:05.000Z",
          items: [
            { id: "u2", kind: "UserMessage", text: "回复：你好" },
            { id: "a2", kind: "AgentMessage", text: "你好" }
          ]
        }
      ],
      version: 2,
      updatedAt: "2026-04-22T00:01:05.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "history-turn-1",
          user: { text: "看一下这个接口怎么改", ts: "2026-04-22T00:00:00.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-22T00:00:00.000Z",
            finishedAt: "2026-04-22T00:00:10.000Z",
            body: [{ text: "先看现有实现，再改这一处。" }]
          }
        },
        {
          id: "thread-turn-2",
          user: { text: "回复：你好", ts: "2026-04-22T00:01:00.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-22T00:01:00.000Z",
            finishedAt: "2026-04-22T00:01:05.000Z",
            body: [{ text: "你好" }]
          }
        }
      ]
    },
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].id, "thread-turn-1");
  assert.equal(snapshot.turns[1].id, "thread-turn-2");
  assert.equal(
    snapshot.turns.filter((turn) =>
      turn.items.some((item) => item?.kind === "UserMessage" && item?.text === "看一下这个接口怎么改")
    ).length,
    1
  );
});

test("display state does not let live conversation overwrite an existing authoritative turn body", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:05.000Z",
          items: [
            { id: "u1", kind: "UserMessage", text: "回复：哈哈哈哈" },
            { id: "a1", kind: "AgentMessage", text: "哈哈哈哈" }
          ]
        }
      ],
      version: 2,
      updatedAt: "2026-04-22T00:00:05.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "turn-1",
          user: { text: "回复：哈哈哈哈", ts: "2026-04-22T00:00:00.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-22T00:00:00.000Z",
            finishedAt: "2026-04-22T00:00:05.000Z",
            body: [{ text: "哈哈\n哈哈哈哈" }]
          }
        }
      ]
    },
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].id, "turn-1");
  assert.deepEqual(
    snapshot.turns[0].items.map((item) => item.text),
    ["回复：哈哈哈哈", "哈哈哈哈"]
  );
});
