/**
 * `@volli/host-core/ports`: what host code asks of the process hosting it, with the headless answers.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export {
  type AttentionDeliveryPort,
  type ClientCapabilityPort,
  type ClientMenuItem,
  HEADLESS_ATTENTION,
  type HostBroadcastEventTopic,
  type HostClientEventSink,
  type HostEventBus,
  type HostEventMap,
  NO_POWER_EVENTS,
  type SecretKeyPort,
  SecretKeyUnavailableError,
} from "../ports";
