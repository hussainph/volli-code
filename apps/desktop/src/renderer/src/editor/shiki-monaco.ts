import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import type * as Monaco from "monaco-editor";
import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from "shiki";
import type { LanguageInput, ThemeInput, ThemeRegistrationResolved } from "shiki/types";

/** Cap line length so minified/huge files cannot stall the main thread. */
export const SHIKI_TOKENIZE_MAX_LINE_LENGTH = 20_000;

/** Cap per-line tokenize time (ms) so pathological grammars yield instead of hang. */
export const SHIKI_TOKENIZE_TIME_LIMIT_MS = 500;

export interface ShikiMonacoBootstrap {
  highlighter: Highlighter;
  /**
   * Register a TextMate theme with Monaco without calling `shikiToMonaco` again.
   * Later catalog themes must use this path — a second `shikiToMonaco` stacks
   * `setTheme` wrappers (see theming-engine Surface 2).
   */
  registerTheme: (theme: ThemeRegistrationResolved) => Promise<void>;
}

export interface BootstrapShikiMonacoOptions {
  themes?: ThemeInput[];
  langs?: LanguageInput[];
  tokenizeMaxLineLength?: number;
  tokenizeTimeLimit?: number;
}

/**
 * Create a JS-regex shiki highlighter and wire it to Monaco exactly once.
 */
export async function bootstrapShikiMonaco(
  monaco: typeof Monaco,
  options: BootstrapShikiMonacoOptions = {},
): Promise<ShikiMonacoBootstrap> {
  const engine = createJavaScriptRegexEngine();
  const highlighter = await createHighlighter({
    themes: options.themes ?? [],
    langs: options.langs ?? [],
    engine,
  });

  // @shikijs/monaco types against monaco-editor-core; we ship full monaco-editor.
  shikiToMonaco(highlighter, monaco as Parameters<typeof shikiToMonaco>[1], {
    tokenizeMaxLineLength: options.tokenizeMaxLineLength ?? SHIKI_TOKENIZE_MAX_LINE_LENGTH,
    tokenizeTimeLimit: options.tokenizeTimeLimit ?? SHIKI_TOKENIZE_TIME_LIMIT_MS,
  });

  return {
    highlighter,
    async registerTheme(theme) {
      await highlighter.loadTheme(theme);
      const resolved = highlighter.getTheme(theme.name);
      // Same monaco-editor vs monaco-editor-core structural mismatch as above.
      monaco.editor.defineTheme(
        theme.name,
        textmateThemeToMonacoTheme(resolved) as Monaco.editor.IStandaloneThemeData,
      );
    },
  };
}
