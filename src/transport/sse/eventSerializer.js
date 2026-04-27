export const SSE_TRANSPORT_EVENTS = Object.freeze({
  SNAPSHOT: "thread.snapshot",
  OVERLAY: "thread.overlay",
  CANONICAL_EVENT: "canonical.event",
  KEEPALIVE: "keepalive",
  ERROR: "error"
});

function splitLines(value) {
  return String(value).split(/\r?\n/u);
}

export function serializeSseFrame({ event, data, id }) {
  const lines = [];

  if (id != null) {
    lines.push(`id: ${id}`);
  }
  if (event) {
    lines.push(`event: ${event}`);
  }

  const encoded = JSON.stringify(data ?? {});
  for (const line of splitLines(encoded)) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}
