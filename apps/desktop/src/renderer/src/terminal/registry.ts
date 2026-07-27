/**
 * Module-level registry of live terminal engines, keyed by sessionId. Living
 * OUTSIDE the React tree is the whole point: engines must survive every
 * incidental unmount — nav switches, project switches, Settings, and React
 * StrictMode's dev double-mount — and only ever die on an explicit tab close
 * or project removal (CLAUDE.md: never unmount a live terminal incidentally).
 *
 * The React layer treats this as get-or-create: a `TerminalView` looks its
 * engine up here on mount and re-parents it into the freshly-rendered
 * container, instead of constructing a new one.
 */
import { getCurrentAppearance, onTerminalAppearanceChanged } from "./appearance";
import { watchDevicePixelRatio } from "./device-pixel-ratio";
import { onGpuSessionRotated } from "./gpu-session";
import { ResttyEngine } from "./restty-engine";
import type { TerminalEngine } from "./engine";

const engines = new Map<string, TerminalEngine>();
const membershipListeners = new Set<() => void>();

/**
 * Tell every watcher the engine set changed. Snapshot AND per-listener catch —
 * the fan-outs below need only the catch (they walk engines, which nothing they
 * call can add to or remove from mid-walk), while this one walks a listener set
 * a listener can mutate: unsubscribing itself mid-walk would skip its
 * neighbour. The catch is the shared part: a THROWING watcher must never abort
 * the create/dispose it was merely observing — an exception escaping
 * `disposeEngine` would strand the caller's remaining PTYs unkilled.
 */
function announceMembership(): void {
  const watchers = [...membershipListeners];
  for (const listener of watchers) {
    try {
      listener();
    } catch (error) {
      console.warn("terminal engine-set listener failed:", error);
    }
  }
}

function fitLiveEngines(): void {
  for (const engine of engines.values()) {
    try {
      engine.fit();
    } catch (error) {
      // A display hop can kill one engine's GPU device mid-refit; the others
      // must still get theirs. Device-loss recovery arrives separately via
      // gpu-session rotation.
      console.warn("terminal refit failed:", error);
    }
  }
}

// Module-lifetime subscriptions (the registry IS the app-wide engine list):
// a GPU session rotation rebuilds every live renderer against the fresh
// device, and a ghostty config edit re-themes them in place (issue #18).
// Both fan-outs catch per engine, for `fitLiveEngines`' reason sharpened by
// when they run. A rotation fires right after a GPU device died, and rebuilding
// against a freshly-crashed device is exactly where `createRestty` throws — one
// unlucky engine must not cost engines #2..N their renderer and leave them
// permanently blank. Worse, the throw would escape `rotate()` into
// gpu-session's `.catch()`, which drops it: silent, and the recovery never
// completes.
onGpuSessionRotated(() => {
  for (const engine of engines.values()) {
    try {
      engine.rebuildRenderer?.();
    } catch (error) {
      console.warn("terminal renderer rebuild failed:", error);
    }
  }
});
onTerminalAppearanceChanged(() => {
  const appearance = getCurrentAppearance();
  for (const engine of engines.values()) {
    try {
      engine.applyAppearance?.(appearance);
    } catch (error) {
      // A font family that won't resolve, or a re-theme against a dead pane:
      // the other terminals still deserve the user's new config.
      console.warn("terminal appearance reload failed:", error);
    }
  }
});

// restty's ResizeObserver catches CSS-size changes, but not a pure backing-scale
// change when a window moves between displays. Keep the recovery at the
// TerminalEngine seam: every current/future renderer only has to implement
// fit(), while the app owns display lifecycle events.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  // fit() itself re-measures once more next frame, covering the window where
  // Chromium reports the new DPR just before the final layout settles.
  watchDevicePixelRatio(window, fitLiveEngines);
}

/** The engine for `sessionId`, constructing it on first request. */
export function getOrCreateEngine(sessionId: string): TerminalEngine {
  let engine = engines.get(sessionId);
  if (engine === undefined) {
    engine = new ResttyEngine();
    engines.set(sessionId, engine);
    announceMembership();
  }
  return engine;
}

/**
 * Every live engine, in creation order. A snapshot array rather than
 * `engines.values()`: a Map iterator is single-pass, and one escaping this
 * module would read as empty the second time a caller walked it.
 */
export function liveEngines(): readonly TerminalEngine[] {
  return [...engines.values()];
}

/**
 * Subscribe to the engine set growing or shrinking. Paired with `liveEngines`
 * this is the whole read seam over the registry — gpu-pressure.ts is built on
 * exactly these two and nothing else.
 */
export function onLiveEnginesChanged(listener: () => void): () => void {
  membershipListeners.add(listener);
  return () => {
    membershipListeners.delete(listener);
  };
}

/**
 * Lookup only — for the PTY-output dispatch path, which must NEVER construct:
 * get-or-create there would leak a fresh engine for every event that races a
 * session close.
 */
export function getEngine(sessionId: string): TerminalEngine | undefined {
  return engines.get(sessionId);
}

/** Dispose and forget an engine. Call only when its session is truly gone. */
export function disposeEngine(sessionId: string): void {
  const engine = engines.get(sessionId);
  if (engine === undefined) return;
  // Forget it BEFORE disposing. `dispose()` announces the released backend, and
  // anything folding the registry into a reading (gpu-pressure) recomputes from
  // `liveEngines()` on that event — with the dying engine still in the map it
  // would publish a reading that counts a destroyed terminal as a live one,
  // ahead of the corrected reading `announceMembership()` triggers below.
  engines.delete(sessionId);
  engine.dispose();
  announceMembership();
}
