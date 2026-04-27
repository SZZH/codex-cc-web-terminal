import { CANONICAL_EVENT_KINDS, assertCanonicalEvent } from "../canonical/index.js";
import { createLiveTurnAggregator } from "./aggregator/liveTurnAggregator.js";
import { createThreadSnapshot, createTurnSnapshot, TURN_STATUSES } from "./snapshot.js";

function ensureProvider(snapshot, provider) {
  if (provider && !snapshot.metadata.providerSet.includes(provider)) {
    snapshot.metadata.providerSet.push(provider);
  }
}

function ensureTurn(snapshot, event) {
  const turnId = event.turnId ?? snapshot.activeTurnId ?? `turn:${event.seq}`;
  let turn = snapshot.turns.find((entry) => entry.id === turnId);

  if (!turn) {
    turn = createTurnSnapshot({
      id: turnId,
      startedAt: event.ts
    });
    snapshot.turns.push(turn);
  }

  return turn;
}

function upsertTerminalTextItem(turn, id, kind, text, ts) {
  const existing = turn.items.find((item) => item.id === id);
  if (existing) {
    existing.text = text;
    existing.completedAt = ts;
    return existing;
  }

  const created = {
    kind,
    id,
    text,
    createdAt: ts,
    completedAt: ts
  };
  turn.items.push(created);
  return created;
}

function materializeOverlay(turn, overlay, completedAt) {
  if (!overlay) {
    return;
  }

  if (overlay.message?.text) {
    upsertTerminalTextItem(turn, `message:${turn.id}`, "AgentMessage", overlay.message.text, completedAt);
  }

  if (overlay.reasoning?.text) {
    upsertTerminalTextItem(turn, `reasoning:${turn.id}`, "Reasoning", overlay.reasoning.text, completedAt);
  }

  for (const tool of overlay.tools) {
    turn.items.push({ ...tool });
  }

  for (const artifact of overlay.artifacts) {
    turn.items.push({ ...artifact });
  }
}

function upsertUserMessage(turn, event) {
  const id = `user:${turn.id}`;
  const text = String(event.payload?.text ?? "");
  const content = Array.isArray(event.payload?.content) ? JSON.parse(JSON.stringify(event.payload.content)) : [];
  const existing = turn.items.find((item) => item.id === id);
  if (existing) {
    existing.text = text;
    existing.completedAt = event.ts;
    existing.payload = {
      ...(existing.payload || {}),
      content
    };
    return existing;
  }

  const created = {
    kind: "UserMessage",
    id,
    text,
    createdAt: event.ts,
    completedAt: event.ts,
    payload: {
      content
    }
  };
  turn.items.unshift(created);
  return created;
}

function applyTerminalTurn(snapshot, aggregator, event, status) {
  const turn = ensureTurn(snapshot, event);
  materializeOverlay(turn, aggregator.getOverlay(), event.ts);
  turn.status = status;
  turn.completedAt = event.ts;
  snapshot.activeTurnId = null;
  aggregator.reset({ threadId: snapshot.threadId, turnId: "" });
}

export function createThreadProjector(input = {}) {
  const snapshot = createThreadSnapshot(
    input.snapshot
      ? {
          ...input.snapshot,
          threadId: input.snapshot.threadId ?? input.threadId ?? "",
          metadata: input.snapshot.metadata ?? input.metadata
        }
      : {
          threadId: input.threadId ?? "",
          metadata: input.metadata
        }
  );
  const aggregator = createLiveTurnAggregator({
    threadId: snapshot.threadId,
    turnId: ""
  });

  function touch(event) {
    snapshot.version += 1;
    snapshot.updatedAt = event.ts;
  }

  return {
    applyEvent(event) {
      assertCanonicalEvent(event, "projector event");
      ensureProvider(snapshot, event.provider);
      touch(event);

      switch (event.kind) {
        case CANONICAL_EVENT_KINDS.THREAD_METADATA_UPDATED:
          snapshot.metadata = {
            ...snapshot.metadata,
            title: event.payload?.name ?? snapshot.metadata.title,
            cwd: event.payload?.cwd ?? snapshot.metadata.cwd,
            providerSet: snapshot.metadata.providerSet,
            tags: snapshot.metadata.tags,
            extra: {
              ...(snapshot.metadata.extra || {}),
              ...(event.payload || {})
            }
          };
          break;
        case CANONICAL_EVENT_KINDS.THREAD_SNAPSHOT:
          if (event.payload?.snapshot && typeof event.payload.snapshot === "object") {
            Object.assign(snapshot, createThreadSnapshot(event.payload.snapshot));
          }
          break;
        case CANONICAL_EVENT_KINDS.TURN_STARTED:
          snapshot.activeTurnId = event.turnId ?? `turn:${event.seq}`;
          ensureTurn(snapshot, event);
          aggregator.reset({ threadId: snapshot.threadId, turnId: snapshot.activeTurnId });
          break;
        case CANONICAL_EVENT_KINDS.USER_MESSAGE:
          upsertUserMessage(ensureTurn(snapshot, event), event);
          break;
        case CANONICAL_EVENT_KINDS.MESSAGE_DELTA:
        case CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED:
        case CANONICAL_EVENT_KINDS.REASONING_DELTA:
        case CANONICAL_EVENT_KINDS.REASONING_COMPLETED:
        case CANONICAL_EVENT_KINDS.TOOL_STARTED:
        case CANONICAL_EVENT_KINDS.TOOL_PROGRESS:
        case CANONICAL_EVENT_KINDS.TOOL_COMPLETED:
        case CANONICAL_EVENT_KINDS.TOOL_FAILED:
        case CANONICAL_EVENT_KINDS.ARTIFACT_CREATED:
        case CANONICAL_EVENT_KINDS.ARTIFACT_UPDATED:
          aggregator.applyEvent(event);
          break;
        case CANONICAL_EVENT_KINDS.TURN_COMPLETED:
          applyTerminalTurn(snapshot, aggregator, event, TURN_STATUSES.COMPLETED);
          break;
        case CANONICAL_EVENT_KINDS.TURN_FAILED:
          applyTerminalTurn(snapshot, aggregator, event, TURN_STATUSES.FAILED);
          break;
        case CANONICAL_EVENT_KINDS.TURN_INTERRUPTED:
          applyTerminalTurn(snapshot, aggregator, event, TURN_STATUSES.INTERRUPTED);
          break;
        default:
          break;
      }

      snapshot.lastSeq = Math.max(Number(snapshot.lastSeq || 0), Number(event.seq || 0));

      return {
        snapshot: this.getSnapshot(),
        overlay: this.getOverlay()
      };
    },

    applyEvents(events = []) {
      let state = {
        snapshot: this.getSnapshot(),
        overlay: this.getOverlay()
      };
      for (const event of events) {
        state = this.applyEvent(event);
      }
      return state;
    },

    getSnapshot() {
      return createThreadSnapshot(snapshot);
    },

    getOverlay() {
      const overlay = aggregator.getOverlay();
      return overlay ? JSON.parse(JSON.stringify(overlay)) : null;
    }
  };
}
