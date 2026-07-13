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

function fitLiveEngines(): void {
  for (const engine of engines.values()) engine.fit();
}

// Module-lifetime subscriptions (the registry IS the app-wide engine list):
// a GPU session rotation rebuilds every live renderer against the fresh
// device, and a ghostty config edit re-themes them in place (issue #18).
onGpuSessionRotated(() => {
  for (const engine of engines.values()) engine.rebuildRenderer?.();
});
onTerminalAppearanceChanged(() => {
  const appearance = getCurrentAppearance();
  for (const engine of engines.values()) engine.applyAppearance?.(appearance);
});

// restty's ResizeObserver catches CSS-size changes, but not a pure backing-scale
// change when a window moves between displays. Keep the recovery at the
// TerminalEngine seam: every current/future renderer only has to implement
// fit(), while the app owns display lifecycle events.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  watchDevicePixelRatio(window, () => {
    fitLiveEngines();
    // Chromium can report the new DPR just before the final layout settles.
    // Refit once more at the next paint boundary for that presentation race.
    window.requestAnimationFrame(fitLiveEngines);
  });
}

/** The engine for `sessionId`, constructing it on first request. */
export function getOrCreateEngine(sessionId: string): TerminalEngine {
  let engine = engines.get(sessionId);
  if (engine === undefined) {
    engine = new ResttyEngine();
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
  engine.dispose();
  engines.delete(sessionId);
}
