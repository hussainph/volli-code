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
 * try again or restart) and **reset**, which moves the sealed file aside with
 * {@link archiveSealedStore} and starts an empty store. The archive is kept,
 * beside the store and excluded from backups by the store's own `*` rule,
 * until a person deletes it.
 *
 * A status carries no secret, no key byte and no path: it is safe to write to
 * a status file or hand to a client. The refusal's own sentence, which names
 * the key file's path and the fix, goes to the operator's log instead.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isSecretKeyUnavailable, type SecretKeyRefusal } from "../ports/secret-key";

export type CredentialState = "ready" | "empty" | "locked" | "refused" | "corrupt";

/** The kinds of credential a host keeps sealed under its key. */
export type CredentialKind = "session-env";

/**
 * Why credentials are `locked` or `refused`: the key's refusal, or
 * `store-unreadable` when the sealed file itself cannot be opened for reading.
 */
export type CredentialReason = SecretKeyRefusal | "store-unreadable";

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

/** The status a failure to open sealed credentials leaves. */
export function credentialStatusFor(error: unknown): CredentialStatus {
  if (isSecretKeyUnavailable(error)) {
    return {
      state: UNSAFE.has(error.reason) ? "refused" : "locked",
      reason: error.reason,
      unavailable: SEALED_CREDENTIAL_KINDS,
    };
  }
  if (error instanceof SealedStoreUnreadableError) {
    return { state: "locked", reason: "store-unreadable", unavailable: SEALED_CREDENTIAL_KINDS };
  }
  return { state: "corrupt", reason: null, unavailable: SEALED_CREDENTIAL_KINDS };
}

/** Whether a status leaves stored credentials unusable until unlock or reset. */
export function credentialsUnavailable(status: CredentialStatus): boolean {
  return status.state !== "ready" && status.state !== "empty";
}

/**
 * Moves the sealed file at `path` aside, never over anything: it is linked
 * to a fresh `<name>.locked-<time>-<random>` beside it, then its old name is
 * removed, and the directory is synced. Answers the archive's file name, or
 * `null` when nothing was at `path`.
 */
export function archiveSealedStore(path: string, now: Date): string | null {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const name = `${basename(path)}.locked-${stamp}-${randomBytes(4).toString("hex")}`;
  const archive = join(dirname(path), name);
  try {
    // `link` never replaces: a name that exists fails rather than losing it.
    linkSync(path, archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  unlinkSync(path);
  try {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Some filesystems cannot sync a directory; the move itself has happened.
  }
  return name;
}
