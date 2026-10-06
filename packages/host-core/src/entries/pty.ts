/**
 * `@volli/host-core/pty`: the terminal supervisor and its stream contract.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export { type AgentRuntimeEnvironment, type PtyManagerPorts, PtyManager } from "../pty/manager";
export type { ParkConfig, ProcessInspector } from "../pty/park";
