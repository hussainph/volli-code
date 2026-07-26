import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  allShikiLanguageIds,
  editorThemeImporterFor,
  resolveEditorThemeId,
  DEFAULT_EDITOR_THEME_ID,
  workerClasses,
  monacoModule,
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
  workerClasses: {
    editor: class EditorWorker {
      constructor(readonly options?: WorkerOptions) {}
    },
    json: class JsonWorker {
      constructor(readonly options?: WorkerOptions) {}
    },
    css: class CssWorker {
      constructor(readonly options?: WorkerOptions) {}
    },
    html: class HtmlWorker {
      constructor(readonly options?: WorkerOptions) {}
    },
    typescript: class TypeScriptWorker {
      constructor(readonly options?: WorkerOptions) {}
    },
  },
  monacoModule: {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      createModel: vi.fn(),
    },
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
    },
    Uri: {
      parse: vi.fn((value: string) => ({ path: value })),
    },
    typescript: {
      getTypeScriptWorker: vi.fn(),
      getJavaScriptWorker: vi.fn(),
    },
  },
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
vi.mock("monaco-editor/editor/editor.worker?worker", () => ({
  default: workerClasses.editor,
}));
vi.mock("monaco-editor/language/json/json.worker?worker", () => ({
  default: workerClasses.json,
}));
vi.mock("monaco-editor/language/css/css.worker?worker", () => ({
  default: workerClasses.css,
}));
vi.mock("monaco-editor/language/html/html.worker?worker", () => ({
  default: workerClasses.html,
}));
vi.mock("monaco-editor/language/typescript/ts.worker?worker", () => ({
  default: workerClasses.typescript,
}));
vi.mock("monaco-editor", () => monacoModule);

import {
  createLazyInitializer,
  createShikiBackedModelFactory,
  initializeMonacoRuntime,
  prepareMonacoEditorThemes,
  startModelLanguageWorker,
  waitForLanguageWorkerRegistration,
  workerKindForLabel,
} from "./monaco-runtime";
import { resetMonacoEditorThemeForTests } from "./monaco-theme";

const loadOneDarkPro = () => Promise.resolve({ name: "one-dark-pro" });
const loadNord = () => Promise.resolve({ name: "nord" });

function runtimeWithWorkers() {
  const typeScriptWorker = vi.fn(async () => undefined);
  const javaScriptWorker = vi.fn(async () => undefined);
  const typeScriptFactory = vi.fn(async () => typeScriptWorker);
  const javaScriptFactory = vi.fn(async () => javaScriptWorker);
  const runtime = {
    monaco: {
      typescript: {
        getTypeScriptWorker: typeScriptFactory,
        getJavaScriptWorker: javaScriptFactory,
      },
    },
  };
  return {
    runtime,
    typeScriptWorker,
    javaScriptWorker,
    typeScriptFactory,
    javaScriptFactory,
  };
}

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
  monacoModule.editor.setTheme.mockClear();
  monacoModule.languages.register.mockClear();
});

describe("prepareMonacoEditorThemes", () => {
  it("bootstraps with only the default theme and empty langs (not all importers)", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    editorThemeImporterFor.mockReturnValue(loadOneDarkPro);
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
      themes: [loadOneDarkPro],
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

  it("bootstraps with no theme when the default importer is unavailable", async () => {
    editorThemeImporterFor.mockReturnValue(null);
    const monaco = {
      editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
      languages: { getLanguages: () => [], register: vi.fn() },
    };

    await prepareMonacoEditorThemes(monaco as never);

    expect(bootstrapShikiMonaco).toHaveBeenCalledWith(monaco, {
      themes: [],
      langs: [],
    });
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
    editorThemeImporterFor.mockImplementation((id: string) => {
      if (id === "one-dark-pro") return loadOneDarkPro;
      if (id === "nord") return loadNord;
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
    expect(loadTheme).toHaveBeenCalledWith(loadNord);
  });

  it("skips loading and registration for a late id with no catalog importer", async () => {
    const setTheme = vi.fn();
    const loadTheme = vi.fn(async () => undefined);
    const registerTheme = vi.fn(async () => undefined);
    const monaco = {
      editor: { defineTheme: vi.fn(), setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    editorThemeImporterFor.mockImplementation((id: string) =>
      id === "one-dark-pro" ? loadOneDarkPro : null,
    );
    bootstrapShikiMonaco.mockResolvedValue({
      highlighter: {
        getLoadedThemes: () => ["one-dark-pro"],
        loadTheme,
        getTheme: vi.fn((name: string) => ({ name })),
      },
      registerTheme,
      registerLanguage: vi.fn(),
    });

    await prepareMonacoEditorThemes(monaco as never);
    loadTheme.mockClear();
    registerTheme.mockClear();
    const { refreshMonacoEditorTheme } = await import("./monaco-theme");
    refreshMonacoEditorTheme("missing");

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("missing"));
    expect(loadTheme).not.toHaveBeenCalled();
    expect(registerTheme).not.toHaveBeenCalled();
  });
});

describe("initializeMonacoRuntime", () => {
  it("configures every Vite worker and returns a Shiki-backed registry", async () => {
    const runtime = await initializeMonacoRuntime();
    const environment = globalThis.MonacoEnvironment as {
      getWorker(workerId: string, label: string): Worker & { options?: WorkerOptions };
    };

    for (const [label, WorkerClass] of [
      ["plaintext", workerClasses.editor],
      ["json", workerClasses.json],
      ["scss", workerClasses.css],
      ["html", workerClasses.html],
      ["typescript", workerClasses.typescript],
    ] as const) {
      const worker = environment.getWorker("worker-id", label);
      expect(worker).toBeInstanceOf(WorkerClass);
      expect(worker.options).toEqual({ name: `volli-monaco-${label}` });
    }
    expect(runtime.monaco.editor).toBe(monacoModule.editor);
    expect(runtime.monaco.languages).toBe(monacoModule.languages);
    expect(runtime.registry).toBeDefined();
    expect(runtime.shiki).toBeDefined();
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

  it("applies external text through Monaco edit operations without setValue", () => {
    const fullRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 };
    const pushEditOperations = vi.fn();
    const setValue = vi.fn();
    const model = { getFullModelRange: () => fullRange, pushEditOperations, setValue };
    const monaco = {
      editor: { createModel: vi.fn(() => model) },
      Uri: { parse: vi.fn((uri: string) => ({ path: uri })) },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    const session = {
      highlighter: {},
      registerTheme: vi.fn(),
      registerLanguage: vi.fn(),
    };
    const factory = createShikiBackedModelFactory(monaco as never, session as never);

    factory.applyExternalEdit(model as never, "agent update\n");

    expect(pushEditOperations).toHaveBeenCalledWith(
      [],
      [{ range: fullRange, text: "agent update\n" }],
      expect.any(Function),
    );
    expect(setValue).not.toHaveBeenCalled();
  });

  it("reports a rejected grammar load without rejecting the synchronous model create", async () => {
    const failure = new Error("grammar chunk missing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ensureShikiLanguageBound.mockRejectedValue(failure);
    const model = { id: "model-1" };
    const monaco = {
      editor: { createModel: vi.fn(() => model) },
      Uri: { parse: vi.fn((uri: string) => ({ path: uri })) },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    const session = {
      highlighter: {},
      registerTheme: vi.fn(),
      registerLanguage: vi.fn(),
    };
    const factory = createShikiBackedModelFactory(monaco as never, session as never);

    expect(
      factory.createModel({
        value: "const x = 1",
        language: "typescript",
        uri: "volli-document://file/p/main/src/index.ts",
      }),
    ).toBe(model);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[volli] failed to load Shiki grammar "typescript":',
        failure,
      ),
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

  it("uses its default retry yield and eventually returns the worker", async () => {
    const worker = vi.fn();
    const getWorker = vi
      .fn<() => Promise<typeof worker>>()
      .mockRejectedValueOnce(new Error("JavaScript not registered!"))
      .mockResolvedValue(worker);

    await expect(waitForLanguageWorkerRegistration(getWorker)).resolves.toBe(worker);
    expect(getWorker).toHaveBeenCalledTimes(2);
  });

  it("rethrows the registration error after the final permitted attempt", async () => {
    const failure = new Error("TypeScript not registered!");
    const getWorker = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(waitForLanguageWorkerRegistration(getWorker, { attempts: 1 })).rejects.toBe(
      failure,
    );
  });
});

describe("startModelLanguageWorker", () => {
  it("does not start a rich worker for non-JavaScript models", async () => {
    const { runtime, typeScriptFactory, javaScriptFactory } = runtimeWithWorkers();
    const model = { getLanguageId: () => "json", uri: { path: "/data.json" } };

    await expect(startModelLanguageWorker(runtime as never, model as never)).resolves.toBeNull();
    expect(typeScriptFactory).not.toHaveBeenCalled();
    expect(javaScriptFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["typescript", "typeScriptWorker", "typeScriptFactory"],
    ["javascript", "javaScriptWorker", "javaScriptFactory"],
  ] as const)("starts the %s worker for the model URI", async (language, workerKey, factoryKey) => {
    const seams = runtimeWithWorkers();
    const uri = { path: `/src/file.${language}` };
    const model = { getLanguageId: () => language, uri };

    await expect(startModelLanguageWorker(seams.runtime as never, model as never)).resolves.toBe(
      "typescript",
    );
    expect(seams[factoryKey]).toHaveBeenCalledTimes(1);
    expect(seams[workerKey]).toHaveBeenCalledWith(uri);
  });
});
