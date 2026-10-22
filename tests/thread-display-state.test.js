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

test("display state maps user image payload into thread items for history rendering", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    liveConversation: {
      turns: [
        {
          id: "turn-images",
          user: {
            text: "帮我看下这张图",
            ts: "2026-04-22T00:00:03.000Z",
            content: [
              { type: "input_text", text: "帮我看下这张图" },
              { type: "input_image", image_url: "data:image/png;base64,abc", alt: "示例图" }
            ]
          },
          assistant: { status: "completed", body: [] }
        }
      ]
    },
    threadId: "thread-images",
    liveSessionMeta: { resumeSessionId: "thread-images" },
    threadMeta: { resumeSessionId: "thread-images" }
  });

  const userItem = snapshot.turns[0].items[0];
  assert.equal(userItem.kind, "UserMessage");
  assert.equal(userItem.payload.content.length, 2);
  assert.equal(userItem.payload.content[1].type, "input_image");
  assert.equal(userItem.payload.content[1].image_url, "data:image/png;base64,abc");
});

test("display state maps assistant image body blocks into image items", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    liveConversation: {
      turns: [
        {
          id: "turn-assistant-image",
          user: { text: "生成一张图", ts: "2026-04-22T00:00:03.000Z" },
          assistant: {
            status: "completed",
            body: [
              { id: "body-image-1", kind: "image", payload: { url: "/api/files/demo.png", alt: "结果图" } },
              { id: "body-text-1", kind: "markdown", text: "图已经生成好了" }
            ]
          }
        }
      ]
    },
    threadId: "thread-assistant-image",
    liveSessionMeta: { resumeSessionId: "thread-assistant-image" },
    threadMeta: { resumeSessionId: "thread-assistant-image" }
  });

  assert.equal(snapshot.turns[0].items[1].kind, "ImageView");
  assert.equal(snapshot.turns[0].items[1].payload.url, "/api/files/demo.png");
  assert.equal(snapshot.turns[0].items[2].kind, "AgentMessage");
  assert.equal(snapshot.turns[0].items[2].text, "图已经生成好了");
});

test("display state maps assistant output_image variants into image items", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    liveConversation: {
      turns: [
        {
          id: "turn-assistant-output-image",
          user: { text: "生成一张图" },
          assistant: {
            status: "completed",
            body: [
              { type: "output_image", image_url: "/tmp/generated.png", alt: "生成结果" },
              { type: "markdown", text: "已完成" }
            ]
          }
        }
      ]
    },
    threadId: "thread-assistant-output-image"
  });

  assert.equal(snapshot.turns[0].items[1].kind, "ImageView");
  assert.equal(snapshot.turns[0].items[1].payload.url, "/tmp/generated.png");
  assert.equal(snapshot.turns[0].items[1].payload.alt, "生成结果");
  assert.equal(snapshot.turns[0].items[2].text, "已完成");
});

test("display state maps live assistant process events into thread items for rendering", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    liveConversation: {
      turns: [
        {
          id: "turn-process-live",
          user: { text: "跑一下检查", ts: "2026-04-22T00:00:03.000Z" },
          assistant: {
            status: "running",
            process: [
              {
                id: "proc-1",
                type: "command_execution",
                summary: "exec_command started",
                content: "exec_command started",
                payload: { command: "npm run check" },
                phase: "streaming"
              }
            ],
            body: []
          }
        }
      ]
    },
    threadId: "thread-process-live",
    liveSessionMeta: { resumeSessionId: "thread-process-live" },
    threadMeta: { resumeSessionId: "thread-process-live" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items[1].kind, "CommandExecution");
  assert.equal(snapshot.turns[0].items[1].summary, "exec_command started");
});

test("display state merges live assistant body and process into the same authoritative turn without rollback", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-authoritative-live",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-authoritative-live-1",
          status: "inProgress",
          items: [{ id: "user-1", kind: "UserMessage", text: "检查一下当前实现" }]
        }
      ],
      version: 5,
      updatedAt: "2026-04-29T00:00:00.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "turn-authoritative-live-1",
          user: { text: "检查一下当前实现", ts: "2026-04-29T00:00:00.000Z" },
          assistant: {
            status: "running",
            process: [
              {
                id: "proc-authoritative-1",
                type: "command_execution",
                summary: "npm run check",
                content: "npm run check",
                payload: { command: "npm run check" },
                phase: "streaming"
              }
            ],
            body: [{ id: "body-1", kind: "markdown", text: "我先跑一遍检查。" }]
          }
        }
      ]
    },
    threadId: "thread-authoritative-live",
    liveSessionMeta: { resumeSessionId: "thread-authoritative-live" },
    threadMeta: { resumeSessionId: "thread-authoritative-live" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items[0].kind, "UserMessage");
  assert.equal(snapshot.turns[0].items[1].kind, "CommandExecution");
  assert.equal(snapshot.turns[0].items[1].summary, "npm run check");
  assert.equal(snapshot.turns[0].items[2].kind, "AgentMessage");
  assert.equal(snapshot.turns[0].items[2].text, "我先跑一遍检查。");
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

test("display state does not append legacy runtime draft when the same typed turn already has assistant content", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    liveConversation: {
      turns: [
        {
          id: "live-turn-typed-1",
          user: { text: "继续追问", ts: "2026-04-22T00:00:03.000Z" },
          assistant: {
            status: "completed",
            body: [{ text: "typed 正式回复" }]
          }
        }
      ]
    },
    runtimeMessages: [
      {
        id: "draft-user-live-typed-1",
        role: "user",
        text: "继续追问",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-22T00:00:03.000Z"
      },
      {
        id: "draft-assistant-live-typed-1",
        role: "assistant",
        text: "legacy 兜底回复",
        source: "normalized",
        partType: "markdown",
        timestamp: "2026-04-22T00:00:04.000Z"
      }
    ],
    threadId: "thread-typed-1",
    liveSessionMeta: { resumeSessionId: "thread-typed-1" },
    threadMeta: { resumeSessionId: "thread-typed-1" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.deepEqual(
    snapshot.turns[0].items.map((item) => item.text),
    ["继续追问", "typed 正式回复"]
  );
});

test("display state does not append legacy runtime draft when the same typed turn already exists before assistant text arrives", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-typed-2",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-typed-2",
          status: "inProgress",
          items: [{ id: "u1", kind: "UserMessage", text: "回忆一下昨天做了什么" }]
        }
      ],
      version: 2,
      updatedAt: "2026-04-29T00:00:00.000Z"
    },
    runtimeMessages: [
      {
        id: "draft-user-typed-2",
        role: "user",
        text: "回忆一下昨天做了什么",
        source: "draft",
        partType: "text",
        timestamp: "2026-04-29T00:00:01.000Z"
      }
    ],
    threadId: "thread-typed-2",
    liveSessionMeta: { resumeSessionId: "thread-typed-2" },
    threadMeta: { resumeSessionId: "thread-typed-2" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].id, "turn-typed-2");
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

test("display state keeps the latest completed live turn visible when authoritative snapshot still lags behind", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "history-turn-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "回复：1111" },
            { id: "a1", kind: "AgentMessage", text: "11111111" }
          ]
        }
      ],
      version: 8,
      updatedAt: "2026-04-22T00:00:08.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "history-turn-1",
          user: { text: "回复：1111", ts: "2026-04-22T00:00:01.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-22T00:00:01.000Z",
            finishedAt: "2026-04-22T00:00:02.000Z",
            body: [{ text: "11111111" }]
          }
        },
        {
          id: "live-turn-2",
          user: { text: "回复：2222", ts: "2026-04-22T00:00:09.000Z" },
          assistant: {
            status: "completed",
            startedAt: "2026-04-22T00:00:09.000Z",
            finishedAt: "2026-04-22T00:00:10.000Z",
            body: [{ text: "22222222" }]
          }
        }
      ]
    },
    threadId: "thread-1",
    liveSessionMeta: { resumeSessionId: "thread-1" },
    threadMeta: { resumeSessionId: "thread-1" },
    preferAuthoritativeSnapshot: true
  });

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].id, "history-turn-1");
  assert.equal(snapshot.turns[1].id, "live-turn-2");
  assert.deepEqual(
    snapshot.turns[1].items.map((item) => item.text),
    ["回复：2222", "22222222"]
  );
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

test("display state keeps a completed authoritative turn immutable when stale same-turn continuation data arrives", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-immutable",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-immutable-1",
          status: "completed",
          startedAt: "2026-04-22T00:00:00.000Z",
          completedAt: "2026-04-22T00:00:05.000Z",
          items: [
            { id: "u1", kind: "UserMessage", text: "历史问题" },
            { id: "a1", kind: "AgentMessage", text: "已经提交的最终答案" }
          ]
        }
      ],
      version: 4,
      updatedAt: "2026-04-22T00:00:05.000Z"
    },
    liveConversation: {
      turns: [
        {
          id: "turn-immutable-1",
          user: { text: "历史问题", ts: "2026-04-22T00:00:00.000Z" },
          assistant: {
            status: "running",
            body: [{ text: "不应该覆盖最终答案的晚到实时文本" }]
          }
        }
      ]
    },
    threadId: "thread-immutable",
    liveSessionMeta: { resumeSessionId: "thread-immutable" },
    threadMeta: { resumeSessionId: "thread-immutable" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].status, "completed");
  assert.deepEqual(
    snapshot.turns[0].items.map((item) => item.text),
    ["历史问题", "已经提交的最终答案"]
  );
});

test("display state hides terminal turns that only contain a user message shell", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-shell-1",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-good-1",
          status: "completed",
          items: [
            { id: "u1", kind: "UserMessage", text: "上一轮问题" },
            { id: "a1", kind: "AgentMessage", text: "上一轮回答" }
          ]
        },
        {
          id: "turn-shell-1",
          status: "completed",
          items: [{ id: "u2", kind: "UserMessage", text: "回忆一下，今天做了什么" }]
        }
      ],
      version: 3,
      updatedAt: "2026-04-29T00:00:00.000Z"
    },
    threadId: "thread-shell-1",
    liveSessionMeta: { resumeSessionId: "thread-shell-1" },
    threadMeta: { resumeSessionId: "thread-shell-1" }
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].id, "turn-good-1");
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

test("display state lets active live conversation update an existing authoritative turn body", () => {
  const snapshot = buildDisplayedThreadSnapshot({
    authoritativeSnapshot: {
      threadId: "thread-live-active",
      metadata: { name: "会话" },
      turns: [
        {
          id: "turn-active",
          status: "inProgress",
          startedAt: "2026-04-22T00:00:00.000Z",
          items: [
            { id: "u1", kind: "UserMessage", text: "写一段长回复" },
            { id: "a1", kind: "AgentMessage", text: "第一段" }
          ]
        }
      ],
      version: 2,
      updatedAt: "2026-04-22T00:00:05.000Z"
    },
    liveConversation: {
      status: "running",
      activeTurnId: "turn-active",
      turns: [
        {
          id: "turn-active",
          user: { text: "写一段长回复", ts: "2026-04-22T00:00:00.000Z" },
          assistant: {
            status: "running",
            startedAt: "2026-04-22T00:00:00.000Z",
            body: [{ text: "第一段，第二段" }]
          }
        }
      ]
    },
    threadId: "thread-live-active",
    liveSessionMeta: { resumeSessionId: "thread-live-active" },
    threadMeta: { resumeSessionId: "thread-live-active" }
  });

  const agentMessage = snapshot.turns[0].items.find((item) => item.kind === "AgentMessage");
  assert.equal(agentMessage.text, "第一段，第二段");
});

test("persisted thread sync can be forced while json input waits for history polling", () => {
  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-json-input",
      threadMeta: { resumeSessionId: "thread-json-input" },
      liveSessionId: "live-json-input",
      liveSessionMeta: { resumeSessionId: "thread-json-input" },
      hasAuthoritativeLiveData: true
    }),
    false
  );

  assert.equal(
    shouldSyncPersistedThread({
      routeThreadId: "thread-json-input",
      threadMeta: { resumeSessionId: "thread-json-input" },
      liveSessionId: "live-json-input",
      liveSessionMeta: { resumeSessionId: "thread-json-input" },
      hasAuthoritativeLiveData: true,
      forceSync: true
    }),
    true
  );
});
