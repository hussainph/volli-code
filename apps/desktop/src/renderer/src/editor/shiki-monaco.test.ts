import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  createHighlighterCore,
  createJavaScriptRegexEngine,
  shikiToMonaco,
  textmateThemeToMonacoTheme,
} = vi.hoisted(() => ({
  createHighlighterCore: vi.fn(),
  createJavaScriptRegexEngine: vi.fn(),
  shikiToMonaco: vi.fn(),
  textmateThemeToMonacoTheme: vi.fn(),
}));

vi.mock("shiki/core", () => ({
  createHighlighterCore,
}));

vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine,
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco,
  textmateThemeToMonacoTheme,
}));

function fakeHighlighter(loadedLanguages: string[] = []) {
  return {
    getLoadedThemes: () => [] as string[],
    getLoadedLanguages: () => loadedLanguages,
    getTheme: vi.fn(),
    loadTheme: vi.fn(async () => undefined),
    setTheme: vi.fn(() => ({ colorMap: [] as string[] })),
  };
}

function fakeMonaco(existingLanguageIds: string[] = []) {
  const languages = existingLanguageIds.map((id) => ({ id }));
  return {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      create: vi.fn(),
    },
    languages: {
      getLanguages: () => languages,
      register: vi.fn((language: { id: string }) => {
        languages.push(language);
      }),
      setTokensProvider: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createJavaScriptRegexEngine.mockReturnValue({ kind: "javascript" });
  createHighlighterCore.mockResolvedValue(fakeHighlighter());
  textmateThemeToMonacoTheme.mockReturnValue({
    base: "vs-dark",
    inherit: false,
    colors: {},
    rules: [],
  });
});

describe("ensureMonacoLanguagesRegistered", () => {
  it("registers only language ids Monaco does not already know", async () => {
    const monaco = fakeMonaco(["typescript", "json"]);
    const { ensureMonacoLanguagesRegistered } = await import("./shiki-monaco");

    ensureMonacoLanguagesRegistered(monaco as never, [
      "typescript",
      "toml",
      "cmake",
      "makefile",
      "properties",
      "toml",
    ]);

    expect(monaco.languages.register).toHaveBeenCalledTimes(4);
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "toml" });
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "cmake" });
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "makefile" });
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "properties" });
    expect(monaco.languages.getLanguages().map((language) => language.id)).toEqual([
      "typescript",
      "json",
      "toml",
      "cmake",
      "makefile",
      "properties",
    ]);
  });
});

describe("bootstrapShikiMonaco", () => {
  it("wires Monaco once with the JS regex engine and tokenize limits", async () => {
    const engine = { kind: "javascript" };
    createJavaScriptRegexEngine.mockReturnValue(engine);
    const highlighter = fakeHighlighter(["typescript", "toml"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco(["typescript"]);

    const { bootstrapShikiMonaco, SHIKI_TOKENIZE_MAX_LINE_LENGTH, SHIKI_TOKENIZE_TIME_LIMIT_MS } =
      await import("./shiki-monaco");

    await bootstrapShikiMonaco(monaco as never);

    expect(createJavaScriptRegexEngine).toHaveBeenCalledTimes(1);
    expect(createHighlighterCore).toHaveBeenCalledWith({
      themes: [],
      langs: [],
      engine,
    });
    expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "toml" });
    expect(shikiToMonaco).toHaveBeenCalledTimes(1);
    expect(shikiToMonaco).toHaveBeenCalledWith(highlighter, monaco, {
      tokenizeMaxLineLength: SHIKI_TOKENIZE_MAX_LINE_LENGTH,
      tokenizeTimeLimit: SHIKI_TOKENIZE_TIME_LIMIT_MS,
    });
    const registerOrder = monaco.languages.register.mock.invocationCallOrder[0];
    const shikiOrder = shikiToMonaco.mock.invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(shikiOrder);
  });

  it("registers a later theme without calling shikiToMonaco again", async () => {
    const highlighter = fakeHighlighter();
    const resolvedTheme = {
      name: "catppuccin-mocha",
      type: "dark" as const,
      colors: { "editor.background": "#1e1e2e" },
      settings: [],
      fg: "#cdd6f4",
      bg: "#1e1e2e",
    };
    highlighter.getTheme.mockReturnValue(resolvedTheme);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco();
    const monacoTheme = {
      base: "vs-dark" as const,
      inherit: false,
      colors: { "editor.background": "#1e1e2e" },
      rules: [],
    };
    textmateThemeToMonacoTheme.mockReturnValue(monacoTheme);

    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);

    await session.registerTheme(resolvedTheme);

    expect(highlighter.loadTheme).toHaveBeenCalledWith(resolvedTheme);
    expect(textmateThemeToMonacoTheme).toHaveBeenCalledWith(resolvedTheme);
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith("catppuccin-mocha", monacoTheme);
    expect(shikiToMonaco).toHaveBeenCalledTimes(1);
  });
});
