import test from "node:test";
import assert from "node:assert/strict";

import { createHistoryPayloadResolver } from "../src/routes/historyPayloads.js";
import { parseHistoryQuery, parseScopedHistoryRoute, parseThreadRoute } from "../src/routes/historyRouteParams.js";
import { buildSessionSidebarPayload } from "../src/routes/sessionSidebar.js";
import {
  buildSidebarSnapshotFromGroups,
  filterSidebarSessionsByRecency,
  mergeProjectGroupsWithLiveSessions
} from "../src/sessions/history/sessionSidebarSnapshot.js";
import { buildSessionCreatePayloadFromThreadState } from "../src/routes/threadComposerState.js";

test("buildSessionSidebarPayload falls back to grouped + live session merge", () => {
  const payload = buildSessionSidebarPayload({
    listAll() {
      return [
        { id: "live-1", name: "live", updatedAt: "2026-04-28T10:00:00.000Z" },
        { id: "history-1", name: "history", updatedAt: "2026-04-27T10:00:00.000Z" }
      ];
    },
    listProjectGroups() {
      return [
        {
          id: "project:demo",
          name: "demo",
          sessions: [{ id: "history-1", name: "history", updatedAt: "2026-04-27T10:00:00.000Z" }]
        }
      ];
    }
  });

  assert.equal(payload.projectGroups.length, 1);
  assert.deepEqual(payload.sessions.map((session) => session.id), ["live-1", "history-1"]);
});

test("mergeProjectGroupsWithLiveSessions injects matching live sessions and preserves empty groups", () => {
  const groups = mergeProjectGroupsWithLiveSessions(
    [
      {
        id: "project:/workspace/demo",
        projectRoot: "/workspace/demo",
        cwd: "/workspace/demo",
        sessions: [
          { id: "history-1", provider: "codex", resumeSessionId: "thread-1", updatedAt: "2026-04-27T10:00:00.000Z" }
        ]
      },
      {
        id: "project:/workspace/empty",
        projectRoot: "/workspace/empty",
        cwd: "/workspace/empty",
        sessions: [{ id: "history-old", provider: "codex", resumeSessionId: "thread-old", updatedAt: "2026-04-01T10:00:00.000Z" }]
      }
    ],
    [
      { id: "live-1", provider: "codex", resumeSessionId: "thread-1", cwd: "/workspace/demo/app", updatedAt: "2026-04-28T10:00:00.000Z" },
      { id: "live-2", provider: "codex", resumeSessionId: "thread-2", cwd: "/workspace/demo/app", updatedAt: "2026-04-26T10:00:00.000Z" }
    ]
  );

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].sessions.map((session) => session.id),
    ["live-1", "live-2"]
  );
  assert.deepEqual(groups[1].sessions, []);
});

test("buildSidebarSnapshotFromGroups appends sessions missing from project groups", () => {
  const payload = buildSidebarSnapshotFromGroups(
    [
      { id: "live-2", updatedAt: "2026-04-28T10:00:00.000Z" },
      { id: "history-1", updatedAt: "2026-04-27T10:00:00.000Z" }
    ],
    [
      {
        id: "project:/workspace/demo",
        sessions: [{ id: "history-1", updatedAt: "2026-04-27T10:00:00.000Z" }]
      }
    ]
  );

  assert.deepEqual(payload.sessions.map((session) => session.id), ["live-2", "history-1"]);
});

test("filterSidebarSessionsByRecency keeps only unarchived sessions used within seven days", () => {
  const nowMs = Date.parse("2026-04-29T12:00:00.000Z");
  const payload = filterSidebarSessionsByRecency(
    [
      { id: "recent-history", kind: "history", updatedAt: "2026-04-25T10:00:00.000Z" },
      { id: "eight-days-old-history", kind: "history", updatedAt: "2026-04-21T10:00:00.000Z" },
      { id: "old-history", kind: "history", updatedAt: "2026-04-01T10:00:00.000Z" },
      { id: "running-live-old", kind: "live", status: "running", updatedAt: "2026-04-01T10:00:00.000Z" },
      { id: "exited-live-old", kind: "live", status: "exited", updatedAt: "2026-04-01T10:00:00.000Z" },
      { id: "archived-history", kind: "archived", status: "archived", updatedAt: "2026-04-25T10:00:00.000Z" },
      { id: "archived-live", kind: "live", archivedAt: "2026-04-25T11:00:00.000Z", updatedAt: "2026-04-25T10:00:00.000Z" }
    ],
    { nowMs }
  );

  assert.deepEqual(payload.map((session) => session.id), ["recent-history"]);
});

test("history route helpers parse query and scoped routes", () => {
  assert.deepEqual(parseHistoryQuery("/api/history-messages?provider=cc&resumeSessionId=thread-2"), {
    provider: "cc",
    resumeSessionId: "thread-2"
  });
  assert.deepEqual(parseScopedHistoryRoute("/api/history-sessions/codex/thread-1/messages", "messages"), {
    provider: "codex",
    resumeSessionId: "thread-1"
  });
  assert.equal(parseScopedHistoryRoute("/api/history-sessions/codex/thread-1/thread", "messages"), null);
});

test("parseThreadRoute handles optional suffixes", () => {
  assert.deepEqual(parseThreadRoute("/api/threads/codex/thread-1"), {
    provider: "codex",
    resumeSessionId: "thread-1",
    suffix: ""
  });
  assert.deepEqual(parseThreadRoute("/api/threads/codex/thread-1/conversation"), {
    provider: "codex",
    resumeSessionId: "thread-1",
    suffix: "conversation"
  });
  assert.equal(parseThreadRoute("/api/threads/codex"), null);
});

test("createHistoryPayloadResolver prefers merged bundle conversation when live continuation exists", () => {
  const resolver = createHistoryPayloadResolver({
    getHistoricalMessages() {
      return {
        session: { id: "history:codex:thread-1" },
        messages: [],
        turns: [],
        backgroundAgents: [],
        threadSnapshot: { threadId: "thread-1", turns: [{ id: "turn-stale" }] },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-stale" }],
          backgroundAgents: []
        }
      };
    },
    getThreadSnapshotBundle() {
      return {
        session: { id: "history:codex:thread-1" },
        threadSnapshot: {
          threadId: "thread-1",
          turns: [{ id: "turn-stale" }, { id: "turn-fresh" }]
        },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-stale" }, { id: "turn-fresh" }],
          backgroundAgents: []
        }
      };
    },
    getThreadContinuationRuntime() {
      return {
        session: { id: "live-1" },
        threadSnapshot: { threadId: "thread-1", turns: [{ id: "turn-fresh" }] },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-fresh" }],
          backgroundAgents: []
        }
      };
    }
  });

  const payload = resolver.getThreadMessagesPayload("codex", "thread-1");

  assert.equal(payload.session.id, "live-1");
  assert.deepEqual(payload.threadSnapshot.turns.map((turn) => turn.id), ["turn-stale", "turn-fresh"]);
  assert.deepEqual(payload.conversation.turns.map((turn) => turn.id), ["turn-stale", "turn-fresh"]);
});

test("createHistoryPayloadResolver returns merged conversation payload for thread readers too", () => {
  const resolver = createHistoryPayloadResolver({
    getHistoricalMessages() {
      return {
        session: { id: "history:codex:thread-1" },
        messages: [],
        turns: [{ id: "turn-stale" }],
        backgroundAgents: [],
        threadSnapshot: { threadId: "thread-1", turns: [{ id: "turn-stale" }] },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-stale" }],
          backgroundAgents: []
        }
      };
    },
    getThreadSnapshotBundle() {
      return {
        session: { id: "history:codex:thread-1" },
        threadSnapshot: { threadId: "thread-1", turns: [{ id: "turn-stale" }] },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-stale" }],
          backgroundAgents: []
        }
      };
    },
    getThreadContinuationRuntime() {
      return {
        session: { id: "live-1" },
        threadSnapshot: { threadId: "thread-1", turns: [{ id: "turn-fresh" }] },
        conversation: {
          threadId: "thread-1",
          turns: [{ id: "turn-fresh" }],
          backgroundAgents: []
        }
      };
    }
  });

  const payload = resolver.getThreadConversationPayload("codex", "thread-1");
  const bundle = resolver.getThreadBundle("codex", "thread-1");

  assert.equal(payload.session.id, "live-1");
  assert.deepEqual(payload.threadSnapshot.turns.map((turn) => turn.id), ["turn-stale", "turn-fresh"]);
  assert.deepEqual(payload.conversation.turns.map((turn) => turn.id), ["turn-stale", "turn-fresh"]);
  assert.equal(bundle.session.id, "live-1");
  assert.deepEqual(bundle.threadSnapshot.turns.map((turn) => turn.id), ["turn-stale", "turn-fresh"]);
});

test("createHistoryPayloadResolver merges equivalent historical and live continuation turns instead of duplicating shell turns", () => {
  const resolver = createHistoryPayloadResolver({
    getHistoricalMessages() {
      return {
        session: { id: "history:codex:thread-1" },
        messages: [],
        turns: [],
        backgroundAgents: [],
        threadSnapshot: {
          threadId: "thread-1",
          turns: [
            {
              id: "turn-historical",
              status: "completed",
              startedAt: "2026-04-29T09:44:44.748Z",
              completedAt: "2026-04-29T09:44:59.714Z",
              items: [
                { id: "u-1", kind: "UserMessage", text: "回复：TRACE-FIX" },
                { id: "a-1", kind: "AgentMessage", text: "TRACE-FIX" }
              ]
            }
          ]
        },
        conversation: {
          threadId: "thread-1",
          turns: [
            {
              id: "turn-historical",
              user: { id: "u-1", text: "回复：TRACE-FIX", ts: "2026-04-29T09:44:44.748Z" },
              assistant: {
                body: [{ id: "a-1", kind: "markdown", text: "TRACE-FIX", ts: "2026-04-29T09:44:59.714Z" }],
                process: [],
                status: "completed",
                startedAt: "2026-04-29T09:44:44.748Z",
                finishedAt: "2026-04-29T09:44:59.714Z"
              }
            }
          ],
          backgroundAgents: []
        }
      };
    },
    getThreadSnapshotBundle() {
      return {
        session: { id: "history:codex:thread-1" },
        threadSnapshot: {
          threadId: "thread-1",
          turns: [
            {
              id: "turn-historical",
              status: "completed",
              startedAt: "2026-04-29T09:44:44.748Z",
              completedAt: "2026-04-29T09:44:59.714Z",
              items: [
                { id: "u-1", kind: "UserMessage", text: "回复：TRACE-FIX" },
                { id: "a-1", kind: "AgentMessage", text: "TRACE-FIX" }
              ]
            }
          ]
        },
        conversation: {
          threadId: "thread-1",
          turns: [
            {
              id: "turn-historical",
              user: { id: "u-1", text: "回复：TRACE-FIX", ts: "2026-04-29T09:44:44.748Z" },
              assistant: {
                body: [{ id: "a-1", kind: "markdown", text: "TRACE-FIX", ts: "2026-04-29T09:44:59.714Z" }],
                process: [],
                status: "completed",
                startedAt: "2026-04-29T09:44:44.748Z",
                finishedAt: "2026-04-29T09:44:59.714Z"
              }
            }
          ],
          backgroundAgents: []
        }
      };
    },
    getThreadContinuationRuntime() {
      return {
        session: { id: "live-1" },
        threadSnapshot: {
          threadId: "thread-1",
          turns: [
            {
              id: "live-shell",
              status: "completed",
              startedAt: "2026-04-29T09:44:40.979Z",
              completedAt: "2026-04-29T09:45:12.129Z",
              items: [{ id: "u-2", kind: "UserMessage", text: "回复：TRACE-FIX" }]
            }
          ]
        },
        conversation: {
          threadId: "thread-1",
          turns: [
            {
              id: "live-shell",
              user: { id: "u-2", text: "回复：TRACE-FIX", ts: "2026-04-29T09:44:40.979Z" },
              assistant: {
                body: [],
                process: [],
                status: "completed",
                startedAt: "2026-04-29T09:44:40.979Z",
                finishedAt: "2026-04-29T09:45:12.129Z"
              }
            }
          ],
          backgroundAgents: []
        }
      };
    }
  });

  const payload = resolver.getThreadMessagesPayload("codex", "thread-1");

  assert.equal(payload.session.id, "live-1");
  assert.equal(payload.threadSnapshot.turns.length, 1);
  assert.equal(payload.threadSnapshot.turns[0].items.length, 2);
  assert.equal(payload.conversation.turns.length, 1);
  assert.equal(payload.conversation.turns[0].assistant.body[0].text, "TRACE-FIX");
});

test("buildSessionCreatePayloadFromThreadState fills missing create fields from thread state", () => {
  const payload = buildSessionCreatePayloadFromThreadState(
    {
      provider: "codex",
      resumeSessionId: "thread-1",
      model: "",
      cwd: ""
    },
    {
      provider: "codex",
      threadId: "thread-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      reasoningEffort: "low",
      permissionMode: "full-access"
    }
  );

  assert.equal(payload.cwd, "/tmp/project");
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.reasoningEffort, "low");
  assert.equal(payload.permissionMode, "full-access");
});
