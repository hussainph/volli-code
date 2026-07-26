import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { bootstrapShikiMonaco, ensureShikiLanguage } = vi.hoisted(() => ({
  bootstrapShikiMonaco: vi.fn(),
  ensureShikiLanguage: vi.fn(async () => true),
}));

vi.mock("./shiki-monaco", () => ({ bootstrapShikiMonaco }));
vi.mock("./shiki-langs", () => ({ ensureShikiLanguage }));

import {
  createLazyInitializer,
  createShikiBackedModelFactory,
  prepareMonacoEditorThemes,
  waitForLanguageWorkerRegistration,
  workerKindForLabel,
} from "./monaco-runtime";

beforeEach(() => {
  vi.clearAllMocks();
  bootstrapShikiMonaco.mockResolvedValue({
    highlighter: {},
    registerTheme: vi.fn(),
  });
  ensureShikiLanguage.mockResolvedValue(true);
});

describe("prepareMonacoEditorThemes", () => {
  it("bootstraps shiki once then keeps volli-dark as the active Monaco theme", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
    };
    const shiki = { highlighter: { id: "shiki" }, registerTheme: vi.fn() };
    bootstrapShikiMonaco.mockResolvedValue(shiki);

    const result = await prepareMonacoEditorThemes(monaco as never, {
      background: "#111111",
      foreground: "#f5f5f5",
      muted: "#1c1c1c",
      mutedForeground: "#9a9a9a",
      border: "#262626",
      primary: "#e8652a",
      destructive: "#e5484d",
    });

    expect(bootstrapShikiMonaco).toHaveBeenCalledTimes(1);
    expect(bootstrapShikiMonaco).toHaveBeenCalledWith(monaco);
    expect(defineTheme).toHaveBeenCalledWith(
      "volli-dark",
      expect.objectContaining({
        base: "vs-dark",
        colors: expect.objectContaining({ "editor.background": "#111111" }),
      }),
    );
    expect(setTheme).toHaveBeenCalledWith("volli-dark");
    expect(result).toBe(shiki);
    // shiki's empty-theme bootstrap may call setTheme(undefined); volli-dark must win last.
    expect(setTheme.mock.calls.at(-1)).toEqual(["volli-dark"]);
  });
});

describe("createShikiBackedModelFactory", () => {
  it("ensures the shiki grammar when a Monaco model is created", () => {
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
