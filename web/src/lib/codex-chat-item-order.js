export function mergeOrder(current, incoming, { older = false, afterId, beforeId } = {}) {
  const result = [...current];
  for (let index = 0; index < incoming.length; index += 1) {
    const id = incoming[index];
    if (result.includes(id)) continue;
    const next = incoming.slice(index + 1).find((candidate) => result.includes(candidate));
    const previous = incoming.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    if (next) result.splice(result.indexOf(next), 0, id);
    else if (previous) result.splice(result.indexOf(previous) + 1, 0, id);
    else if (afterId && result.includes(afterId)) result.splice(result.indexOf(afterId) + 1, 0, id);
    else if (beforeId && result.includes(beforeId)) result.splice(result.indexOf(beforeId), 0, id);
    else if (older) result.unshift(id);
    else result.push(id);
  }
  return result;
}

export function mergeItemOrder(current, incoming, { authoritative = false, afterId, beforeId, headId } = {}) {
  const ids = [...new Set(incoming)];
  if (!ids.length) return [...current];
  if (!authoritative) {
    // A turn summary is sparse: its next item may follow many already-loaded items.
    const result = [...current];
    ids.forEach((id, index) => {
      if (result.includes(id)) return;
      const next = ids.slice(index + 1).find((candidate) => result.includes(candidate));
      if (next) result.splice(result.indexOf(next), 0, id);
      else if (id === headId) result.unshift(id);
      else if (beforeId && result.includes(beforeId)) result.splice(result.indexOf(beforeId), 0, id);
      else result.push(id);
    });
    return result;
  }
  // An item page is an ordered slice, and must also correct IDs first seen out of order over WS.
  const incomingIds = new Set(ids);
  const firstKnown = current.findIndex((id) => incomingIds.has(id));
  const result = current.filter((id) => !incomingIds.has(id));
  const insertion = afterId && result.includes(afterId) ? result.indexOf(afterId) + 1
    : beforeId && result.includes(beforeId) ? result.indexOf(beforeId)
      : firstKnown >= 0 ? current.slice(0, firstKnown).filter((id) => !incomingIds.has(id)).length : result.length;
  result.splice(insertion, 0, ...ids);
  return result;
}

export function includeWindowItems(turn, ids, { reset = false } = {}) {
  const included = new Set([...(reset ? [] : turn.itemsWindowIds || []), ...ids]);
  turn.itemsWindowIds = turn.itemOrder.filter((id) => included.has(id));
}
