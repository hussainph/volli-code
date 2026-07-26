import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  allShikiLanguageIds,
  editorThemeImporterFor,
  resolveEditorThemeId,
  DEFAULT_EDITOR_THEME_ID,
} = vi.hoisted(() => ({
  bootstrapShikiMonaco: vi.fn(),
  ensureMonacoLanguagesRegistered: vi.fn(),
  ensureShikiLanguageBound: vi.fn(async () => true),
  allShikiLanguageIds: vi.fn(() => ["typescript", "toml"]),
  editorThemeImporterFor: vi.fn((id: string) =>
    id === "one-dark-pro" ? () => Promise.resolve({ name: "one-dark-pro" }) : null,
  ),
  resolveEditorThemeId: vi.fn(() => "one-dark-pro"),
  DEFAULT_EDITOR_THEME_ID: "one-dark-pro",
}));

vi.mock("./shiki-monaco", () => ({
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
}));
vi.mock("./shiki-langs", () => ({ allShikiLanguageIds }));
vi.mock("./editor-theme-catalog", () => ({
  editorThemeImporterFor,
  resolveEditorThemeId,
  DEFAULT_EDITOR_THEME_ID,
}));

import {
  createLazyInitializer,
  createShikiBackedModelFactory,
  prepareMonacoEditorThemes,
  waitForLanguageWorkerRegistration,
  workerKindForLabel,
} from "./monaco-runtime";
import { resetMonacoEditorThemeForTests } from "./monaco-theme";

beforeEach(() => {
  vi.clearAllMocks();
  resetMonacoEditorThemeForTests();
  bootstrapShikiMonaco.mockResolvedValue({
    highlighter: {
      getLoadedThemes: () => ["one-dark-pro"],
      loadTheme: vi.fn(async () => undefined),
      getTheme: vi.fn((name: string) => ({ name })),
    },
    registerTheme: vi.fn(async () => undefined),
    registerLanguage: vi.fn(),
  });
  ensureShikiLanguageBound.mockResolvedValue(true);
  allShikiLanguageIds.mockReturnValue(["typescript", "toml"]);
  editorThemeImporterFor.mockImplementation((id: string) =>
    id === "one-dark-pro" ? () => Promise.resolve({ name: "one-dark-pro" }) : null,
  );
  resolveEditorThemeId.mockReturnValue("one-dark-pro");
});

describe("prepareMonacoEditorThemes", () => {
  it("bootstraps with only the default theme and empty langs (not all importers)", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    const defaultLoad = () => Promise.resolve({ name: "one-dark-pro" });
    editorThemeImporterFor.mockReturnValue(defaultLoad);
    const shiki = {
      highlighter: {
        getLoadedThemes: () => ["one-dark-pro"],
        loadTheme: vi.fn(async () => undefined),
        getTheme: vi.fn((name: string) => ({ name })),
      },
      registerTheme: vi.fn(async () => undefined),
      registerLanguage: vi.fn(),
    };
    bootstrapShikiMonaco.mockResolvedValue(shiki);

    const result = await prepareMonacoEditorThemes(monaco as never);

    expect(allShikiLanguageIds).toHaveBeenCalledTimes(1);
    expect(ensureMonacoLanguagesRegistered).toHaveBeenCalledWith(monaco, ["typescript", "toml"]);
    expect(editorThemeImporterFor).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID);
    expect(bootstrapShikiMonaco).toHaveBeenCalledTimes(1);
    expect(bootstrapShikiMonaco).toHaveBeenCalledWith(monaco, {
      themes: [defaultLoad],
      langs: [],
    });
    expect(resolveEditorThemeId).toHaveBeenCalledWith({
      editorThemeId: null,
      appThemeSlug: "ember",
    });
    await vi.waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith("one-dark-pro");
    });
    expect(result).toBe(shiki);
  });

  it("does not register or activate volli-dark", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };

    await prepareMonacoEditorThemes(monaco as never);

    await vi.waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID);
    });
    expect(defineTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("keeps a theme queued before bootstrap instead of forcing the ember default", async () => {
    const { refreshMonacoEditorTheme } = await import("./monaco-theme");
    refreshMonacoEditorTheme("nord");
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme: vi.fn(), setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };

    await prepareMonacoEditorThemes(monaco as never);
    await vi.waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith("nord");
    });
    expect(setTheme).not.toHaveBeenCalledWith("one-dark-pro");
  });

  it("loads a late catalog theme through registerTheme before setTheme", async () => {
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme: vi.fn(), setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    const registerTheme = vi.fn(async () => undefined);
    const loadTheme = vi.fn(async () => undefined);
    const getTheme = vi.fn((name: string) => ({ name, type: "dark" as const }));
    bootstrapShikiMonaco.mockResolvedValue({
      highlighter: {
        getLoadedThemes: () => ["one-dark-pro"],
        loadTheme,
        getTheme,
      },
      registerTheme,
      registerLanguage: vi.fn(),
    });
    const nordLoad = () => Promise.resolve({ name: "nord" });
    editorThemeImporterFor.mockImplementation((id: string) => {
      if (id === "one-dark-pro") return () => Promise.resolve({ name: "one-dark-pro" });
      if (id === "nord") return nordLoad;
      return null;
    });

    await prepareMonacoEditorThemes(monaco as never);
    setTheme.mockClear();

    const { refreshMonacoEditorTheme } = await import("./monaco-theme");
    refreshMonacoEditorTheme("nord");
    await vi.waitFor(() => {
      expect(registerTheme).toHaveBeenCalled();
      expect(setTheme).toHaveBeenCalledWith("nord");
    });
    expect(loadTheme).toHaveBeenCalledWith(nordLoad);
  });
});

describe("createShikiBackedModelFactory", () => {
  it("binds the language provider when creating a model", () => {
    const model = { id: "model-1" };
    const createModel = vi.fn(() => model);
    const parse = vi.fn((uri: string) => ({ path: uri }));
    const session = {
      highlighter: {},
      registerTheme: vi.fn(),
      registerLanguage: vi.fn(),
    };
    const monaco = {
      editor: { createModel },
      Uri: { parse },
      languages: { getLanguages: () => [], register: vi.fn() },
    };

    const factory = createShikiBackedModelFactory(monaco as never, session as never);

    expect(
      factory.createModel({
        value: "const x = 1",
        language: "typescript",
        uri: "volli-document://file/p/main/src/index.ts",
      }),
    ).toBe(model);

    expect(ensureShikiLanguageBound).toHaveBeenCalledTimes(1);
    expect(ensureShikiLanguageBound).toHaveBeenCalledWith(session, monaco, "typescript");
    expect(createModel).toHaveBeenCalledWith(
      "const x = 1",
      "typescript",
      expect.objectContaining({ path: "volli-document://file/p/main/src/index.ts" }),
    );
  });
});

describe("createLazyInitializer", () => {
  it("shares one initialization promise across concurrent and later callers", async () => {
    const runtime = { name: "monaco" };
    const initialize = vi.fn(async () => runtime);
    const load = createLazyInitializer(initialize);

    const [first, second] = await Promise.all([load(), load()]);
    const third = await load();

    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(third).toBe(runtime);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe("workerKindForLabel", () => {
  it.each([
    ["json", "json"],
    ["css", "css"],
    ["scss", "css"],
    ["less", "css"],
    ["html", "html"],
    ["handlebars", "html"],
    ["razor", "html"],
    ["typescript", "typescript"],
    ["javascript", "typescript"],
    ["plaintext", "editor"],
  ] as const)("routes Monaco's %s label to the %s worker", (label, expected) => {
    expect(workerKindForLabel(label)).toBe(expected);
  });
});

describe("waitForLanguageWorkerRegistration", () => {
  it("yields while Monaco's asynchronous language activation is still registering", async () => {
    const worker = vi.fn();
    const getWorker = vi
      .fn<() => Promise<typeof worker>>()
      .mockRejectedValueOnce("TypeScript not registered!")
      .mockResolvedValue(worker);
    const waitForNextAttempt = vi.fn(async () => undefined);

    await expect(
      waitForLanguageWorkerRegistration(getWorker, { attempts: 2, waitForNextAttempt }),
    ).resolves.toBe(worker);
    expect(getWorker).toHaveBeenCalledTimes(2);
    expect(waitForNextAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not hide a non-registration worker failure", async () => {
    const failure = new Error("worker chunk failed to load");
    const getWorker = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const waitForNextAttempt = vi.fn(async () => undefined);

    await expect(
      waitForLanguageWorkerRegistration(getWorker, { attempts: 5, waitForNextAttempt }),
    ).rejects.toBe(failure);
    expect(getWorker).toHaveBeenCalledTimes(1);
    expect(waitForNextAttempt).not.toHaveBeenCalled();
  });
});
