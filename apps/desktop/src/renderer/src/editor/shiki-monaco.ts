import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import type * as Monaco from "monaco-editor";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageInput, ThemeInput, ThemeRegistrationResolved } from "shiki/types";

/** Cap line length so minified/huge files cannot stall the main thread. */
export const SHIKI_TOKENIZE_MAX_LINE_LENGTH = 20_000;

/** Cap per-line tokenize time (ms) so pathological grammars yield instead of hang. */
export const SHIKI_TOKENIZE_TIME_LIMIT_MS = 500;

export interface ShikiMonacoBootstrap {
  highlighter: HighlighterCore;
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
 * Ensure every loaded shiki language id exists in Monaco before `shikiToMonaco`.
 *
 * `@shikijs/monaco` only calls `setTokensProvider` when
 * `monaco.languages.getLanguages()` already lists the id. Monaco 0.56 ships
 * many built-ins but not catalog ids like `toml`, `cmake`, `makefile`, or
 * `properties` — register those (and any other gaps) so TextMate highlighting
 * attaches.
 */
export function ensureMonacoLanguagesRegistered(
  monaco: Pick<typeof Monaco, "languages">,
  languageIds: Iterable<string>,
): void {
  const existing = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const id of languageIds) {
    if (existing.has(id)) continue;
    monaco.languages.register({ id });
    existing.add(id);
  }
}

/**
 * Create a JS-regex shiki highlighter (core + engine; no bundle-full registry)
 * and wire it to Monaco exactly once.
 *
 * Document languages are expected eagerly in `options.langs` so providers can
 * register in this single `shikiToMonaco` pass. Late `loadLanguage` alone cannot
 * install TextMate providers — `@shikijs/monaco` does not re-bind on subsequent
 * loads.
 */
export async function bootstrapShikiMonaco(
  monaco: typeof Monaco,
  options: BootstrapShikiMonacoOptions = {},
): Promise<ShikiMonacoBootstrap> {
  const engine = createJavaScriptRegexEngine();
  const highlighter = await createHighlighterCore({
    themes: options.themes ?? [],
    langs: options.langs ?? [],
    engine,
  });

  ensureMonacoLanguagesRegistered(monaco, highlighter.getLoadedLanguages());

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
