/**
 * `@volli/host-core/handlers`: the host's one handler map, catalog key to the whole command (VC-668).
 *
 * The map a root builds is sealed: a door reaches an entry only through
 * `invokeHandler` or `admittedHandlers`, each of which runs the door's policy
 * first.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  createHostHandlers,
  type HandlerSink,
  type HostExperiments,
  type HostHandlerCoverage,
  type HostHandlerInput,
  type HostHandlerOptions,
  type HostHandlerOutput,
  type HostHandlers,
  type HostHandlerSignatures,
  type HostSubscriptionHandler,
  type SessionCreateHandlerInput,
  type SessionReadHandlerInput,
  type SessionReadPort,
} from "../handlers/host-handlers";
export type {
  RemoteHostsPort,
  RemoteHostsUnsubscribe,
  RemoteHostUpdateWhen,
} from "../handlers/remote-hosts-port";
export {
  ADMITTED,
  admittedHandlers,
  invokeHandler,
  refused,
  type AdmissionObserver,
  type AdmissionRecord,
  type AdmissionVerdict,
  type HandlerPolicy,
  type HandlerRefusal,
  type HostHandlerMap,
} from "../handlers/handler-map";
export { DESKTOP_WINDOW_POLICY, ROUTER_POLICY } from "../handlers/policies";
