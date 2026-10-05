/**
 * Credential status: what a host can say about its sealed secrets without
 * opening them (VC-641; `docs/plans/sealed-credential-store.md` §7).
 *
 * Losing or damaging the key never stops a host. The store settles one of
 * these states the first time it is asked, and every credential consumer
 * reads around a state that is not `ready`: no stored value is injected,
 * listed or used, and everything else (the board, Sessions that need no
 * stored secret, Session-scoped secrets held in memory) keeps working.
 *
 * | state     | when                                                        | saves    |
 * | --------- | ----------------------------------------------------------- | -------- |
 * | `ready`   | the sealed file opened with its key                         | allowed  |
 * | `empty`   | no sealed file exists (first run, or after a reset)         | allowed  |
 * | `locked`  | the key is missing, wrong, malformed, unreadable, sealed by | refused  |
 * |           | another adapter, or the keychain will not open it; or the   |          |
 * |           | sealed file itself cannot be read                           |          |
 * | `refused` | the key file is unsafe: other users may read it, another    | refused  |
 * |           | user owns it, it is not a regular file, or its configured   |          |
 * |           | path is relative. It is never read for use                  |          |
 * | `corrupt` | the key opened, and the sealed file is not a valid store    | refused  |
 *
 * `locked`, `refused` and `corrupt` leave the sealed file byte-identical: no
 * plaintext, no default key, and no fresh key sealed over what exists. Only
 * this scope's material is gated: today that is the persistent Session
 * secrets (`session-env`). Model sign-ins, web search keys and MCP
 * credentials do not live under this key yet and are unaffected; the typed
 * store (VC-631) adds kinds here as each one moves in.
 *
 * Two explicit ways out, both person or local-admin intent, never an agent
 * verb: **unlock** (put the key back, unlock the keychain, fix the mode, then
 * try again or restart) and, for `locked` or `corrupt` only, **reset**, which
 * moves the sealed file aside with {@link archiveSealedStore} and starts an
 * empty store. A `refused` key configuration is fixed, not reset: the store
 * it refuses may be perfectly good. The archive is kept, beside the store and
 * excluded from backups by the store's own `*` rule, until a person deletes it.
 *
 * A status carries no secret, no key byte and no path: it is safe to write to
 * a status file or hand to a client. The refusal's own sentence, which names
 * the key file's path and the fix, goes to the operator's log instead.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isSecretKeyUnavailable, type SecretKeyRefusal } from "../ports/secret-key";
import type { CredentialFamily } from "./credential-families";

export type CredentialState = "ready" | "empty" | "locked" | "refused" | "corrupt";

/**
 * The kinds of credential a host keeps sealed under its key: the typed
 * inventory's families (`credential-families.ts`). The legacy Session store
 * gates `session-env` alone.
 */
export type CredentialKind = CredentialFamily;

/**
 * Why credentials are `locked` or `refused`: the key's refusal,
 * `store-unreadable` when the sealed file itself cannot be opened for reading,
 * or `newer-format` when it opened and a newer Volli wrote it (VC-642): this
 * build leaves it alone rather than rewrite a schema it does not know.
 */
export type CredentialReason =
  | SecretKeyRefusal
  | "store-unreadable"
  | "newer-format"
  /**
   * Another Volli process held the credential lock at that instant (VC-642).
   * Transient: reported for that one read, never remembered, never reset.
   */
  | "busy"
  /**
   * The credential lock file cannot be used: a symlink, not a regular file,
   * another user's, or not lockable (VC-642). The store it guards may be
   * perfectly good, so it is fixed (moved aside), never reset.
   */
  | "lock-unusable";

export interface CredentialStatus {
  readonly state: CredentialState;
  /** Why credentials are `locked` or `refused`; `null` otherwise. */
  readonly reason: CredentialReason | null;
  /** What this state makes unavailable. Empty when `ready` or `empty`. */
  readonly unavailable: readonly CredentialKind[];
}

/** Every kind sealed under the key today. */
export const SEALED_CREDENTIAL_KINDS: readonly CredentialKind[] = ["session-env"];

/** Unsafe, never lost: the operator fixes the file, and nothing is re-entered. */
const UNSAFE: ReadonlySet<SecretKeyRefusal> = new Set<SecretKeyRefusal>([
  "too-open",
  "wrong-owner",
  "not-a-file",
  "relative-path",
]);

export const CREDENTIALS_READY: CredentialStatus = {
  state: "ready",
  reason: null,
  unavailable: [],
};
export const CREDENTIALS_EMPTY: CredentialStatus = {
  state: "empty",
  reason: null,
  unavailable: [],
};

/** Thrown by the store when the sealed file itself could not be opened for reading. */
export class SealedStoreUnreadableError extends Error {
  constructor() {
    super("Could not read secret storage.");
    this.name = "SealedStoreUnreadableError";
  }
}

/**
 * The credential lock file cannot be used (VC-642). The message names the
 * file and the fix, for an operator's log; the status carries only the
 * reason.
 */
export class CredentialLockUnusableError extends Error {
  readonly code = "credential-lock-unusable";
  constructor(message: string) {
    super(message);
    this.name = "CredentialLockUnusableError";
  }
}

/** A read that found another process holding the lock: unavailable for now, not remembered. */
export function credentialsBusy(
  kinds: readonly CredentialKind[] = SEALED_CREDENTIAL_KINDS,
): CredentialStatus {
  return { state: "locked", reason: "busy", unavailable: kinds };
}

/**
 * Whether a person may reset (set aside) stored credentials in this status:
 * only when the key or the sealed file itself is the problem. Never for a
 * `refused` key configuration, a busy lock or an unusable lock file, where the
 * store may be perfectly good.
 */
export function credentialsResettable(status: CredentialStatus): boolean {
  return (
    credentialsUnavailable(status) &&
    status.state !== "refused" &&
    status.reason !== "busy" &&
    status.reason !== "lock-unusable"
  );
}

/** Thrown when a sealed store opened and a newer Volli's schema is inside. */
export class SealedStoreNewerError extends Error {
  constructor() {
    super("Saved credentials were written by a newer Volli. Update Volli to use them.");
    this.name = "SealedStoreNewerError";
  }
}

/**
 * The status a failure to open sealed credentials leaves. `kinds` are the
 * ones that store gates; the legacy Session store's by default.
 */
export function credentialStatusFor(
  error: unknown,
  kinds: readonly CredentialKind[] = SEALED_CREDENTIAL_KINDS,
): CredentialStatus {
  if (isSecretKeyUnavailable(error)) {
    return {
      state: UNSAFE.has(error.reason) ? "refused" : "locked",
      reason: error.reason,
      unavailable: kinds,
    };
  }
  if (error instanceof SealedStoreUnreadableError) {
    return { state: "locked", reason: "store-unreadable", unavailable: kinds };
  }
  if (error instanceof CredentialLockUnusableError) {
    return { state: "locked", reason: "lock-unusable", unavailable: kinds };
  }
  if (error instanceof SealedStoreNewerError) {
    return { state: "locked", reason: "newer-format", unavailable: kinds };
  }
  return { state: "corrupt", reason: null, unavailable: kinds };
}

/** Whether a status leaves stored credentials unusable until unlock or reset. */
export function credentialsUnavailable(status: CredentialStatus): boolean {
  return status.state !== "ready" && status.state !== "empty";
}

/** What {@link archiveSealedStore} did. */
export interface SealedStoreArchive {
  /** The archive's file name beside the store. */
  readonly name: string;
  /**
   * Whether every directory sync succeeded. `false` means the move happened
   * but a power cut could still undo part of it: report it, never hide it.
   */
  readonly synced: boolean;
}

/**
 * Moves the sealed file at `path` aside. It never overwrites, never deletes,
 * and a crash at any point leaves the bytes under at least one name:
 *
 * 1. link the file to a fresh `<name>.locked-<time>-<random>` beside it
 *    (`link` fails rather than replace an existing name);
 * 2. sync the directory, so the new name is durable before the old one goes;
 * 3. remove the old name, and sync the directory again.
 *
 * Not atomic: a crash between 1 and 3 leaves both names, which is the safe
 * side. A directory that cannot be synced does not stop the move; it is
 * reported through {@link SealedStoreArchive.synced}. Answers `null` when
 * nothing was at `path`.
 */
export function archiveSealedStore(path: string, now: Date): SealedStoreArchive | null {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const name = `${basename(path)}.locked-${stamp}-${randomBytes(4).toString("hex")}`;
  const directory = dirname(path);
  try {
    linkSync(path, join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const linked = syncDirectory(directory);
  unlinkSync(path);
  const removed = syncDirectory(directory);
  return { name, synced: linked && removed };
}

/** Whether `directory` synced. Some filesystems cannot; the caller reports it. */
function syncDirectory(directory: string): boolean {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
