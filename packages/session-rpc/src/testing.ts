/**
 * `@volli/session-rpc/testing`: test support for the router's clients (VC-668).
 * A Session router context from the per-behaviour ports it took before the
 * host's handler map, so a client's router test states only the behaviour it
 * needs. Production code never imports it; production builds the map in
 * `@volli/host-core/handlers`.
 */
export {
  sessionContext,
  sessionHandlersFrom,
  type LegacySessionPorts,
} from "./session-handlers.test-support";
