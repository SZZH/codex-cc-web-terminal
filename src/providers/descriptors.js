import { createProviderAdapter, createNoopSessionFactory } from "./adapter.js";
import { PROVIDER_CAPABILITIES } from "./capabilities.js";

function createDescriptor({
  id,
  label,
  aliases = [],
  capabilities = {}
}) {
  const adapter = createProviderAdapter({
    id,
    label,
    capabilities,
    createSession: createNoopSessionFactory(id)
  });

  return Object.freeze({
    id,
    label,
    aliases: Object.freeze([...new Set([id, ...aliases].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]),
    adapter,
    capabilities: adapter.capabilities
  });
}

export const BUILTIN_PROVIDER_DESCRIPTORS = Object.freeze([
  createDescriptor({
    id: "codex",
    label: "Codex",
    aliases: ["openai-codex"],
    capabilities: {
      [PROVIDER_CAPABILITIES.SESSION_RESUME]: true,
      [PROVIDER_CAPABILITIES.SESSION_HISTORY]: true,
      [PROVIDER_CAPABILITIES.STREAMING_EVENTS]: true,
      [PROVIDER_CAPABILITIES.TOOL_CALLS]: true,
      [PROVIDER_CAPABILITIES.STRUCTURED_OUTPUT]: true
    }
  }),
  createDescriptor({
    id: "cc",
    label: "Claude",
    aliases: ["claude", "anthropic-claude"],
    capabilities: {
      [PROVIDER_CAPABILITIES.SESSION_RESUME]: true,
      [PROVIDER_CAPABILITIES.SESSION_HISTORY]: true,
      [PROVIDER_CAPABILITIES.STREAMING_EVENTS]: true,
      [PROVIDER_CAPABILITIES.TOOL_CALLS]: true
    }
  }),
  createDescriptor({
    id: "cursor",
    label: "Cursor",
    aliases: ["cursor-agent"],
    capabilities: {
      [PROVIDER_CAPABILITIES.SESSION_RESUME]: true,
      [PROVIDER_CAPABILITIES.TOOL_CALLS]: true,
      [PROVIDER_CAPABILITIES.STRUCTURED_OUTPUT]: true
    }
  }),
  createDescriptor({
    id: "opencode",
    label: "OpenCode",
    aliases: ["open-code"],
    capabilities: {
      [PROVIDER_CAPABILITIES.STREAMING_EVENTS]: true,
      [PROVIDER_CAPABILITIES.TOOL_CALLS]: true,
      [PROVIDER_CAPABILITIES.STRUCTURED_OUTPUT]: true
    }
  })
]);
