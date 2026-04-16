import test from "node:test";
import assert from "node:assert/strict";

import { compareConversationContent, createConversationState } from "../web/src/lib/conversation-timeline.js";

test("compareConversationContent treats richer same-version turn content as newer", () => {
  const richer = createConversationState({
    sessionId: "session-live",
    threadId: "thread-1",
    version: 3,
    turns: [
      {
        id: "turn-1",
        user: { id: "user-1", text: "继续", ts: "2026-04-14T00:00:00.000Z" },
        assistant: {
          status: "running",
          startedAt: "2026-04-14T00:00:01.000Z",
          finishedAt: "",
          process: [],
          body: [
            {
              id: "body-1",
              kind: "markdown",
              text: "这是已经流出来的实时回复内容",
              payload: { phase: "streaming" },
              ts: "2026-04-14T00:00:02.000Z"
            }
          ]
        }
      }
    ]
  });

  const staleSnapshot = createConversationState({
    sessionId: "session-live",
    threadId: "thread-1",
    version: 3,
    turns: [
      {
        id: "turn-1",
        user: { id: "user-1", text: "继续", ts: "2026-04-14T00:00:00.000Z" },
        assistant: {
          status: "running",
          startedAt: "2026-04-14T00:00:01.000Z",
          finishedAt: "",
          process: [],
          body: []
        }
      }
    ]
  });

  assert.ok(compareConversationContent(richer, staleSnapshot) > 0);
  assert.ok(compareConversationContent(staleSnapshot, richer) < 0);
});
