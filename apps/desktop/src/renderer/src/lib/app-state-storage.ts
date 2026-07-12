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
import { toast } from "sonner";
import type { StateStorage } from "zustand/middleware";

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

/** Fire-and-forget write-through; toasts on either a typed failure or a rejected IPC call. */
function persist(key: string, value: string, failureVerb: string): void {
  window.api.appState
    .set(key, value)
    .then((result) => {
      if (!result.ok) toast.error(`Could not ${failureVerb} "${key}": ${result.error}`);
    })
    .catch((error: unknown) => {
      toast.error(`Could not ${failureVerb} "${key}": ${errorMessage(error)}`);
    });
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

function persistDebounced(key: string, value: string, failureVerb: string): void {
  const existing = pendingWrites.get(key);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    persist(key, value, failureVerb);
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
    persist(key, pending.value, pending.failureVerb);
  }
  pendingWrites.clear();
}

// Renderer-only module: flush pending prefs before the window tears down so a
// last-moment zoom/resize isn't dropped by the debounce.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPendingAppState);
}

/** The ui/workspace persist stores' storage adapter (see stores/ui.ts, stores/workspace.ts). */
export const appStateStorage: StateStorage = {
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
