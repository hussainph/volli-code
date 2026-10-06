/**
 * Which catalog keys the host's handler map answers (VC-668; HP § Command
 * catalog, "One handler map").
 *
 * The map itself lives in `@volli/host-core/handlers`: a total mapping from
 * {@link HostHandlerKey} to the one function every door's projection calls.
 * The key sets live here, beside the registry they are derived from, because
 * each projection checks itself against them and the router package cannot
 * import host-core (D2).
 */
import type { TicketEventActor } from "./ticket-events";
import {
  CATALOG_ENTRIES,
  type AgentCommandBindingId,
  type CatalogKey,
  type CatalogKeyOf,
  type VerbEntry,
} from "./verb-registry";

/**
 * Catalog keys the projection answers itself, so no host handler exists for
 * them: the Session router's own route diagnostics, recorded by the router
 * that serves them and read by the in-process lab. They are policed like any
 * entry and projected onto no network door. The list can only shrink.
 */
export const DOOR_LOCAL_CATALOG_KEYS = Object.freeze([
  "labDiagnostics.list",
  "labDiagnostics.subscribe",
] as const satisfies readonly CatalogKey[]);

export type DoorLocalCatalogKey = (typeof DOOR_LOCAL_CATALOG_KEYS)[number];

/** Every key the host's handler map answers: the catalog, less what a door answers itself. */
export type HostHandlerKey = Exclude<CatalogKey, DoorLocalCatalogKey>;

/** The handler keys among some entries: what one router family projects from the map. */
export type HostHandlerKeyOf<E extends VerbEntry> = Exclude<CatalogKeyOf<E>, DoorLocalCatalogKey>;

/**
 * The handler keys the agent socket also serves: its `AGENT_VERB_TABLE`
 * binding for each must be a projection of the map, never a handler of its
 * own. A both-door entry's socket binding id is its key.
 */
export type SocketHandlerKey = Extract<HostHandlerKey, AgentCommandBindingId>;

/**
 * What a door tells a handler about the call, besides its input: who it
 * authenticated, as host history attributes them. A door never passes a
 * port, a clock or an effect; the handler owns those.
 */
export interface HandlerCall {
  readonly actor: TicketEventActor;
  /**
   * Set only by the desktop's own window, which receives a command's
   * committed board in its reply: a board change is then not echoed back to
   * it over the change feed, exactly as before the map. Every other caller's
   * change is published. VC-565's `commandId` reconciliation retires it.
   */
  readonly origin?: "desktop-window";
}

/** One entry of the host's handler map: the whole command, whichever door called. */
export type HostHandler<Input, Output> = (
  input: Input,
  call: HandlerCall,
) => Output | Promise<Output>;

const doorLocal: readonly string[] = DOOR_LOCAL_CATALOG_KEYS;

/** {@link HostHandlerKey}, at runtime, in declaration order. */
export const HOST_HANDLER_KEYS: readonly HostHandlerKey[] = Object.freeze(
  CATALOG_ENTRIES.map((entry) => entry.key).filter(
    (key) => !doorLocal.includes(key),
  ) as HostHandlerKey[],
);
