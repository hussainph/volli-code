/**
 * Step E for the web search keys (VC-643; `docs/plans/sealed-credential-store.md`
 * §4, "E — expand, compatible with the legacy writer"): a sealed mirror of
 * the `secrets` table, kept reconciled from it.
 *
 * **`secrets` stays the one source of truth.** Every read still comes from
 * SQLite ({@link WebCredentialStore}); nothing here is ever read back into it
 * or handed to a provider. The sealed copy exists so the read switch (VC-644)
 * can start from a verified inventory. An older build that knows nothing of
 * this keeps saving and clearing keys in `secrets`, and migration 059's
 * triggers count every one of those changes in `web_credential_source`.
 *
 * **Reconcile, never merge.** {@link WebCredentialMirror.reconcile}, under the
 * credential lock, reads every web key row and the source revision in one
 * short synchronous SQLite read, then makes the inventory's `web-search`
 * family an exact copy: rows that are gone are dropped from it, so a stale
 * mirror can never bring back a key someone cleared, here, in an older build,
 * or by restoring a backup (which never carries keys). The file is fsynced,
 * read back, opened and compared before the receipt (source lineage and
 * revision, inventory id and generation) is written to `web_credential_mirror`.
 * It runs on every launch and after every save or clear.
 *
 * **SQLite first, then the seal.** A save or clear commits to `secrets`
 * first; sealing follows. SQL cannot dual-write an encrypted file, so these
 * are two ordered commits with SQLite canonical, not one atomic write. When
 * the seal fails the save still happened: it is reported as "saved; sealing
 * pending", never as a failed save and never as sealed.
 *
 * **Boot never waits and never fails here.** One synchronous attempt at the
 * lock; {@link WebCredentialMirror.reconcileSoon} retries asynchronously while
 * another process holds it. A locked, refused or corrupt inventory (VC-641),
 * a busy lock, a full disk or a failed sync leaves sealing pending and the
 * source untouched. Nothing here deletes a source row or a sealed file, and
 * nothing here logs a value: outcomes are counts, states and reason codes.
 *
 * **The keychain, only asynchronously, and only when it may be asked.** A
 * keyring whose key is fetched asynchronously (desktop's keychain) answers
 * `key-pending` under the lock until it has been unlocked; the lock is never
 * held across that fetch. {@link WebCredentialMirror.reconcileSoon} unlocks
 * it, then tries again: always for a person's save or clear, and for the
 * unattended launch reconcile only when the host says the keychain was
 * already used this launch (`mayUnlockUnattended`). Otherwise the mirror stays
 * pending until a person saves or clears a key: no new unattended keychain
 * access. Safe in step E, where nothing reads the mirror.
 *
 * **Stopped at quit.** {@link WebCredentialMirror.stop} ends it for good: a
 * busy retry's pause is cancelled, a key fetch in flight is abandoned (not
 * awaited, and nothing it fetches is kept), and nothing starts afterwards.
 */
import type Database from "better-sqlite3";

import type { WebKeySealing } from "@volli/shared";

import { prepared } from "@volli/host-core/db/prepared";
import {
  CredentialKeyPendingError,
  CredentialLockBusyError,
  credentialStatusFor,
  isSealedOpenFailure,
  SealedFileChangedError,
  SealedFileIndeterminateError,
  SealedFileUnverifiedError,
  type CredentialKeyring,
  type MirrorEntry,
  type MirrorSnapshot,
  type SealedInventory,
} from "@volli/host-core/secrets";

import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET } from "./credential";

/** Which `secrets` row holds which provider's key: the inventory selector for each. */
export const WEB_KEY_SECRETS: Readonly<Record<string, string>> = {
  [BRAVE_SEARCH_KEY_SECRET]: "brave",
  [EXA_SEARCH_KEY_SECRET]: "exa",
};

/**
 * Why sealing is pending, for a log line. A code, never a value or a path:
 *
 * - `no-keyring`: this host has no key backend for the inventory.
 * - `no-source`: the database has no source revision row (not migrated).
 * - `busy`: another Volli process held the credential lock.
 * - `key-pending`: the keychain's key has not been fetched this launch, and
 *   this run may not fetch it (an unattended launch reconcile, before the
 *   keychain was used this launch); the next save or clear does.
 * - `moved`: a copy was sealed and verified, but the source changed while it
 *   was (`revision` is the one sealed); the next reconcile catches up.
 * - `stopped`: the app is quitting; nothing was started.
 * - `locked` / `refused` / `corrupt`: the inventory's credential status (VC-641),
 *   with its reason beside it.
 * - `changed`: the sealed file changed outside the lock; nothing was written.
 * - `indeterminate`: written, but the directory could not be synced.
 * - `unverified`: written, but it did not read back as written.
 * - `failed`: anything else (a full disk, a failed write, a SQLite error).
 */
export type WebSealingPendingReason =
  | "no-keyring"
  | "no-source"
  | "busy"
  | "key-pending"
  | "moved"
  | "stopped"
  | "locked"
  | "refused"
  | "corrupt"
  | "changed"
  | "indeterminate"
  | "unverified"
  | "failed";

/** What one reconciliation found or did. Counts and codes only. */
export type WebMirrorResult =
  | {
      readonly sealing: "sealed" | "none";
      /** Whether a new sealed file was written this time. */
      readonly written: boolean;
      /** How many keys the mirror holds: the source's count. */
      readonly keys: number;
      readonly revision: number;
    }
  | {
      readonly sealing: "pending";
      readonly reason: WebSealingPendingReason;
      /** The credential status reason, for `locked` and `refused`. */
      readonly detail?: string | null;
      /** For `moved`: the source revision the sealed copy holds. */
      readonly revision?: number;
    };

export interface WebCredentialMirrorOptions {
  db: Database.Database;
  /**
   * The host's typed inventory, or `null` when it has no key backend for one:
   * sealing then stays pending and the keys stay in legacy mode.
   */
  inventory: SealedInventory | null;
  /**
   * The inventory's keyring, when its key is fetched asynchronously
   * ({@link CredentialKeyring.unlock}): {@link WebCredentialMirror.reconcileSoon}
   * fetches it, never under the lock.
   */
  keyring?: CredentialKeyring | null;
  /**
   * Whether an unattended reconcile (the launch one) may fetch the key: on
   * desktop, only once this launch has already used the keychain. Absent:
   * never; a person's save or clear always may.
   */
  mayUnlockUnattended?: () => boolean;
  /** Told every result, for a log line. Never given a value. */
  onResult?: (result: WebMirrorResult) => void;
}

/** What starts a {@link WebCredentialMirror.reconcileSoon}. */
export interface WebReconcileOptions {
  /**
   * A person's save or clear, which may ask the keychain. Otherwise
   * unattended (the launch reconcile), which asks it only when
   * `mayUnlockUnattended` says so.
   */
  readonly person?: boolean;
  /** How long a busy lock is retried. */
  readonly timeoutMs?: number;
}

/** How long {@link WebCredentialMirror.reconcileSoon} retries a busy lock. */
export const WEB_MIRROR_RETRY_MS = 10_000;
/** The pauses between busy retries, as `retryWhileBusy` takes them. */
const RETRY_PAUSES_MS = [5, 10, 25, 50, 100];
/** Key fetches per run: one, and one more for a key another process wrote meanwhile. */
const MAX_UNLOCKS = 2;
const STOPPED: WebMirrorResult = { sealing: "pending", reason: "stopped" };

interface SourceRow {
  source_id: string;
  revision: number;
}

interface MirrorRow {
  source_id: string;
  source_revision: number;
}

export class WebCredentialMirror {
  readonly #db: Database.Database;
  readonly #inventory: SealedInventory | null;
  readonly #keyring: CredentialKeyring | null;
  readonly #mayUnlockUnattended: () => boolean;
  readonly #onResult: (result: WebMirrorResult) => void;
  readonly #stop = new AbortController();
  #running: Promise<WebMirrorResult> | null = null;
  /** Another run is owed after this one; `person` when any caller was one. */
  #again: { person: boolean; timeoutMs: number } | null = null;

  constructor(options: WebCredentialMirrorOptions) {
    this.#db = options.db;
    this.#inventory = options.inventory;
    this.#keyring = options.keyring ?? null;
    this.#mayUnlockUnattended = options.mayUnlockUnattended ?? (() => false);
    this.#onResult = options.onResult ?? (() => {});
  }

  /**
   * Makes the sealed mirror an exact copy of `secrets` now, or says why it is
   * pending. One attempt at the lock, and never the keychain: never waits,
   * never throws.
   */
  reconcile(): WebMirrorResult {
    const result = this.#stop.signal.aborted ? STOPPED : this.#attempt();
    this.#tell(result);
    return result;
  }

  /**
   * {@link reconcile}, retried asynchronously while another process holds the
   * lock (never holding it across a pause), and after fetching a key the
   * keyring has not fetched yet when this run may (see
   * {@link WebReconcileOptions.person}). Calls that arrive while one runs
   * share one more run after it, so the last caller's commit is always read.
   * Never rejects; after {@link stop}, settles `stopped` at once.
   */
  reconcileSoon(options: WebReconcileOptions = {}): Promise<WebMirrorResult> {
    const timeoutMs = options.timeoutMs ?? WEB_MIRROR_RETRY_MS;
    const person = options.person === true;
    if (this.#running !== null) {
      this.#again = { person: person || this.#again?.person === true, timeoutMs };
      return this.#running;
    }
    const run = async (): Promise<WebMirrorResult> => {
      let next: { person: boolean; timeoutMs: number } | null = { person, timeoutMs };
      let result: WebMirrorResult = STOPPED;
      while (next !== null) {
        this.#again = null;
        result = await this.#run(next.person, next.timeoutMs);
        this.#tell(result);
        next = this.#stop.signal.aborted ? null : this.#again;
      }
      return result;
    };
    const running = run().finally(() => {
      this.#running = null;
      this.#again = null;
    });
    this.#running = running;
    return running;
  }

  /**
   * Ends sealing for this launch (an accepted quit): a busy retry's pause is
   * cancelled, a key fetch in flight is abandoned rather than awaited, and no
   * reconcile, lock attempt or keychain call starts afterwards. A run in
   * flight settles `stopped`. SQLite saves are not this mirror's to stop.
   */
  stop(): void {
    this.#stop.abort();
  }

  /** One run: attempts, busy pauses and key fetches, until an answer or the deadline. */
  async #run(person: boolean, timeoutMs: number): Promise<WebMirrorResult> {
    const signal = this.#stop.signal;
    const deadline = Date.now() + timeoutMs;
    let unlocks = 0;
    for (let tries = 0; ; tries += 1) {
      if (signal.aborted) return STOPPED;
      const result = this.#attempt();
      if (result.sealing !== "pending") return result;
      if (result.reason === "key-pending") {
        const unlock = this.#keyring?.unlock;
        if (
          unlock === undefined ||
          unlocks >= MAX_UNLOCKS ||
          (!person && !this.#mayUnlockUnattended())
        ) {
          return result;
        }
        unlocks += 1;
        await untilAborted(unlock.call(this.#keyring, { signal }), signal);
        continue;
      }
      if (result.reason !== "busy" && result.reason !== "moved") return result;
      const pause = Math.min(
        RETRY_PAUSES_MS[Math.min(tries, RETRY_PAUSES_MS.length - 1)]!,
        deadline - Date.now(),
      );
      if (pause <= 0) return result;
      await pauseUnlessAborted(pause, signal);
    }
  }

  /**
   * What SQLite says about the mirror, without opening it (so without the
   * keychain): `sealed` or `none` when the last verified receipt is for the
   * source as it is now, `pending` otherwise.
   */
  sealing(): WebKeySealing {
    try {
      return this.#read(() => {
        const source = this.#source();
        const receipt = prepared<[], MirrorRow>(
          this.#db,
          "SELECT source_id, source_revision FROM web_credential_mirror WHERE id = 1",
        ).get();
        const current =
          source !== undefined &&
          receipt !== undefined &&
          receipt.source_id === source.source_id &&
          receipt.source_revision === source.revision;
        if (!current) return "pending";
        return this.#entries().length > 0 ? "sealed" : "none";
      });
    } catch {
      return "pending";
    }
  }

  /** A listener's failure is never the save's or the boot's. */
  #tell(result: WebMirrorResult): void {
    try {
      this.#onResult(result);
    } catch {
      // A log line that could not be written; the outcome stands.
    }
  }

  /**
   * One read transaction (`BEGIN DEFERRED`, only SELECTs): a consistent WAL
   * snapshot that never takes SQLite's write lock, so it never waits on a
   * writer while this process holds the credential lock.
   */
  #read<T>(work: () => T): T {
    return this.#db.transaction(work).deferred();
  }

  #attempt(): WebMirrorResult {
    if (this.#inventory === null) return { sealing: "pending", reason: "no-keyring" };
    let missingSource = false;
    try {
      const outcome = this.#inventory.mirror("web-search", () => {
        const snapshot = this.#snapshot();
        if (snapshot === null) {
          missingSource = true;
          throw new Error("no source");
        }
        return snapshot;
      });
      prepared(
        this.#db,
        `INSERT INTO web_credential_mirror (id, source_id, source_revision, inventory_id, generation)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_id = excluded.source_id,
           source_revision = excluded.source_revision,
           inventory_id = excluded.inventory_id,
           generation = excluded.generation`,
      ).run(
        outcome.receipt.source,
        outcome.receipt.revision,
        outcome.inventory,
        outcome.generation,
      );
      // The copy is of the source as it was read under the lock. If it moved
      // on meanwhile (another process, or an older build, wrote), the copy is
      // already stale: say so, rather than call a past revision sealed.
      const now = this.#read(() => this.#source());
      if (now?.source_id !== outcome.receipt.source || now.revision !== outcome.receipt.revision) {
        return { sealing: "pending", reason: "moved", revision: outcome.receipt.revision };
      }
      return {
        sealing: outcome.records > 0 ? "sealed" : "none",
        written: outcome.kind === "sealed",
        keys: outcome.records,
        revision: outcome.receipt.revision,
      };
    } catch (error) {
      if (missingSource) return { sealing: "pending", reason: "no-source" };
      return pendingFor(error);
    }
  }

  /** Every web key row and the source revision, in one read transaction. */
  #snapshot(): MirrorSnapshot | null {
    return this.#read(() => {
      const source = this.#source();
      if (source === undefined) return null;
      return {
        entries: this.#entries(),
        receipt: { source: source.source_id, revision: source.revision },
      };
    });
  }

  #source(): SourceRow | undefined {
    return prepared<[], SourceRow>(
      this.#db,
      "SELECT source_id, revision FROM web_credential_source WHERE id = 1",
    ).get();
  }

  #entries(): MirrorEntry[] {
    const names = Object.keys(WEB_KEY_SECRETS);
    return prepared<string[], { name: string; value: string }>(
      this.#db,
      `SELECT name, value FROM secrets WHERE name IN (${names.map(() => "?").join(", ")}) ORDER BY name`,
    )
      .all(...names)
      .map((row) => ({ selector: { provider: WEB_KEY_SECRETS[row.name]! }, value: row.value }));
  }
}

/**
 * `work`, or as soon as `signal` aborts, whichever is first: an abandoned
 * promise is not awaited any further. Never rejects. Each caller has just
 * seen `signal` unaborted, synchronously, so an abort can only come later.
 */
function untilAborted(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((settle) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      settle();
    };
    signal.addEventListener("abort", done, { once: true });
    work.then(done, done);
  });
}

/** Waits `ms`, or until `signal` aborts, which also cancels the timer. */
function pauseUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paused = new Promise<void>((settle) => {
    timer = setTimeout(settle, ms);
  });
  return untilAborted(paused, signal).finally(() => clearTimeout(timer));
}

function pendingFor(error: unknown): WebMirrorResult {
  if (error instanceof CredentialLockBusyError) return { sealing: "pending", reason: "busy" };
  if (error instanceof CredentialKeyPendingError) {
    return { sealing: "pending", reason: "key-pending" };
  }
  if (error instanceof SealedFileChangedError) return { sealing: "pending", reason: "changed" };
  if (error instanceof SealedFileIndeterminateError) {
    return { sealing: "pending", reason: "indeterminate" };
  }
  if (error instanceof SealedFileUnverifiedError) {
    return { sealing: "pending", reason: "unverified" };
  }
  if (isSealedOpenFailure(error)) {
    const status = credentialStatusFor(error, ["web-search"]);
    return {
      sealing: "pending",
      reason: status.state as "locked" | "refused" | "corrupt",
      detail: status.reason,
    };
  }
  return { sealing: "pending", reason: "failed" };
}

/**
 * One line for an operator's log. Counts, states and reason codes only. A
 * pending line says plainly that the keys are held in legacy mode: in the
 * profile database, not encrypted.
 */
export function describeWebSealing(result: WebMirrorResult): string {
  if (result.sealing === "pending") {
    const why =
      result.reason === "moved"
        ? `moved: revision ${result.revision} sealed, the source has changed since`
        : result.detail == null
          ? result.reason
          : `${result.reason}: ${result.detail}`;
    return `held in the profile database (legacy mode, not encrypted); sealed copy pending (${why})`;
  }
  const copy = result.written ? "sealed copy written and verified" : "sealed copy current";
  return result.sealing === "none"
    ? `none saved; ${copy} (revision ${result.revision})`
    : `${result.keys} saved in the profile database; ${copy} (revision ${result.revision})`;
}
