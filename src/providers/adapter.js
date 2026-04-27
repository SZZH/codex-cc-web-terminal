import { createCapabilityMatrix } from "./capabilities.js";

function asNonEmptyString(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`Provider adapter requires a non-empty ${fieldName}.`);
  }
  return text;
}

function ensureFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`Provider adapter requires a ${fieldName}() function.`);
  }
  return value;
}

export class ProviderAdapter {
  constructor(definition = {}) {
    this.id = asNonEmptyString(definition.id, "id");
    this.label = asNonEmptyString(definition.label, "label");
    this.capabilities = createCapabilityMatrix(definition.capabilities);
    this.createSession = ensureFunction(definition.createSession, "createSession");
  }

  supports(capability) {
    return Boolean(this.capabilities[capability]);
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      capabilities: this.capabilities
    };
  }
}

export function createProviderAdapter(definition) {
  return new ProviderAdapter(definition);
}

export function createNoopSessionFactory(providerId) {
  return async function createSession() {
    throw new Error(`Provider "${providerId}" is not wired yet.`);
  };
}
