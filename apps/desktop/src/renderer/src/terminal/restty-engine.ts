/**
 * restty-backed `TerminalEngine`. restty renders a terminal into a canvas via
 * WASM (libghostty-vt) + WebGPU, with automatic WebGL2 fallback. We drive it
 * manually (no `connectPty` websocket): PTY output is fed in with
 * `sendInput(data, "pty")`, and user keystrokes are captured in `beforeInput`.
 *
 * Two failure modes this file is built against (see CLAUDE.md):
 *  1. Never destroy a live terminal incidentally. The engine owns a persistent
 *     `hostEl`; `attach` RE-PARENTS that element between containers rather than
 *     recreating restty, so React remounts and keep-alive re-reveals preserve
 *     the live GPU canvas and scrollback.
 *  2. A GPU canvas measures as zero while `display:none`, then renders blank
 *     when shown. `fit()` forces a re-measure + repaint on reveal.
 */
import { createRestty, type Restty, type ResttyRuntimeEvent, type ResttySurfacePane } from "restty";

import { terminalConfig } from "./config";
import type { TerminalDimensions, TerminalEngine } from "./engine";

export class ResttyEngine implements TerminalEngine {
  /** Persistent surface node; re-parented across containers, never recreated. */
  private readonly hostEl: HTMLDivElement;
  private restty: Restty | null = null;
  private pane: ResttySurfacePane | null = null;
  private unsubscribeRuntime: (() => void) | null = null;

  private dataCb: ((data: string) => void) | null = null;
  private resizeCb: ((dimensions: TerminalDimensions) => void) | null = null;
  private dimensions: TerminalDimensions | null = null;
  /** The active renderer backend once known ("webgpu" | "webgl2"). */
  backend: string | null = null;
  private disposed = false;

  constructor() {
    this.hostEl = document.createElement("div");
    // Fill whatever container we are parented into; restty measures this box.
    this.hostEl.style.width = "100%";
    this.hostEl.style.height = "100%";
  }

  attach(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.hostEl.parentElement !== container) {
      container.appendChild(this.hostEl);
    }

    if (this.restty === null) {
      this.restty = createRestty({
        root: this.hostEl,
        terminal: terminalConfig(),
        // Capture keystrokes here and forward them to the PTY. Returning null
        // suppresses restty's local application: a terminal emulator must not
        // echo — the shell/PTY echoes, and we render that echo as `write`
        // output. PTY output itself arrives via `sendInput(_, "pty")` and is
        // passed straight through so the VT parser renders it.
        services: {
          beforeInput: ({ text, source }) => {
            if (source === "pty") return text;
            if (text) this.dataCb?.(text);
            return null;
          },
        },
      });
      this.pane = this.restty.getActivePane();
      this.subscribeRuntimeEvents();
    } else {
      // Re-parenting can leave stale layout; force a re-measure on the new box.
      this.fit();
    }
  }

  /**
   * restty's autoResize measures the canvas and emits `term-size` runtime
   * events; we mirror the grid into `dimensions` and forward it to the host
   * (→ PTY resize). `backend` events reveal which renderer actually won.
   */
  private subscribeRuntimeEvents(): void {
    if (this.pane === null) return;
    this.backend = safeBackend(this.restty);
    this.unsubscribeRuntime = this.pane.runtime.events.subscribe((event: ResttyRuntimeEvent) => {
      if (event.type === "term-size") {
        // A hidden (zero-size) canvas can report a degenerate grid; ignore it
        // so we never shrink the PTY to nothing. fit() re-measures on reveal.
        if (event.cols < 1 || event.rows < 1) return;
        this.dimensions = { cols: event.cols, rows: event.rows };
        this.resizeCb?.(this.dimensions);
      } else if (event.type === "backend") {
        this.backend = event.backend;
      }
    });
  }

  write(data: string): void {
    if (this.disposed) return;
    this.restty?.sendInput(data, "pty");
  }

  onData(callback: (data: string) => void): void {
    this.dataCb = callback;
  }

  onResize(callback: (dimensions: TerminalDimensions) => void): void {
    this.resizeCb = callback;
    if (this.dimensions !== null) callback(this.dimensions);
  }

  getDimensions(): TerminalDimensions | null {
    return this.dimensions;
  }

  fit(): void {
    if (this.disposed || this.restty === null) return;
    // Re-measure from the (now visible) canvas size and repaint. The follow-up
    // `term-size` event forwards the corrected grid to the PTY.
    this.restty.updateSize(true);
  }

  focus(): void {
    if (this.disposed) return;
    this.restty?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.dataCb = null;
    this.resizeCb = null;
    this.restty?.destroy();
    this.restty = null;
    this.pane = null;
    this.hostEl.remove();
  }
}

/** `getBackend()` may throw before the renderer initializes; treat as unknown. */
function safeBackend(restty: Restty | null): string | null {
  if (restty === null) return null;
  try {
    return restty.getBackend();
  } catch {
    return null;
  }
}
