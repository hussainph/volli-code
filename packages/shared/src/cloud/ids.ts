/**
 * Volli Cloud ids: one scheme, ours, independent of the backend's own row ids.
 *
 * Every cloud entity has an `id` that is a lowercase canonical UUID, minted by
 * whoever originates the entity (a client, a runner, or the backend for facts
 * it originates) and validated by the mutation that writes it. References
 * between tables are these strings. A backend row id never crosses into this
 * package, runner code, object-storage keys or exports.
 *
 * New ids are v4 from `crypto.randomUUID()`, the generator the app already
 * uses, so migrated ids and new ids are indistinguishable. Nothing may depend
 * on id order or on the version nibble, which is why {@link isUuid} checks the
 * canonical shape and not a version.
 *
 * Ids are not secrets: authorization never relies on an id being unguessable.
 */

/** The canonical, lowercase 8-4-4-4-12 hex form. Uppercase is not canonical. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The entities that carry a minted UUID. The brand is a compile-time tag only;
 * at runtime every id is a plain string.
 */
export type IdKind =
  | "workspace"
  | "member"
  | "invite"
  | "user"
  | "project"
  | "projectRepo"
  | "ticket"
  | "label"
  | "comment"
  | "signal"
  | "boardEvent"
  | "session"
  | "transcriptSegment"
  | "runner"
  | "workingCopy"
  | "job"
  | "command"
  | "automation"
  | "export"
  | "migration"
  | "deletionRequest"
  | "auditEntry"
  | "secret"
  | "secretKey";

declare const ID_KIND: unique symbol;

/** A UUID known to name one kind of entity. */
export type Id<K extends IdKind> = string & { readonly [ID_KIND]: K };

export type WorkspaceId = Id<"workspace">;
export type MemberId = Id<"member">;
export type InviteId = Id<"invite">;
export type UserId = Id<"user">;
export type ProjectId = Id<"project">;
export type ProjectRepoId = Id<"projectRepo">;
export type TicketId = Id<"ticket">;
export type LabelId = Id<"label">;
export type CommentId = Id<"comment">;
export type SignalId = Id<"signal">;
export type BoardEventId = Id<"boardEvent">;
export type SessionId = Id<"session">;
export type RunnerId = Id<"runner">;
export type WorkingCopyId = Id<"workingCopy">;
export type JobId = Id<"job">;
export type CommandId = Id<"command">;
export type AutomationId = Id<"automation">;
export type ExportId = Id<"export">;
export type MigrationId = Id<"migration">;
export type DeletionRequestId = Id<"deletionRequest">;
export type AuditEntryId = Id<"auditEntry">;

/** Whether `value` is a lowercase canonical UUID string (any version). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Thrown when a value that must be an id is not one. */
export class InvalidIdError extends Error {
  readonly code = "invalid_id";
  readonly kind: IdKind;
  readonly value: unknown;
  constructor(kind: IdKind, value: unknown) {
    super(`Expected a lowercase UUID for ${kind}, got ${describe(value)}`);
    this.name = "InvalidIdError";
    this.kind = kind;
    this.value = value;
  }
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value.slice(0, 64)) : typeof value;
}

/** `value` as an id of `kind`, or {@link InvalidIdError}. The boundary check every create runs. */
export function parseId<K extends IdKind>(kind: K, value: unknown): Id<K> {
  if (!isUuid(value)) throw new InvalidIdError(kind, value);
  return value as Id<K>;
}

/** `value` as an id of `kind`, or `null` when it is not a canonical UUID. For tolerant reads. */
export function readId<K extends IdKind>(_kind: K, value: unknown): Id<K> | null {
  return isUuid(value) ? (value as Id<K>) : null;
}

/** Mints a new v4 id with the platform's `crypto.randomUUID()`. */
export function newId<K extends IdKind>(_kind: K): Id<K> {
  return globalThis.crypto.randomUUID() as Id<K>;
}

/**
 * Derived ids already shipped (Session event ids, Attention ids, transcript
 * digests, blob hashes, `<op>:create` command ids, `runtime-<kind>:<uuid>`)
 * stay frozen opaque strings. They are never parsed, only compared, and each
 * table that holds one declares its uniqueness scope.
 */
export const MAX_DERIVED_ID_LENGTH = 512;

/** Whether `value` can be stored as a frozen derived id: a non-empty string of at most 512 characters. */
export function isDerivedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DERIVED_ID_LENGTH;
}
