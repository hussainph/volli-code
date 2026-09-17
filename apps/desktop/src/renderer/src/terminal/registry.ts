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
import { XtermEngine } from "./xterm-engine";
import type { TerminalEngine } from "./engine";

const engines = new Map<string, TerminalEngine>();

function fitLiveEngines(): void {
  for (const engine of engines.values()) {
    try {
      engine.fit();
    } catch (error) {
      // One engine failing to re-measure must not cost the others theirs.
      console.warn("terminal refit failed:", error);
    }
  }
}

// Module-lifetime subscription (the registry IS the app-wide engine list): a
// ghostty config edit re-themes every live terminal in place (issue #18).
// Catching per engine, for `fitLiveEngines`' reason.
const unsubscribeTerminalAppearanceChanged = onTerminalAppearanceChanged(() => {
  const appearance = getCurrentAppearance();
  for (const engine of engines.values()) {
    try {
      engine.applyAppearance?.(appearance);
    } catch (error) {
      // A font family that won't resolve, or a re-theme against a disposed
      // terminal: the other terminals still deserve the user's new config.
      //
      // Logged, not toasted. A pane that missed a re-theme is cosmetic and
      // self-correcting — it keeps rendering with the previous appearance,
      // stays fully usable, and picks the new one up on the next config edit or
      // whenever its terminal is next created. There is nothing for the user to
      // do about it, and a red toast over a font tweak would spend the
      // attention a real failure needs.
      console.warn("terminal appearance reload failed:", error);
    }
  }
});

// Nothing else notices a pure backing-scale change when a window moves between
// displays: the CSS box never moves, so no resize observer fires. Keep the
// recovery at the TerminalEngine seam — every current/future renderer only has
// to implement fit(), while the app owns display lifecycle events.
let unsubscribeDevicePixelRatio: (() => void) | null = null;
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  // fit() itself re-measures once more next frame, covering the window where
  // Chromium reports the new DPR just before the final layout settles.
  unsubscribeDevicePixelRatio = watchDevicePixelRatio(window, fitLiveEngines);
}

// The registry outlives this module: Vite re-evaluates it on every renderer HMR
// edit, and without a teardown each outgoing copy keeps its module-lifetime
// subscriptions forever.
import.meta.hot?.dispose(() => {
  unsubscribeTerminalAppearanceChanged();
  unsubscribeDevicePixelRatio?.();
});

/** The engine for `sessionId`, constructing it on first request. */
export function getOrCreateEngine(sessionId: string): TerminalEngine {
  let engine = engines.get(sessionId);
  if (engine === undefined) {
    engine = new XtermEngine();
    engines.set(sessionId, engine);
  }
  return engine;
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
  // Forget it BEFORE disposing, so a lookup that races the teardown cannot hand
  // anyone an engine whose terminal is already gone.
  engines.delete(sessionId);
  engine.dispose();
}
