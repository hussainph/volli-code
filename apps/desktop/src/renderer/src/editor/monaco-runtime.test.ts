import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  bootstrapShikiMonaco,
  ensureShikiLanguage,
  allShikiLangImporters,
  allEditorThemeImporters,
  resolveEditorThemeId,
  DEFAULT_EDITOR_THEME_ID,
} = vi.hoisted(() => ({
  bootstrapShikiMonaco: vi.fn(),
  ensureShikiLanguage: vi.fn(async () => true),
  allShikiLangImporters: vi.fn(() => [] as Array<() => Promise<unknown>>),
  allEditorThemeImporters: vi.fn(() => [] as Array<() => Promise<unknown>>),
  resolveEditorThemeId: vi.fn(() => "one-dark-pro"),
  DEFAULT_EDITOR_THEME_ID: "one-dark-pro",
}));

vi.mock("./shiki-monaco", () => ({ bootstrapShikiMonaco }));
vi.mock("./shiki-langs", () => ({ ensureShikiLanguage, allShikiLangImporters }));
vi.mock("./editor-theme-catalog", () => ({
  allEditorThemeImporters,
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
    highlighter: {},
    registerTheme: vi.fn(),
  });
  ensureShikiLanguage.mockResolvedValue(true);
  allShikiLangImporters.mockReturnValue([]);
  allEditorThemeImporters.mockReturnValue([]);
  resolveEditorThemeId.mockReturnValue("one-dark-pro");
});

describe("prepareMonacoEditorThemes", () => {
  it("bootstraps shiki once with catalog themes and langs, then sets the resolved default", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
    };
    const shiki = { highlighter: { id: "shiki" }, registerTheme: vi.fn() };
    const langs = [() => Promise.resolve({ id: "typescript" })];
    const themes = [() => Promise.resolve({ name: "one-dark-pro" })];
    bootstrapShikiMonaco.mockResolvedValue(shiki);
    allShikiLangImporters.mockReturnValue(langs);
    allEditorThemeImporters.mockReturnValue(themes);

    const result = await prepareMonacoEditorThemes(monaco as never);

    expect(allEditorThemeImporters).toHaveBeenCalledTimes(1);
    expect(allShikiLangImporters).toHaveBeenCalledTimes(1);
    expect(bootstrapShikiMonaco).toHaveBeenCalledTimes(1);
    expect(bootstrapShikiMonaco).toHaveBeenCalledWith(monaco, { themes, langs });
    expect(resolveEditorThemeId).toHaveBeenCalledWith({
      editorThemeId: null,
      appThemeSlug: "ember",
    });
    expect(defineTheme).not.toHaveBeenCalled();
    expect(setTheme).toHaveBeenCalledWith("one-dark-pro");
    expect(setTheme.mock.calls.at(-1)).toEqual(["one-dark-pro"]);
    expect(result).toBe(shiki);
  });

  it("does not register or activate volli-dark", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = { editor: { defineTheme, setTheme } };

    await prepareMonacoEditorThemes(monaco as never);

    expect(defineTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
    expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID);
  });

  it("keeps a theme queued before bootstrap instead of forcing the ember default", async () => {
    const { refreshMonacoEditorTheme } = await import("./monaco-theme");
    refreshMonacoEditorTheme("nord");
    const setTheme = vi.fn();
    const monaco = { editor: { defineTheme: vi.fn(), setTheme } };

    await prepareMonacoEditorThemes(monaco as never);

    expect(setTheme).toHaveBeenCalledWith("nord");
    expect(setTheme).not.toHaveBeenCalledWith("one-dark-pro");
  });
});

describe("createShikiBackedModelFactory", () => {
  it("calls ensureShikiLanguage when creating a model (no-op after eager bootstrap)", () => {
    const model = { id: "model-1" };
    const createModel = vi.fn(() => model);
    const parse = vi.fn((uri: string) => ({ path: uri }));
    const highlighter = { id: "highlighter" };

    const factory = createShikiBackedModelFactory(
      { editor: { createModel }, Uri: { parse } } as never,
      highlighter as never,
    );

    expect(
      factory.createModel({
        value: "const x = 1",
        language: "typescript",
        uri: "volli-document://file/p/main/src/index.ts",
      }),
    ).toBe(model);

    expect(ensureShikiLanguage).toHaveBeenCalledTimes(1);
    expect(ensureShikiLanguage).toHaveBeenCalledWith(highlighter, "typescript");
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
