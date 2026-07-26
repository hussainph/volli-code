/**
 * Shiki ↔ Monaco wire-up.
 *
 * Vendored from `@shikijs/monaco@4.3.1` (MIT — Copyright (c) 2021 Pine Wu,
 * Copyright (c) 2023 Anthony Fu) so we own a single `themeMap` / `colorMap` and
 * can `registerLanguage` after late `loadLanguage`. Call {@link wireShikiToMonaco}
 * exactly once — never stack `setTheme` wrappers.
 */

import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import { EncodedTokenMetadata, INITIAL, type StateStack } from "@shikijs/vscode-textmate";
import type * as Monaco from "monaco-editor";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageInput, ThemeInput, ThemeRegistrationResolved } from "shiki/types";

import { ensureShikiLanguage } from "./shiki-langs";

/** Cap line length so minified/huge files cannot stall the main thread. */
export const SHIKI_TOKENIZE_MAX_LINE_LENGTH = 20_000;

/** Cap per-line tokenize time (ms) so pathological grammars yield instead of hang. */
export const SHIKI_TOKENIZE_TIME_LIMIT_MS = 500;

/** `@shikijs/vscode-textmate` FontStyle bits (const enum — copy values for isolatedModules). */
const FONT_STYLE_NONE = 0;
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

export interface ShikiMonacoBootstrap {
  highlighter: HighlighterCore;
  /**
   * Register a TextMate theme with Monaco without calling {@link wireShikiToMonaco}
   * again. Updates the shared themeMap so late `setTheme` keeps token colors.
   */
  registerTheme: (theme: ThemeRegistrationResolved) => Promise<void>;
  /**
   * Install a TextMate tokens provider for a language already loaded into the
   * highlighter. Shares the bootstrap colorMap / setTheme wrapper.
   */
  registerLanguage: (languageId: string) => void;
}

export interface BootstrapShikiMonacoOptions {
  themes?: ThemeInput[];
  langs?: LanguageInput[];
  tokenizeMaxLineLength?: number;
  tokenizeTimeLimit?: number;
}

interface ShikiMonacoWireOptions {
  tokenizeMaxLineLength?: number;
  tokenizeTimeLimit?: number;
}

interface ShikiMonacoWire {
  registerLanguage: (languageId: string) => void;
  /** Sync themeMap + `defineTheme`. Theme must already be loaded in the highlighter. */
  defineTheme: (theme: ThemeRegistrationResolved) => void;
}

class TokenizerState implements Monaco.languages.IState {
  constructor(private readonly ruleStackValue: StateStack) {}

  get ruleStack(): StateStack {
    return this.ruleStackValue;
  }

  clone(): TokenizerState {
    return new TokenizerState(this.ruleStackValue);
  }

  equals(other: Monaco.languages.IState): boolean {
    if (
      !(other instanceof TokenizerState) ||
      other !== this ||
      other.ruleStackValue !== this.ruleStackValue
    ) {
      return false;
    }
    return true;
  }
}

const RE_FONT_STYLE_SPLIT = /[\s,]+/;
const VALID_FONT_STYLES = ["italic", "bold", "underline", "strikethrough"] as const;
const VALID_FONT_ALIASES: Readonly<Record<string, string>> = {
  "line-through": "strikethrough",
};

function normalizeColor(color: string | string[] | undefined): string | undefined {
  let value: string | undefined = Array.isArray(color) ? color[0] : color;
  if (!value) return undefined;
  value = (value.charCodeAt(0) === 35 ? value.slice(1) : value).toLowerCase();
  if (value.length === 3 || value.length === 4) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return value;
}

function normalizeFontStyleBits(fontStyle: number): string {
  if (fontStyle <= FONT_STYLE_NONE) return "";
  const styles: string[] = [];
  if (fontStyle & FONT_STYLE_ITALIC) styles.push("italic");
  if (fontStyle & FONT_STYLE_BOLD) styles.push("bold");
  if (fontStyle & FONT_STYLE_UNDERLINE) styles.push("underline");
  if (fontStyle & FONT_STYLE_STRIKETHROUGH) styles.push("strikethrough");
  return styles.join(" ");
}

function normalizeFontStyleString(fontStyle: string | undefined): string {
  if (!fontStyle) return "";
  const styles = new Set(
    fontStyle
      .split(RE_FONT_STYLE_SPLIT)
      .map((style) => style.trim().toLowerCase())
      .map((style) => VALID_FONT_ALIASES[style] || style)
      .filter(Boolean),
  );
  return VALID_FONT_STYLES.filter((style) => styles.has(style)).join(" ");
}

function getColorStyleKey(color: string, fontStyle: string): string {
  if (!fontStyle) return color;
  return `${color}|${fontStyle}`;
}

/**
 * Ensure every language id exists in Monaco before providers attach.
 *
 * `@shikijs/monaco` (and this fork) only call `setTokensProvider` when
 * `monaco.languages.getLanguages()` already lists the id. Monaco 0.56 ships
 * many built-ins but not catalog ids like `toml`, `cmake`, `makefile`, or
 * `properties` — register those (and any other gaps) as empty shells so
 * TextMate highlighting can attach when grammars load.
 */
export function ensureMonacoLanguagesRegistered(
  monaco: {
    languages: {
      getLanguages: () => ReadonlyArray<{ id: string }>;
      register: (language: { id: string }) => void;
    };
  },
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
 * One-shot Shiki → Monaco adapter (vendored). Owns themeMap/colorMap and
 * exposes late {@link ShikiMonacoWire.registerLanguage} / `defineTheme`.
 */
export function wireShikiToMonaco(
  highlighter: HighlighterCore,
  monaco: typeof Monaco,
  options: ShikiMonacoWireOptions = {},
): ShikiMonacoWire {
  const themeMap = new Map<string, Monaco.editor.IStandaloneThemeData>();
  const themeIds = highlighter.getLoadedThemes();
  for (const themeId of themeIds) {
    const monacoTheme = textmateThemeToMonacoTheme(
      highlighter.getTheme(themeId),
    ) as Monaco.editor.IStandaloneThemeData;
    themeMap.set(themeId, monacoTheme);
    monaco.editor.defineTheme(themeId, monacoTheme);
  }

  const colorMap: string[] = [];
  const colorStyleToScopeMap = new Map<string, string>();
  const originalSetTheme = monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = (themeName: string) => {
    const ret = highlighter.setTheme(themeName);
    const theme = themeMap.get(themeName);
    colorMap.length = ret.colorMap.length;
    for (let i = 0; i < ret.colorMap.length; i++) colorMap[i] = ret.colorMap[i]!;
    colorStyleToScopeMap.clear();
    theme?.rules.forEach((rule) => {
      const c = normalizeColor(rule.foreground);
      if (!c) return;
      const key = getColorStyleKey(c, normalizeFontStyleString(rule.fontStyle));
      if (!colorStyleToScopeMap.has(key)) colorStyleToScopeMap.set(key, rule.token);
    });
    originalSetTheme(themeName);
  };

  const originalCreate = monaco.editor.create.bind(monaco.editor);
  monaco.editor.create = ((
    element: HTMLElement,
    createOptions?: Monaco.editor.IStandaloneEditorConstructionOptions,
    override?: Monaco.editor.IEditorOverrideServices,
  ) => {
    if (createOptions?.theme) monaco.editor.setTheme(createOptions.theme);
    return originalCreate(element, createOptions, override);
  }) as typeof monaco.editor.create;

  if (themeIds[0] !== undefined) {
    monaco.editor.setTheme(themeIds[0]);
  }

  function findScopeByColorAndStyle(color: string, fontStyle: number): string | undefined {
    const key = getColorStyleKey(color, normalizeFontStyleBits(fontStyle));
    return colorStyleToScopeMap.get(key);
  }

  const tokenizeMaxLineLength = options.tokenizeMaxLineLength ?? SHIKI_TOKENIZE_MAX_LINE_LENGTH;
  const tokenizeTimeLimit = options.tokenizeTimeLimit ?? SHIKI_TOKENIZE_TIME_LIMIT_MS;
  const boundProviders = new Set<string>();

  function registerLanguage(lang: string): void {
    if (boundProviders.has(lang)) return;
    const monacoLanguageIds = new Set(monaco.languages.getLanguages().map((l) => l.id));
    if (!monacoLanguageIds.has(lang)) return;
    if (!highlighter.getLoadedLanguages().includes(lang)) return;

    monaco.languages.setTokensProvider(lang, {
      getInitialState() {
        return new TokenizerState(INITIAL);
      },
      tokenize(line, state) {
        const tokenizerState = state as TokenizerState;
        if (line.length >= tokenizeMaxLineLength) {
          return {
            endState: tokenizerState,
            tokens: [{ startIndex: 0, scopes: "" }],
          };
        }
        const result = highlighter
          .getLanguage(lang)
          .tokenizeLine2(line, tokenizerState.ruleStack, tokenizeTimeLimit);
        if (result.stoppedEarly) {
          console.warn(`Time limit reached when tokenizing line: ${line.substring(0, 100)}`);
        }
        const tokensLength = result.tokens.length / 2;
        const tokens: Array<{ startIndex: number; scopes: string }> = [];
        for (let j = 0; j < tokensLength; j++) {
          const startIndex = result.tokens[2 * j]!;
          const metadata = result.tokens[2 * j + 1]!;
          const color = normalizeColor(
            colorMap[EncodedTokenMetadata.getForeground(metadata)] || "",
          );
          const fontStyle = EncodedTokenMetadata.getFontStyle(metadata);
          const scope = color ? findScopeByColorAndStyle(color, fontStyle) || "" : "";
          tokens.push({ startIndex, scopes: scope });
        }
        return {
          endState: new TokenizerState(result.ruleStack),
          tokens,
        };
      },
    });
    boundProviders.add(lang);
  }

  for (const lang of highlighter.getLoadedLanguages()) {
    registerLanguage(lang);
  }

  return {
    registerLanguage,
    defineTheme(theme) {
      const monacoTheme = textmateThemeToMonacoTheme(theme) as Monaco.editor.IStandaloneThemeData;
      themeMap.set(theme.name, monacoTheme);
      monaco.editor.defineTheme(theme.name, monacoTheme);
    },
  };
}

/**
 * Load a document language grammar and install its TextMate tokens provider.
 * Returns `false` for plaintext / unknown ids.
 */
export async function ensureShikiLanguageBound(
  session: ShikiMonacoBootstrap,
  monaco: {
    languages: {
      getLanguages: () => ReadonlyArray<{ id: string }>;
      register: (language: { id: string }) => void;
    };
  },
  monacoLanguageId: string,
): Promise<boolean> {
  const loaded = await ensureShikiLanguage(session.highlighter, monacoLanguageId);
  if (!loaded) return false;
  ensureMonacoLanguagesRegistered(monaco, [monacoLanguageId]);
  session.registerLanguage(monacoLanguageId);
  return true;
}

/**
 * Create a JS-regex shiki highlighter (core + engine; no bundle-full registry)
 * and wire it to Monaco exactly once.
 *
 * Bootstrap with a tiny theme set (typically the default catalog theme) and
 * empty langs — late themes use {@link ShikiMonacoBootstrap.registerTheme};
 * late langs use {@link ensureShikiLanguageBound} / `registerLanguage`.
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

  // Register any langs already loaded (usually none) before the one-shot wire.
  ensureMonacoLanguagesRegistered(monaco, highlighter.getLoadedLanguages());

  const wire = wireShikiToMonaco(highlighter, monaco, {
    tokenizeMaxLineLength: options.tokenizeMaxLineLength,
    tokenizeTimeLimit: options.tokenizeTimeLimit,
  });

  return {
    highlighter,
    registerLanguage: wire.registerLanguage,
    async registerTheme(theme) {
      if (!highlighter.getLoadedThemes().includes(theme.name)) {
        await highlighter.loadTheme(theme);
      }
      const resolved = highlighter.getTheme(theme.name);
      wire.defineTheme(resolved);
    },
  };
}
