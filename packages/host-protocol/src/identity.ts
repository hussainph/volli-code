/**
 * The identities the protocol carries. This file names them and does not
 * define them: `docs/plans/host-identity.md` (VC-550) owns what each one means,
 * who mints it and when it changes. These aliases exist so a hello, a welcome
 * and an actor can say which identity a field holds. The guards check only the
 * wire grammar that spec fixes (`docs/BOUNDARIES.md` rule 1: a UUID, never
 * anything machine-local).
 */

/** One host install. Changes when a workspace is promoted elsewhere, so a fence has a name to refuse. */
export type HostId = string;
/** The portable unit a host is authoritative for. Today, one project's board. */
export type WorkspaceId = string;
/** The workspace's ownership fence. It only increases, and it is raised on every move. */
export type WorkspaceEpoch = number;
/** One worker process enrolled with a host. */
export type WorkerId = string;
/** One paired client device. */
export type DeviceId = string;
/** A durable Session, as the session ledger names it. */
export type SessionId = string;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_IDENTIFIER_LENGTH = 512;

/**
 * Version 4 specifically, matching `requestedSessionId` in `@volli/session-rpc`.
 * A v1 UUID embeds the minting machine's MAC address, and the nil and max ids
 * name nothing.
 */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** An epoch is a non-negative safe integer: it is compared, never parsed. */
export function isEpoch(value: unknown): value is WorkspaceEpoch {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The identifier grammar `@volli/session-rpc` already enforces at its edge: it
 * must be non-empty and bounded, with no surrounding whitespace. It applies to
 * ids the protocol carries but did not mint, such as a Session id from before
 * VC-358.
 */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}
