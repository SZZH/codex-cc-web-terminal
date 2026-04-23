export const PROVIDER_CAPABILITIES = Object.freeze({
  SESSION_RESUME: "session:resume",
  SESSION_HISTORY: "session:history",
  TOOL_CALLS: "tool:calls",
  STREAMING_TEXT: "stream:text",
  STREAMING_EVENTS: "stream:events",
  MULTIMODAL_INPUT: "input:multimodal",
  STRUCTURED_OUTPUT: "output:structured"
});

export const DEFAULT_CAPABILITY_MATRIX = Object.freeze({
  [PROVIDER_CAPABILITIES.SESSION_RESUME]: false,
  [PROVIDER_CAPABILITIES.SESSION_HISTORY]: false,
  [PROVIDER_CAPABILITIES.TOOL_CALLS]: false,
  [PROVIDER_CAPABILITIES.STREAMING_TEXT]: true,
  [PROVIDER_CAPABILITIES.STREAMING_EVENTS]: false,
  [PROVIDER_CAPABILITIES.MULTIMODAL_INPUT]: false,
  [PROVIDER_CAPABILITIES.STRUCTURED_OUTPUT]: false
});

export function createCapabilityMatrix(overrides = {}) {
  return Object.freeze({
    ...DEFAULT_CAPABILITY_MATRIX,
    ...overrides
  });
}

export function listProviderCapabilities() {
  return Object.values(PROVIDER_CAPABILITIES);
}
