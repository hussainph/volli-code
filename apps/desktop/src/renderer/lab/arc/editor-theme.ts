/**
 * The editor, brought inside the canvas — the last surface still painting from
 * a catalog instead of from the seed.
 *
 * The ticket body is a Monaco editor, and Monaco paints its own background from
 * whatever theme is set. Every one of the 22 ids in `editor-themes.ts` is a
 * DARK code theme, so on a light canvas the description field renders as a
 * near-black slab in the middle of a paper document. That is not a light-mode
 * bug so much as the shape of the old arrangement showing through: the app
 * surface, the terminal and the editor were three independently themed things
 * that only ever agreed because the app was dark-only.
 *
 * So this derives the editor from the same seed as everything else, and the
 * result is a theme with two jobs rather than one:
 *
 *  - **The prose surface.** The ticket body is a document, not a code pane. It
 *    paints on `--background` and inks in `--foreground`, which makes the field
 *    disappear into the page the way a Linear or Notion body does — the box was
 *    never a design decision, it was One Dark's background showing.
 *  - **The syntax palette**, for the file and diff views, built by rotating the
 *    accent's hue and solving each role for a contrast floor against the paper
 *    it lands on. Six roles, because six is what markdown and a diff actually
 *    distinguish; a full TextMate palette would be inventing distinctions
 *    nothing here renders.
 *
 * The pure half is {@link arcEditorTheme}. {@link applyArcEditorTheme} is the
 * impure one, and it is deliberately the only thing in `arc/` that reaches for
 * a runtime rather than the document — see its note on why it waits.
 */
import {
  apcaLc,
  hexToOklch,
  oklchToHex,
  type ResolvedAppearance,
  type ThemeTokens,
} from "@volli/shared";
import type { ThemeRegistrationResolved } from "shiki";

/** The name the theme registers under. One name, redefined in place on every repaint. */
export const ARC_EDITOR_THEME_ID = "volli-arc";

/**
 * The six syntax roles, as hue rotations from the accent.
 *
 * Rotations rather than authored colors, for the reason the canvas rotates its
 * harmony stops: a palette derived from the seed moves with the seed, and one
 * that is authored stays behind the moment somebody picks a different accent.
 * The offsets are the standard code-highlighting relationships — strings warm-
 * shifted away from keywords, functions and types on the cool side — placed on
 * OKLCH's perceptually even wheel so they stay equally distinct at every seed.
 */
const SYNTAX_ROLES = [
  { role: "string", hueOffset: 140, scopes: ["string", "string.quoted", "markup.inserted"] },
  {
    role: "keyword",
    hueOffset: 290,
    scopes: ["keyword", "storage", "storage.type", "keyword.control"],
  },
  { role: "constant", hueOffset: 40, scopes: ["constant", "constant.numeric", "support.constant"] },
  {
    role: "function",
    hueOffset: 215,
    scopes: ["entity.name.function", "support.function", "meta.function-call"],
  },
  { role: "type", hueOffset: 95, scopes: ["entity.name.type", "support.type", "support.class"] },
  { role: "tag", hueOffset: 330, scopes: ["entity.name.tag", "markup.deleted", "invalid"] },
] as const;

/**
 * Saturation for the syntax roles, and the floor each is solved to.
 *
 * Lc 60 rather than the 75 secondary copy now gets: syntax color is a
 * SECOND channel on top of shape and position — you are never reading a keyword
 * by its hue alone — and pushing every role to body weight would produce six
 * near-black inks whose distinctions had been solved away.
 */
const SYNTAX = { chroma: 0.115, floorLc: 60 } as const;

function solveOn(surface: string, targetLc: number, C: number, h: number): string {
  const bound = hexToOklch(surface).L < 0.5 ? 1 : 0;
  const ceiling = Math.abs(apcaLc(oklchToHex(bound, C, h), surface));
  const target = Math.min(targetLc, ceiling);
  let fail = hexToOklch(surface).L;
  let pass = bound;
  for (let i = 0; i < 32; i += 1) {
    const mid = (fail + pass) / 2;
    if (Math.abs(apcaLc(oklchToHex(mid, C, h), surface)) >= target) pass = mid;
    else fail = mid;
  }
  return oklchToHex(pass, C, h);
}

/** `#rrggbb` + an alpha byte — Monaco's colors take `#rrggbbaa`. */
function withAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/**
 * The editor theme a token set implies.
 *
 * Pure and deterministic like the rest of `arc/` — it takes the already-derived
 * app tokens rather than the canvas state, because the whole point is that the
 * editor is the SAME paper as the card beside it. Deriving it from the seed a
 * second time would be a second chance to disagree.
 */
export function arcEditorTheme(
  tokens: ThemeTokens,
  resolved: ResolvedAppearance,
): ThemeRegistrationResolved {
  const background = tokens["--background"];
  const foreground = tokens["--foreground"];
  const muted = tokens["--muted-foreground"];
  const accent = hexToOklch(tokens["--primary"]);

  const settings = [
    // The default rule. Monaco needs a scope-less entry or untokenized text
    // falls back to its own built-in foreground rather than to ours.
    { settings: { foreground, background } },
    {
      scope: ["comment", "punctuation.definition.comment", "markup.quote"],
      settings: { foreground: muted, fontStyle: "italic" },
    },
    {
      // Markdown structure inks as body, not as a color: a heading in a prose
      // document is heavier, not another hue.
      scope: ["markup.heading", "entity.name.section", "markup.bold"],
      settings: { foreground, fontStyle: "bold" },
    },
    { scope: ["markup.italic"], settings: { foreground, fontStyle: "italic" } },
    {
      scope: ["markup.underline.link", "string.other.link", "markup.inline.raw"],
      settings: { foreground: tokens["--primary-text"] },
    },
    ...SYNTAX_ROLES.map(({ hueOffset, scopes }) => ({
      scope: [...scopes],
      settings: {
        foreground: solveOn(
          background,
          SYNTAX.floorLc,
          SYNTAX.chroma,
          (accent.h + hueOffset) % 360,
        ),
      },
    })),
  ];

  return {
    name: ARC_EDITOR_THEME_ID,
    type: resolved,
    bg: background,
    fg: foreground,
    settings,
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      // No line-highlight box and no gutter fill: both draw a rectangle across
      // a prose field, which is the slab this theme exists to remove.
      "editor.lineHighlightBackground": withAlpha(background, 0),
      "editorGutter.background": background,
      "editorLineNumber.foreground": tokens["--border-strong"],
      "editorLineNumber.activeForeground": muted,
      "editorCursor.foreground": tokens["--primary"],
      "editor.selectionBackground": withAlpha(tokens["--primary"], 0.24),
      "editor.inactiveSelectionBackground": withAlpha(tokens["--primary"], 0.12),
      "editor.selectionHighlightBackground": withAlpha(tokens["--primary"], 0.14),
      "editorWidget.background": tokens["--popover"],
      "editorWidget.border": tokens["--border"],
      "editorIndentGuide.background1": tokens["--border"],
      "editorIndentGuide.activeBackground1": tokens["--border-strong"],
      "editorWhitespace.foreground": tokens["--border"],
      "scrollbarSlider.background": withAlpha(tokens["--border-strong"], 0.4),
      "scrollbarSlider.hoverBackground": withAlpha(tokens["--border-strong"], 0.6),
      "scrollbarSlider.activeBackground": withAlpha(tokens["--border-strong"], 0.8),
      "diffEditor.insertedTextBackground": withAlpha(tokens["--primary"], 0.1),
      "diffEditor.removedTextBackground": withAlpha(tokens["--destructive"], 0.12),
    },
  };
}

/** The theme most recently derived, so a late-mounting editor can be caught up. */
let armed: ThemeRegistrationResolved | null = null;
let watching = false;

/**
 * Registers the theme with the running Monaco and activates it.
 *
 * It does NOT boot Monaco to do so, and that restraint is the whole design of
 * this function. `loadMonacoRuntime` is a lazy singleton — calling it starts the
 * editor, its five language workers and the shiki highlighter — so a canvas
 * repaint that reached for it would pay for all of that on the Board scratch,
 * the Chrome scratch and every other surface with no editor on screen.
 *
 * Instead the theme is ARMED and applied when an editor actually appears. The
 * mounted `.monaco-editor` node is the signal: it can only exist once the
 * runtime resolved, so seeing one means `loadMonacoRuntime()` returns an
 * already-settled promise rather than starting anything.
 *
 * Lab-only plumbing, and it should not survive the port. In the app this
 * belongs inside `applyTheme` next to `refreshTerminalTokenTheme` — the same
 * choke point, for the same reason: there should be no way to change the app's
 * colors without every surface hearing about it.
 */
export function applyArcEditorTheme(theme: ThemeRegistrationResolved | null): void {
  armed = theme;
  if (theme !== null) void pushToMonaco(theme);
  if (watching) return;
  watching = true;
  new MutationObserver(() => {
    if (armed !== null && document.querySelector(".monaco-editor") !== null) {
      void pushToMonaco(armed);
    }
  }).observe(document.body, { childList: true, subtree: true });
}

async function pushToMonaco(theme: ThemeRegistrationResolved): Promise<void> {
  if (document.querySelector(".monaco-editor") === null) return;
  try {
    const { loadMonacoRuntime } = await import("@renderer/editor/monaco-runtime");
    const runtime = await loadMonacoRuntime();
    await runtime.shiki.registerTheme(theme);
    runtime.monaco.editor.setTheme(theme.name);
  } catch (error) {
    // A lab preview is never worth breaking a repaint over — the editor simply
    // keeps whatever theme it had.
    console.warn("[lab] could not apply the derived editor theme:", error);
  }
}
