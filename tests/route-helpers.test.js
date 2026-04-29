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

test("mergeProjectGroupsWithLiveSessions injects matching live sessions and keeps latest identities", () => {
  const groups = mergeProjectGroupsWithLiveSessions(
    [
      {
        id: "project:/workspace/demo",
        projectRoot: "/workspace/demo",
        cwd: "/workspace/demo",
        sessions: [
          { id: "history-1", provider: "codex", resumeSessionId: "thread-1", updatedAt: "2026-04-27T10:00:00.000Z" }
        ]
      }
    ],
    [
      { id: "live-1", provider: "codex", resumeSessionId: "thread-1", cwd: "/workspace/demo/app", updatedAt: "2026-04-28T10:00:00.000Z" },
      { id: "live-2", provider: "codex", resumeSessionId: "thread-2", cwd: "/workspace/demo/app", updatedAt: "2026-04-26T10:00:00.000Z" }
    ]
  );

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].sessions.map((session) => session.id),
    ["live-1", "live-2"]
  );
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

test("filterSidebarSessionsByRecency keeps only recent sessions but preserves active live sessions", () => {
  const nowMs = Date.parse("2026-04-29T12:00:00.000Z");
  const payload = filterSidebarSessionsByRecency(
    [
      { id: "recent-history", kind: "history", updatedAt: "2026-04-25T10:00:00.000Z" },
      { id: "old-history", kind: "history", updatedAt: "2026-04-01T10:00:00.000Z" },
      { id: "running-live-old", kind: "live", status: "running", updatedAt: "2026-04-01T10:00:00.000Z" },
      { id: "exited-live-old", kind: "live", status: "exited", updatedAt: "2026-04-01T10:00:00.000Z" }
    ],
    { nowMs }
  );

  assert.deepEqual(payload.map((session) => session.id), ["recent-history", "running-live-old"]);
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
