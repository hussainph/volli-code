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
 *     owns the app's canvas layer, its geometry, and the two foregrounds
 *     painted directly ON it — the foregrounds as `!important` rules, because
 *     `applyTheme` writes those tokens inline and nothing weaker reaches them.
 *  2. The `--lab-canvas*` custom properties the seam reads — the gradient
 *     itself and the three-rung ink ladder painted on it.
 *  3. The whole derived app token set, via `applyThemeTokens` (see tokens.ts).
 *     This is what makes the opaque content card inherit the canvas instead of
 *     staying stock dark under it, and what makes the light/dark ink flip reach
 *     helper text inside the card rather than only the sidebar. It also
 *     re-solves the veils, so a translucent sidebar keeps its rung.
 *
 * Only (1) and (2) are torn down again — see {@link applyArcCanvas}.
 */
import {
  canvasBackground,
  canvasElevation,
  canvasInk,
  deriveCanvasTokens,
  deriveLabelInk,
  parseCanvas,
  resolveAppearance,
  type Appearance,
  type Canvas,
} from "@volli/shared";

import { applyThemeTokens } from "@renderer/theme/apply";

import { applyArcEditorTheme, arcEditorTheme } from "./editor-theme";

const STORAGE_KEY = "volli-lab:arc-canvas";

/**
 * What the lab remembers: the gradient, and the appearance the editor is set to.
 *
 * Two fields rather than one because the canvas model no longer carries a mode —
 * appearance is scoped independently in the app, so a `Canvas` that named one
 * could not express "this workspace overrides the canvas but not the
 * appearance". The editor still owns both, which is why the pair is assembled
 * HERE rather than pushed back into the shared type.
 */
export interface LabCanvas {
  canvas: Canvas;
  appearance: Appearance;
}

function isAppearance(value: unknown): value is Appearance {
  return value === "auto" || value === "light" || value === "dark";
}

/**
 * Armed state for the `lab.css` seam; its value is the RESOLVED mode.
 *
 * The ONE attribute, since the window's arrangement settled. It used to be two
 * — this one plus a `data-lab-seam` naming which of four ways the sidebar, the
 * canvas and the card met — and the second went with the choice: an attribute
 * that can only ever hold one value is not a switch, it is a claim that the
 * stylesheet is waiting for a value nobody will send. Every rule that keyed on
 * it now scopes on this alone.
 */
const CANVAS_ATTRIBUTE = "data-lab-canvas";
const CANVAS_VARIABLE = "--lab-canvas";
/**
 * The on-canvas copy ladder, head first. All three carry the `--lab-canvas-ink`
 * prefix because they are one family solved together (`arcInk`) — which is also
 * what keeps the middle one distinguishable from `--lab-label-ink` below, the
 * card's label tier, whose name it otherwise nearly repeats. Prefix says which
 * side of the card's edge a tier belongs to; suffix says which rung.
 */
const INK_VARIABLE = "--lab-canvas-ink";
const INK_LABEL_VARIABLE = "--lab-canvas-ink-label";
const INK_MUTED_VARIABLE = "--lab-canvas-ink-muted";
/**
 * The elevation set — cumulative lift per on-canvas tier, the micro-label ink,
 * and the three shadow tiers.
 *
 * Every one of these carries a value even when its dial is at zero
 * (`transparent`, `none`, the muted token) rather than being left unset. The
 * seam's rules are unconditional, so an unset property would fall back to the
 * `var()` fallback on a *repaint* while still matching — which is the same
 * mid-drag flicker the attribute ordering below exists to prevent, arriving
 * from the other direction.
 */
const LIFT_VARIABLES = ["--lab-lift-1", "--lab-lift-2"] as const;
const LABEL_VARIABLE = "--lab-label-ink";
const SHADOW_VARIABLES = {
  raised: "--lab-shadow-raised",
  card: "--lab-shadow-card",
  overlay: "--lab-shadow-overlay",
} as const;
const CANVAS_VARIABLES = [
  CANVAS_VARIABLE,
  INK_VARIABLE,
  INK_LABEL_VARIABLE,
  INK_MUTED_VARIABLE,
  ...LIFT_VARIABLES,
  LABEL_VARIABLE,
  ...Object.values(SHADOW_VARIABLES),
];

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The last canvas actually PUT ON THE DOCUMENT this session, or null once it
 * has been taken down. See {@link watchSystemAppearance} for why this exists
 * rather than a re-read of storage.
 */
let applied: LabCanvas | null = null;

/**
 * The stored canvas, or null when there is none — or when what is stored is no
 * longer paintable.
 *
 * The appearance rides in the same entry under its old name, `mode`, so every
 * canvas stored before the split still loads with the appearance it was saved
 * at. `parseCanvas` ignores the key; this reads it.
 */
export function loadArcCanvas(): LabCanvas | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const canvas = parseCanvas(parsed);
    if (canvas === null) return null;
    const mode = (parsed as { mode?: unknown }).mode;
    return { canvas, appearance: isAppearance(mode) ? mode : "auto" };
  } catch {
    // An unreadable or unparseable entry means "no canvas". A dev-tool
    // preference is never worth failing a page load over.
    return null;
  }
}

/** Remembers `choice` for the next reload; `null` clears the key. */
export function saveArcCanvas(choice: LabCanvas | null): void {
  try {
    if (choice === null) window.localStorage.removeItem(STORAGE_KEY);
    else {
      const stored = { ...choice.canvas, mode: choice.appearance };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
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
export function applyArcCanvas(choice: LabCanvas | null): void {
  const root = document.documentElement;
  applied = choice;

  if (choice === null) {
    root.removeAttribute(CANVAS_ATTRIBUTE);
    for (const name of CANVAS_VARIABLES) root.style.removeProperty(name);
    // Disarming only stops FUTURE editors being caught up; the one on screen
    // keeps the derived theme until something sets another. Same asymmetry as
    // the token set above, and the same reason — the caller that genuinely
    // turns a canvas off is the one that knows what should come back.
    applyArcEditorTheme(null);
    return;
  }

  const { canvas } = choice;
  const resolved = resolveAppearance(choice.appearance, systemPrefersDark());
  const tokens = deriveCanvasTokens(canvas, resolved);
  // Elevation before ink, because the ink's worst case depends on it: a lifted
  // tier is a surface the on-canvas text now sits on, and at NEGATIVE lift it
  // is darker than any pool — so an ink chosen against the gradient alone would
  // be chosen against surfaces that are no longer the hardest ones on screen.
  const elevation = canvasElevation(canvas, resolved, tokens);
  const { ink, inkLabel, inkMuted } = canvasInk(canvas, resolved, elevation.surfaces);
  // The app set first: it is the widest write, and the seam's `!important`
  // rules sit above it for the two tokens that paint on the canvas itself.
  applyThemeTokens(tokens);
  root.style.setProperty(CANVAS_VARIABLE, canvasBackground(canvas, resolved));
  root.style.setProperty(INK_VARIABLE, ink);
  root.style.setProperty(INK_LABEL_VARIABLE, inkLabel);
  root.style.setProperty(INK_MUTED_VARIABLE, inkMuted);
  LIFT_VARIABLES.forEach((name, tier) => {
    root.style.setProperty(name, elevation.tiers[tier].veil);
  });
  // Solved in both modes, and off the token set that was just derived rather
  // than off the canvas a second time — the label tier is a position between two
  // of these exact hexes, so a second derivation could only disagree with them.
  root.style.setProperty(LABEL_VARIABLE, deriveLabelInk(tokens, resolved));
  for (const [tier, name] of Object.entries(SHADOW_VARIABLES)) {
    root.style.setProperty(name, elevation.shadows[tier as keyof typeof SHADOW_VARIABLES]);
  }
  // The editor is not a custom property — Monaco owns its own pixels — so it
  // gets the derived set pushed at it rather than inheriting one.
  applyArcEditorTheme(arcEditorTheme(tokens, resolved));
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
    if (current === null || current.appearance !== "auto") return;
    applyArcCanvas(current);
  });
}
