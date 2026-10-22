import { throwIfReadAborted } from "./readCancellation.js";

const invalid = () => Object.assign(new Error("Invalid initial history page"), { status: 502, code: "invalid_initial_history" });

// Keep the two reader operations local while preserving their independent cursors.
export async function readInitialHistory(service, threadId, { signal } = {}) {
  throwIfReadAborted(signal);
  const turnsPage = await service.reader.listTurns(threadId, { limit: 1, signal });
  throwIfReadAborted(signal);
  if (turnsPage?.threadId !== threadId || !Array.isArray(turnsPage.turns) || turnsPage.turns.length > 1 ||
    turnsPage.turns.some((turn) => !turn?.id)) throw invalid();
  const turn = turnsPage.turns[0];
  const itemsPage = turn ? await service.reader.listItems(threadId, turn.id, { limit: 30, sortDirection: "desc", signal }) : null;
  throwIfReadAborted(signal);
  if (turn && (itemsPage?.threadId !== threadId || itemsPage.turnId !== turn.id ||
    !Array.isArray(itemsPage.items) || itemsPage.items.length > 30)) throw invalid();
  service.reconcileRequests(threadId, turnsPage.turns);
  if (turn) service.reconcileItems?.(threadId, turn.id, itemsPage.items);
  throwIfReadAborted(signal);
  return { turnsPage, itemsPage };
}
