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
 */
import type Database from "better-sqlite3";

import type { WebKeySealing } from "@volli/shared";

import { prepared } from "@volli/host-core/db/prepared";
import { withTransaction } from "@volli/host-core/db/transaction-gate";
import {
  CredentialLockBusyError,
  credentialStatusFor,
  isSealedOpenFailure,
  retryWhileBusy,
  SealedFileChangedError,
  SealedFileIndeterminateError,
  SealedFileUnverifiedError,
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
    };

export interface WebCredentialMirrorOptions {
  db: Database.Database;
  /**
   * The host's typed inventory, or `null` when it has no key backend for one:
   * sealing then stays pending and the keys stay in legacy mode.
   */
  inventory: SealedInventory | null;
  /** Told every result, for a log line. Never given a value. */
  onResult?: (result: WebMirrorResult) => void;
}

/** How long {@link WebCredentialMirror.reconcileSoon} retries a busy lock. */
export const WEB_MIRROR_RETRY_MS = 10_000;

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
  readonly #onResult: (result: WebMirrorResult) => void;
  #running: Promise<WebMirrorResult> | null = null;
  #again = false;

  constructor(options: WebCredentialMirrorOptions) {
    this.#db = options.db;
    this.#inventory = options.inventory;
    this.#onResult = options.onResult ?? (() => {});
  }

  /**
   * Makes the sealed mirror an exact copy of `secrets` now, or says why it is
   * pending. One attempt at the lock: never waits, never throws.
   */
  reconcile(): WebMirrorResult {
    const result = this.#attempt();
    this.#onResult(result);
    return result;
  }

  /**
   * {@link reconcile}, retried asynchronously while another process holds the
   * lock, never holding it across a pause. Calls that arrive while one runs
   * share one more run after it, so the last caller's commit is always read.
   * Never rejects.
   */
  reconcileSoon(timeoutMs: number = WEB_MIRROR_RETRY_MS): Promise<WebMirrorResult> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    const run = async (): Promise<WebMirrorResult> => {
      let result: WebMirrorResult;
      do {
        this.#again = false;
        try {
          result = await retryWhileBusy(() => {
            const attempt = this.#attempt();
            if (attempt.sealing === "pending" && attempt.reason === "busy") {
              throw new CredentialLockBusyError();
            }
            return attempt;
          }, timeoutMs);
        } catch {
          result = { sealing: "pending", reason: "busy" };
        }
        this.#onResult(result);
      } while (this.#again);
      return result;
    };
    const running = run().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /**
   * What SQLite says about the mirror, without opening it (so without the
   * keychain): `sealed` or `none` when the last verified receipt is for the
   * source as it is now, `pending` otherwise.
   */
  sealing(): WebKeySealing {
    try {
      return withTransaction(this.#db, () => {
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
    return withTransaction(this.#db, () => {
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

function pendingFor(error: unknown): WebMirrorResult {
  if (error instanceof CredentialLockBusyError) return { sealing: "pending", reason: "busy" };
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
    const why = result.detail == null ? result.reason : `${result.reason}: ${result.detail}`;
    return `held in the profile database (legacy mode, not encrypted); sealed copy pending (${why})`;
  }
  const copy = result.written ? "sealed copy written and verified" : "sealed copy current";
  return result.sealing === "none"
    ? `none saved; ${copy} (revision ${result.revision})`
    : `${result.keys} saved in the profile database; ${copy} (revision ${result.revision})`;
}
