/**
 * restty-backed `TerminalEngine`. restty renders a terminal into a canvas via
 * WASM (libghostty-vt) + WebGPU, with automatic WebGL2 fallback. We drive it
 * manually (no `connectPty` websocket): PTY output is fed in with
 * `sendInput(data, "pty")`, and everything PTY-bound flows back out through an
 * injected always-"connected" `ptyTransport` (see `createInstance`).
 *
 * Failure modes this file is built against (see CLAUDE.md):
 *  1. Never destroy a live terminal incidentally. The engine owns a persistent
 *     `hostEl`; `attach` RE-PARENTS that element between containers rather than
 *     recreating restty, so React remounts and keep-alive re-reveals preserve
 *     the live GPU canvas and scrollback.
 *  2. A GPU canvas measures as zero while `display:none`, then renders blank
 *     when shown. `fit()` forces a re-measure + repaint on reveal.
 *  3. GPU device loss (restty has no recovery): the gpu-session module rotates
 *     the shared session and the registry calls `rebuildRenderer()`, which
 *     recreates restty in place and replays `recentOutput` — bounded, so deep
 *     scrollback is sacrificed, but the visible screen and the live shell
 *     survive a GPU process crash.
 */
import {
  createRestty,
  type Restty,
  type ResttyFontInput,
  type ResttyRuntimeEvent,
  type ResttySurfacePane,
} from "restty";

import { getCurrentAppearance } from "./appearance";
import type { TerminalAppearance, TerminalDimensions, TerminalEngine } from "./engine";
import { currentGpuSession, watchGpuDeviceLoss } from "./gpu-session";
import { heldAltSides, installAltSideTracker, optionAsAltSequence } from "./option-as-alt";

/**
 * Replay-buffer cap. Sized for the device-loss rebuild: enough to restore the
 * visible screen plus recent scrollback, small enough that 20 idle terminals
 * hold at most ~20 MB of UTF-16 between them.
 */
const REPLAY_BUFFER_MAX_CHARS = 512_000;

/** Families resolve via Local Font Access, most-preferred first; the emoji
 *  face rides along as a glyph fallback (restty picks per-cluster). */
function resttyFonts(fontFamilies: readonly string[]): ResttyFontInput[] {
  return [
    ...fontFamilies.map((family) => ({ family, local: "prefer" as const })),
    { family: "Apple Color Emoji", local: "prefer" as const },
  ];
}

export class ResttyEngine implements TerminalEngine {
  /** Persistent surface node; re-parented across containers, never recreated. */
  private readonly hostEl: HTMLDivElement;
  private restty: Restty | null = null;
  private pane: ResttySurfacePane | null = null;
  private unsubscribeRuntime: (() => void) | null = null;

  private readonly dataCbs = new Set<(data: string) => void>();
  private readonly resizeCbs = new Set<(dimensions: TerminalDimensions) => void>();
  private dimensions: TerminalDimensions | null = null;
  /**
   * Recent PTY output, capped at REPLAY_BUFFER_MAX_CHARS. Serves two jobs:
   * pre-attach buffering (the shell's first output often lands before the
   * view mounts) and the device-loss rebuild replay.
   */
  private recentOutput: string[] = [];
  private recentOutputChars = 0;
  /** Desired pause state; applied whenever a renderer is (re)created. */
  private paused = false;
  /** The active renderer backend once known ("webgpu" | "webgl2"). */
  backend: string | null = null;
  private disposed = false;

  constructor() {
    this.hostEl = document.createElement("div");
    // Fill whatever container we are parented into; restty measures this box.
    this.hostEl.style.width = "100%";
    this.hostEl.style.height = "100%";
    // ghostty `macos-option-as-alt`: capture-phase so the remapped chord
    // never reaches restty's own key encoding (which would emit ESC + the
    // macOS composed character — see option-as-alt.ts).
    installAltSideTracker(window);
    this.hostEl.addEventListener("keydown", this.onKeyDownCapture, true);
  }

  attach(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.hostEl.parentElement !== container) {
      container.appendChild(this.hostEl);
    }
    if (this.restty === null) {
      this.createInstance();
    } else {
      // Re-parenting can leave stale layout; force a re-measure on the new box.
      this.fit();
    }
  }

  /** Create the restty renderer inside hostEl and replay buffered output. */
  private createInstance(): void {
    const appearance = getCurrentAppearance();
    this.restty = createRestty({
      root: this.hostEl,
      // The app-owned session (not restty's module-global default) is what
      // makes device-loss rotation possible — see gpu-session.ts.
      session: currentGpuSession(),
      terminal: {
        renderer: "auto", // WebGPU with automatic WebGL2 fallback
        fontSize: appearance.fontSize,
        fonts: resttyFonts(appearance.fontFamilies),
        theme: appearance.theme,
        ligatures: appearance.ligatures,
        ...(appearance.scrollbackLimitBytes !== null
          ? { maxScrollbackBytes: appearance.scrollbackLimitBytes }
          : {}),
        // restty owns auto-sizing: it measures the canvas and emits `term-size`
        // runtime events, which the engine forwards to the PTY.
        autoResize: true,
      },
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
            if (this.dataCbs.size === 0) return false;
            this.emitData(data);
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
    if (!getCurrentAppearance().mouseReporting) {
      this.pane?.runtime.interaction.setMouseMode("off");
    }
    if (this.paused) this.pane?.runtime.terminal.setPaused(true);
    // Replay in order. On first attach this is the pre-mount buffer; on a
    // device-loss rebuild it restores the visible screen. Chunks can split
    // escape sequences at the trim boundary — the VT parser tolerates it,
    // at worst the oldest replayed line renders garbled.
    for (const chunk of this.recentOutput) this.restty.sendInput(chunk, "pty");
  }

  /**
   * restty's autoResize measures the canvas and emits `term-size` runtime
   * events; we mirror the grid into `dimensions` and forward it to the host
   * (→ PTY resize). `backend` events reveal which renderer actually won —
   * and WebGPU winning is the cue to arm the device-loss watcher.
   */
  private subscribeRuntimeEvents(): void {
    if (this.pane === null) return;
    this.backend = safeBackend(this.restty);
    if (this.backend === "webgpu") this.armDeviceLossWatch();
    this.unsubscribeRuntime = this.pane.runtime.events.subscribe((event: ResttyRuntimeEvent) => {
      if (event.type === "term-size") {
        // A hidden (zero-size) canvas is clamped to a degenerate 1×1 grid;
        // ignore it so we never shrink the PTY to a single cell. fit()
        // re-measures on reveal.
        if (event.cols <= 1 || event.rows <= 1) return;
        this.dimensions = { cols: event.cols, rows: event.rows };
        for (const cb of this.resizeCbs) cb(this.dimensions);
      } else if (event.type === "backend") {
        this.backend = event.backend;
        if (event.backend === "webgpu") this.armDeviceLossWatch();
      }
    });
  }

  private armDeviceLossWatch(): void {
    const canvas = this.hostEl.querySelector("canvas");
    if (canvas !== null) watchGpuDeviceLoss(canvas);
  }

  write(data: string): void {
    if (this.disposed) return;
    this.remember(data);
    this.restty?.sendInput(data, "pty");
  }

  /** Append to the replay buffer, trimming whole chunks past the cap. */
  private remember(data: string): void {
    this.recentOutput.push(data);
    this.recentOutputChars += data.length;
    while (this.recentOutputChars > REPLAY_BUFFER_MAX_CHARS && this.recentOutput.length > 1) {
      this.recentOutputChars -= this.recentOutput.shift()!.length;
    }
  }

  private emitData(data: string): void {
    for (const cb of this.dataCbs) cb(data);
  }

  private readonly onKeyDownCapture = (event: KeyboardEvent): void => {
    const sides = heldAltSides();
    const seq = optionAsAltSequence(
      event,
      getCurrentAppearance().macosOptionAsAlt,
      sides.left,
      sides.right,
    );
    if (seq === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.emitData(seq);
  };

  onData(callback: (data: string) => void): () => void {
    this.dataCbs.add(callback);
    return () => {
      this.dataCbs.delete(callback);
    };
  }

  onResize(callback: (dimensions: TerminalDimensions) => void): () => void {
    this.resizeCbs.add(callback);
    if (this.dimensions !== null) callback(this.dimensions);
    return () => {
      this.resizeCbs.delete(callback);
    };
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

  /** Live re-apply for ghostty config edits (issue #18 live reload). */
  applyAppearance(appearance: TerminalAppearance): void {
    if (this.disposed || this.pane === null) return;
    const terminal = this.pane.runtime.terminal;
    terminal.applyTheme(appearance.theme);
    terminal.setFontSize(appearance.fontSize);
    terminal.setLigatures(appearance.ligatures);
    terminal.setFonts(resttyFonts(appearance.fontFamilies)).catch((error: unknown) => {
      // A family that fails to resolve keeps the previous faces — worth a
      // log, not a toast, since the terminal remains fully usable.
      console.warn("terminal font reload failed:", error);
    });
    this.pane.runtime.interaction.setMouseMode(appearance.mouseReporting ? "auto" : "off");
    // scrollbackLimitBytes is init-only; new renderers pick it up.
  }

  /** Recreate the renderer after a GPU device loss (session already rotated). */
  rebuildRenderer(): void {
    if (this.disposed || this.restty === null) return;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    try {
      this.restty.destroy();
    } catch {
      // Teardown against a dead GPU device may throw; the replacement
      // renderer below doesn't care.
    }
    this.restty = null;
    this.pane = null;
    this.backend = null;
    // Detached engines (created, never attached) just wait for attach —
    // createInstance needs a laid-out host to measure.
    if (this.hostEl.parentElement !== null) {
      this.createInstance();
      this.fit();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hostEl.removeEventListener("keydown", this.onKeyDownCapture, true);
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.dataCbs.clear();
    this.resizeCbs.clear();
    this.recentOutput = [];
    this.recentOutputChars = 0;
    try {
      this.restty?.destroy();
    } catch {
      // Best-effort: a dead GPU device may make teardown throw; the DOM
      // removal below still detaches everything user-visible.
    }
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
