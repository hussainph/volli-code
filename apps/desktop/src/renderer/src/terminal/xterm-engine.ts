/**
 * xterm.js-backed `TerminalEngine`, rendered by xterm's DOM renderer.
 *
 * DOM, deliberately (VC-107). The renderer before this one drew the grid into
 * a WebGPU canvas, which bought GPU text at the cost of a whole apparatus the
 * app had to own: a shared device to lose, per-terminal GL contexts to count
 * against Chromium's cap, a device-loss rotation, and glyphs the app
 * rasterized itself. xterm's DOM renderer has none of that — Chromium draws
 * the text, so there is no device, no context budget, and no fallback ladder.
 * There is also no WebGL addon here on purpose: adding one would put the whole
 * apparatus back for a grid this app never renders faster than the user reads.
 *
 * Ghostty stays the appearance source: this file maps FROM `TerminalAppearance`
 * (theme, fonts, size, scrollback, mouse reporting, Option-as-Alt) onto xterm
 * options, and `xterm-appearance.ts` holds every rule that can be stated
 * without a live terminal.
 *
 * Failure modes this file is built against (see CLAUDE.md):
 *  1. Never destroy a live terminal incidentally. The engine owns a persistent
 *     `hostEl`; `attach` RE-PARENTS that element between containers rather than
 *     rebuilding the terminal, so React remounts and keep-alive re-reveals
 *     preserve the live grid and its scrollback.
 *  2. A hidden host measures as zero. xterm itself tolerates being opened
 *     inside `display:none` — it measures cell size off text metrics rather
 *     than layout — but the fit addon reads the host's computed box, where a
 *     percentage height resolves to a meaningless number while hidden. So a
 *     fit against a zero-size host is OWED (`pendingFit`) and flushed on
 *     reveal, never applied against the degenerate box.
 *
 * Accepted losses, stated where they are lost rather than only in the ticket:
 *  - LIGATURES. `TerminalAppearance.ligatures` maps to nothing. The DOM
 *    renderer draws per-cell spans, and xterm's ligature addon reaches for
 *    Node's `fs` to read the font file, which a sandboxed renderer has no
 *    business doing. Ghostty's `font-feature` still parses and is still
 *    carried through the appearance chain; it simply does not reach a glyph.
 *  - BINARY INPUT. xterm reports the legacy X10 / UTF-8 (DECSET 1005) mouse
 *    encodings through `onBinary` as raw bytes above 127, and this app's PTY
 *    write path is a UTF-8 string bridge that would mangle them. Only
 *    `onData` is forwarded. Every current TUI negotiates SGR 1006, which is
 *    plain ASCII and arrives on `onData`.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

import { getCurrentAppearance } from "./appearance";
import { heldAltSides, installAltSideTracker, optionAsAltSequence } from "./option-as-alt";
import {
  clampFontSize,
  isMouseTrackingOnly,
  macOptionIsMeta,
  scrollbackLines,
  xtermFontFamily,
  xtermTheme,
} from "./xterm-appearance";
import type { TerminalAppearance, TerminalDimensions, TerminalEngine } from "./engine";

/**
 * Pre-attach buffer cap, in UTF-16 code units. This buffer exists for exactly
 * one window — between the PTY starting and the view first mounting — because
 * the shell's banner and first prompt land before there is a terminal to write
 * them into. It is emptied on that first attach and never refilled (xterm's own
 * scrollback owns history from then on), so the cap only has to cover a login
 * shell's opening output for a session nobody has looked at yet.
 */
const PREATTACH_BUFFER_MAX_CHARS = 64_000;

/**
 * Deliver `value` to every listener, isolating each one. Two rules, both
 * load-bearing (same reasoning as the registry's `fitLiveEngines`):
 *
 *  1. Iterate a SNAPSHOT. A listener that unsubscribes itself — or re-adds the
 *     same function object — mutates the live Set mid-walk, which skips or
 *     double-fires its neighbours.
 *  2. Catch per listener. A throwing subscriber must not abort the fan-out, and
 *     above all must not escape into the engine's own lifecycle: a throw out of
 *     a resize announcement would leave the caller's remaining PTYs unresized.
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

export class XtermEngine implements TerminalEngine {
  /** Persistent surface node; re-parented across containers, never recreated. */
  private readonly hostEl: HTMLDivElement;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  /** The DECSET filter installed while `mouse-reporting = false`; see below. */
  private mouseFilter: IDisposable | null = null;
  /** Watches the host's box; see `createInstance`. */
  private resizeObserver: ResizeObserver | null = null;
  /** Coalesced follow-up fit — every fit() re-measures once more next frame. */
  private settleFitFrame: number | null = null;
  /** A fit arrived while hidden (zero-size) or paused; flushed on unpause. */
  private pendingFit = false;

  private readonly dataCbs = new Set<(data: string) => void>();
  private readonly resizeCbs = new Set<(dimensions: TerminalDimensions) => void>();
  private dimensions: TerminalDimensions | null = null;
  /** PTY output that arrived before the terminal existed; see the cap above. */
  private preAttachOutput: string[] = [];
  private preAttachChars = 0;
  /** Pane-local zoom layered over the live Ghostty-config base size. */
  private fontSizeOffset = 0;
  private disposed = false;

  constructor() {
    this.hostEl = document.createElement("div");
    // Fill whatever container we are parented into; the fit addon measures this
    // box (via xterm's own element, whose parent this is).
    this.hostEl.style.width = "100%";
    this.hostEl.style.height = "100%";
    // Window-wide and installed once: which Option key is held is global state,
    // and only the keydown on Option itself carries the side (see
    // option-as-alt.ts).
    installAltSideTracker(window);
  }

  attach(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.hostEl.parentElement !== container) {
      container.appendChild(this.hostEl);
    }
    if (this.term === null) {
      this.createInstance();
    } else {
      // Re-parenting can leave stale layout; force a re-measure on the new box.
      this.fit();
    }
  }

  /** Build the terminal inside hostEl and flush the pre-attach buffer. */
  private createInstance(): void {
    const appearance = getCurrentAppearance();
    const term = new Terminal({
      // Required by the Unicode 11 addon below: `term.unicode` is marked
      // experimental, and reading it throws without this. Nothing else here
      // uses a proposed API.
      allowProposedApi: true,
      // The app paints the terminal's background itself; a transparent grid
      // would cost a compositing pass per cell for nothing.
      allowTransparency: false,
      cursorBlink: false,
      fontFamily: xtermFontFamily(appearance.fontFamilies),
      fontSize: this.resolvedFontSize(appearance.fontSize),
      // Ghostty lets Option-drag select even while a TUI is tracking the mouse,
      // which is the only way to copy out of one.
      macOptionClickForcesSelection: true,
      macOptionIsMeta: macOptionIsMeta(appearance.macosOptionAsAlt),
      scrollOnUserInput: true,
      scrollback: scrollbackLines(appearance.scrollbackLimitBytes),
      theme: xtermTheme(appearance.theme),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    // Unicode 11 widths — the addon only REGISTERS the table; this line is what
    // selects it, and without it a terminal drawing modern emoji and CJK puts
    // the cursor one cell off for the rest of the line. `term.unicode` is the
    // proposed API `allowProposedApi` above is set for.
    term.unicode.activeVersion = "11";

    term.onData((data) => {
      this.emitData(data);
    });
    term.onResize(({ cols, rows }) => {
      // xterm clamps to a minimum 2x1 grid; a host that measured badly can
      // still produce a degenerate one, and shrinking a PTY to a single cell
      // reflows a TUI into rubble it never recovers from.
      if (cols <= 1 || rows <= 1) return;
      this.dimensions = { cols, rows };
      fanOut(this.resizeCbs, "resize", this.dimensions);
    });
    term.attachCustomKeyEventHandler(this.handleKeyEvent);

    // Safe while the host is `display:none` (a background tab's first attach):
    // xterm measures cell size from text metrics rather than from layout, so
    // the grid it opens with is real and `fit()` on reveal corrects it.
    term.open(this.hostEl);
    this.term = term;
    this.fitAddon = fitAddon;
    this.applyMouseReporting(appearance.mouseReporting);
    // xterm has NO auto-resize of its own — unlike the renderer this replaces,
    // which observed its own root. Most of the ways a terminal's box changes
    // raise no other signal the app can hear: dragging a split divider,
    // toggling the sidebar, resizing the window, revealing a pane. Without this
    // the grid stays whatever it was first fit to, the PTY keeps the size it
    // was born with, and every TUI in it draws to the wrong width.
    //
    // Safe against a feedback loop: the host is 100%x100% of its container, so
    // nothing xterm draws inside it can change the box being observed.
    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.hostEl);

    // In order, then dropped: from here on xterm's own buffer is the history.
    // Chunks can split an escape sequence at a trim boundary — the VT parser
    // tolerates it, at worst the oldest replayed line renders garbled.
    for (const chunk of this.preAttachOutput) term.write(chunk);
    this.preAttachOutput = [];
    this.preAttachChars = 0;
    this.fit();
  }

  write(data: string): void {
    if (this.disposed) return;
    if (this.term === null) {
      this.rememberPreAttach(data);
      return;
    }
    this.term.write(data);
  }

  /** Append to the pre-attach buffer, trimming whole chunks past the cap. */
  private rememberPreAttach(data: string): void {
    this.preAttachOutput.push(data);
    this.preAttachChars += data.length;
    while (this.preAttachChars > PREATTACH_BUFFER_MAX_CHARS && this.preAttachOutput.length > 1) {
      this.preAttachChars -= this.preAttachOutput.shift()?.length ?? 0;
    }
  }

  private emitData(data: string): void {
    fanOut(this.dataCbs, "input", data);
  }

  /**
   * ghostty `macos-option-as-alt`, ahead of xterm's own key encoding.
   *
   * Returning `false` tells xterm not to handle the event; `preventDefault` is
   * what stops the browser from also delivering the macOS composed character
   * to xterm's hidden textarea, which would send "∫" chasing our ESC+b.
   * xterm calls this handler for keyup and keypress too, hence the type guard.
   */
  private readonly handleKeyEvent = (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return true;
    const sides = heldAltSides();
    const seq = optionAsAltSequence(
      event,
      getCurrentAppearance().macosOptionAsAlt,
      sides.left,
      sides.right,
    );
    if (seq === null) return true;
    event.preventDefault();
    this.emitData(seq);
    return false;
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

  /**
   * Nothing to pause, and the owed-fit flush.
   *
   * There is no render loop to stop: the DOM renderer repaints only what
   * changed, and a hidden terminal's rows cost Chromium nothing to keep — which
   * is why no pause flag is kept here at all. The seam keeps the call because
   * the hosts pair it with reveal, and reveal is exactly when a fit that could
   * not be taken while hidden has to land.
   */
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    if (!paused && this.pendingFit) this.fit();
  }

  fit(): void {
    if (this.disposed || this.term === null) return;
    this.fitNow();
    // Chromium can hand out geometry one frame before layout and the display
    // association settle (reveal, monitor move, font load). One coalesced
    // next-frame re-measure covers that race for every caller, so no call site
    // needs its own requestAnimationFrame twin.
    if (this.settleFitFrame !== null) window.cancelAnimationFrame(this.settleFitFrame);
    this.settleFitFrame = window.requestAnimationFrame(() => {
      this.settleFitFrame = null;
      this.fitNow();
    });
  }

  private fitNow(): void {
    if (this.disposed || this.fitAddon === null) return;
    const bounds = this.hostEl.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      // A hidden host measures as zero here while its COMPUTED height is still
      // a percentage the fit addon would happily parse as pixels. Owe the fit
      // so reveal applies it rather than losing it.
      this.pendingFit = true;
      return;
    }
    this.pendingFit = false;
    this.fitAddon.fit();
  }

  focus(): void {
    if (this.disposed) return;
    this.term?.focus();
  }

  adjustFontSize(delta: number): void {
    if (this.disposed || this.term === null || !Number.isFinite(delta) || delta === 0) return;
    const base = getCurrentAppearance().fontSize;
    const next = clampFontSize(base + this.fontSizeOffset + delta);
    this.fontSizeOffset = next - base;
    this.term.options.fontSize = next;
    this.fit();
    this.focus();
  }

  resetFontSize(): void {
    if (this.disposed || this.term === null) return;
    this.fontSizeOffset = 0;
    this.term.options.fontSize = this.resolvedFontSize(getCurrentAppearance().fontSize);
    this.fit();
    this.focus();
  }

  private resolvedFontSize(base: number): number {
    return clampFontSize(base + this.fontSizeOffset);
  }

  /**
   * ghostty `mouse-reporting = false`: swallow the DECSET sequences that turn
   * tracking on, so an app that asks is simply never granted it.
   *
   * A parser handler rather than a mode switch because xterm has no "refuse
   * mouse reporting" option. Returning `true` marks the sequence handled and
   * the mode never gets set; returning `false` hands it back to xterm's own
   * handler untouched. Only DECSET (`h`) is filtered — the matching DECRST
   * (`l`) is left alone, since turning off a mode that was never on is a no-op
   * and intercepting it would only give a TUI a reason to disbelieve us.
   */
  private applyMouseReporting(enabled: boolean): void {
    this.mouseFilter?.dispose();
    this.mouseFilter = null;
    if (enabled || this.term === null) return;
    this.mouseFilter = this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) =>
      isMouseTrackingOnly(params),
    );
  }

  /** Live re-apply for ghostty config edits (issue #18 live reload). */
  applyAppearance(appearance: TerminalAppearance): void {
    if (this.disposed || this.term === null) return;
    const { options } = this.term;
    options.theme = xtermTheme(appearance.theme);
    options.fontFamily = xtermFontFamily(appearance.fontFamilies);
    options.fontSize = this.resolvedFontSize(appearance.fontSize);
    options.macOptionIsMeta = macOptionIsMeta(appearance.macosOptionAsAlt);
    // Live, unlike the renderer this replaced: xterm resizes its buffer in
    // place, so a scrollback-limit edit reaches terminals that are already open
    // instead of only the next one.
    options.scrollback = scrollbackLines(appearance.scrollbackLimitBytes);
    this.applyMouseReporting(appearance.mouseReporting);
    // A font change re-measures the cell, which changes the grid.
    this.fit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.settleFitFrame !== null) window.cancelAnimationFrame(this.settleFitFrame);
    this.settleFitFrame = null;
    this.mouseFilter?.dispose();
    this.mouseFilter = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    // Disposes the addons too (xterm owns their lifetime once loaded) and
    // removes the DOM it built inside hostEl.
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
    this.dataCbs.clear();
    this.resizeCbs.clear();
    this.preAttachOutput = [];
    this.preAttachChars = 0;
    this.hostEl.remove();
  }
}
