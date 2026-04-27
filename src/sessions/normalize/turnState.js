function sortAgents(items = []) {
  return [...items].sort((left, right) => {
    const rightTs = Date.parse(String(right?.updatedAt || right?.finishedAt || right?.startedAt || ""));
    const leftTs = Date.parse(String(left?.updatedAt || left?.finishedAt || left?.startedAt || ""));
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });
}

export function createEmptyConversationState() {
  return {
    turns: [],
    backgroundAgents: [],
    activeTurnId: ""
  };
}

function replaceTurn(turns, turnId, updater) {
  return turns.map((turn) => {
    if (turn.id !== turnId) {
      return turn;
    }
    return updater(turn);
  });
}

function applyTurnCreated(state, delta) {
  const nextTurn = {
    id: String(delta.turnId || ""),
    sessionId: "",
    threadId: "",
    user: delta.user || null,
    assistant: {
      body: [],
      process: [],
      status: "running",
      startedAt: delta.timestamp,
      finishedAt: ""
    }
  };
  const filtered = state.turns.filter((turn) => turn.id !== nextTurn.id);
  return {
    ...state,
    activeTurnId: nextTurn.id,
    turns: [...filtered, nextTurn]
  };
}

function compactBodyText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function shouldTreatAsDuplicateParagraph(previousText, nextText) {
  const prev = compactBodyText(previousText);
  const next = compactBodyText(nextText);
  if (!prev || !next) {
    return false;
  }
  if (prev === next) {
    return true;
  }
  const shorter = prev.length <= next.length ? prev : next;
  const longer = prev.length > next.length ? prev : next;
  return shorter.length >= 24 && longer.includes(shorter) && shorter.length / longer.length >= 0.88;
}

function mergeStreamingMarkdownBlock(lastBlock, incoming) {
  const previousText = String(lastBlock?.text || "");
  const nextText = String(incoming?.text || "");

  if (!nextText) {
    return false;
  }
  if (!previousText || nextText === previousText) {
    lastBlock.text = nextText || previousText;
    lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }
  if (nextText.startsWith(previousText)) {
    // Some streaming transports resend the whole current draft instead of a pure delta.
    lastBlock.text = nextText;
    lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }
  if (previousText.startsWith(nextText) && nextText.length >= 24) {
    // Ignore shorter stale snapshots that would make the text jump backwards.
    lastBlock.ts = incoming.ts || lastBlock.ts;
    return true;
  }

  lastBlock.text = `${previousText}${nextText}`;
  lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "streaming" };
  lastBlock.ts = incoming.ts || lastBlock.ts;
  return true;
}

function areProcessEventsEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    String(left.type || "") === String(right.type || "") &&
    String(left.title || "") === String(right.title || "") &&
    String(left.summary || "") === String(right.summary || "") &&
    String(left.content || "") === String(right.content || "")
  );
}

function applyBodyAppended(state, delta) {
  const targetTurnId = String(delta.turnId || state.activeTurnId || "");
  return {
    ...state,
    turns: replaceTurn(state.turns, targetTurnId, (turn) => {
      const nextBody = [...turn.assistant.body];
      const incoming = delta.block || {};
      const incomingKind = String(incoming.kind || "markdown");
      const incomingText = String(incoming.text || "");
      const mergeMode = String(incoming.mergeMode || "paragraph").toLowerCase();
      const lastBlock = nextBody[nextBody.length - 1];
      const canMergeMarkdown =
        incomingKind === "markdown" &&
        lastBlock &&
        String(lastBlock.kind || "") === "markdown";

      if (canMergeMarkdown && mergeMode === "stream_append") {
        mergeStreamingMarkdownBlock(lastBlock, incoming);
      } else if (canMergeMarkdown && mergeMode === "stream_replace") {
        lastBlock.text = incomingText;
        lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "completed" };
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else if (
        canMergeMarkdown &&
        mergeMode === "paragraph" &&
        String(lastBlock.text || "").trim() &&
        incomingText &&
        !shouldTreatAsDuplicateParagraph(String(lastBlock.text || ""), incomingText)
      ) {
        lastBlock.text = `${String(lastBlock.text || "").trim()}\n${incomingText}`.trim();
        lastBlock.payload = { ...(lastBlock.payload || {}), ...(incoming.payload || {}), phase: "completed" };
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else if (
        canMergeMarkdown &&
        mergeMode === "paragraph" &&
        (
          String(lastBlock.text || "").trim() === incomingText.trim() ||
          shouldTreatAsDuplicateParagraph(String(lastBlock.text || ""), incomingText)
        )
      ) {
        if (compactBodyText(incomingText).length > compactBodyText(String(lastBlock.text || "")).length) {
          lastBlock.text = incomingText;
        }
        lastBlock.ts = incoming.ts || lastBlock.ts;
      } else {
        nextBody.push(incoming);
      }

      return {
        ...turn,
        assistant: {
          ...turn.assistant,
          body: nextBody
        }
      };
    })
  };
}

function applyProcessAppended(state, delta) {
  return {
    ...state,
    turns: replaceTurn(state.turns, String(delta.turnId || state.activeTurnId || ""), (turn) => {
      const nextProcess = [...turn.assistant.process];
      const incomingEvent = delta.event || {};
      const lastEvent = nextProcess[nextProcess.length - 1];
      if (areProcessEventsEquivalent(lastEvent, incomingEvent)) {
        lastEvent.ts = incomingEvent.ts || lastEvent.ts;
        lastEvent.payload = { ...(lastEvent.payload || {}), ...(incomingEvent.payload || {}) };
      } else {
        nextProcess.push(incomingEvent);
      }
      return {
        ...turn,
        assistant: {
          ...turn.assistant,
          process: nextProcess
        }
      };
    })
  };
}

function applyTurnStatusChanged(state, delta) {
  return {
    ...state,
    turns: replaceTurn(state.turns, String(delta.turnId || state.activeTurnId || ""), (turn) => ({
      ...turn,
      assistant: {
        ...turn.assistant,
        status: String(delta.status || "running"),
        finishedAt: delta.status && delta.status !== "running" ? String(delta.timestamp || "") : turn.assistant.finishedAt
      }
    }))
  };
}

function applyTurnCompleted(state, delta) {
  return {
    ...state,
    activeTurnId: state.activeTurnId === delta.turnId ? "" : state.activeTurnId,
    turns: replaceTurn(state.turns, String(delta.turnId || state.activeTurnId || ""), (turn) => ({
      ...turn,
      assistant: {
        ...turn.assistant,
        status: String(delta.status || "completed"),
        finishedAt: String(delta.timestamp || turn.assistant.finishedAt || "")
      }
    }))
  };
}

function applyBackgroundAgentUpserted(state, delta) {
  const next = [...state.backgroundAgents];
  const agent = delta.agent || {};
  const index = next.findIndex((item) => item.agentId === agent.agentId);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...agent,
      relatedTurnIds: Array.from(new Set([...(next[index].relatedTurnIds || []), ...(agent.relatedTurnIds || [])]))
    };
  } else {
    next.push({
      ...agent,
      relatedTurnIds: Array.from(new Set([...(agent.relatedTurnIds || [])]))
    });
  }
  return {
    ...state,
    backgroundAgents: sortAgents(next)
  };
}

export function applyDelta(state, delta) {
  if (!delta || typeof delta !== "object") {
    return state;
  }
  switch (delta.kind) {
    case "turn_created":
      return applyTurnCreated(state, delta);
    case "body_appended":
      return applyBodyAppended(state, delta);
    case "process_appended":
      return applyProcessAppended(state, delta);
    case "turn_status_changed":
      return applyTurnStatusChanged(state, delta);
    case "turn_completed":
      return applyTurnCompleted(state, delta);
    case "background_agent_upserted":
      return applyBackgroundAgentUpserted(state, delta);
    default:
      return state;
  }
}
