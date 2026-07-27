/**
 * The canvas the lab is currently painted with — put on the document, and
 * remembered across reloads.
 *
 * It follows you off this scratch on purpose, exactly like the theme choice
 * next door: a vivid canvas is judged by whether the App shell's sidebar is
 * still readable on it, so a canvas that unwound when you left the editor could
 * only ever be judged against its own preview pad. See `theme-choice.ts` for
 * why a `volli-lab:`-namespaced `localStorage` key is the right home for a
 * dev-tool preference in a folder the app cannot import.
 *
 * Arming a canvas writes THREE things:
 *
 *  1. `data-lab-canvas` on the root, which arms the `lab.css` seam. That seam
 *     owns the app's canvas layer and the two foregrounds painted directly ON
 *     it — as `!important` rules, because `applyTheme` writes those tokens
 *     inline and nothing weaker reaches them.
 *  2. The three `--lab-canvas*` custom properties the seam reads.
 *  3. The whole derived app token set, via `applyThemeTokens` (see tokens.ts).
 *     This is what makes the opaque content card inherit the canvas instead of
 *     staying stock dark under it, and what makes the light/dark ink flip reach
 *     helper text inside the card rather than only the sidebar. It also
 *     re-solves the veils, so a translucent sidebar keeps its rung.
 *
 * Only (1) and (2) are torn down again — see {@link applyArcCanvas}.
 */
import { applyThemeTokens } from "@renderer/theme/apply";

import {
  arcCanvasBackground,
  arcInk,
  clampArcCanvasState,
  resolveArcMode,
  type ArcCanvasState,
} from "./model";
import { deriveArcTokens } from "./tokens";

const STORAGE_KEY = "volli-lab:arc-canvas";

/** Armed state for the `lab.css` seam; its value is the RESOLVED mode. */
const CANVAS_ATTRIBUTE = "data-lab-canvas";
const CANVAS_VARIABLE = "--lab-canvas";
const INK_VARIABLE = "--lab-canvas-ink";
const INK_MUTED_VARIABLE = "--lab-canvas-ink-muted";
const CANVAS_VARIABLES = [CANVAS_VARIABLE, INK_VARIABLE, INK_MUTED_VARIABLE];

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The last canvas actually PUT ON THE DOCUMENT this session, or null once it
 * has been taken down. See {@link watchSystemAppearance} for why this exists
 * rather than a re-read of storage.
 */
let applied: ArcCanvasState | null = null;

/** The stored canvas, or null when there is none — or when what is stored is no longer paintable. */
export function loadArcCanvas(): ArcCanvasState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return clampArcCanvasState(parsed);
  } catch {
    // An unreadable or unparseable entry means "no canvas". A dev-tool
    // preference is never worth failing a page load over.
    return null;
  }
}

/** Remembers `state` for the next reload; `null` clears the key. */
export function saveArcCanvas(state: ArcCanvasState | null): void {
  try {
    if (state === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — the canvas still applies for this session.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/**
 * Paints `state` onto the document, or takes the seam back down when it is
 * null.
 *
 * The attribute moves LAST on the way up and FIRST on the way down, because it
 * is the switch: armed while `--lab-canvas-ink` did not exist, the seam's
 * `var()` would resolve to the guaranteed-invalid value and drop every sidebar
 * label to its inherited color for a frame.
 *
 * **Teardown does not restore the theme's tokens, and callers must.** Two
 * reasons, and they point the same way. This module cannot import
 * `theme-choice.ts` — that direction is the cycle (theme-choice → paint →
 * model is the acyclic one) — and it could not choose correctly anyway, since
 * which theme should come back is precisely what that module owns. Removing the
 * derived properties instead of leaving them would be worse than useless: the
 * common `applyArcCanvas(loadArcCanvas())` call sits one line after an
 * `applyTheme`, so on a boot with nothing stored it would erase the theme that
 * had just been applied. So the derived set is left to be overwritten, and the
 * one caller that genuinely takes a canvas DOWN (the editor's Reset) re-applies
 * the standing lab theme itself.
 */
export function applyArcCanvas(state: ArcCanvasState | null): void {
  const root = document.documentElement;
  applied = state;

  if (state === null) {
    root.removeAttribute(CANVAS_ATTRIBUTE);
    for (const name of CANVAS_VARIABLES) root.style.removeProperty(name);
    return;
  }

  const resolved = resolveArcMode(state.mode, systemPrefersDark());
  const { ink, inkMuted } = arcInk(state, resolved);
  // The app set first: it is the widest write, and the seam's `!important`
  // rules sit above it for the two tokens that paint on the canvas itself.
  applyThemeTokens(deriveArcTokens(state, resolved));
  root.style.setProperty(CANVAS_VARIABLE, arcCanvasBackground(state, resolved));
  root.style.setProperty(INK_VARIABLE, ink);
  root.style.setProperty(INK_MUTED_VARIABLE, inkMuted);
  root.setAttribute(CANVAS_ATTRIBUTE, resolved);
}

let watching = false;

/**
 * Repaints an `auto` canvas when the system flips appearance.
 *
 * Called from `main.tsx` rather than registered at import time: scratches are
 * all imported eagerly (see scratch.ts), so a module-scope listener here would
 * install itself whether or not the canvas editor is the scratch on screen.
 *
 * It repaints what is ON THE DOCUMENT, falling back to storage only before
 * anything has been applied this session. Re-reading storage unconditionally
 * looks like the safer choice and is the opposite: `saveArcCanvas` swallows a
 * failed write on purpose (a full or blocked quota must not break the editor),
 * so after one such failure storage holds a canvas OLDER than the one on
 * screen — and a system appearance flip would then silently roll the user's
 * edits back. The applied state is the only record that cannot be stale.
 */
export function watchSystemAppearance(): void {
  if (watching) return;
  watching = true;
  window.matchMedia(SYSTEM_DARK_QUERY).addEventListener("change", () => {
    const current = applied ?? loadArcCanvas();
    if (current === null || current.mode !== "auto") return;
    applyArcCanvas(current);
  });
}
