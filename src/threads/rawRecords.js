import { createRawThreadRecord } from "./types.js";

function inferRecordSubtype(recordType, raw) {
  if (recordType === "response_item") {
    return raw?.payload?.type ?? raw?.type ?? "unknown";
  }
  if (recordType === "event_msg") {
    return raw?.payload?.type ?? raw?.msg?.type ?? "unknown";
  }
  return raw?.type ?? "unknown";
}

export function createRawRecord(input = {}) {
  const recordType = input.recordType ?? input.raw?.type ?? "unknown";
  return createRawThreadRecord({
    ...input,
    recordType,
    recordSubtype: input.recordSubtype ?? inferRecordSubtype(recordType, input.raw ?? {})
  });
}

export function createRawRecords(records = []) {
  return records.map((record, index) =>
    createRawRecord({
      seq: record.seq ?? index + 1,
      ...record
    })
  );
}
