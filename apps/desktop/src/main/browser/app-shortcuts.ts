import type { BrowserAppShortcut } from "@volli/shared";

/**
 * Which keys pressed inside a Browser page belong to the app (VC-301).
 *
 * A Browser Tab's page is its own native WebContents, so a key pressed in it
 * never reaches the renderer's window `keydown` listeners — ⌘K, the project
 * chords and pane focus all went dead the moment a page had focus, and ⌘W fell
 * through to the menu's Close Window. Main sees every key first
 * (`before-input-event`), and this is the whole of its decision.
 *
 * DELIBERATELY SMALL. Everything not named here is the page's, including every
 * editing chord: main cannot see whether the page's focus is a text field, so a
 * chord that means something inside one (⌘[ / ⌘] outdent, ⌘B bold, ⌘P print,
 * Escape closing a page's own dialog, Tab moving through its form) is never
 * taken. What is taken is chosen because no page owns it in a browser either:
 *
 *  • ⌘K — the command palette. The ticket's one exception to "a page field
 *    keeps its chords": the palette is the way out of anywhere.
 *  • ⌘1–⌘9 — select the Nth project, as everywhere else in the app.
 *  • ⌃⌘ + an arrow — move between split panes.
 *  • ⌘W — close THIS Browser Tab. The browser's own meaning, and the only safe
 *    one: left alone it falls through to the menu and closes the window.
 *  • ⌘L — return focus to the app, on this tab's address bar. The browser's
 *    own "leave the page" chord, where Escape and Tab are the page's.
 *
 * The first three are replayed into the renderer as the chord they are, so the
 * listener that already owns each one — with its own guards, the terminal guard
 * on ⌘K included — is the one that decides. Only the two that need to know
 * WHICH tab the key came from are named here.
 */

/** The fields of Electron's `Input` this decision reads. */
export interface BrowserKeyInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
}

/**
 * Where one key goes.
 *
 *  • `page` — not the app's; the page gets it as it always did.
 *  • `swallow` — the app's, but nothing to do: a held ⌘W's repeats must not
 *    reach the page or, through it, the menu's Close Window.
 *  • `app` — the app's; main hands the shortcut to the renderer.
 */
export type BrowserKeyRoute =
  | { kind: "page" }
  | { kind: "swallow" }
  | { kind: "app"; shortcut: BrowserAppShortcut };

const PAGE: BrowserKeyRoute = { kind: "page" };
const SWALLOW: BrowserKeyRoute = { kind: "swallow" };

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function replay(input: BrowserKeyInput): BrowserKeyRoute {
  return {
    kind: "app",
    shortcut: {
      kind: "replay",
      chord: {
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        repeat: input.isAutoRepeat,
      },
    },
  };
}

/** An action on the tab itself fires once per press; its repeats are swallowed. */
function once(input: BrowserKeyInput, shortcut: BrowserAppShortcut): BrowserKeyRoute {
  return input.isAutoRepeat ? SWALLOW : { kind: "app", shortcut };
}

export function browserKeyRoute(input: BrowserKeyInput): BrowserKeyRoute {
  // Key up is the page's: it never saw the down, and a stray up does nothing.
  // A key mid-composition belongs to the input method, never to a shortcut.
  if (input.type !== "keyDown" || input.isComposing || !input.meta || input.alt) return PAGE;

  if (input.control) {
    return !input.shift && ARROWS.has(input.code) ? replay(input) : PAGE;
  }
  if (input.shift) return PAGE;

  const key = input.key.toLowerCase();
  if (key === "k" || /^[1-9]$/.test(input.key)) return replay(input);
  if (key === "w") return once(input, { kind: "close-tab" });
  if (key === "l") return once(input, { kind: "focus-address" });
  return PAGE;
}
