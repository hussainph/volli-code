/**
 * The v1 feature names and the exact operations each one grants (HP §
 * Handshake and capabilities). Data, so a host can enforce it, a test can
 * snapshot it, and VC-669 can generalize it without re-deriving anything.
 *
 * A feature's operation set is FIXED once it ships: it never widens and
 * never narrows. A new command joins a new feature name, never an old one,
 * so a client that was granted `session.read` knows exactly what it may call.
 *
 * Every operation is a command catalog key (a router procedure path).
 * `@volli/session-rpc` checks at test time that each one is a `hostApi`
 * entry and that no key sits in two features.
 */
import type { HostFeature } from "./handshake";

/** Answered on every authenticated connection, whatever it negotiated: v1's bootstrap. */
export const HOST_BASE_OPERATIONS = ["protocol.welcome"] as const;

export const HOST_FEATURE_OPERATIONS = {
  /** The Session router's own commands and reads, by Session id (VC-663). */
  sessions: [
    "sessions.create",
    "sessions.attach",
    "session.snapshot",
    "session.projection",
    "session.command",
    "session.cancelInteraction",
    "session.reconcile",
  ],
  /** Following one Session's stream, resuming after a cursor (VC-663). */
  "sessions.subscribe": ["session.subscribe"],
  /**
   * Paging a Session's transcript above its snapshot's window (VC-315). A
   * snapshot is a bounded window, so a Client that cannot page reads only
   * the newest part of a Session: one granted this knows the history above
   * it is there to read. Its own name because `sessions` is frozen (VC-669).
   */
  "sessions.history": ["session.history"],
  /** The socket's Session reads, scoped to the connection's Workspace (VC-663, D4). */
  "session.read": ["session.list", "session.show", "session.peek", "session.answer"],
  /**
   * The host's Model Access catalog and preferences (VC-663), as the Session
   * router declares them today (D3). VC-572 refines their policy; anything it
   * adds takes a new name.
   */
  "model-access": [
    "modelAccess.inspect",
    "modelAccess.defaults",
    "modelAccess.setDefault",
    "modelAccess.hiddenModels",
    "modelAccess.setHiddenModels",
    "modelAccess.compactionPolicy",
    "modelAccess.setCompactionPolicy",
    "modelAccess.codeModePolicy",
    "modelAccess.setCodeModePolicy",
    "modelAccess.pickerView",
    "modelAccess.setPickerView",
  ],
} as const satisfies Readonly<Record<HostFeature, readonly string[]>>;

/** A feature this build can grant. */
export type HostV1Feature = keyof typeof HOST_FEATURE_OPERATIONS;

/** Every operation some v1 feature grants, or the base set. */
export type HostOperation =
  | (typeof HOST_BASE_OPERATIONS)[number]
  | (typeof HOST_FEATURE_OPERATIONS)[HostV1Feature][number];

/** The v1 feature names, in the order a host offers them. */
export const HOST_V1_FEATURES = Object.keys(HOST_FEATURE_OPERATIONS) as readonly HostV1Feature[];

/**
 * The operations a connection may reach: the base set plus every operation of
 * each granted feature. A name this build does not know grants nothing.
 */
export function operationsGrantedBy(features: readonly HostFeature[]): ReadonlySet<string> {
  const granted = new Set<string>(HOST_BASE_OPERATIONS);
  for (const feature of features) {
    if (!Object.hasOwn(HOST_FEATURE_OPERATIONS, feature)) continue;
    for (const operation of HOST_FEATURE_OPERATIONS[feature as HostV1Feature]) {
      granted.add(operation);
    }
  }
  return granted;
}
