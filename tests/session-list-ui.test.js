import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGroupedSessions,
  cacheKey,
  decorateSession,
  mergeSessionTitlesIntoCache,
  parseHistoryRouteSessionId
} from "../web/src/lib/session-list.js";

test("parseHistoryRouteSessionId parses provider and resumeSessionId", () => {
  assert.deepEqual(parseHistoryRouteSessionId("history:codex:thread-123"), {
    provider: "codex",
    resumeSessionId: "thread-123"
  });
  assert.equal(parseHistoryRouteSessionId("session-123"), null);
});

test("decorateSession derives list display fields", () => {
  const decorated = decorateSession({
    id: "session-1",
    name: "Demo",
    inputPreview: "hello",
    cwd: "/tmp/demo"
  });

  assert.equal(decorated.displayTitle, "Demo");
  assert.equal(decorated.displayPreview, "hello");
  assert.equal(decorated.groupName, "demo");
});

test("buildGroupedSessions prefers backend project groups when present", () => {
  const grouped = buildGroupedSessions(
    [],
    [
      {
        name: "demo",
        cwd: "/tmp/demo",
        sessions: [{ id: "session-1", name: "Demo", inputPreview: "", cwd: "/tmp/demo" }]
      }
    ]
  );

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sessions[0].displayTitle, "Demo");
});

test("buildGroupedSessions falls back to local grouping when project groups are absent", () => {
  const grouped = buildGroupedSessions([
    { id: "a", name: "A", inputPreview: "", cwd: "/tmp/demo-a", updatedAt: "2026-04-27T10:00:00.000Z" },
    { id: "b", name: "B", inputPreview: "", cwd: "/tmp/demo-a", updatedAt: "2026-04-28T10:00:00.000Z" }
  ]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].sessions.map((session) => session.id), ["b", "a"]);
});

test("mergeSessionTitlesIntoCache only stores non-empty titles", () => {
  const sessionCache = {};
  mergeSessionTitlesIntoCache(
    [
      { id: "session-1", kind: "live", name: "Demo" },
      { id: "session-2", kind: "live", name: "" }
    ],
    sessionCache
  );

  assert.equal(sessionCache[cacheKey({ id: "session-1", kind: "live" })].title, "Demo");
  assert.equal(cacheKey({ provider: "codex", kind: "thread", resumeSessionId: "thread-1" }), "thread:codex:thread-1");
  assert.equal(sessionCache[cacheKey({ id: "session-2", kind: "live" })], undefined);
});
