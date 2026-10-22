import { isDeepStrictEqual } from "node:util";

export const invalid = (message, code = "invalid_interaction_response", status = 400) => Object.assign(new Error(message), { status, code });
export const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const equal = isDeepStrictEqual;
export const dangerousKey = (key) => ["__proto__", "constructor", "prototype"].includes(key);
export const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export function fields(value, allowed, message = "Invalid interaction response fields") {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key) || dangerousKey(key))) throw invalid(message);
}

export function safeObject(value, depth = 0) {
  if (depth > 64) throw invalid("Interaction nesting limit exceeded");
  if (Array.isArray(value)) { for (const entry of value) safeObject(entry, depth + 1); return; }
  if (object(value)) for (const [key, entry] of Object.entries(value)) {
    if (dangerousKey(key)) throw invalid("Unsafe interaction field");
    safeObject(entry, depth + 1);
  }
}
