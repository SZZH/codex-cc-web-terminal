import fs from "node:fs";
import path from "node:path";

import { parseHistoricalFile } from "./historicalParsing.js";

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export function historyFileSignature(filePath) {
  return statSignature(fs.statSync(filePath, { bigint: true }));
}

export function optionalHistoryFileSignature(filePath) {
  try {
    return historyFileSignature(filePath);
  } catch {
    return "missing";
  }
}

export function buildHistoryCatalogSourceSignature(sourceDirs) {
  return sourceDirs.map((dirPath) => {
    const parts = [];
    const queue = [dirPath];
    while (queue.length) {
      const current = queue.pop();
      let stat;
      try {
        stat = fs.statSync(current, { bigint: true });
      } catch {
        parts.push(`${current}:missing`);
        continue;
      }
      parts.push(`${current}:${statSignature(stat)}`);
      if (!stat.isDirectory()) {
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".jsonl"))) {
          queue.push(path.join(current, entry.name));
        }
      }
    }
    return parts.sort().join(",");
  }).join("|");
}

export function readHistoryCatalogFile(filePath, cached = null) {
  const signature = historyFileSignature(filePath);
  const stat = fs.statSync(filePath);
  if (cached?.signature === signature) {
    return { stat, parsed: cached.parsed, cached };
  }

  const parsed = parseHistoricalFile(filePath);
  // Do not associate content read during an append with the newer file version.
  const nextCache = historyFileSignature(filePath) === signature ? { signature, parsed } : null;
  return { stat, parsed, cached: nextCache };
}
