/**
 * restty-backed `TerminalEngine`. restty renders a terminal into a canvas via
 * WASM (libghostty-vt) + WebGPU, with automatic WebGL2 fallback. We drive it
 * manually: an in-memory `ptyTransport` (see `createInstance`) bridges restty's
 * WebSocket-oriented API to Electron IPC. `connectPty()` wires it up; PTY output
 * enters through `ptyCallbacks.onData(data)` so it passes restty's output filter
 * (DECSET mouse-mode tracking, OSC handlers, reply state) — `sendInput(data,
 * "pty")` would bypass that, leaving TUIs drawn but blind to pointer input.
 * Everything PTY-bound (keystrokes, mouse reports, terminal replies) flows back
 * out through the transport's `sendInput`.
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
  type PtyCallbacks,
  type Restty,
  type ResttyFontInput,
  type ResttyRuntimeEvent,
  type ResttySurfacePane,
} from "restty";

import { getCurrentAppearance } from "./appearance";
import { polledBackend, sameGpuState, toTerminalBackend } from "./engine";
import type {
  TerminalAppearance,
  TerminalBackend,
  TerminalDimensions,
  TerminalEngine,
  TerminalGpuState,
} from "./engine";
import { currentGpuSession, watchGpuDeviceLoss } from "./gpu-session";
import { heldAltSides, installAltSideTracker, optionAsAltSequence } from "./option-as-alt";

/**
 * Replay-buffer cap. Sized for the device-loss rebuild: enough to restore the
 * visible screen plus recent scrollback, small enough that 20 idle terminals
 * hold at most ~20 MB of UTF-16 between them.
 */
const REPLAY_BUFFER_MAX_CHARS = 512_000;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;

/** Families resolve via Local Font Access, most-preferred first. macOS's
 * Apple Symbols covers the common terminal-symbol blocks, while STIX Two Math
 * fills later Misc Technical codepoints such as U+23FA that Apple Symbols
 * omits. Color emoji remains last and is selected only for emoji presentation. */
/**
 * Deliver `value` to every listener, isolating each one. Two rules, both load-
 * bearing (same reasoning as the registry's `fitLiveEngines`):
 *
 *  1. Iterate a SNAPSHOT. A listener that unsubscribes itself — or re-adds the
 *     same function object — mutates the live Set mid-walk, which skips or
 *     double-fires its neighbours.
 *  2. Catch per listener. A throwing subscriber must not abort the fan-out, and
 *     above all must not escape into the engine's own lifecycle: a throw out of
 *     `dispose()`'s backend announcement would leave the GPU canvas alive, the
 *     engine in the registry, and the caller's remaining PTYs unkilled.
 */
function fanOut<T>(listeners: Iterable<(value: T) => void>, event: string, value: T): void {
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    try {
      listener(value);
    } catch (error) {
      console.warn(`terminal ${event} listener failed:`, error);
    }
  }
}

function resttyFonts(fontFamilies: readonly string[]): ResttyFontInput[] {
  return [
    ...fontFamilies.map((family) => ({ family, local: "prefer" as const })),
    { family: "Apple Symbols", local: "prefer" as const },
    { family: "STIX Two Math", local: "prefer" as const },
    { family: "Apple Color Emoji", local: "prefer" as const },
  ];
}

export class ResttyEngine implements TerminalEngine {
  /** Persistent surface node; re-parented across containers, never recreated. */
  private readonly hostEl: HTMLDivElement;
  private restty: Restty | null = null;
  private pane: ResttySurfacePane | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  /** Coalesced follow-up fit — every fit() re-measures once more next frame. */
  private settleFitFrame: number | null = null;
  /** A fit arrived while hidden (zero-size) or paused; flushed on unpause. */
  private pendingFit = false;
  /** Restty's PTY callbacks are the only public path that runs its output
   * filter (mouse-mode tracking, OSC handlers, reply state) before WASM.
   * Their presence IS the connection state — `isConnected()` derives from it,
   * so the transport can never report connected while replies have nowhere
   * to go (restty drops emulator replies + mouse reports when disconnected). */
  private ptyCallbacks: PtyCallbacks | null = null;

  private readonly dataCbs = new Set<(data: string) => void>();
  private readonly resizeCbs = new Set<(dimensions: TerminalDimensions) => void>();
  private readonly gpuStateCbs = new Set<(state: TerminalGpuState) => void>();
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
  /** Pane-local zoom layered over the live Ghostty-config base size. */
  private fontSizeOffset = 0;
  /** The active renderer backend once known; null until restty resolves it. */
  backend: TerminalBackend | null = null;
  private disposed = false;
  /**
   * The last pair handed to `gpuStateCbs`. Both fields are derived state
   * (`restty`, `backend`), but the dedupe has to compare against what was
   * ANNOUNCED, not against the live values — that is the whole difference
   * between "nothing moved" and "it moved and came back before anyone looked".
   * Starts where a freshly-constructed engine already is, so the first real
   * transition is the first announcement.
   */
  private announcedGpuState: TerminalGpuState = { hasRenderer: false, backend: null };

  /**
   * A renderer exists iff restty does. Distinguishes an engine that holds no
   * GPU context and has asked for none — never attached (headless sessions),
   * mid-rebuild, or disposed — from one whose backend is still resolving.
   */
  get hasRenderer(): boolean {
    return this.restty !== null;
  }

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
    this.ptyCallbacks = null;
    this.restty = createRestty({
      root: this.hostEl,
      // The app-owned session (not restty's module-global default) is what
      // makes device-loss rotation possible — see gpu-session.ts.
      session: currentGpuSession(),
      surface: {
        // Volli owns split geometry and process/session creation. Restty's
        // built-in Cmd+D listener is window-global PER engine, so leaving it
        // enabled splits hidden tabs too and every new pane reuses this
        // engine's single ptyTransport.
        shortcuts: false,
        defaultContextMenu: false,
      },
      terminal: {
        renderer: "auto", // WebGPU with automatic WebGL2 fallback
        fontSize: this.resolvedFontSize(appearance.fontSize),
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
        // The in-memory transport bridges restty's WebSocket-oriented API to
        // Volli's Electron IPC. PTY output MUST enter through callbacks.onData:
        // restty.sendInput(data, "pty") bypasses the output filter that tracks
        // DECSET mouse modes, so TUIs draw but never receive pointer reports.
        ptyTransport: {
          connect: ({ callbacks }) => {
            this.ptyCallbacks = callbacks;
            callbacks.onConnect?.();
          },
          disconnect: () => {
            const callbacks = this.ptyCallbacks;
            this.ptyCallbacks = null;
            callbacks?.onDisconnect?.();
          },
          isConnected: () => this.ptyCallbacks !== null,
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
    // A renderer now exists, so `hasRenderer` just flipped — half of what GPU
    // pressure counts, and on a rebuild that lands on the same backend the ONLY
    // half that moves. Announce here rather than after the wiring below: if any
    // of it throws (a rotation runs right after a device died, which is exactly
    // where restty throws), the registry catches it and readers would otherwise
    // be left believing this engine still holds nothing.
    this.announceGpuState();
    // Registers the transport callbacks used by write()/replay and marks the
    // transport connected so keystrokes, terminal replies, and mouse reports
    // all route back through sendInput above.
    this.restty.connectPty();
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
    for (const chunk of this.recentOutput) this.deliverPtyOutput(chunk);
  }

  /**
   * restty's autoResize measures the canvas and emits `term-size` runtime
   * events; we mirror the grid into `dimensions` and forward it to the host
   * (→ PTY resize). `backend` events reveal which renderer actually won —
   * and WebGPU winning is the cue to arm the device-loss watcher.
   */
  private subscribeRuntimeEvents(): void {
    // Read the backend BEFORE bailing on a missing pane: neither the read nor
    // the device-loss watch needs one, and a renderer that came up without a
    // pane would otherwise sit at `null` forever with nothing left to update
    // it — a caller waiting on `pending` would wait for good.
    //
    // POLLED, so `polledBackend` — NOT `toTerminalBackend` (used on the event
    // below). We are one statement after `createRestty` returned; restty's
    // async init has not run, and its runtime state still holds the `"none"`
    // it was initialised with. Read literally, every terminal would look like
    // "resolved, holds zero contexts" for its whole acquisition window.
    // `polledBackend` folds that to `null` (pending) and the `backend` event
    // below supplies the real answer, `"none"` included.
    this.setBackend(polledBackend(safeBackend(this.restty)));
    if (this.backend === "webgpu") this.armDeviceLossWatch();
    if (this.pane === null) return;
    this.unsubscribeRuntime = this.pane.runtime.events.subscribe((event: ResttyRuntimeEvent) => {
      if (event.type === "term-size") {
        // A hidden (zero-size) canvas is clamped to a degenerate 1×1 grid;
        // ignore it so we never shrink the PTY to a single cell. fit()
        // re-measures on reveal.
        if (event.cols <= 1 || event.rows <= 1) return;
        this.dimensions = { cols: event.cols, rows: event.rows };
        fanOut(this.resizeCbs, "resize", this.dimensions);
      } else if (event.type === "backend") {
        // ANNOUNCED, so `toTerminalBackend` — NOT `polledBackend` (used on the
        // synchronous read above). restty emits this event from exactly one
        // place per outcome, at the end of backend selection, so `"none"` here
        // is the real "tried WebGPU, tried WebGL2, got neither" and must stay
        // resolved: folding it to `null` would leave `pending` un-drainable.
        this.setBackend(toTerminalBackend(event.backend));
        if (this.backend === "webgpu") this.armDeviceLossWatch();
      } else if (event.type === "state" && event.state === "ready") {
        // The first visible fit can happen while restty is still loading fonts,
        // WASM, and its GPU backend. Refit again at the lifecycle boundary
        // where the backing canvas can actually consume the settled geometry —
        // or, if the engine is hidden right now, owe the fit until reveal.
        if (this.paused) this.pendingFit = true;
        else this.fit();
      }
    });
  }

  /** Record a backend transition, then announce the pair it belongs to. */
  private setBackend(backend: TerminalBackend | null): void {
    this.backend = backend;
    this.announceGpuState();
  }

  /**
   * Publish `(hasRenderer, backend)` if it moved since the last announcement.
   * EVERY mutation of `restty` or `backend` ends here — creating the renderer,
   * the rebuild's teardown, dispose — because either field moving changes what
   * this engine costs the GPU, and only the pair says which way.
   *
   * Silent on a repeat: restty re-reports the same backend on every renderer
   * (re)creation, and callers act on these readings. Deduping on `backend`
   * alone is the bug this replaces — see `sameGpuState`.
   */
  private announceGpuState(): void {
    const state: TerminalGpuState = { hasRenderer: this.hasRenderer, backend: this.backend };
    if (sameGpuState(state, this.announcedGpuState)) return;
    this.announcedGpuState = state;
    fanOut(this.gpuStateCbs, "gpu state", state);
  }

  onGpuStateChanged(callback: (state: TerminalGpuState) => void): () => void {
    this.gpuStateCbs.add(callback);
    return () => {
      this.gpuStateCbs.delete(callback);
    };
  }

  private armDeviceLossWatch(): void {
    const canvas = this.hostEl.querySelector("canvas");
    if (canvas !== null) watchGpuDeviceLoss(canvas);
  }

  write(data: string): void {
    if (this.disposed) return;
    this.remember(data);
    this.deliverPtyOutput(data);
  }

  private deliverPtyOutput(data: string): void {
    this.ptyCallbacks?.onData?.(data);
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
    fanOut(this.dataCbs, "input", data);
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
    // Flush any fit that arrived while hidden (DPR change, renderer-ready) so
    // reveal is correct even for hosts that don't pair setPaused with fit().
    if (!paused && this.pendingFit) this.fit();
  }

  fit(): void {
    if (this.disposed || this.restty === null) return;
    this.fitNow();
    // Chromium can hand out geometry/devicePixelRatio one frame before layout
    // and the display association settle (reveal, monitor move, renderer
    // startup). One coalesced next-frame re-measure covers that race for every
    // caller, so no call site needs its own requestAnimationFrame twin.
    if (this.settleFitFrame !== null) window.cancelAnimationFrame(this.settleFitFrame);
    this.settleFitFrame = window.requestAnimationFrame(() => {
      this.settleFitFrame = null;
      this.fitNow();
    });
  }

  private fitNow(): void {
    if (this.disposed || this.restty === null) return;
    const bounds = this.hostEl.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      // A hidden host measures as zero — don't feed restty a degenerate box;
      // owe the fit so unpausing (reveal) applies it instead of losing it.
      this.pendingFit = true;
      return;
    }
    this.pendingFit = false;
    // Re-measure from the (now visible) canvas size and repaint. The follow-up
    // `term-size` event forwards the corrected grid to the PTY.
    this.restty.updateSize(true);
  }

  focus(): void {
    if (this.disposed) return;
    this.restty?.focus();
  }

  adjustFontSize(delta: number): void {
    if (this.disposed || !Number.isFinite(delta) || delta === 0) return;
    const base = getCurrentAppearance().fontSize;
    const next = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, base + this.fontSizeOffset + delta),
    );
    this.fontSizeOffset = next - base;
    this.pane?.runtime.terminal.setFontSize(next);
    this.fit();
    this.focus();
  }

  resetFontSize(): void {
    if (this.disposed) return;
    this.fontSizeOffset = 0;
    this.pane?.runtime.terminal.setFontSize(getCurrentAppearance().fontSize);
    this.fit();
    this.focus();
  }

  private resolvedFontSize(base: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, base + this.fontSizeOffset));
  }

  /** Live re-apply for ghostty config edits (issue #18 live reload). */
  applyAppearance(appearance: TerminalAppearance): void {
    if (this.disposed || this.pane === null) return;
    const terminal = this.pane.runtime.terminal;
    terminal.applyTheme(appearance.theme);
    terminal.setFontSize(this.resolvedFontSize(appearance.fontSize));
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
    if (this.settleFitFrame !== null) window.cancelAnimationFrame(this.settleFitFrame);
    this.settleFitFrame = null;
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
    // Announce the torn-down half AFTER both fields are actually gone, so the
    // pair readers see is `(false, null)` and never a phantom live renderer on
    // a destroyed one. `createInstance` below announces the other half; between
    // the two, callers counting GPU contexts see this engine drop its context
    // and take a fresh one even when the backend it lands on is the one it left.
    this.setBackend(null);
    this.ptyCallbacks = null;
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
    if (this.settleFitFrame !== null) window.cancelAnimationFrame(this.settleFitFrame);
    this.settleFitFrame = null;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    try {
      this.restty?.destroy();
    } catch {
      // Best-effort: a dead GPU device may make teardown throw; the DOM
      // removal below still detaches everything user-visible.
    }
    this.restty = null;
    this.pane = null;
    this.ptyCallbacks = null;
    // Announce the released context AFTER the renderer is actually gone — a
    // reader that folds this engine into a reading must see `hasRenderer`
    // false, not a phantom unresolved context — and BEFORE the listener sets
    // are dropped, or the last reader never learns the context went away. One
    // announcement, of the settled pair: `restty` and `backend` are both
    // already null above, so this is the single edge to `(false, null)`.
    this.setBackend(null);
    this.dataCbs.clear();
    this.resizeCbs.clear();
    this.gpuStateCbs.clear();
    this.recentOutput = [];
    this.recentOutputChars = 0;
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
