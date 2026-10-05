/**
 * The typed sealed credential inventory, `host-credentials.enc` (VC-642;
 * `docs/plans/sealed-credential-store.md` §3, §6, §7).
 *
 * One authenticated file holds every family a host has moved in
 * (`credential-families.ts`), sealed under a named key from a
 * {@link CredentialKeyring} (`sealed-envelope.ts`), shared between processes
 * through {@link SealedDocument}: every read-for-use and every change takes
 * the {@link CredentialLock}, reloads, and merges only its own record.
 *
 * The plaintext is `{ schema, inventory, generation, records }`: the schema
 * version this build writes ({@link INVENTORY_SCHEMA}), a UUID naming this
 * inventory, a generation that grows by one per commit, and the records. Each
 * record has a UUID, its family and selector, its value, a revision that grows
 * by one per replacement, and when it last changed. A revision lets a caller
 * that read a record, went away to refresh it, and came back commit only if
 * nobody replaced or removed it meanwhile (`expectRevision`): a sign-out or a
 * new sign-in beats a late refresh.
 *
 * It keeps the lost-key rules of VC-641 (`credential-state.ts`): a key that is
 * missing, wrong, unsafe or held by another backend leaves the file
 * byte-identical and the status `locked` or `refused`; a file that opened and
 * does not parse is `corrupt`; a newer schema is `locked` (`newer-format`)
 * and never rewritten. Reads then answer nothing, saves are refused, and only
 * {@link SealedInventory.unlock} or {@link SealedInventory.reset} changes that.
 * A failure is remembered, so a backend is asked once per unlock.
 *
 * Nothing seals into this file yet: it is the module each family's cutover
 * moves onto. It must not be activated for a family that a permitted older
 * build still writes elsewhere (§3, "Do not activate a new incompatible file
 * format on a profile a permitted older build will still try to mutate").
 */
import { randomUUID } from "node:crypto";

import type { CredentialKeyring } from "../ports/credential-keyring";
import { SecretKeyUnavailableError, isSecretKeyUnavailable } from "../ports/secret-key";
import {
  CREDENTIAL_FAMILIES,
  isCredentialFamily,
  selectorKey,
  validSelector,
  validValue,
  type CredentialFamily,
  type CredentialSelector,
  type CredentialValue,
} from "./credential-families";
import { credentialLockFor, CredentialLockBusyError, type CredentialLock } from "./credential-lock";
import {
  archiveSealedStore,
  CREDENTIALS_EMPTY,
  CREDENTIALS_READY,
  credentialStatusFor,
  credentialsUnavailable,
  SealedStoreNewerError,
  type CredentialStatus,
} from "./credential-state";
import { envelopeHeader, openEnvelope, sealEnvelope } from "./sealed-envelope";
import {
  isSealedOpenFailure,
  SealedDocument,
  type SealedCodec,
  type SealedDocumentOptions,
} from "./sealed-document";

/** The typed inventory's file, beside the database. */
export const CREDENTIAL_INVENTORY_FILE_NAME = "host-credentials.enc";
/** The plaintext schema this build reads and writes. A newer one is never rewritten. */
export const INVENTORY_SCHEMA = 1;

/** A record without its value: what may be listed. */
export interface CredentialRecordMetadata {
  readonly id: string;
  readonly family: CredentialFamily;
  readonly selector: CredentialSelector;
  readonly revision: number;
  readonly updatedAt: number;
}

/** A record with its value: only for the host service that owns the family. */
export interface CredentialRecord extends CredentialRecordMetadata {
  readonly value: CredentialValue;
}

interface Inventory {
  readonly inventory: string;
  readonly generation: number;
  readonly records: readonly CredentialRecord[];
}

/** `expectRevision` did not match: someone replaced or removed the record first. */
export class CredentialRevisionConflictError extends Error {
  readonly code = "credential-revision-conflict";
  constructor() {
    super("The saved credential changed since it was read.");
    this.name = "CredentialRevisionConflictError";
  }
}

export interface ChangeOptions {
  /**
   * Commit only if the record is still at this revision; `null` means only
   * if there is none. Omitted: replace whatever is there.
   */
  readonly expectRevision?: number | null;
}

export interface SealedInventoryOptions {
  /** `<dataDir>/host-credentials.enc`. */
  readonly path: string;
  readonly keyring: CredentialKeyring;
  /** Defaults to `host-credentials.lock` beside {@link path}. */
  readonly lock?: CredentialLock;
  /** The families this host gates, reported unavailable while locked. Default: all. */
  readonly families?: readonly CredentialFamily[];
  readonly now?: () => number;
  /** Durability options for the file; see {@link SealedDocumentOptions}. */
  readonly document?: SealedDocumentOptions;
}

/** What {@link SealedInventory.reset} did. */
export interface SealedInventoryReset {
  readonly archive: string | null;
  readonly synced: boolean;
  readonly status: CredentialStatus;
}

export class SealedInventory {
  readonly #document: SealedDocument<Inventory>;
  readonly #families: readonly CredentialFamily[];
  readonly #now: () => number;
  #status: CredentialStatus | null = null;
  #failure: Error | null = null;

  constructor(options: SealedInventoryOptions) {
    this.#families = options.families ?? CREDENTIAL_FAMILIES;
    this.#now = options.now ?? Date.now;
    this.#document = new SealedDocument(
      options.path,
      inventoryCodec(options.keyring),
      options.lock ?? credentialLockFor(options.path),
      // Every family that moves here is a cutover path: durability is required (§6).
      { requireDirectorySync: true, ...options.document },
    );
  }

  /** Where the inventory stands, settling it now if nothing has asked. Metadata only. */
  status(): CredentialStatus {
    this.#read();
    // Unsettled only when the lock was busy on the first ask: unavailable for now.
    return (
      this.#status ?? { state: "locked", reason: "store-unreadable", unavailable: this.#families }
    );
  }

  /** The refusal sentence behind a `locked` or `refused` key, for an operator's log. */
  problem(): string | null {
    this.status();
    return isSecretKeyUnavailable(this.#failure) ? this.#failure.message : null;
  }

  /** Tries a locked, refused or corrupt inventory again. */
  unlock(): CredentialStatus {
    this.#failure = null;
    this.#status = null;
    return this.status();
  }

  /**
   * Sets an inventory this host cannot open aside (never deleting it; see
   * `archiveSealedStore`) and starts empty. Only for `locked` or `corrupt`;
   * person or local-admin intent only.
   */
  reset(now: Date = new Date()): SealedInventoryReset {
    const status = this.status();
    if (status.state === "refused") {
      throw new Error("Saved credentials are refused because the key configuration is unsafe.");
    }
    if (!credentialsUnavailable(status)) {
      throw new Error("Saved credentials are not locked, so there is nothing to reset.");
    }
    const archived = this.#document.lock.withSync(() => {
      try {
        return archiveSealedStore(this.#document.path, now);
      } catch {
        // eslint-disable-next-line preserve-caught-error -- never a path or filesystem text
        throw new Error("Could not set the saved credentials aside.");
      }
    });
    this.#document.forget();
    return {
      archive: archived?.name ?? null,
      synced: archived?.synced ?? true,
      status: this.unlock(),
    };
  }

  /** The family's records, without values. Fresh; empty while unavailable. */
  list(family: CredentialFamily): CredentialRecordMetadata[] {
    return (this.#read()?.records ?? [])
      .filter((record) => record.family === family)
      .map(({ value: _value, ...metadata }) => metadata);
  }

  /**
   * One record with its value, read for use: fresh from disk under the lock,
   * so a revocation in another process is seen. `null` when there is none or
   * credentials are unavailable (see {@link status}).
   */
  get(family: CredentialFamily, selector: CredentialSelector): CredentialRecord | null {
    const slot = selectorKey(family, selector);
    return (
      this.#read()?.records.find(
        (record) => selectorKey(record.family, record.selector) === slot,
      ) ?? null
    );
  }

  /** Saves `value` at the selector, keeping its id and bumping its revision. */
  put(
    family: CredentialFamily,
    selector: CredentialSelector,
    value: CredentialValue,
    options: ChangeOptions = {},
  ): CredentialRecordMetadata {
    if (!validSelector(family, selector) || !validValue(family, value)) {
      throw new Error("Invalid credential.");
    }
    const slot = selectorKey(family, selector);
    let saved: CredentialRecord | undefined;
    this.#change((current) => {
      const previous = current.records.find(
        (record) => selectorKey(record.family, record.selector) === slot,
      );
      expect(previous, options);
      saved = {
        id: previous?.id ?? randomUUID(),
        family,
        selector: { ...selector },
        value,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: this.#now(),
      };
      return current.records.filter((record) => record !== previous).concat(saved);
    });
    const { value: _value, ...metadata } = saved!;
    return metadata;
  }

  /** Removes the record at the selector. Answers whether one was there. */
  remove(
    family: CredentialFamily,
    selector: CredentialSelector,
    options: ChangeOptions = {},
  ): boolean {
    const slot = selectorKey(family, selector);
    let removed = false;
    this.#change((current) => {
      const previous = current.records.find(
        (record) => selectorKey(record.family, record.selector) === slot,
      );
      expect(previous, options);
      if (previous === undefined) return null;
      removed = true;
      return current.records.filter((record) => record !== previous);
    });
    return removed;
  }

  /** The inventory, fresh, or `null` while unavailable (a busy lock included). */
  #read(): Inventory | null {
    if (this.#failure !== null) return null;
    try {
      const inventory = this.#document.read();
      this.#status = inventory === null ? CREDENTIALS_EMPTY : CREDENTIALS_READY;
      return inventory ?? EMPTY;
    } catch (error) {
      // A busy lock is momentary: unavailable for this read, not a status.
      if (error instanceof CredentialLockBusyError) return null;
      this.#fail(error);
      return null;
    }
  }

  /** Applies `change` to the current records under the lock; `null` from it writes nothing. */
  #change(change: (current: Inventory) => CredentialRecord[] | null): void {
    if (this.#failure !== null) throw this.#failure;
    let written: boolean;
    try {
      ({ written } = this.#document.update((current) => {
        const inventory = current ?? EMPTY;
        const records = change(inventory);
        if (records === null) return null;
        return {
          inventory: current?.inventory ?? randomUUID(),
          generation: inventory.generation + 1,
          records,
        };
      }));
    } catch (error) {
      if (!isSealedOpenFailure(error)) throw error;
      this.#fail(error);
      throw error;
    }
    if (written) this.#status = CREDENTIALS_READY;
  }

  #fail(error: unknown): void {
    this.#failure = error as Error;
    this.#status = credentialStatusFor(error, this.#families);
  }
}

const EMPTY: Inventory = { inventory: "", generation: 0, records: [] };

function expect(previous: CredentialRecord | undefined, options: ChangeOptions): void {
  if (options.expectRevision === undefined) return;
  if ((previous?.revision ?? null) !== options.expectRevision) {
    throw new CredentialRevisionConflictError();
  }
}

/** The inventory's codec over a keyring: `VHC1` envelope, strict JSON plaintext. */
function inventoryCodec(keyring: CredentialKeyring): SealedCodec<Inventory> {
  return {
    probe: () => keyring.probe(),
    open(bytes) {
      const header = envelopeHeader(bytes);
      if (header.backend !== keyring.backend) {
        throw new SecretKeyUnavailableError(
          "other-adapter",
          `Saved credentials were sealed by the ${header.backend} backend, and this host seals ` +
            `with the ${keyring.backend} backend, so it cannot open them.`,
        );
      }
      return parseInventory(openEnvelope(bytes, keyring.resolve(header.keyId)));
    },
    seal(inventory, active) {
      const key = keyring.active();
      // Never re-key by saving: what is there must already be under this key.
      // Moving to another key is rotation (VC-649), an explicit operation.
      if (active !== null && envelopeHeader(active).keyId !== key.id) {
        throw new Error("Saved credentials are sealed under another key.");
      }
      return sealEnvelope(
        keyring.backend,
        key,
        JSON.stringify({ schema: INVENTORY_SCHEMA, ...inventory }),
      );
    },
  };
}

/** Strict: an unknown field, family or duplicate slot is corrupt, never guessed at. */
function parseInventory(text: string): Inventory {
  const file = JSON.parse(text) as Record<string, unknown>;
  if (typeof file["schema"] === "number" && file["schema"] > INVENTORY_SCHEMA) {
    throw new SealedStoreNewerError();
  }
  const { inventory, generation, records } = file;
  if (
    file["schema"] !== INVENTORY_SCHEMA ||
    typeof inventory !== "string" ||
    !/^[0-9a-f-]{36}$/.test(inventory) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    !Array.isArray(records)
  ) {
    throw new Error("Invalid credential inventory.");
  }
  const slots = new Set<string>();
  const ids = new Set<string>();
  const parsed = records.map((candidate: unknown): CredentialRecord => {
    const record = candidate as Record<string, unknown>;
    const { id, family, selector, value, revision, updatedAt } = record ?? {};
    if (
      typeof id !== "string" ||
      ids.has(id) ||
      !isCredentialFamily(family) ||
      !validSelector(family, selector) ||
      !validValue(family, value) ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      typeof updatedAt !== "number" ||
      !Number.isFinite(updatedAt) ||
      updatedAt < 0 ||
      slots.has(selectorKey(family, selector as CredentialSelector))
    ) {
      throw new Error("Invalid credential inventory.");
    }
    ids.add(id);
    slots.add(selectorKey(family, selector as CredentialSelector));
    // Whitelisted fields only: nothing unknown rides out through a listing.
    return {
      id,
      family,
      selector: { ...(selector as CredentialSelector) },
      value,
      revision: revision as number,
      updatedAt,
    };
  });
  return { inventory, generation: generation as number, records: parsed };
}
