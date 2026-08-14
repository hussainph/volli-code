/**
 * `StateStorage` backed by an in-memory cache + the preload bridge — replaces
 * localStorage for the ui/workspace zustand `persist` stores now that UI
 * prefs live in SQLite's `app_state` table (docs/CONCEPT.md decision #29).
 *
 * `getItem` reads the cache synchronously so the ui/workspace stores can
 * rehydrate the moment `lib/boot.ts` seeds it from the bootstrap payload — no
 * store construction here ever waits on an IPC round trip. `setItem`/
 * `removeItem` update the cache immediately (so a read-after-write in the
 * same tick sees it) and fire-and-forget the SQLite write, surfacing a
 * failure via a toast (CLAUDE.md: never silently swallow a failed mutation).
 */
import { errorMessage } from "@volli/shared";
import type { StateStorage } from "zustand/middleware";

import { toastError } from "@renderer/lib/toast";

const cache = new Map<string, string>();

/**
 * Fills the cache at boot from the bootstrap payload's raw `app_state` JSON
 * strings. Empty values are skipped: `removeItem` below persists `""` (there
 * is no delete channel), and seeding one back would make `getItem` hand
 * zustand's JSON storage an unparseable empty string on rehydrate.
 */
export function seedAppStateCache(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value !== "") cache.set(key, value);
  }
}

/** Writes through to main and reports whether SQLite acknowledged the value. */
async function persist(key: string, value: string, failureVerb: string): Promise<boolean> {
  try {
    const result = await window.api.appState.set(key, value);
    if (result.ok) return true;
    toastError(`Couldn't ${failureVerb} "${key}": ${result.error}`);
  } catch (error: unknown) {
    toastError(`Couldn't ${failureVerb} "${key}": ${errorMessage(error)}`);
  }
  return false;
}

/**
 * Trailing-edge debounce, per key: zustand's `persist` calls `setItem` on EVERY
 * store change, and some fire in bursts — the sidebar resize handle writes
 * `sidebarWidth` on every pointermove, which would otherwise be hundreds of IPC
 * round-trips + SQLite UPSERTs per drag. The cache is updated synchronously
 * (below), so read-after-write stays correct; only the last value per key needs
 * to reach SQLite, once the burst settles.
 */
const PERSIST_DEBOUNCE_MS = 200;

interface PendingWrite {
  value: string;
  failureVerb: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingWrites = new Map<string, PendingWrite>();
const writesInFlight = new Map<string, Promise<boolean>>();

/**
 * Serializes writes to one key, so an older bridge call can never settle after
 * and overwrite a value whose durability a caller already observed.
 */
function persistInOrder(key: string, value: string, failureVerb: string): Promise<boolean> {
  const previous = writesInFlight.get(key);
  const write =
    previous === undefined
      ? persist(key, value, failureVerb)
      : previous.then(() => persist(key, value, failureVerb));
  writesInFlight.set(key, write);
  void write.then(() => {
    if (writesInFlight.get(key) === write) writesInFlight.delete(key);
  });
  return write;
}

function persistDebounced(key: string, value: string, failureVerb: string): void {
  const existing = pendingWrites.get(key);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    void persistInOrder(key, value, failureVerb);
  }, PERSIST_DEBOUNCE_MS);
  pendingWrites.set(key, { value, failureVerb, timer });
}

/**
 * Flushes every pending debounced write immediately — best-effort durability
 * before the window unloads. A pref changed within the debounce window of an
 * app quit would otherwise be lost, where the localStorage this replaced wrote
 * synchronously. The write stays fire-and-forget, so completion before exit
 * isn't guaranteed, but firing now beats waiting out the debounce. Registered
 * on `beforeunload` below.
 */
export function flushPendingAppState(): void {
  for (const [key, pending] of pendingWrites) {
    clearTimeout(pending.timer);
    void persistInOrder(key, pending.value, pending.failureVerb);
  }
  pendingWrites.clear();
}

/**
 * Flushes one key and resolves only when main has acknowledged every write to
 * it that was scheduled before this call. This is the durability barrier for
 * user intent that must survive before its renderer-only source is released;
 * a key with no scheduled write returns `false` rather than inventing an ack.
 */
export function flushPendingAppStateKey(key: string): Promise<boolean> {
  const pending = pendingWrites.get(key);
  if (pending !== undefined) {
    clearTimeout(pending.timer);
    pendingWrites.delete(key);
    return persistInOrder(key, pending.value, pending.failureVerb);
  }
  return writesInFlight.get(key) ?? Promise.resolve(false);
}

// Renderer-only module: flush pending prefs before the window tears down so a
// last-moment zoom/resize isn't dropped by the debounce.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPendingAppState);
}

/**
 * The synchronous face of {@link appStateStorage}: zustand's `StateStorage`
 * type allows Promise returns, but this cache-backed implementation is always
 * sync — direct consumers (the composer's draft cache) depend on that, so it's
 * part of the contract, not an implementation accident.
 */
export interface SyncStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The persist stores' storage adapter (see stores/ui.ts, stores/workspace.ts,
 * stores/chat-drafts.ts).
 */
export const appStateStorage: StateStorage & SyncStateStorage = {
  getItem: (key) => cache.get(key) ?? null,
  setItem: (key, value) => {
    cache.set(key, value);
    persistDebounced(key, value, "save");
  },
  removeItem: (key) => {
    cache.delete(key);
    persistDebounced(key, "", "clear");
  },
};
