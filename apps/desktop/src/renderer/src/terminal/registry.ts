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
import { ResttyEngine } from "./restty-engine";
import type { TerminalEngine } from "./engine";

const engines = new Map<string, TerminalEngine>();

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
