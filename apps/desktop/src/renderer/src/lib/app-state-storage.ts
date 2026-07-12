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

/** The ui/workspace persist stores' storage adapter (see stores/ui.ts, stores/workspace.ts). */
export const appStateStorage: StateStorage = {
  getItem: (key) => cache.get(key) ?? null,
  setItem: (key, value) => {
    cache.set(key, value);
    persist(key, value, "save");
  },
  removeItem: (key) => {
    cache.delete(key);
    persist(key, "", "clear");
  },
};
