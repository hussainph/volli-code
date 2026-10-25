/**
 * The saved sign-in: the refresh token and what the window shows before the
 * backend answers, sealed in the host credential inventory
 * (`host-credentials.enc`) under the `host-private` family, purpose
 * {@link ACCOUNT_SESSION_PURPOSE}, by the keychain-wrapped keyring the web
 * search keys and remote hosts' device keys use. Harness mode's keychain
 * guard swaps that keyring for the file one, so a `volli-drive` build seals
 * here without touching the keychain.
 *
 * An existing family, not a new one: older builds parse the whole inventory
 * strictly, so a family they do not know would read as corrupt to them. The
 * value is a versioned JSON string, the shape `host-private` holds.
 *
 * The access token is never saved. Every write names the record it replaces
 * (`expect`), so a sign-out (or a sign-out and a new sign-in) beats a late
 * refresh: the refresh's save fails and its tokens are dropped.
 */
import { ACCOUNT_PROVIDERS, type AccountProviderKind } from "@volli/shared";

export const ACCOUNT_SESSION_PURPOSE = "account-session";
const SELECTOR = { purpose: ACCOUNT_SESSION_PURPOSE } as const;
const SAVED_SESSION_VERSION = 1;

/** What the inventory offers this module: one `host-private` record, read and replaced by identity. */
export interface AccountSessionInventory {
  get(
    family: "host-private",
    selector: { readonly purpose: string },
  ): { readonly id: string; readonly revision: number; readonly value: unknown } | null;
  put(
    family: "host-private",
    selector: { readonly purpose: string },
    value: string,
    options?: { readonly expect?: SavedSessionRef | null },
  ): { readonly id: string; readonly revision: number };
  remove(
    family: "host-private",
    selector: { readonly purpose: string },
    options?: { readonly expect?: SavedSessionRef | null },
  ): boolean;
}

/** Which saved record a change was based on. */
export interface SavedSessionRef {
  readonly id: string;
  readonly revision: number;
}

export interface SavedAccountSession {
  readonly provider: AccountProviderKind;
  readonly refreshToken: string;
  readonly sessionId: string | null;
  readonly profile: { readonly displayName: string | null; readonly email: string | null };
}

export interface AccountSessionStore {
  /** The saved sign-in, or `null` (none, or one this build cannot read, which is then removed). */
  load(): Promise<{ session: SavedAccountSession; ref: SavedSessionRef } | null>;
  /**
   * Saves `session` in place of the record `expect` names (`null`: only if
   * there is none). Throws {@link SavedSessionChangedError} when another
   * change got there first.
   */
  save(session: SavedAccountSession, expect: SavedSessionRef | null): Promise<SavedSessionRef>;
  /** Forgets the saved sign-in; quiet when there is none. */
  clear(): Promise<void>;
  /** Forgets the saved sign-in only if it is still the record `ref` names; quiet otherwise. */
  discard(ref: SavedSessionRef): Promise<void>;
}

/** The saved sign-in changed since it was read (a sign-out, or another sign-in). */
export class SavedSessionChangedError extends Error {
  readonly code = "saved-session-changed";
  constructor() {
    super("The saved sign-in changed since it was read.");
    this.name = "SavedSessionChangedError";
  }
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Whether `value` is a saved sign-in a newer build wrote: this build leaves it alone. */
export function isNewerSavedSession(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const version = (JSON.parse(value) as { v?: unknown } | null)?.v;
    return typeof version === "number" && version > SAVED_SESSION_VERSION;
  } catch {
    return false;
  }
}

/** A saved value this build wrote, or `null` for anything else. */
export function parseSavedSession(value: unknown): SavedAccountSession | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const profile = record["profile"] as Record<string, unknown> | null | undefined;
  const displayName = nullableString(profile?.["displayName"]);
  const email = nullableString(profile?.["email"]);
  const sessionId = nullableString(record["sessionId"]);
  const provider = record["provider"];
  if (
    record["v"] !== SAVED_SESSION_VERSION ||
    !(ACCOUNT_PROVIDERS as readonly unknown[]).includes(provider) ||
    typeof record["refreshToken"] !== "string" ||
    record["refreshToken"] === "" ||
    sessionId === undefined ||
    displayName === undefined ||
    email === undefined
  ) {
    return null;
  }
  return {
    provider: provider as AccountProviderKind,
    refreshToken: record["refreshToken"],
    sessionId,
    profile: { displayName, email },
  };
}

function serialize(session: SavedAccountSession): string {
  return JSON.stringify({ v: SAVED_SESSION_VERSION, ...session });
}

function isRevisionConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "credential-revision-conflict";
}

/**
 * The store over the sealed inventory. A keychain-backed keyring fetches its
 * key asynchronously, so each call unlocks first (a no-op once unlocked).
 */
export function inventoryAccountSessionStore(
  inventory: AccountSessionInventory,
  unlock: () => Promise<void>,
): AccountSessionStore {
  return {
    async load() {
      await unlock();
      const record = inventory.get("host-private", SELECTOR);
      if (record === null) return null;
      const session = parseSavedSession(record.value);
      const ref = { id: record.id, revision: record.revision };
      if (session === null) {
        // A newer build's sign-in is that build's to read: kept for it. Anything
        // else unreadable is no sign-in at all.
        if (!isNewerSavedSession(record.value)) {
          inventory.remove("host-private", SELECTOR, { expect: ref });
        }
        return null;
      }
      return { session, ref };
    },
    async save(session, expect) {
      await unlock();
      try {
        const saved = inventory.put("host-private", SELECTOR, serialize(session), { expect });
        return { id: saved.id, revision: saved.revision };
      } catch (error) {
        if (isRevisionConflict(error)) throw new SavedSessionChangedError();
        throw error;
      }
    },
    async clear() {
      await unlock();
      inventory.remove("host-private", SELECTOR);
    },
    async discard(ref) {
      await unlock();
      try {
        inventory.remove("host-private", SELECTOR, { expect: ref });
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    },
  };
}
