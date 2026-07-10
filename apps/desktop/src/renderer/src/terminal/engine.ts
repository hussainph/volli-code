/**
 * The renderer-side terminal seam (CONCEPT.md decision #23: keep the terminal
 * renderer swappable). Everything above this interface — the sessions layer,
 * tab strip, PTY piping — talks only to `TerminalEngine`, so the concrete
 * renderer (restty today; ghostty-web or xterm.js tomorrow) can change without
 * touching the host. Deliberately DOM-facing but renderer-agnostic.
 *
 * Grid ownership: the engine measures its own container and owns the cols/rows
 * grid (like xterm.js + a fit addon). The host does NOT compute dimensions; it
 * subscribes via `onResize` and forwards the reported grid to the PTY. `write`
 * feeds PTY output IN; `onData` reports user keystrokes to forward OUT.
 */

/** Terminal grid dimensions in character cells. */
export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalEngine {
  /**
   * Mount (or re-parent) the engine's rendered surface into `container`.
   * Idempotent and re-parent-safe: the engine keeps a persistent host element
   * so switching containers (React remounts, keep-alive re-reveals) never
   * destroys the live GPU canvas.
   */
  attach(container: HTMLElement): void;

  /** Feed a chunk of raw PTY output (ANSI intact) into the terminal. */
  write(data: string): void;

  /** Subscribe to user input (already-encoded bytes) to forward to the PTY. */
  onData(callback: (data: string) => void): void;

  /** Subscribe to grid-size changes; fires immediately if a size is known. */
  onResize(callback: (dimensions: TerminalDimensions) => void): void;

  /** The last measured grid, or null before the first layout. */
  getDimensions(): TerminalDimensions | null;

  /**
   * Re-measure the container and repaint. Call after revealing a previously
   * hidden (display:none, zero-size) terminal — a hidden GPU canvas measures
   * as zero and must be refit on show.
   */
  fit(): void;

  focus(): void;

  /** Tear down the renderer and release GPU resources. Terminal use only. */
  dispose(): void;
}
