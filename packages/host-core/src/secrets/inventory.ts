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
 * record has a UUID, its family and selector, its value, its revision (the
 * generation of the commit that last wrote it), and when it last changed. A
 * record that is removed and saved again gets a new UUID and a later
 * revision, so neither ever repeats. A caller that read a record, went away to
 * refresh it, and came back commits only if that same record is still there,
 * unchanged (`expect: { id, revision }`): a sign-out, or a sign-out and a new
 * sign-in, beats a late refresh.
 *
 * It keeps the lost-key rules of VC-641 (`credential-state.ts`): a key that is
 * missing, wrong, unsafe or held by another backend leaves the file
 * byte-identical and the status `locked` or `refused`; a file that opened and
 * does not parse is `corrupt`; a newer schema is `locked` (`newer-format`)
 * and never rewritten. Reads then answer nothing, saves are refused, and only
 * {@link SealedInventory.unlock} or {@link SealedInventory.reset} changes that.
 * A failure is remembered, so a backend is asked once per unlock.
 *
 * It is the module each family's cutover moves onto. The first family in it
 * is `web-search`, as a MIRROR only (VC-643, step E): {@link SealedInventory.mirror}
 * keeps it an exact copy of the `secrets` table with a receipt naming the
 * source state it copies, while SQLite stays canonical and every read stays
 * there. No older build reads or writes this file, so mirroring here changes
 * nothing for one. It must not become canonical for a family that a permitted
 * older build still writes elsewhere (§3, "Do not activate a new incompatible
 * file format on a profile a permitted older build will still try to
 * mutate"): that is each family's switch, behind a floor raise.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { CredentialKeyPendingError, type CredentialKeyring } from "../ports/credential-keyring";
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
  credentialsBusy,
  CredentialLockUnusableError,
  credentialsResettable,
  credentialStatusFor,
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
  /** Families mirrored from a canonical source elsewhere, and what each copies. */
  readonly receipts?: Readonly<Partial<Record<CredentialFamily, MirrorReceipt>>>;
}

/**
 * Which state of its canonical source a mirrored family copies (step E of a
 * family's move, `docs/plans/sealed-credential-store.md` §4): the source's
 * lineage id and its revision. Non-secret; it names no value.
 */
export interface MirrorReceipt {
  /** The source's lineage: a new one after a restore, so its revisions never collide. */
  readonly source: string;
  /** The source revision the mirrored records were read at. */
  readonly revision: number;
}

/** One record as the canonical source holds it. */
export interface MirrorEntry {
  readonly selector: CredentialSelector;
  readonly value: CredentialValue;
}

/** Everything a canonical source holds for one family, read in one transaction. */
export interface MirrorSnapshot {
  readonly entries: readonly MirrorEntry[];
  readonly receipt: MirrorReceipt;
}

/** What {@link SealedInventory.mirror} found or did. */
export interface MirrorOutcome {
  /**
   * `sealed`: a new file was published, read back and verified. `current`:
   * the file already held exactly the source (or there is no file and the
   * source is empty), so nothing was written.
   */
  readonly kind: "sealed" | "current";
  readonly receipt: MirrorReceipt;
  /** The sealed inventory's id and generation; `null` when there is no file. */
  readonly inventory: string | null;
  readonly generation: number | null;
  /** How many records the family holds now. */
  readonly records: number;
}

/** `expectRevision` did not match: someone replaced or removed the record first. */
export class CredentialRevisionConflictError extends Error {
  readonly code = "credential-revision-conflict";
  constructor() {
    super("The saved credential changed since it was read.");
    this.name = "CredentialRevisionConflictError";
  }
}

/** Which record a change was based on: its identity and the commit that last wrote it. */
export interface CredentialRecordRef {
  readonly id: string;
  readonly revision: number;
}

export interface ChangeOptions {
  /**
   * Commit only if this same record (id and revision) is still the one at the
   * selector; `null` means only if there is none. Omitted: replace whatever
   * is there.
   */
  readonly expect?: CredentialRecordRef | null;
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

  /**
   * Where the inventory stands now, read again under the lock. Metadata
   * only. Another process holding the lock at that instant is `locked`
   * (`busy`) for this answer alone.
   */
  status(): CredentialStatus {
    return this.#read().status;
  }

  /** One family's records and the status they were read under: one read, never two that disagree. */
  snapshot(family: CredentialFamily): {
    records: CredentialRecordMetadata[];
    status: CredentialStatus;
  } {
    const { inventory, status } = this.#read();
    return {
      records: (inventory?.records ?? [])
        .filter((record) => record.family === family)
        .map(({ value: _value, ...metadata }) => metadata),
      status,
    };
  }

  /**
   * The sentence behind a status that is not `ready` or `empty`, for an
   * operator's log: a key or lock-file refusal (which may name the file), or
   * the busy lock. `null` otherwise, a corrupt store included.
   */
  problem(): string | null {
    if (this.status().reason === "busy") return new CredentialLockBusyError().message;
    const failure = this.#failure;
    return isSecretKeyUnavailable(failure) || failure instanceof CredentialLockUnusableError
      ? failure.message
      : null;
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
    if (!credentialsResettable(status)) {
      if (status.state === "refused") {
        throw new Error("Saved credentials are refused because the key configuration is unsafe.");
      }
      if (status.reason === "busy") throw new CredentialLockBusyError();
      if (status.reason === "lock-unusable") {
        throw new Error(
          "Saved credentials are unused because their lock file cannot be used. Fix the lock " +
            "file; a reset cannot, and the credentials may be fine.",
        );
      }
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
    return this.snapshot(family).records;
  }

  /**
   * One record with its value, read for use: fresh from disk under the lock,
   * so a revocation in another process is seen. `null` when there is none or
   * credentials are unavailable (see {@link status}).
   */
  get(family: CredentialFamily, selector: CredentialSelector): CredentialRecord | null {
    const slot = selectorKey(family, selector);
    return (
      this.#read().inventory?.records.find(
        (record) => selectorKey(record.family, record.selector) === slot,
      ) ?? null
    );
  }

  /** Saves `value` at the selector, keeping its id; its revision becomes this commit's generation. */
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
    this.#change((current, generation) => {
      const previous = current.records.find(
        (record) => selectorKey(record.family, record.selector) === slot,
      );
      expect(previous, options);
      saved = {
        id: previous?.id ?? randomUUID(),
        family,
        selector: { ...selector },
        value,
        revision: generation,
        updatedAt: this.#now(),
      };
      return {
        records: current.records.filter((record) => record !== previous).concat(saved),
        receipts: withoutReceipt(current.receipts, family),
      };
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
      return {
        records: current.records.filter((record) => record !== previous),
        receipts: withoutReceipt(current.receipts, family),
      };
    });
    return removed;
  }

  /**
   * Makes `family` an exact copy of a canonical source kept elsewhere (step
   * E), with a receipt naming the source state it copies. Under one hold of
   * the lock: reloads the inventory, calls `read` for the source (one short
   * synchronous read; never an await), and when the family's records or
   * receipt differ, seals the source's records over the file, fsyncs, then
   * reads the file back, opens it and checks it holds exactly that. Records
   * the source no longer has are dropped, so a stale mirror never keeps a
   * cleared value. A record whose value is unchanged keeps its id and
   * revision; a changed one keeps its id; a new one gets a new id. Other
   * families are untouched.
   *
   * With no file and an empty source there is nothing to protect: nothing is
   * written and no key is made. Like every read and save here it takes the
   * lock once and never waits; while unavailable it throws what a save would.
   */
  mirror(family: CredentialFamily, read: () => MirrorSnapshot): MirrorOutcome {
    let snapshot: MirrorSnapshot | undefined;
    let outcome: MirrorOutcome | undefined;
    // Nothing to protect, answered before the key backend is asked anything:
    // a keychain that is unavailable (or a key file that is unsafe) cannot
    // make "no key and no sealed copy" pending.
    const empty = this.#document.lock.withSync(() => {
      if (existsSync(this.#document.path)) return null;
      const source = checkedSnapshot(family, read());
      return source.entries.length === 0 ? source : null;
    });
    if (empty !== null) return nothing(empty);
    const exact = (inventory: Inventory): boolean =>
      sameEntries(inventory.records, family, snapshot!.entries) &&
      sameReceipt(inventory.receipts?.[family], snapshot!.receipt);
    this.#change(
      (current, generation, existing) => {
        snapshot = checkedSnapshot(family, read());
        if (existing === null && snapshot.entries.length === 0) {
          // The source emptied since the look above.
          outcome = nothing(snapshot);
          return null;
        }
        if (exact(current)) {
          outcome = {
            kind: "current",
            receipt: snapshot.receipt,
            inventory: existing!.inventory,
            generation: existing!.generation,
            records: snapshot.entries.length,
          };
          return null;
        }
        const others = current.records.filter((record) => record.family !== family);
        const mirrored = snapshot.entries.map((entry): CredentialRecord => {
          const slot = selectorKey(family, entry.selector);
          const previous = current.records.find(
            (record) => record.family === family && selectorKey(family, record.selector) === slot,
          );
          if (previous !== undefined && sameValue(previous.value, entry.value)) return previous;
          return {
            id: previous?.id ?? randomUUID(),
            family,
            selector: { ...entry.selector },
            value: entry.value,
            revision: generation,
            updatedAt: this.#now(),
          };
        });
        return {
          records: others.concat(mirrored),
          receipts: { ...current.receipts, [family]: { ...snapshot.receipt } },
        };
      },
      (reopened) => {
        if (!exact(reopened)) throw new Error("mismatch");
        outcome = {
          kind: "sealed",
          receipt: snapshot!.receipt,
          inventory: reopened.inventory,
          generation: reopened.generation,
          records: snapshot!.entries.length,
        };
      },
    );
    return outcome!;
  }

  /**
   * The inventory, fresh, with the status it was read under; `null` while
   * unavailable. A busy lock answers `busy`, and a key not fetched yet
   * `key-pending`, for this read only; anything else that stops the open is
   * remembered until unlock.
   */
  #read(): { inventory: Inventory | null; status: CredentialStatus } {
    if (this.#failure !== null) return { inventory: null, status: this.#status! };
    try {
      const inventory = this.#document.read();
      this.#status = inventory === null ? CREDENTIALS_EMPTY : CREDENTIALS_READY;
      return { inventory: inventory ?? EMPTY, status: this.#status };
    } catch (error) {
      if (error instanceof CredentialLockBusyError) {
        return { inventory: null, status: credentialsBusy(this.#families) };
      }
      // A key not fetched yet is for this read alone, like a busy lock.
      if (error instanceof CredentialKeyPendingError) {
        return { inventory: null, status: credentialStatusFor(error, this.#families) };
      }
      this.#fail(error);
      return { inventory: null, status: this.#status! };
    }
  }

  /**
   * Applies `change` to the current records under the lock, giving it the
   * generation this commit will have and the inventory as read (`null`: no
   * file); `null` from it writes nothing. It answers the records and the
   * receipts to keep. With `verify`, the published file is read back and
   * judged under the same lock.
   */
  #change(
    change: (
      current: Inventory,
      generation: number,
      existing: Inventory | null,
    ) => { records: CredentialRecord[]; receipts: NonNullable<Inventory["receipts"]> } | null,
    verify?: (reopened: Inventory) => void,
  ): void {
    if (this.#failure !== null) throw this.#failure;
    let written: boolean;
    try {
      ({ written } = this.#document.update((current) => {
        const inventory = current ?? EMPTY;
        const next = change(inventory, inventory.generation + 1, current);
        if (next === null) return null;
        const { records, receipts } = next;
        return {
          inventory: current?.inventory ?? randomUUID(),
          generation: inventory.generation + 1,
          records,
          ...(Object.keys(receipts).length === 0 ? {} : { receipts }),
        };
      }, verify));
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

/**
 * A direct change to a family is not a copy of its source any more: its
 * receipt goes, so nothing can take the family for a verified mirror.
 */
function withoutReceipt(
  receipts: Inventory["receipts"],
  family: CredentialFamily,
): NonNullable<Inventory["receipts"]> {
  const { [family]: _dropped, ...rest } = receipts ?? {};
  return rest;
}

function sameValue(left: CredentialValue, right: CredentialValue): boolean {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : JSON.stringify(left) === JSON.stringify(right);
}

/** Whether `family`'s records hold exactly `entries`: the same selectors and values, no more. */
function sameEntries(
  records: readonly CredentialRecord[],
  family: CredentialFamily,
  entries: readonly MirrorEntry[],
): boolean {
  const held = records.filter((record) => record.family === family);
  return (
    held.length === entries.length &&
    entries.every((entry) => {
      const slot = selectorKey(family, entry.selector);
      const record = held.find((candidate) => selectorKey(family, candidate.selector) === slot);
      return record !== undefined && sameValue(record.value, entry.value);
    })
  );
}

function sameReceipt(left: MirrorReceipt | undefined, right: MirrorReceipt): boolean {
  return left !== undefined && left.source === right.source && left.revision === right.revision;
}

/** "Nothing to protect": an empty source and no sealed file, so nothing written. */
function nothing(empty: MirrorSnapshot): MirrorOutcome {
  return { kind: "current", receipt: empty.receipt, inventory: null, generation: null, records: 0 };
}

/**
 * The source's snapshot, checked before anything is sealed from it: what is
 * written must parse again, or it would turn every family in the file corrupt.
 */
function checkedSnapshot(family: CredentialFamily, snapshot: MirrorSnapshot): MirrorSnapshot {
  const slots = new Set<string>();
  for (const entry of snapshot.entries) {
    const slot = validSelector(family, entry.selector) && selectorKey(family, entry.selector);
    if (slot === false || !validValue(family, entry.value) || slots.has(slot)) {
      throw new Error("Invalid credential.");
    }
    slots.add(slot);
  }
  if (!validReceipt(snapshot.receipt)) throw new Error("Invalid credential.");
  return snapshot;
}

function validReceipt(value: unknown): value is MirrorReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { source, revision, ...rest } = value as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    typeof source === "string" &&
    /^[0-9a-f]{32}$/.test(source) &&
    Number.isSafeInteger(revision) &&
    (revision as number) >= 0
  );
}

/** The receipts of a parsed file: absent, or an object of valid receipts keyed by family. */
function parseReceipts(value: unknown): Inventory["receipts"] | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const receipts: Partial<Record<CredentialFamily, MirrorReceipt>> = {};
  for (const [family, receipt] of Object.entries(value)) {
    if (!isCredentialFamily(family) || !validReceipt(receipt)) return null;
    receipts[family] = { source: receipt.source, revision: receipt.revision };
  }
  return receipts;
}

function expect(previous: CredentialRecord | undefined, options: ChangeOptions): void {
  const expected = options.expect;
  if (expected === undefined) return;
  const same =
    expected === null
      ? previous === undefined
      : previous !== undefined &&
        previous.id === expected.id &&
        previous.revision === expected.revision;
  if (!same) throw new CredentialRevisionConflictError();
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
  const receipts = parseReceipts(file["receipts"]);
  if (
    receipts === null ||
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
      (revision as number) > (generation as number) ||
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
  return {
    inventory,
    generation: generation as number,
    records: parsed,
    ...(receipts === undefined ? {} : { receipts }),
  };
}
