/**
 * restty-backed `TerminalEngine`. restty renders a terminal into a canvas via
 * WASM (libghostty-vt) + WebGPU, with automatic WebGL2 fallback. We drive it
 * manually (no `connectPty` websocket): PTY output is fed in with
 * `sendInput(data, "pty")`, and everything PTY-bound flows back out through an
 * injected always-"connected" `ptyTransport` (see `attach`).
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
  /** PTY output that arrived before `attach` created restty; replayed in order. */
  private pendingWrites: string[] = [];
  /** Desired pause state; applied on attach if set before restty exists. */
  private paused = false;
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
        services: {
          // An always-"connected" transport is the single path for ALL
          // PTY-bound bytes, and it must stay that way:
          //  - restty flushes emulator replies (CPR/DA/OSC color/clipboard,
          //    mouse reports) to `sendInput` ONLY while `isConnected()` is
          //    true — a disconnected transport silently drops them.
          //  - keystrokes/pastes route through restty's `sendKeyInput`, which
          //    runs `mapKeyForPty` (backspace → \x7f, enter → \r, kitty
          //    legacy-compat) and, while connected, SKIPS local application —
          //    the PTY echo we render via `write` is the only echo. Do not
          //    also forward keys from a `beforeInput` hook: it runs before
          //    the transport send, so a null return would starve this path
          //    and a non-null return would double-send.
          ptyTransport: {
            connect: () => {},
            disconnect: () => {},
            isConnected: () => true,
            sendInput: (data) => {
              if (this.dataCb === null) return false;
              this.dataCb(data);
              return true;
            },
            // On every grid change restty calls this AND emits a `term-size`
            // runtime event; the runtime event is the one authoritative
            // PTY-resize path (see subscribeRuntimeEvents), so this no-ops
            // to avoid a double resize.
            resize: () => true,
          },
        },
      });
      this.pane = this.restty.getActivePane();
      this.subscribeRuntimeEvents();
      if (this.paused) this.pane?.runtime.terminal.setPaused(true);
      const buffered = this.pendingWrites;
      this.pendingWrites = [];
      for (const chunk of buffered) this.restty.sendInput(chunk, "pty");
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
        // A hidden (zero-size) canvas is clamped to a degenerate 1×1 grid;
        // ignore it so we never shrink the PTY to a single cell. fit()
        // re-measures on reveal.
        if (event.cols <= 1 || event.rows <= 1) return;
        this.dimensions = { cols: event.cols, rows: event.rows };
        this.resizeCb?.(this.dimensions);
      } else if (event.type === "backend") {
        this.backend = event.backend;
      }
    });
  }

  write(data: string): void {
    if (this.disposed) return;
    if (this.restty === null) {
      // The shell's first output often lands before the view mounts; buffer
      // until attach creates restty, then replay in order.
      this.pendingWrites.push(data);
      return;
    }
    this.restty.sendInput(data, "pty");
  }

  onData(callback: (data: string) => void): void {
    this.dataCb = callback;
  }

  onResize(callback: (dimensions: TerminalDimensions) => void): void {
    this.resizeCb = callback;
    if (this.dimensions !== null) callback(this.dimensions);
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.paused = paused;
    // Skips repaints + GPU ticks; PTY parsing continues, so the buffer stays
    // current while hidden.
    this.pane?.runtime.terminal.setPaused(paused);
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
    this.pendingWrites = [];
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
