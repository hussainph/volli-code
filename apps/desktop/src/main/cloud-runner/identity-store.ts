/**
 * This Mac's runner link, sealed: the `runnerId`, its name and the rotating
 * refresh credential, one record per signed-in person in the host credential
 * inventory (`host-credentials.enc`), family `host-private`, purpose
 * `cloud-runner:<userId>`. The same keychain-wrapped keyring seals it as the
 * saved sign-in (`../account/session-store.ts`) and remote hosts' device
 * keys; harness mode's keychain guard swaps in the file keyring, so a
 * `volli-drive` build never touches the keychain.
 *
 * An existing family, not a new one: older builds parse the whole inventory
 * strictly, so a family they do not know would read as corrupt to them. A
 * new purpose inside `host-private` is what the saved sign-in already does;
 * `identity-store-n1.test.ts` pins it.
 *
 * Per person, so a different person signing in on this Mac gets a runner of
 * their own, and signing back in finds the same one. The value is versioned
 * JSON naming its owner; a record whose owner is not the one asked for reads
 * as none.
 *
 * **Writes are fenced** (N1's `RunnerLinkStore` contract): every save names
 * the record it read (`expect`), so nothing written in between is
 * overwritten, and a save whose `generation` is not newer than the stored
 * one for the same runner is refused, so a stale writer cannot roll the
 * credential back. A removal is fenced one level up: the Mac runner gives
 * each link its own epoch and refuses that epoch's saves once it ends
 * (`mac-runner.ts`), so a rotation landing after a removal never brings the
 * link back.
 */
import type { RunnerLink, RunnerLinkStore } from "@volli/host-core/cloud-runner";
import { readId, type RunnerId } from "@volli/shared/cloud";

const PURPOSE_PREFIX = "cloud-runner:";
const LINK_VERSION = 1;

/** The inventory's purpose for `userId`'s runner on this Mac. */
export function runnerLinkPurpose(userId: string): string {
  return `${PURPOSE_PREFIX}${userId}`;
}

interface RecordRef {
  readonly id: string;
  readonly revision: number;
}

/** What the inventory offers this module: `host-private` records, read and replaced by identity. */
export interface RunnerLinkInventory {
  get(
    family: "host-private",
    selector: { readonly purpose: string },
  ): { readonly id: string; readonly revision: number; readonly value: unknown } | null;
  put(
    family: "host-private",
    selector: { readonly purpose: string },
    value: string,
    options?: { readonly expect?: RecordRef | null },
  ): { readonly id: string; readonly revision: number };
  remove(
    family: "host-private",
    selector: { readonly purpose: string },
    options?: { readonly expect?: RecordRef | null },
  ): boolean;
}

/** A save the store refused: the stored link is as new or newer, or it changed since it was read. */
export class StaleRunnerLinkError extends Error {
  readonly code = "stale-runner-link";
  constructor(message: string) {
    super(message);
    this.name = "StaleRunnerLinkError";
  }
}

/** A sealed link this build wrote for `ownerUserId`, or `null` for anything else. */
export function parseRunnerLink(value: unknown, ownerUserId: string): RunnerLink | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const runnerId = readId("runner", record["runnerId"]);
  const { name, credential, generation } = record;
  if (
    record["v"] !== LINK_VERSION ||
    record["ownerUserId"] !== ownerUserId ||
    runnerId === null ||
    typeof name !== "string" ||
    typeof credential !== "string" ||
    credential === "" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  return { runnerId: runnerId as RunnerId, name, credential, generation };
}

/** Whether `value` is a link a newer build wrote: this build leaves it alone. */
function isNewerLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const version = (JSON.parse(value) as { v?: unknown } | null)?.v;
    return typeof version === "number" && version > LINK_VERSION;
  } catch {
    return false;
  }
}

function isRevisionConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "credential-revision-conflict";
}

/**
 * `ownerUserId`'s link on this Mac. A keychain-backed keyring fetches its key
 * asynchronously, so each call unlocks first (a no-op once unlocked); a
 * keychain that refuses rejects here, and the Mac runner shows it.
 */
export function inventoryRunnerLinkStore(
  inventory: RunnerLinkInventory,
  unlock: () => Promise<void>,
  ownerUserId: string,
): RunnerLinkStore {
  const selector = { purpose: runnerLinkPurpose(ownerUserId) } as const;
  return {
    async load() {
      await unlock();
      const record = inventory.get("host-private", selector);
      if (record === null) return null;
      const link = parseRunnerLink(record.value, ownerUserId);
      if (link === null && !isNewerLink(record.value)) {
        // Unreadable and not a newer build's: no link at all.
        inventory.remove("host-private", selector, {
          expect: { id: record.id, revision: record.revision },
        });
      }
      return link;
    },
    async save(link) {
      await unlock();
      const current = inventory.get("host-private", selector);
      const stored = current === null ? null : parseRunnerLink(current.value, ownerUserId);
      if (stored !== null && stored.runnerId === link.runnerId) {
        if (link.generation <= stored.generation) {
          throw new StaleRunnerLinkError(
            `The sealed link is at generation ${stored.generation}; ${link.generation} is not newer.`,
          );
        }
      }
      const value = JSON.stringify({
        v: LINK_VERSION,
        ownerUserId,
        runnerId: link.runnerId,
        name: link.name,
        credential: link.credential,
        generation: link.generation,
      });
      try {
        inventory.put("host-private", selector, value, {
          expect: current === null ? null : { id: current.id, revision: current.revision },
        });
      } catch (error) {
        if (isRevisionConflict(error)) {
          throw new StaleRunnerLinkError("The sealed link changed while it was being saved.");
        }
        throw error;
      }
    },
    async clear() {
      await unlock();
      inventory.remove("host-private", selector);
    },
  };
}
