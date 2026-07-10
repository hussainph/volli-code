// Terminal-multiplexer contract shared across the IPC boundary. Type-only,
// except the pure `resolveShell` helper below. The Electron preload may only
// `import type` from here (pack keeps main/preload dependency-disjoint), so
// nothing in this module may pull in Node/Electron/DOM at runtime.

import type { GhosttyTerminalPrefs } from "./ghostty-config";

/** Renderer → main request to boot a PTY session inside a workspace. */
export interface CreateTerminalSessionRequest {
  /** The workspace (tracked project) the session is scoped to. */
  workspaceId: string;
  /** Absolute working directory; validated against the project roots in main. */
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * Result of a create request. Like every IPC result it travels as a typed
 * discriminated union rather than a thrown error — `ipcMain.handle`
 * rejections serialize into useless strings and every failure must be
 * surfaceable in the UI.
 */
export type CreateTerminalSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

/** Result of a fire-and-forget write/resize/kill against an existing session. */
export type TerminalIoResult = { ok: true } | { ok: false; error: string };

/** main → renderer: a chunk of raw PTY output for one session. */
export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

/** main → renderer: the PTY for one session exited. */
export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
}

/** main → renderer: everything the renderer needs to map the user's Ghostty config onto restty. */
export interface GhosttyAppearancePayload {
  prefs: GhosttyTerminalPrefs;
  /** Merged config text in effective last-wins order (renderer overlays its inline color keys); null when no config file exists. */
  configText: string | null;
  /** Raw text of the resolved custom theme file when `theme` named one; null when builtin/absent. */
  themeSource: string | null;
}

export type GhosttyConfigResult =
  | { ok: true; value: GhosttyAppearancePayload }
  | { ok: false; error: string };

/** The shell binary and argv to spawn for a login terminal. */
export interface ResolvedShell {
  file: string;
  args: string[];
}

/**
 * Picks the shell to spawn: the user's `$SHELL` when it is a non-empty
 * string, otherwise a `/bin/zsh` fallback (macOS default). Always a login
 * shell (`-l`) so the PTY inherits the user's full profile — PATH, aliases,
 * toolchain shims the coding agents rely on. Pure so it is unit-testable
 * without spawning anything.
 */
export function resolveShell(env: Record<string, string | undefined>): ResolvedShell {
  const shell = env["SHELL"];
  const file = typeof shell === "string" && shell.length > 0 ? shell : "/bin/zsh";
  return { file, args: ["-l"] };
}
