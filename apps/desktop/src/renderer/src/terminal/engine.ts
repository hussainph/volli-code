/**
 * The renderer-side terminal seam (CONCEPT.md decision #23: keep the terminal
 * renderer swappable). Everything above this interface — the sessions layer,
 * tab strip, PTY piping — talks only to `TerminalEngine`, so the concrete
 * renderer (xterm.js today, through its DOM renderer) can change without
 * touching the host. Deliberately DOM-facing but renderer-agnostic.
 *
 * Grid ownership: the engine measures its own container and owns the cols/rows
 * grid. The host does NOT compute dimensions; it subscribes via `onResize` and
 * forwards the reported grid to the PTY. `write` feeds PTY output IN; `onData`
 * reports user keystrokes to forward OUT.
 */
import type { GhosttyTheme } from "@volli/shared";

/** Terminal grid dimensions in character cells. */
export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/**
 * The resolved appearance every terminal renders with, derived from the
 * user's real Ghostty config (issue #18) with app-token fallbacks. Ghostty's
 * theme format is the app's terminal-appearance lingua franca (decision #26
 * made ghostty the reference emulator); a non-ghostty engine maps FROM this
 * shape rather than inventing its own config language.
 */
export interface TerminalAppearance {
  theme: GhosttyTheme;
  /** Preferred font families in order; engines resolve them against locally
   *  installed fonts however their font loader works. */
  fontFamilies: string[];
  /** Font size in CSS pixels. */
  fontSize: number;
  /** Programming-ligature shaping (ghostty `font-feature` calt/liga subset).
   *  Carried through the chain but not currently rendered — see the accepted
   *  losses at the top of `xterm-engine.ts`. */
  ligatures: boolean;
  /** Whether apps may receive mouse reports (ghostty `mouse-reporting`). */
  mouseReporting: boolean;
  /** ghostty `macos-option-as-alt`: which Option key produces ESC-prefixed
   *  input instead of macOS composed characters. */
  macosOptionAsAlt: "left" | "right" | boolean;
  /** ghostty `scrollback-limit` in bytes; null = engine default. Applies to
   *  live terminals as well as new ones — the engine converts it to a line
   *  budget it can resize into (see `scrollbackLines`). */
  scrollbackLimitBytes: number | null;
}

export interface TerminalEngine {
  /**
   * Mount (or re-parent) the engine's rendered surface into `container`.
   * Idempotent and re-parent-safe: the engine keeps a persistent host element
   * so switching containers (React remounts, keep-alive re-reveals) never
   * destroys the live terminal.
   */
  attach(container: HTMLElement): void;

  /** Feed a chunk of raw PTY output (ANSI intact) into the terminal. */
  write(data: string): void;

  /**
   * Subscribe to user input (already-encoded bytes) to forward to the PTY.
   * Multi-subscriber: a transcript recorder can listen alongside the PTY
   * writer. Returns the unsubscribe function — hosts MUST call it on
   * effect cleanup or StrictMode's double-mount forwards every keystroke
   * twice.
   */
  onData(callback: (data: string) => void): () => void;

  /**
   * Subscribe to grid-size changes; fires immediately if a size is known.
   * Multi-subscriber; returns the unsubscribe function (see onData).
   */
  onResize(callback: (dimensions: TerminalDimensions) => void): () => void;

  /**
   * Tell the engine whether its surface is on screen. PTY output is parsed
   * either way, so the buffer stays current while hidden; what an engine owes
   * this call is that revealing it (`setPaused(false)`) applies any fit that
   * could not be taken against a zero-size host. Callable before `attach` and
   * after `dispose` (no-op).
   */
  setPaused(paused: boolean): void;

  /**
   * Re-measure the container and repaint. Call after revealing a previously
   * hidden (display:none, zero-size) terminal. Implementations own settle
   * timing: a fit that lands while hidden is applied on the next unpause, and
   * the measurement is repeated once geometry has settled.
   */
  fit(): void;

  focus(): void;

  /** Adjust only this pane's font size, preserving the Ghostty-config base. */
  adjustFontSize(delta: number): void;

  /** Reset only this pane to the current Ghostty-config font size. */
  resetFontSize(): void;

  /**
   * Re-apply a changed appearance to the LIVE terminal (theme, font size,
   * fonts, scrollback, mouse mode) without recreating it — the live-reload
   * path for ghostty config edits. Optional: an engine without runtime
   * knobs simply renders new sessions with the new appearance.
   */
  applyAppearance?(appearance: TerminalAppearance): void;

  /** Tear down the terminal and release its resources. Terminal use only. */
  dispose(): void;
}
