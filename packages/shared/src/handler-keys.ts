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
import { DESKTOP_ENTRIES, type DesktopKey } from "./desktop-entries";
import type { TicketEventActor } from "./ticket-events";
import {
  AGENT_COMMAND_BINDINGS,
  CATALOG_ENTRIES,
  type AgentCommandBindingId,
  type CatalogKey,
  type CatalogKeyOf,
  type VerbEntry,
  type VerbKey,
} from "./verb-registry";

/**
 * Catalog keys the projection answers itself, so no host handler exists for
 * them: the Session router's own route diagnostics, recorded by the router
 * that serves them and read by the in-process lab (projected onto no network
 * door), and `protocol.welcome`, the WebSocket handshake's own answer: the
 * welcome the door negotiated for this connection, which no host handler
 * could know (VC-663). They are policed like any entry.
 */
export const DOOR_LOCAL_CATALOG_KEYS = Object.freeze([
  "labDiagnostics.list",
  "labDiagnostics.subscribe",
  "protocol.welcome",
  "protocol.hostWelcome",
] as const satisfies readonly CatalogKey[]);

export type DoorLocalCatalogKey = (typeof DOOR_LOCAL_CATALOG_KEYS)[number];

/** Public wire aliases that project existing handlers rather than adding domain commands.
 * VC-729 keeps the frozen model-access feature unchanged; hostModels uses
 * the same Model Access commands under host-connection-only admission.
 */
export const HANDLER_PROJECTION_KEYS = Object.freeze([
  "hostModels.inspect",
  "hostModels.defaults",
  "hostModels.setDefault",
  "hostModels.hiddenModels",
  "hostModels.setHiddenModels",
  "hostModels.compactionPolicy",
  "hostModels.setCompactionPolicy",
  "hostModels.codeModePolicy",
  "hostModels.setCodeModePolicy",
  "hostModels.pickerView",
  "hostModels.setPickerView",
] as const satisfies readonly CatalogKey[]);

export type HandlerProjectionKey = (typeof HANDLER_PROJECTION_KEYS)[number];

/** The public tier's domain handler keys: no door-local answers or wire aliases. */
export type PublicHandlerKey = Exclude<CatalogKey, DoorLocalCatalogKey | HandlerProjectionKey>;

/**
 * The keys the catalog's doors serve (D-A1 = (c) hybrid): the public
 * catalog's domain handler keys (wire aliases reuse these) and the
 * desktop-only tier's (`DESKTOP_ENTRIES`, VC-608), together. A router, the
 * WebSocket and the desktop window's legacy channels reach these and nothing
 * else; promoting a desktop entry to the public tier keeps its key, and so its
 * handler.
 */
export type CatalogHandlerKey = PublicHandlerKey | DesktopKey;

/**
 * The socket's ticket writes whose command is a board handler under the
 * board's own key (VC-794): the CLI keeps its verbs and their wire shape, and
 * the write, its receipt, its wakes and its feed rows are the handler's, as
 * they are for the person's own edit. One compound update, not three calls:
 * `board.updateTicket` takes the priority, labels and body mutation too, so
 * `volli ticket update` stays one transaction.
 */
export const SOCKET_BOARD_PROJECTIONS = Object.freeze({
  "ticket.create": "board.createTicket",
  "ticket.update": "board.updateTicket",
  "ticket.comment": "board.createComment",
} as const satisfies Partial<Record<AgentCommandBindingId, CatalogKey>>);

/** {@link SOCKET_BOARD_PROJECTIONS}, as a type: socket verb to the board key it projects. */
export type SocketBoardProjections = typeof SOCKET_BOARD_PROJECTIONS;

/**
 * The agent doors' own keys (VC-923): every socket verb that is neither a
 * catalog command nor a ticket write projected onto a board key. They are
 * entries of the same one map as the catalog's, reached only through it and
 * only under a door's policy, so the socket's verb table is a table of
 * projections like every other door's. No catalog door reaches them: their
 * entries have no catalog declaration, so the catalog's policies refuse them.
 *
 * Their handlers are the agent socket's own verbs, whose ports (the
 * Session Engine, the attachments, the host's environment facts) are the
 * agent command service's composition: that service serves them into the map
 * it was handed (`serveHostHandlers`), and until it does they answer
 * unavailable.
 */
export type AgentHandlerKey = Exclude<
  AgentCommandBindingId,
  CatalogKey | DesktopKey | keyof SocketBoardProjections
>;

/**
 * Every key the host's ONE handler map answers: the catalog's
 * ({@link CatalogHandlerKey}) and the agent doors' ({@link AgentHandlerKey}),
 * together. The map is total over all of them, so a key with no handler fails
 * `pnpm typecheck`.
 */
export type HostHandlerKey = CatalogHandlerKey | AgentHandlerKey;

type AssertNever<Type extends never> = Type;

/** No desktop-only key is a Verb Registry key: one key, one tier. */
export type DesktopKeysDisjoint = AssertNever<Extract<DesktopKey, VerbKey>>;

/** The handler keys among some entries: what one router family projects from the map. */
export type HostHandlerKeyOf<E extends VerbEntry> = Exclude<
  CatalogKeyOf<E>,
  DoorLocalCatalogKey | HandlerProjectionKey
>;

/**
 * Both-door keys whose map entry runs the socket verb's own handler, rather
 * than the other way round: the socket's Session reads, which the WebSocket
 * serves Workspace-scoped (VC-663, D4). Their map entry reaches the socket's
 * pipeline (`AgentCommandService.executeInWorkspace`) under the router's
 * policy, so both doors still reach one function, and the socket binding
 * stays the verb's own (a projection of the map would call itself). The list
 * can only shrink: an area that moves a read's logic into host-core makes its
 * socket verb a projection and strikes it here.
 */
export const SOCKET_DELEGATED_HANDLER_KEYS = Object.freeze([
  "session.list",
  "session.show",
  "session.peek",
  "session.answer",
] as const satisfies readonly CatalogKey[]);

export type SocketDelegatedHandlerKey = (typeof SOCKET_DELEGATED_HANDLER_KEYS)[number];

/**
 * The handler keys the agent socket serves under its own verb's name: a
 * both-door catalog command's, and every {@link AgentHandlerKey}. Its
 * `AGENT_VERB_TABLE` binding for each must be a projection of the map, never a
 * handler of its own. The socket's ticket writes that project a board key under
 * another name are {@link SocketBoardProjections} (VC-794).
 */
export type SocketHandlerKey = Exclude<
  Extract<HostHandlerKey, AgentCommandBindingId>,
  SocketDelegatedHandlerKey
>;

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
  /**
   * The connection that asked (HP § The Client is a connection, F2), set by a
   * network door and absent on the desktop's in-process IPC. A handler whose
   * state belongs to the asking connection (a sign-in flow, VC-702) keys it
   * by this, never by anything in its input.
   */
  readonly connection?: HandlerConnection;
}

/** One network connection, as a handler may see it: never its credential. */
export interface HandlerConnection {
  /** Random, per connection: what owns per-connection state. */
  readonly id: string;
  /** Aborts, never to be restored, when the connection's admission ends. */
  readonly closed: AbortSignal;
  /** The features its welcome granted, client capabilities included. */
  readonly features: readonly string[];
}

/** One entry of the host's handler map: the whole command, whichever door called. */
export type HostHandler<Input, Output> = (
  input: Input,
  call: HandlerCall,
) => Output | Promise<Output>;

const projected: ReadonlySet<string> = new Set([
  ...DOOR_LOCAL_CATALOG_KEYS,
  ...HANDLER_PROJECTION_KEYS,
]);

/** {@link PublicHandlerKey}, at runtime, in declaration order. */
export const PUBLIC_HANDLER_KEYS: readonly PublicHandlerKey[] = Object.freeze(
  CATALOG_ENTRIES.map((entry) => entry.key).filter(
    (key) => !projected.has(key),
  ) as PublicHandlerKey[],
);

/** {@link DesktopKey}, at runtime, in declaration order. */
export const DESKTOP_HANDLER_KEYS: readonly DesktopKey[] = Object.freeze(
  DESKTOP_ENTRIES.map((entry) => entry.key),
);

/** {@link CatalogHandlerKey}, at runtime: the public tier's keys, then the desktop tier's. */
export const CATALOG_HANDLER_KEYS: readonly CatalogHandlerKey[] = Object.freeze([
  ...PUBLIC_HANDLER_KEYS,
  ...DESKTOP_HANDLER_KEYS,
]);

const catalogued: ReadonlySet<string> = new Set([
  ...CATALOG_ENTRIES.map((entry) => entry.key),
  ...DESKTOP_HANDLER_KEYS,
  ...Object.keys(SOCKET_BOARD_PROJECTIONS),
]);

/** {@link AgentHandlerKey}, at runtime, in the Verb Registry's declaration order. */
export const AGENT_HANDLER_KEYS: readonly AgentHandlerKey[] = Object.freeze(
  [...new Set(Object.values(AGENT_COMMAND_BINDINGS))].filter(
    (key) => !catalogued.has(key),
  ) as AgentHandlerKey[],
);

/** {@link HostHandlerKey}, at runtime: the catalog's keys, then the agent doors'. */
export const HOST_HANDLER_KEYS: readonly HostHandlerKey[] = Object.freeze([
  ...CATALOG_HANDLER_KEYS,
  ...AGENT_HANDLER_KEYS,
]);
