import fs from "node:fs";

import { createRawRecord } from "./rawRecords.js";
import { canonicalizeRawRecords, createCanonicalizerState } from "./canonicalEvents.js";
import { reduceCanonicalEvents } from "./reducer.js";

export function buildThreadSnapshotFromFile(filePath, { threadId = "", metadata = {} } = {}) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const rawRecords = content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line);
        return createRawRecord({
          id: `history:${threadId || "thread"}:${index + 1}`,
          threadId,
          turnId: String(parsed?.payload?.turn_id || parsed?.turn_id || ""),
          raw: parsed,
          seq: index + 1,
          recordTs: parsed?.timestamp || parsed?.payload?.timestamp || null
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!rawRecords.length) {
    return null;
  }

  const events = canonicalizeRawRecords(rawRecords, createCanonicalizerState());
  if (!events.length) {
    return null;
  }

  return reduceCanonicalEvents(events, { threadId, metadata });
}
