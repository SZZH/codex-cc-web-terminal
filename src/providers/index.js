export {
  DEFAULT_CAPABILITY_MATRIX,
  PROVIDER_CAPABILITIES,
  createCapabilityMatrix,
  listProviderCapabilities
} from "./capabilities.js";
export {
  ProviderAdapter,
  createNoopSessionFactory,
  createProviderAdapter
} from "./adapter.js";
export { BUILTIN_PROVIDER_DESCRIPTORS } from "./descriptors.js";
export {
  ProviderRegistry,
  createProviderRegistry,
  providerRegistry,
  resolveProviderId
} from "./registry.js";
