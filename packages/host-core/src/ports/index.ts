/**
 * `@volli/host-core/ports` — what host code asks of the process hosting it
 * (VC-554). See the README's "Ports" section for the vocabulary, how a moved
 * service asks for one, and what a headless host passes.
 */
export { HEADLESS_ATTENTION, type AttentionDeliveryPort } from "./attention";
export {
  ClientCapabilityUnavailableError,
  clientCapabilities,
  isClientCapabilityUnavailable,
  type ClientCapability,
  type ClientCapabilityPort,
  type ClientMenuItem,
} from "./client";
export type {
  HostClientEventSink,
  HostClientEventTopic,
  HostBroadcastEventTopic,
  HostEventBus,
  HostEventMap,
  HostEventTopic,
} from "./events";
export type { CredentialKey, CredentialKeyBackend, CredentialKeyring } from "./credential-keyring";
export { CredentialKeyPendingError } from "./credential-keyring";
export { NO_POWER_EVENTS, type PowerEvent, type PowerPort } from "./power";
export {
  isSecretKeyUnavailable,
  SecretKeyUnavailableError,
  type SecretKeyPort,
  type SecretKeyRefusal,
} from "./secret-key";
export { trashCapabilities, TrashUnavailableError, type TrashPort } from "./trash";
