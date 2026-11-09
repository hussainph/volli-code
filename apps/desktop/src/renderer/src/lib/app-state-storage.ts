/**
 * `StateStorage` backed by an in-memory cache + the preload bridge — replaces
 * localStorage for the ui/project-ui zustand `persist` stores now that UI
 * prefs live in SQLite's `app_state` table.
 *
 * `getItem` reads the cache synchronously so the ui/project-ui stores can
 * rehydrate the moment `lib/boot.ts` seeds it from the bootstrap payload — no
 * store construction here ever waits on an IPC round trip. `setItem`/
 * `removeItem` update the cache immediately (so a read-after-write in the
 * same tick sees it) and fire-and-forget the SQLite write, surfacing a
 * failure via a toast (CLAUDE.md: never silently swallow a failed mutation).
 */
import { CHAT_DRAFTS_APP_STATE_KEY, errorMessage } from "@volli/shared";
import type { PersistOptions, StateStorage } from "zustand/middleware";

import { toastError } from "@renderer/lib/toast";
import {
  isSharedPreferenceKey as isSharedPreference,
  mergePreferenceSnapshot,
} from "../../../preference-patch";

const cache = new Map<string, string>();
const preferenceDefaults = new Map<string, string>();

/**
 * A missing row still has a baseline: the store's own partialized defaults.
 * Register before the first mutation, without creating a row or replacing a
 * boot/peer snapshot. Never derive this from the first write: it already
 * contains the edit whose delta another window must preserve.
 */
export function registerSharedPreferenceDefaults<State>(store: {
  getInitialState(): State;
  persist: {
    getOptions(): Pick<Partial<PersistOptions<State, unknown>>, "name" | "version" | "partialize">;
  };
}): void {
  const { name, version = 0, partialize } = store.persist.getOptions();
  if (name === undefined || !isSharedPreference(name)) {
    throw new Error("Only shared presentation stores may register preference defaults.");
  }
  const initial = store.getInitialState();
  preferenceDefaults.set(
    name,
    JSON.stringify({ state: partialize === undefined ? initial : partialize(initial), version }),
  );
}

// Only shared presentation preferences suppress identical writes. Drafts retain
// their explicit durability/acknowledgement semantics, even for identical bytes.
const sharedPreferenceValues = new Map<string, string>();
const preferenceListeners = new Set<(key: string) => void>();
/** Accepted merged preferences repaint their writer as well as other windows. */
export function onPreferenceValueAccepted(listener: (key: string) => void): () => void {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}

/**
 * Fills the cache at boot from the bootstrap payload's raw `app_state` JSON
 * strings. Empty values are skipped: `removeItem` below persists `""` (there
 * is no delete channel), and seeding one back would make `getItem` hand
 * zustand's JSON storage an unparseable empty string on rehydrate.
 */
export function seedAppStateCache(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value !== "") {
      cache.set(key, value);
      acknowledgedValues.delete(key);
      if (isSharedPreference(key)) sharedPreferenceValues.set(key, value);
    }
  }
}

/** Writes through to main and reports whether SQLite acknowledged the value. */
async function persist(
  key: string,
  value: string,
  failureVerb: string,
  baseValue?: string,
): Promise<boolean> {
  try {
    const result =
      isSharedPreference(key) && baseValue !== undefined && value !== ""
        ? await window.api.appState.set(key, value, baseValue)
        : await window.api.appState.set(key, value);
    if (result.ok) {
      if (isSharedPreference(key) && result.value !== undefined) {
        const accepted = result.value;
        // Main merged an independent edit from another window. Retain any
        // newer local intent while adopting that authoritative snapshot.
        cache.set(key, mergePreferenceSnapshot(accepted, value, cache.get(key) ?? value));
        const pending = pendingWrites.get(key);
        if (pending !== undefined) {
          pending.value = mergePreferenceSnapshot(accepted, value, pending.value);
          pending.baseValue = mergePreferenceSnapshot(accepted, value, pending.baseValue ?? value);
        }
        for (const listener of preferenceListeners) listener(key);
      }
      return true;
    } else {
      toastError(`Couldn't ${failureVerb} "${key}": ${result.error}`);
    }
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
  baseValue?: string;
  failureVerb: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingWrites = new Map<string, PendingWrite>();
const writesInFlight = new Map<string, Promise<boolean>>();
/** Last bridge-acknowledged value per key, invalidated as soon as newer intent is scheduled. */
const acknowledgedValues = new Map<string, string>();

/**
 * Serializes writes to one key, so an older bridge call can never settle after
 * and overwrite a value whose durability a caller already observed.
 */
function persistInOrder(
  key: string,
  value: string,
  failureVerb: string,
  baseValue?: string,
): Promise<boolean> {
  acknowledgedValues.delete(key);
  const previous = writesInFlight.get(key);
  const write =
    previous === undefined
      ? persist(key, value, failureVerb, baseValue)
      : previous.then(() => persist(key, value, failureVerb, baseValue));
  writesInFlight.set(key, write);
  void write.then((ok) => {
    if (writesInFlight.get(key) !== write) return;
    writesInFlight.delete(key);
    if (ok && !pendingWrites.has(key)) {
      const accepted = isSharedPreference(key) ? (cache.get(key) ?? value) : value;
      acknowledgedValues.set(key, accepted);
      if (isSharedPreference(key)) sharedPreferenceValues.set(key, accepted);
    }
  });
  return write;
}

function persistDebounced(
  key: string,
  value: string,
  failureVerb: string,
  baseValue?: string,
): void {
  // Zustand persist runs on transient navigation too. An unchanged preference
  // must not overwrite another window's newer accepted value.
  if (
    failureVerb === "save" &&
    isSharedPreference(key) &&
    (sharedPreferenceValues.get(key) ?? preferenceDefaults.get(key)) === value &&
    !pendingWrites.has(key) &&
    !writesInFlight.has(key)
  )
    return;
  acknowledgedValues.delete(key);
  const existing = pendingWrites.get(key);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const pending = pendingWrites.get(key);
    pendingWrites.delete(key);
    if (pending !== undefined)
      void persistInOrder(key, pending.value, pending.failureVerb, pending.baseValue);
  }, PERSIST_DEBOUNCE_MS);
  pendingWrites.set(key, {
    value,
    baseValue: existing === undefined ? baseValue : existing.baseValue,
    failureVerb,
    timer,
  });
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
    void persistInOrder(key, pending.value, pending.failureVerb, pending.baseValue);
  }
  pendingWrites.clear();
}

/**
 * Flushes one key and resolves only when main has acknowledged every write to
 * it that was scheduled before this call. This is the durability barrier for
 * user intent that must survive before its renderer-only source is released;
 * A completed bridge acknowledgement remains valid for the unchanged value;
 * a key never written (or with a newer failed value) still returns `false`.
 */
export function flushPendingAppStateKey(key: string): Promise<boolean> {
  const pending = pendingWrites.get(key);
  if (pending !== undefined) {
    clearTimeout(pending.timer);
    pendingWrites.delete(key);
    return persistInOrder(key, pending.value, pending.failureVerb, pending.baseValue);
  }
  return (
    writesInFlight.get(key) ??
    Promise.resolve(acknowledgedValues.get(key) === (cache.get(key) ?? ""))
  );
}

/**
 * The acknowledged form of {@link flushPendingAppState}: sends every pending
 * write now and resolves once main has answered every write in flight, with
 * whether all of them landed. Main asks for this before it destroys a window
 * without an unload (VC-577: menu-bar mode), where `beforeunload` — and with
 * it the flush below — never fires, and a draft typed inside the debounce
 * window would otherwise exist nowhere but a renderer that is about to go.
 */
export async function flushAllPendingAppState(): Promise<boolean> {
  let ok = true;
  // Each key's in-flight write is the TAIL of its in-order chain
  // (`persistInOrder`), so awaiting it waits out an older write's slow ack
  // and then the latest value's own. Repeated until nothing is pending, so a
  // write scheduled while this waited is answered for too.
  do {
    flushPendingAppState();
    const results = await Promise.all(writesInFlight.values());
    ok = ok && results.every(Boolean);
  } while (pendingWrites.size > 0);
  return ok;
}

/** Accept another window's committed preference, but never clobber local pending intent. */
export function acceptAppStateValue(key: string, value: string): boolean {
  if (pendingWrites.has(key) || writesInFlight.has(key)) return false;
  if (value === "") cache.delete(key);
  else cache.set(key, value);
  if (isSharedPreference(key)) sharedPreferenceValues.set(key, value);
  return true;
}

/** Answers main's flush request through the preload bridge, when there is one. */
export function installAppStateFlushResponder(
  bridge: { onFlushRequest?: (flush: () => Promise<unknown>) => () => void } | undefined,
): void {
  bridge?.onFlushRequest?.(flushAllPendingAppState);
}

// Renderer-only module: flush pending prefs before the window tears down so a
// last-moment zoom/resize isn't dropped by the debounce.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPendingAppState);
  installAppStateFlushResponder(window.api?.appState);
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
  /**
   * Sends this key's pending write NOW instead of waiting out the debounce.
   *
   * For a write whose LOSS is worse than its cost: a value the debounce drops
   * at quit is normally a preference the next launch merely guesses again, but
   * a RETRACTION dropped at quit comes back as the thing it retracted. Optional
   * because it is a property of the durable adapter, not of the cache face a
   * test substitutes; a caller that flushes must work without one.
   */
  flush?(key: string): void;
}

/**
 * The persist stores' storage adapter (see stores/ui.ts, stores/project-ui.ts,
 * stores/chat-drafts.ts).
 */
function ownsDraftStorage(key: string): boolean {
  return (
    key !== CHAT_DRAFTS_APP_STATE_KEY ||
    typeof window === "undefined" ||
    window.location?.hash !== "#settings"
  );
}

export const appStateStorage: StateStorage & SyncStateStorage = {
  getItem: (key) => (ownsDraftStorage(key) ? (cache.get(key) ?? null) : null),
  setItem: (key, value) => {
    if (!ownsDraftStorage(key)) return;
    const baseValue = cache.get(key) ?? preferenceDefaults.get(key);
    cache.set(key, value);
    persistDebounced(key, value, "save", isSharedPreference(key) ? baseValue : undefined);
  },
  removeItem: (key) => {
    if (!ownsDraftStorage(key)) return;
    const baseValue = cache.get(key);
    cache.delete(key);
    persistDebounced(key, "", "clear", isSharedPreference(key) ? baseValue : undefined);
  },
  // Fire-and-forget on purpose: the caller wants the write on its way before
  // the window can close, not an ack it would have to await on a synchronous
  // path. `persist` still reports a failure the ordinary way.
  flush: (key) => {
    void flushPendingAppStateKey(key);
  },
};
