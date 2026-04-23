export const TURN_STATUSES = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted"
});

function cloneItems(items = []) {
  return items.map((item) => ({
    ...item,
    metadata: item.metadata ? { ...item.metadata } : undefined
  }));
}

export function createThreadSnapshot(input = {}) {
  return {
    threadId: input.threadId ?? "",
    version: input.version ?? 0,
    lastSeq: input.lastSeq ?? 0,
    updatedAt: input.updatedAt ?? null,
    activeTurnId: input.activeTurnId ?? null,
    metadata: {
      title: input.metadata?.title ?? "",
      cwd: input.metadata?.cwd,
      providerSet: [...(input.metadata?.providerSet ?? [])],
      tags: [...(input.metadata?.tags ?? [])],
      extra: input.metadata?.extra && typeof input.metadata.extra === "object" ? { ...input.metadata.extra } : {}
    },
    turns: (input.turns ?? []).map((turn) => ({
      ...turn,
      items: cloneItems(turn.items)
    })),
    backgroundAgents: [...(input.backgroundAgents ?? [])]
  };
}

export function createLiveTurnOverlay(input = {}) {
  return {
    threadId: input.threadId ?? "",
    turnId: input.turnId ?? "",
    status: TURN_STATUSES.RUNNING,
    message: input.message ? { ...input.message } : null,
    reasoning: input.reasoning ? { ...input.reasoning } : null,
    tools: cloneItems(input.tools),
    artifacts: cloneItems(input.artifacts)
  };
}

export function createTurnSnapshot(input = {}) {
  return {
    id: input.id ?? "",
    status: input.status ?? TURN_STATUSES.RUNNING,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    items: cloneItems(input.items)
  };
}
