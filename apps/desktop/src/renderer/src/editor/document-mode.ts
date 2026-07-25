/**
 * The Monaco option set that turns a code editor into a document surface.
 *
 * Source Mode (`fileEditorConstructionOptions`) is a file: a gutter, line
 * numbers, monospace, bracket guides. Document Mode is the Ticket Body and a
 * Markdown Artifact (CONCEPT #49/#60) — prose, in the app's own sans face, with
 * nothing in the margin and no IDE furniture. Everything switched off here was
 * either visible chrome a document must not have, or a language affordance that
 * is actively wrong over prose:
 *
 *  - Word-based suggestions would offer every word already in the document as a
 *    completion for every word being typed. The ONLY completion this surface
 *    has is the `@file` picker, which is trigger-character driven.
 *  - The unicode highlighter flags "ambiguous" and invisible characters, which
 *    in prose means every curly quote and non-breaking space gets a warning box.
 *  - Bracket-pair colourization and match highlighting turn `[a](b)` markdown
 *    links into a rainbow.
 *
 * Two settings are load-bearing rather than cosmetic, both because Document Mode
 * decorations change glyph widths (see `document-decorations.ts`):
 * `wrappingStrategy: "advanced"` makes Monaco measure the DOM to decide where a
 * line wraps instead of assuming a uniform character width, and the sans font
 * makes that non-uniformity the norm rather than the exception.
 */
import type { editor } from "monaco-editor";

/** Type/rhythm for the document surface: DESIGN.md's `body` step, prose leading. */
const DOCUMENT_FONT_SIZE = 14;
const DOCUMENT_LINE_HEIGHT = 24;

export interface DocumentModeInput {
  /** Shown while the document is empty, exactly like the old CodeMirror surface. */
  readonly placeholder?: string;
}

export function documentModeOptions(
  input: DocumentModeInput,
): editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontFamily: "var(--font-sans)",
    fontSize: DOCUMENT_FONT_SIZE,
    lineHeight: DOCUMENT_LINE_HEIGHT,
    // --- nothing in the margins ---
    lineNumbers: "off",
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { horizontal: "hidden", useShadows: false, verticalScrollbarSize: 10 },
    stickyScroll: { enabled: false },
    // --- reads as prose ---
    wordWrap: "on",
    wrappingStrategy: "advanced",
    renderLineHighlight: "none",
    renderWhitespace: "none",
    guides: { indentation: false, bracketPairs: false },
    bracketPairColorization: { enabled: false },
    matchBrackets: "never",
    occurrencesHighlight: "off",
    selectionHighlight: false,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    scrollBeyondLastLine: false,
    padding: { top: 8, bottom: 8 },
    // Monaco's own context menu is foreign to this app's menu idiom (CLAUDE.md),
    // and a document has no "Go to Definition" to offer in it.
    contextmenu: false,
    // --- completion: the `@file` picker and nothing else ---
    quickSuggestions: false,
    wordBasedSuggestions: "off",
    suggestOnTriggerCharacters: true,
    ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
  };
}
