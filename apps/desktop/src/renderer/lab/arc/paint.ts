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
 * This module writes THREE custom properties and one attribute, and nothing
 * else. The actual overrides — the app's canvas layer, and the two sidebar
 * foregrounds that paint directly on it — are `!important` rules in `lab.css`
 * keyed off that attribute.
 *
 * Doing it that way rather than setting `--sidebar-foreground` inline is what
 * makes the seam reversible. `applyTheme` owns those tokens as inline props on
 * the same element, so an inline override would have to be un-written from a
 * snapshot taken before it — and any `applyTheme` call in between (picking a
 * theme, booting) would make that snapshot stale and restore the wrong colors.
 * A stylesheet rule that stops matching the moment the attribute goes has no
 * state to get wrong.
 */
import {
  arcCanvasBackground,
  arcInk,
  clampArcCanvasState,
  resolveArcMode,
  type ArcCanvasState,
} from "./model";

const STORAGE_KEY = "volli-lab:arc-canvas";

/** Armed state for the `lab.css` seam; its value is the RESOLVED mode. */
const CANVAS_ATTRIBUTE = "data-lab-canvas";
const CANVAS_VARIABLE = "--lab-canvas";
const INK_VARIABLE = "--lab-canvas-ink";
const INK_MUTED_VARIABLE = "--lab-canvas-ink-muted";
const CANVAS_VARIABLES = [CANVAS_VARIABLE, INK_VARIABLE, INK_MUTED_VARIABLE];

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

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
 * Paints `state` onto the document, or takes the whole seam back down when it
 * is null.
 *
 * The attribute moves LAST on the way up and FIRST on the way down, because it
 * is the switch: armed while `--lab-canvas-ink` did not exist, the seam's
 * `var()` would resolve to the guaranteed-invalid value and drop every sidebar
 * label to its inherited color for a frame.
 */
export function applyArcCanvas(state: ArcCanvasState | null): void {
  const root = document.documentElement;

  if (state === null) {
    root.removeAttribute(CANVAS_ATTRIBUTE);
    for (const name of CANVAS_VARIABLES) root.style.removeProperty(name);
    return;
  }

  const resolved = resolveArcMode(state.mode, systemPrefersDark());
  const { ink, inkMuted } = arcInk(state, resolved);
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
 * It re-reads storage instead of closing over the last state it painted, so the
 * editor's live edits and this listener cannot end up disagreeing about what is
 * currently on the document.
 */
export function watchSystemAppearance(): void {
  if (watching) return;
  watching = true;
  window.matchMedia(SYSTEM_DARK_QUERY).addEventListener("change", () => {
    const stored = loadArcCanvas();
    if (stored === null || stored.mode !== "auto") return;
    applyArcCanvas(stored);
  });
}
