/** Wire aliases only; VC-550 host-identity.md owns allocation, lifetime and storage. */

/** One host install; never moves with a workspace or survives a profile restore/copy (VC-550). */
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

/** UUIDv4 grammar, matching new ids at the Session RPC seam. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** An epoch is a non-negative safe integer: it is compared, never parsed. */
export function isEpoch(value: unknown): value is WorkspaceEpoch {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Legacy id grammar: bounded, nonempty, no surrounding whitespace. */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}
