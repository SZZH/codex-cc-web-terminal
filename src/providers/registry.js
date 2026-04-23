import { BUILTIN_PROVIDER_DESCRIPTORS } from "./descriptors.js";

function normalizeProviderKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveProviderId(providerId, fallback = "") {
  const registry = providerRegistry;
  const descriptor = registry.get(providerId);
  if (descriptor?.id) {
    return descriptor.id;
  }
  return normalizeProviderKey(providerId) || normalizeProviderKey(fallback);
}

export class ProviderRegistry {
  constructor(descriptors = []) {
    this.providers = new Map();
    this.aliases = new Map();

    for (const descriptor of descriptors) {
      this.register(descriptor);
    }
  }

  register(descriptor) {
    if (!descriptor || typeof descriptor !== "object") {
      throw new Error("Cannot register an empty provider descriptor.");
    }

    const providerId = normalizeProviderKey(descriptor.id);
    if (!providerId) {
      throw new Error("Provider descriptor requires an id.");
    }
    if (this.providers.has(providerId)) {
      throw new Error(`Provider "${providerId}" is already registered.`);
    }

    const normalizedDescriptor = Object.freeze({
      ...descriptor,
      id: providerId
    });
    this.providers.set(providerId, normalizedDescriptor);

    for (const alias of normalizedDescriptor.aliases || []) {
      const key = normalizeProviderKey(alias);
      if (key) {
        this.aliases.set(key, providerId);
      }
    }

    return normalizedDescriptor;
  }

  get(providerId) {
    const key = normalizeProviderKey(providerId);
    const resolvedId = this.providers.has(key) ? key : this.aliases.get(key);
    return resolvedId ? this.providers.get(resolvedId) || null : null;
  }

  require(providerId) {
    const descriptor = this.get(providerId);
    if (!descriptor) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return descriptor;
  }

  has(providerId) {
    return Boolean(this.get(providerId));
  }

  list() {
    return [...this.providers.values()];
  }

  listCapabilities() {
    return this.list().map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      capabilities: descriptor.capabilities
    }));
  }
}

export function createProviderRegistry(descriptors = BUILTIN_PROVIDER_DESCRIPTORS) {
  return new ProviderRegistry(descriptors);
}

export const providerRegistry = createProviderRegistry();
