import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  createHighlighterCore,
  createJavaScriptRegexEngine,
  textmateThemeToMonacoTheme,
  EncodedTokenMetadata,
  INITIAL,
} = vi.hoisted(() => ({
  createHighlighterCore: vi.fn(),
  createJavaScriptRegexEngine: vi.fn(),
  textmateThemeToMonacoTheme: vi.fn(),
  EncodedTokenMetadata: {
    getForeground: vi.fn((_metadata?: number) => 1),
    getFontStyle: vi.fn((_metadata?: number) => 0),
  },
  INITIAL: { kind: "initial" },
}));

vi.mock("shiki/core", () => ({
  createHighlighterCore,
}));

vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine,
}));

vi.mock("@shikijs/monaco", () => ({
  textmateThemeToMonacoTheme,
}));

vi.mock("@shikijs/vscode-textmate", () => ({
  EncodedTokenMetadata,
  INITIAL,
}));

vi.mock("./shiki-langs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shiki-langs")>();
  return {
    ...actual,
    ensureShikiLanguage: vi.fn(actual.ensureShikiLanguage),
  };
});

type TokensProvider = {
  getInitialState: () => {
    clone: () => { ruleStack: unknown };
    equals: (other: unknown) => boolean;
    ruleStack: unknown;
  };
  tokenize: (
    line: string,
    state: { ruleStack: unknown },
  ) => { endState: unknown; tokens: Array<{ startIndex: number; scopes: string }> };
};

function fakeHighlighter(
  loadedLanguages: string[] = [],
  loadedThemes: string[] = ["one-dark-pro"],
  options: {
    tokenizeLine2?: ReturnType<typeof vi.fn>;
    colorMap?: string[];
  } = {},
) {
  const languages = [...loadedLanguages];
  const themes = [...loadedThemes];
  const tokenizeLine2 =
    options.tokenizeLine2 ??
    vi.fn(() => ({
      tokens: new Uint32Array([0, 0]),
      ruleStack: INITIAL,
      stoppedEarly: false,
    }));
  return {
    getLoadedThemes: () => themes,
    getLoadedLanguages: () => languages,
    getTheme: vi.fn((name: string) => ({
      name,
      type: "dark" as const,
      colors: {},
      settings: [],
      fg: "#fff",
      bg: "#000",
    })),
    getLanguage: vi.fn(() => ({ tokenizeLine2 })),
    loadTheme: vi.fn(async (theme: { name?: string }) => {
      if (theme.name && !themes.includes(theme.name)) themes.push(theme.name);
    }),
    loadLanguage: vi.fn(async () => undefined),
    setTheme: vi.fn(() => ({ colorMap: options.colorMap ?? ["#000000", "#ff0000"] })),
    _languages: languages,
    _tokenizeLine2: tokenizeLine2,
  };
}

function fakeMonaco(existingLanguageIds: string[] = []) {
  const languages = existingLanguageIds.map((id) => ({ id }));
  const originalCreate = vi.fn(() => ({ id: "editor" }));
  return {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      create: originalCreate,
      originalCreate,
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
    rules: [
      { token: "keyword", foreground: "#F00", fontStyle: "italic bold" },
      { token: "comment", foreground: "#F00", fontStyle: "italic bold" },
      { token: "string", foreground: "#0f0" },
      { token: "empty" },
    ],
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
    const setThemeSpy = monaco.editor.setTheme;

    const { bootstrapShikiMonaco } = await import("./shiki-monaco");

    await bootstrapShikiMonaco(monaco as never);

    expect(createJavaScriptRegexEngine).toHaveBeenCalledTimes(1);
    expect(createHighlighterCore).toHaveBeenCalledWith({
      themes: [],
      langs: [],
      engine,
    });
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: "toml" });
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith("one-dark-pro", expect.anything());
    expect(monaco.languages.setTokensProvider).toHaveBeenCalledWith(
      "typescript",
      expect.objectContaining({
        getInitialState: expect.any(Function),
        tokenize: expect.any(Function),
      }),
    );
    expect(setThemeSpy).toHaveBeenCalledWith("one-dark-pro");
  });

  it("skips initial setTheme when no themes were loaded at bootstrap", async () => {
    createHighlighterCore.mockResolvedValue(fakeHighlighter([], []));
    const monaco = fakeMonaco();
    const setThemeSpy = monaco.editor.setTheme;
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");

    await bootstrapShikiMonaco(monaco as never);

    expect(setThemeSpy).not.toHaveBeenCalled();
  });

  it("registers a later theme into themeMap without re-wiring setTheme", async () => {
    const highlighter = fakeHighlighter([], ["one-dark-pro"]);
    const resolvedTheme = {
      name: "catppuccin-mocha",
      type: "dark" as const,
      colors: { "editor.background": "#1e1e2e" },
      settings: [],
      fg: "#cdd6f4",
      bg: "#1e1e2e",
    };
    highlighter.getTheme.mockImplementation((name: string) =>
      name === "catppuccin-mocha"
        ? resolvedTheme
        : { name, type: "dark" as const, colors: {}, settings: [], fg: "#fff", bg: "#000" },
    );
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco();
    const monacoTheme = {
      base: "vs-dark" as const,
      inherit: false,
      colors: { "editor.background": "#1e1e2e" },
      rules: [{ token: "keyword", foreground: "#cba6f7", fontStyle: "bold" }],
    };
    textmateThemeToMonacoTheme.mockReturnValue(monacoTheme);

    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);
    const setThemeAfterBootstrap = monaco.editor.setTheme;
    monaco.editor.defineTheme.mockClear();

    await session.registerTheme(resolvedTheme);
    monaco.editor.setTheme("catppuccin-mocha");

    expect(highlighter.loadTheme).toHaveBeenCalledWith(resolvedTheme);
    expect(textmateThemeToMonacoTheme).toHaveBeenCalledWith(resolvedTheme);
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith("catppuccin-mocha", monacoTheme);
    expect(monaco.editor.setTheme).toBe(setThemeAfterBootstrap);
    expect(highlighter.setTheme).toHaveBeenCalledWith("catppuccin-mocha");
  });

  it("does not reload a theme that the highlighter already has", async () => {
    const highlighter = fakeHighlighter([], ["one-dark-pro", "nord"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco();
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);

    await session.registerTheme(highlighter.getTheme("nord"));

    expect(highlighter.loadTheme).not.toHaveBeenCalled();
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith("nord", expect.anything());
  });

  it("installs a tokens provider for a language loaded after bootstrap", async () => {
    const highlighter = fakeHighlighter([], ["one-dark-pro"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco(["typescript"]);

    const { bootstrapShikiMonaco, ensureShikiLanguageBound } = await import("./shiki-monaco");
    const { ensureShikiLanguage } = await import("./shiki-langs");
    const session = await bootstrapShikiMonaco(monaco as never);
    monaco.languages.setTokensProvider.mockClear();

    vi.mocked(ensureShikiLanguage).mockResolvedValue(true);
    highlighter.getLoadedLanguages = () => ["typescript"];

    await ensureShikiLanguageBound(session, monaco as never, "typescript");

    expect(monaco.languages.setTokensProvider).toHaveBeenCalledTimes(1);
    expect(monaco.languages.setTokensProvider).toHaveBeenCalledWith(
      "typescript",
      expect.objectContaining({
        getInitialState: expect.any(Function),
        tokenize: expect.any(Function),
      }),
    );
  });

  it("returns false from ensureShikiLanguageBound when the grammar is unknown", async () => {
    createHighlighterCore.mockResolvedValue(fakeHighlighter());
    const monaco = fakeMonaco();
    const { bootstrapShikiMonaco, ensureShikiLanguageBound } = await import("./shiki-monaco");
    const { ensureShikiLanguage } = await import("./shiki-langs");
    vi.mocked(ensureShikiLanguage).mockResolvedValue(false);
    const session = await bootstrapShikiMonaco(monaco as never);

    expect(await ensureShikiLanguageBound(session, monaco as never, "plaintext")).toBe(false);
    expect(monaco.languages.setTokensProvider).not.toHaveBeenCalled();
  });

  it("patches editor.create to route theme through setTheme", async () => {
    createHighlighterCore.mockResolvedValue(fakeHighlighter());
    const monaco = fakeMonaco();
    const setThemeSpy = monaco.editor.setTheme;
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never);
    setThemeSpy.mockClear();

    const element = {} as HTMLElement;
    (monaco.editor.create as (el: HTMLElement, opts?: object, override?: object) => unknown)(
      element,
      { theme: "one-dark-pro" },
    );

    expect(setThemeSpy).toHaveBeenCalledWith("one-dark-pro");
    expect(monaco.editor.originalCreate).toHaveBeenCalledWith(
      element,
      { theme: "one-dark-pro" },
      undefined,
    );
  });

  it("tokenizes lines through the shared colorMap and skips oversized lines", async () => {
    const tokenizeLine2 = vi.fn(() => ({
      tokens: new Uint32Array([0, 1, 4, 2]),
      ruleStack: { next: true },
      stoppedEarly: true,
    }));
    EncodedTokenMetadata.getForeground.mockImplementation(
      ((metadata: number) => metadata) as () => number,
    );
    EncodedTokenMetadata.getFontStyle.mockImplementation(((metadata: number) =>
      metadata === 1 ? 1 | 2 | 4 | 8 : 0) as () => number);
    const highlighter = fakeHighlighter(["typescript"], ["one-dark-pro"], {
      tokenizeLine2,
      colorMap: ["#000000", "#ff0000", "#00ff00"],
    });
    createHighlighterCore.mockResolvedValue(highlighter);
    textmateThemeToMonacoTheme.mockReturnValue({
      base: "vs-dark",
      inherit: false,
      colors: {},
      rules: [
        {
          token: "keyword",
          foreground: "#FF0000",
          fontStyle: "italic bold underline strikethrough",
        },
        { token: "string", foreground: "#0F0" },
        { token: "comment", foreground: ["#ABC"] },
        { token: "empty" },
      ],
    });
    const monaco = fakeMonaco(["typescript"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { bootstrapShikiMonaco, SHIKI_TOKENIZE_MAX_LINE_LENGTH } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never, {
      tokenizeMaxLineLength: SHIKI_TOKENIZE_MAX_LINE_LENGTH,
      tokenizeTimeLimit: 12,
    });

    const provider = monaco.languages.setTokensProvider.mock.calls[0]![1] as TokensProvider;
    const initial = provider.getInitialState();
    expect(initial.equals(initial)).toBe(true);
    expect(initial.equals(provider.getInitialState() as never)).toBe(false);
    expect(initial.clone().ruleStack).toBe(INITIAL);

    const long = "x".repeat(SHIKI_TOKENIZE_MAX_LINE_LENGTH);
    expect(provider.tokenize(long, initial)).toEqual({
      endState: initial,
      tokens: [{ startIndex: 0, scopes: "" }],
    });
    expect(tokenizeLine2).not.toHaveBeenCalled();

    monaco.editor.setTheme("one-dark-pro");
    const result = provider.tokenize("code", initial);
    expect(tokenizeLine2).toHaveBeenCalledWith("code", INITIAL, 12);
    expect(warn).toHaveBeenCalled();
    expect(result.tokens[0]).toEqual({
      startIndex: 0,
      scopes: "keyword",
    });
    expect(result.tokens[1]?.scopes).toBe("string");
    warn.mockRestore();
  });

  it("maps short hex and line-through aliases when syncing theme rules", async () => {
    createHighlighterCore.mockResolvedValue(
      fakeHighlighter(["typescript"], ["one-dark-pro"], {
        colorMap: ["#000000", "#f0a"],
      }),
    );
    textmateThemeToMonacoTheme.mockReturnValue({
      base: "vs-dark",
      inherit: false,
      colors: {},
      rules: [
        { token: "short", foreground: "#f0a", fontStyle: "line-through , ITALIC" },
        { token: "hashless", foreground: "00ff00" },
      ],
    });
    EncodedTokenMetadata.getForeground.mockReturnValue(1);
    EncodedTokenMetadata.getFontStyle.mockReturnValue(1 | 8);
    const monaco = fakeMonaco(["typescript"]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never);
    monaco.editor.setTheme("one-dark-pro");

    const provider = monaco.languages.setTokensProvider.mock.calls[0]![1] as TokensProvider;
    const state = provider.getInitialState();
    expect(provider.tokenize("x", state).tokens[0]?.scopes).toBe("short");
  });

  it("covers font-style bit combinations and empty color scopes", async () => {
    const tokenizeLine2 = vi.fn(() => ({
      tokens: new Uint32Array([0, 10, 2, 20, 4, 30]),
      ruleStack: INITIAL,
      stoppedEarly: false,
    }));
    // bold-only, underline-only, then missing colorMap entry
    EncodedTokenMetadata.getForeground.mockImplementation(((metadata: number) =>
      metadata === 30 ? 99 : 1) as () => number);
    EncodedTokenMetadata.getFontStyle.mockImplementation(((metadata: number) => {
      if (metadata === 10) return 2; // bold
      if (metadata === 20) return 4; // underline
      return 0;
    }) as () => number);
    const highlighter = fakeHighlighter(["typescript"], ["one-dark-pro"], {
      tokenizeLine2,
      colorMap: ["#000000", "#ff0000"],
    });
    createHighlighterCore.mockResolvedValue(highlighter);
    textmateThemeToMonacoTheme.mockReturnValue({
      base: "vs-dark",
      inherit: false,
      colors: {},
      rules: [
        { token: "bold-token", foreground: "#FF0000", fontStyle: "bold" },
        { token: "underline-token", foreground: "#FF0000", fontStyle: "underline" },
      ],
    });
    const monaco = fakeMonaco(["typescript"]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never);
    monaco.editor.setTheme("one-dark-pro");

    const provider = monaco.languages.setTokensProvider.mock.calls[0]![1] as TokensProvider;
    const result = provider.tokenize("abc", provider.getInitialState());
    expect(result.tokens.map((token) => token.scopes)).toEqual([
      "bold-token",
      "underline-token",
      "",
    ]);
  });

  it("returns early when registering a language Monaco does not know", async () => {
    const highlighter = fakeHighlighter([], ["one-dark-pro"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco([]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);
    monaco.languages.setTokensProvider.mockClear();
    highlighter.getLoadedLanguages = () => ["rust"];

    session.registerLanguage("rust");
    expect(monaco.languages.setTokensProvider).not.toHaveBeenCalled();
  });

  it("ignores registerLanguage when the grammar is not loaded yet", async () => {
    const highlighter = fakeHighlighter([], ["one-dark-pro"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco(["rust"]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);
    monaco.languages.setTokensProvider.mockClear();

    session.registerLanguage("rust");
    expect(monaco.languages.setTokensProvider).not.toHaveBeenCalled();
  });

  it("emits empty scopes when a color has no matching theme rule", async () => {
    const tokenizeLine2 = vi.fn(() => ({
      tokens: new Uint32Array([0, 1]),
      ruleStack: INITIAL,
      stoppedEarly: false,
    }));
    EncodedTokenMetadata.getForeground.mockReturnValue(1);
    EncodedTokenMetadata.getFontStyle.mockReturnValue(0);
    createHighlighterCore.mockResolvedValue(
      fakeHighlighter(["typescript"], ["one-dark-pro"], {
        tokenizeLine2,
        colorMap: ["#000000", "#abcdef"],
      }),
    );
    textmateThemeToMonacoTheme.mockReturnValue({
      base: "vs-dark",
      inherit: false,
      colors: {},
      rules: [{ token: "other", foreground: "#ff0000" }],
    });
    const monaco = fakeMonaco(["typescript"]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never);
    monaco.editor.setTheme("one-dark-pro");

    const provider = monaco.languages.setTokensProvider.mock.calls[0]![1] as TokensProvider;
    expect(provider.tokenize("x", provider.getInitialState()).tokens[0]?.scopes).toBe("");
  });

  it("patches create without applying theme when options omit theme", async () => {
    createHighlighterCore.mockResolvedValue(fakeHighlighter());
    const monaco = fakeMonaco();
    const setThemeSpy = monaco.editor.setTheme;
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    await bootstrapShikiMonaco(monaco as never);
    setThemeSpy.mockClear();

    (monaco.editor.create as (el: HTMLElement, opts?: object) => unknown)({} as HTMLElement, {});
    expect(setThemeSpy).not.toHaveBeenCalled();
  });

  it("does not install a second provider for the same language", async () => {
    const highlighter = fakeHighlighter(["typescript"]);
    createHighlighterCore.mockResolvedValue(highlighter);
    const monaco = fakeMonaco(["typescript"]);
    const { bootstrapShikiMonaco } = await import("./shiki-monaco");
    const session = await bootstrapShikiMonaco(monaco as never);
    const calls = monaco.languages.setTokensProvider.mock.calls.length;

    session.registerLanguage("typescript");
    expect(monaco.languages.setTokensProvider).toHaveBeenCalledTimes(calls);
  });
});
