import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  createHighlighter,
  createJavaScriptRegexEngine,
  shikiToMonaco,
  textmateThemeToMonacoTheme,
} = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  createJavaScriptRegexEngine: vi.fn(),
  shikiToMonaco: vi.fn(),
  textmateThemeToMonacoTheme: vi.fn(),
}));

vi.mock("shiki", () => ({
  createHighlighter,
  createJavaScriptRegexEngine,
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco,
  textmateThemeToMonacoTheme,
}));

function fakeHighlighter() {
  return {
    getLoadedThemes: () => [] as string[],
    getLoadedLanguages: () => [] as string[],
    getTheme: vi.fn(),
    loadTheme: vi.fn(async () => undefined),
    setTheme: vi.fn(() => ({ colorMap: [] as string[] })),
  };
}

function fakeMonaco() {
  return {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      create: vi.fn(),
    },
    languages: {
      getLanguages: () => [] as Array<{ id: string }>,
      setTokensProvider: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createJavaScriptRegexEngine.mockReturnValue({ kind: "javascript" });
  createHighlighter.mockResolvedValue(fakeHighlighter());
  textmateThemeToMonacoTheme.mockReturnValue({
    base: "vs-dark",
    inherit: false,
    colors: {},
    rules: [],
  });
});

describe("bootstrapShikiMonaco", () => {
  it("wires Monaco once with the JS regex engine and tokenize limits", async () => {
    const engine = { kind: "javascript" };
    createJavaScriptRegexEngine.mockReturnValue(engine);
    const highlighter = fakeHighlighter();
    createHighlighter.mockResolvedValue(highlighter);
    const monaco = fakeMonaco();

    const { bootstrapShikiMonaco, SHIKI_TOKENIZE_MAX_LINE_LENGTH, SHIKI_TOKENIZE_TIME_LIMIT_MS } =
      await import("./shiki-monaco");

    await bootstrapShikiMonaco(monaco as never);

    expect(createJavaScriptRegexEngine).toHaveBeenCalledTimes(1);
    expect(createHighlighter).toHaveBeenCalledWith({
      themes: [],
      langs: [],
      engine,
    });
    expect(shikiToMonaco).toHaveBeenCalledTimes(1);
    expect(shikiToMonaco).toHaveBeenCalledWith(highlighter, monaco, {
      tokenizeMaxLineLength: SHIKI_TOKENIZE_MAX_LINE_LENGTH,
      tokenizeTimeLimit: SHIKI_TOKENIZE_TIME_LIMIT_MS,
    });
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
    createHighlighter.mockResolvedValue(highlighter);
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
