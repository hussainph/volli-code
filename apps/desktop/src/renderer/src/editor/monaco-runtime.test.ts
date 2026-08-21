import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  allShikiLanguageIds,
  editorThemeImporterFor,
  resolveEditorThemeId,
  workerClasses,
  monacoModule,
} = vi.hoisted(() => ({
  bootstrapShikiMonaco: vi.fn(),
  ensureMonacoLanguagesRegistered: vi.fn(),
  ensureShikiLanguageBound: vi.fn(async () => true),
  allShikiLanguageIds: vi.fn(() => ["typescript", "toml"]),
  editorThemeImporterFor: vi.fn((id: string) =>
    id === "vitesse-dark" ? () => Promise.resolve({ name: "vitesse-dark" }) : null,
  ),
  resolveEditorThemeId: vi.fn(() => "vitesse-dark"),
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
vi.mock("./editor-theme-catalog", () => ({ editorThemeImporterFor, resolveEditorThemeId }));
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
  externalEditOperations,
  initializeMonacoRuntime,
  mapCodeEditorViewState,
  MAX_VIEW_STATE_LOGICAL_LINES,
  prepareMonacoEditorThemes,
  startModelLanguageWorker,
  waitForLanguageWorkerRegistration,
  workerKindForLabel,
} from "./monaco-runtime";
import { resetMonacoEditorThemeForTests } from "./monaco-theme";

const loadBootTheme = () => Promise.resolve({ name: "vitesse-dark" });
const loadNord = () => Promise.resolve({ name: "nord" });

interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * A text-model double implementing exactly the Monaco contract this seam leans
 * on: offsets and positions over the model's own text, one `pushEditOperations`
 * batch whose ranges all resolve against the PRE-edit text, a caret mapped
 * through those ranges, and `pushStackElement` closing the open undo element.
 *
 * A real model would be better, but renderer tests run under Node with no DOM
 * and monaco-editor's ESM entry dereferences `window` at import time, so one
 * cannot be constructed here. The packaged smokes drive the live editor.
 */
class FakeTextModel {
  private text: string;
  private caret = 0;
  /** Text as it stood when the currently open undo element began. */
  private openElementBefore: string | null = null;
  private readonly undoStack: string[] = [];
  readonly operationBatches: { range: FakeRange; text: string | null }[][] = [];
  readonly calls: string[] = [];

  constructor(text: string) {
    this.text = text;
  }

  getValue(): string {
    return this.text;
  }

  /** Where the caret sits, as an offset into the CURRENT text. */
  caretOffset(): number {
    return this.caret;
  }

  /** Put the caret immediately after the first occurrence of `marker`. */
  placeCaretAfter(marker: string): void {
    this.caret = this.text.indexOf(marker) + marker.length;
  }

  /** A user keystroke: an edit with no stack boundary of its own. */
  type(text: string): void {
    this.pushEditOperations(
      [],
      [{ range: this.rangeAt(this.caret, this.caret), text }],
      () => null,
    );
  }

  getFullModelRange(): FakeRange {
    return this.rangeAt(0, this.text.length);
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const starts = this.lineStarts();
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
    return { lineNumber: line + 1, column: offset - starts[line] + 1 };
  }

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    return this.lineStarts()[position.lineNumber - 1] + position.column - 1;
  }

  pushStackElement(): void {
    this.calls.push("pushStackElement");
    if (this.openElementBefore !== null && this.openElementBefore !== this.text) {
      this.undoStack.push(this.openElementBefore);
    }
    this.openElementBefore = null;
  }

  pushEditOperations(
    _cursors: unknown[],
    operations: { range: FakeRange; text: string | null }[],
    cursorComputer: () => unknown,
  ): void {
    this.calls.push("pushEditOperations");
    this.operationBatches.push(operations);
    cursorComputer();
    this.openElementBefore ??= this.text;
    const edits = operations
      .map((operation) => ({
        start: this.getOffsetAt({
          lineNumber: operation.range.startLineNumber,
          column: operation.range.startColumn,
        }),
        end: this.getOffsetAt({
          lineNumber: operation.range.endLineNumber,
          column: operation.range.endColumn,
        }),
        text: operation.text ?? "",
      }))
      .toSorted((left, right) => left.start - right.start);

    // Every range resolves against the pre-edit text, and the caret is carried
    // through them: shifted by whatever the edits before it grew or shrank, and
    // moved to the end of the replacement only if an edit consumed it.
    let shift = 0;
    let consumed: number | null = null;
    let next = "";
    let cursor = 0;
    for (const edit of edits) {
      next += this.text.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
      if (edit.end <= this.caret) shift += edit.text.length - (edit.end - edit.start);
      else if (edit.start < this.caret && consumed === null) {
        consumed = edit.start + shift + edit.text.length;
      }
    }
    this.text = next + this.text.slice(cursor);
    this.caret = consumed ?? this.caret + shift;
  }

  undo(): void {
    this.pushStackElement();
    const previous = this.undoStack.pop();
    if (previous !== undefined) this.text = previous;
  }

  private rangeAt(start: number, end: number): FakeRange {
    const from = this.getPositionAt(start);
    const to = this.getPositionAt(end);
    return {
      startLineNumber: from.lineNumber,
      startColumn: from.column,
      endLineNumber: to.lineNumber,
      endColumn: to.column,
    };
  }

  private lineStarts(): number[] {
    const starts = [0];
    for (
      let index = this.text.indexOf("\n");
      index !== -1;
      index = this.text.indexOf("\n", index + 1)
    ) {
      starts.push(index + 1);
    }
    return starts;
  }
}

function externalEditFactory() {
  const monaco = {
    editor: { createModel: vi.fn() },
    Uri: { parse: vi.fn((uri: string) => ({ path: uri })) },
    languages: { getLanguages: () => [], register: vi.fn() },
  };
  const session = { highlighter: {}, registerTheme: vi.fn(), registerLanguage: vi.fn() };
  return createShikiBackedModelFactory(monaco as never, session as never);
}

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
      getLoadedThemes: () => ["vitesse-dark"],
      loadTheme: vi.fn(async () => undefined),
      getTheme: vi.fn((name: string) => ({ name })),
    },
    registerTheme: vi.fn(async () => undefined),
    registerLanguage: vi.fn(),
  });
  ensureShikiLanguageBound.mockResolvedValue(true);
  allShikiLanguageIds.mockReturnValue(["typescript", "toml"]);
  editorThemeImporterFor.mockImplementation((id: string) =>
    id === "vitesse-dark" ? () => Promise.resolve({ name: "vitesse-dark" }) : null,
  );
  resolveEditorThemeId.mockReturnValue("vitesse-dark");
  monacoModule.editor.setTheme.mockClear();
  monacoModule.languages.register.mockClear();
});

describe("prepareMonacoEditorThemes", () => {
  it("bootstraps with only the appearance's theme and empty langs (not both importers)", async () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme },
      languages: { getLanguages: () => [], register: vi.fn() },
    };
    editorThemeImporterFor.mockReturnValue(loadBootTheme);
    const shiki = {
      highlighter: {
        getLoadedThemes: () => ["vitesse-dark"],
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
    expect(editorThemeImporterFor).toHaveBeenCalledWith("vitesse-dark");
    expect(bootstrapShikiMonaco).toHaveBeenCalledTimes(1);
    expect(bootstrapShikiMonaco).toHaveBeenCalledWith(monaco, {
      themes: [loadBootTheme],
      langs: [],
    });
    // Boot resolves off the appearance stamped on the document, not off a
    // stored id — there is no stored id any more (VC-123).
    expect(resolveEditorThemeId).toHaveBeenCalledWith({ resolvedAppearance: "dark" });
    await vi.waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith("vitesse-dark");
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
      expect(setTheme).toHaveBeenCalledWith("vitesse-dark");
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
    expect(setTheme).not.toHaveBeenCalledWith("vitesse-dark");
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
        getLoadedThemes: () => ["vitesse-dark"],
        loadTheme,
        getTheme,
      },
      registerTheme,
      registerLanguage: vi.fn(),
    });
    editorThemeImporterFor.mockImplementation((id: string) => {
      if (id === "vitesse-dark") return loadBootTheme;
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
      id === "vitesse-dark" ? loadBootTheme : null,
    );
    bootstrapShikiMonaco.mockResolvedValue({
      highlighter: {
        getLoadedThemes: () => ["vitesse-dark"],
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

  it("carries the caret with its own text when an agent inserts lines above it", () => {
    const model = new FakeTextModel("alpha\nbravo\n");
    model.placeCaretAfter("bra");

    externalEditFactory().applyExternalEdit(model as never, "inserted\nalpha\nbravo\n");

    expect(model.getValue()).toBe("inserted\nalpha\nbravo\n");
    // One insertion at the very top: the caret's own line is inside no range at
    // all, which is exactly what lets Monaco map it down with its text.
    expect(model.operationBatches).toEqual([
      [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          text: "inserted\n",
        },
      ],
    ]);
    expect(model.getValue().slice(0, model.caretOffset())).toBe("inserted\nalpha\nbra");
  });

  it("maps a parked caret and viewport anchor through a prepended clean baseline", () => {
    const oldValue = "first\nanchor\nlast\n";
    const factory = externalEditFactory();
    const stored = {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 4 },
        },
      ],
      viewState: {
        scrollLeft: 11,
        firstPosition: { lineNumber: 2, column: 1 },
        firstPositionDeltaTop: -4,
      },
      contributionsState: { find: { searchString: "anchor" } },
    };

    const mapped = factory.mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      "// one\n// two\nfirst\nanchor\nlast\n",
    );

    expect(mapped).toEqual({
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 4, column: 1 },
          position: { lineNumber: 4, column: 4 },
        },
      ],
      viewState: {
        scrollLeft: 11,
        firstPosition: { lineNumber: 4, column: 1 },
        firstPositionDeltaTop: -4,
      },
      contributionsState: { find: { searchString: "anchor" } },
    });
  });

  it("keeps a parked view state stable when the clean baseline is unchanged", () => {
    const value = "first\nanchor\nlast\n";
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 2 },
          position: { lineNumber: 2, column: 2 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(value, stored, value);

    expect(mapped).toEqual(stored);
  });

  it("maps a first-line viewport anchor through a prepend plus a separate replacement", () => {
    const oldLines = Array.from({ length: 20 }, (_, index) => {
      if (index === 0) return 'export const overlap = "baseline";';
      if (index === 5) return "export const changeSet = 1;";
      return `export const line${index + 1} = ${index + 1};`;
    });
    const oldValue = `${oldLines.join("\n")}\n`;
    const changedLines = [...oldLines];
    changedLines[5] = "export const changeSet = 2;";
    const prependedLines = Array.from(
      { length: 6 },
      (_, index) => `// prepended banner line ${index + 1}`,
    );
    const changedValue = `${prependedLines.join("\n")}\n${changedLines.join("\n")}\n`;
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 12, column: 1 },
          position: { lineNumber: 12, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      changedValue,
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 7, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 18, column: 1 });
  });

  it("maps a repeated-line anchor after a duplicate inserted before its context", () => {
    const oldValue = ["repeated", "first context", "repeated", "second context", ""].join("\n");
    const changedValue = [
      "repeated",
      "repeated",
      "first context",
      "repeated",
      "second context",
      "",
    ].join("\n");
    const stored = {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: -3,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      changedValue,
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 2, column: 1 });
    expect(mapped?.cursorState[0]).toMatchObject({
      selectionStart: { lineNumber: 2, column: 1 },
      position: { lineNumber: 2, column: 1 },
    });
  });

  it("keeps a repeated suffix anchored to its first occurrence when a duplicate is appended", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 2, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "A\nrepeated",
      stored,
      "A\nrepeated\nrepeated",
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 2, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 2, column: 1 });
  });

  it("uses the forward occurrence when duplicate ambiguity has no stable context", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "repeated",
      stored,
      "repeated\nrepeated",
    );

    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 1, column: 1 });
  });

  it("keeps a logical line position stable when disk normalizes CRLF to LF", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 2, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "a\r\nanchor\r\n",
      stored,
      "a\nanchor\n",
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 2, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 2, column: 1 });
  });

  it("keeps a changed logical line stable while disk also normalizes CRLF to LF", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 2, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "a\r\nOLD\r\n",
      stored,
      "a\nNEW\n",
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 2, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 2, column: 1 });
  });

  it("carries a unique line position with that line when it moves", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 2, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "A\nB\nC\n",
      stored,
      "A\nC\nB\n",
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 3, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 3, column: 1 });
  });

  it("maps equal-cardinality repeated lines by occurrence when their context moves", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 4, column: 1 },
          position: { lineNumber: 4, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 4, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "A\ndup\nB\ndup\nC\n",
      stored,
      "A\ndup\nC\ndup\nB\n",
    );

    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 4, column: 1 });
    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 4, column: 1 });
  });

  it.each([
    ["forward", { lineNumber: 2, column: 1 }, { lineNumber: 3, column: 2 }],
    ["reverse", { lineNumber: 3, column: 2 }, { lineNumber: 2, column: 1 }],
  ] as const)(
    "conservatively preserves a %s selection when its unique lines move past each other",
    (_direction, selectionStart, position) => {
      const stored = {
        cursorState: [
          {
            inSelectionMode: true,
            selectionStart,
            position,
          },
        ],
        viewState: {
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      };

      const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
        "A\nB\nC\n",
        stored,
        "A\nC\nB\n",
      );

      expect(mapped).toBe(stored);
    },
  );

  it("conservatively preserves a selection when duplicate reordering stretches its span", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "dup\nA\ndup\nB",
      stored,
      "dup\nB\ndup\nA",
    );

    expect(mapped).toBe(stored);
  });

  it("conservatively preserves an internally ambiguous repeated-line anchor", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "start\nrepeated\nfirst context\nrepeated\nsecond context\nend",
      stored,
      "start\nrepeated\nrepeated\nfirst context\nrepeated\nsecond context\nend",
    );

    expect(mapped).toBe(stored);
  });

  it("conservatively preserves a selection whose active end is internally ambiguous", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 2, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "start\nrepeated\nfirst context\nrepeated\nsecond context\nend",
      stored,
      "start\nrepeated\nrepeated\nfirst context\nrepeated\nsecond context\nend",
    );

    expect(mapped).toBe(stored);
  });

  it.each([
    ["replacement start", "abc", "XYZ123", 1, 1],
    ["equal-length replacement interior", "abc", "XYZ", 2, 2],
    ["replacement end", "abc", "XYZ123", 4, 7],
  ] as const)(
    "maps the %s to its exact relative column",
    (_case, oldText, newText, column, expected) => {
      const oldValue = `before\n${oldText}\nafter\n`;
      const stored = {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 2, column },
            position: { lineNumber: 2, column },
          },
        ],
        viewState: {
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      };

      const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
        oldValue,
        stored,
        `before\n${newText}\nafter\n`,
      );

      expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 2, column: expected });
    },
  );

  it("maps a replacement interior by relative offset clamped to the replacement length", () => {
    const oldValue = "before\nxxxxx\nafter\n";
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 2, column: 3 },
          position: { lineNumber: 2, column: 3 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      "before\nZ\nafter\n",
    );

    expect(mapped?.cursorState).toEqual([
      {
        inSelectionMode: false,
        selectionStart: { lineNumber: 2, column: 2 },
        position: { lineNumber: 2, column: 2 },
      },
    ]);
    expect(mapped?.viewState.firstPosition).toEqual({ lineNumber: 1, column: 1 });
  });

  it("keeps a final-line anchor after an equal-length replacement at its exact column", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 6 },
          position: { lineNumber: 1, column: 6 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 6 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "abc tail",
      stored,
      "XYZ tail",
    );

    expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 1, column: 6 });
  });

  it("maps through a long changed line without copying each shared-prefix suffix", () => {
    const prefix = "x".repeat(50_000);
    const suffix = "y".repeat(50_000);
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: prefix.length + 4 },
          position: { lineNumber: 1, column: prefix.length + 4 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      `${prefix}OLD${suffix}`,
      stored,
      `${prefix}NEW${suffix}`,
    );

    expect(mapped?.cursorState[0]?.position).toEqual({
      lineNumber: 1,
      column: prefix.length + 4,
    });
  });

  it("maps positions at and after a same-line insertion with right affinity", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 2 },
          position: { lineNumber: 1, column: 3 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.("abc", stored, "aXbc");

    expect(mapped?.cursorState[0]).toMatchObject({
      selectionStart: { lineNumber: 1, column: 3 },
      position: { lineNumber: 1, column: 4 },
    });
  });

  it.each([
    ["prefix", "removed\nanchor", 1],
    ["suffix", "anchor\nremoved", 2],
  ] as const)(
    "maps a position on a deleted %s line to the retained boundary",
    (_case, oldValue, lineNumber) => {
      const stored = {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber, column: 1 },
            position: { lineNumber, column: 1 },
          },
        ],
        viewState: {
          scrollLeft: 0,
          firstPosition: { lineNumber, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      };

      const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
        oldValue,
        stored,
        "anchor",
      );

      expect(mapped?.cursorState[0]?.position).toEqual({ lineNumber: 1, column: 1 });
    },
  );

  it("maps an anchor at a zero-length prepend after the inserted text", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      "anchor\n",
      stored,
      "// prepended\nanchor\n",
    );

    expect(mapped?.cursorState[0]).toMatchObject({
      selectionStart: { lineNumber: 2, column: 1 },
      position: { lineNumber: 2, column: 1 },
    });
  });

  it("leaves a parked view state unchanged when an exact edit exceeds the diff budget", () => {
    const oldValue = "a".repeat(10_000);
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 5_000 },
          position: { lineNumber: 1, column: 5_000 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      "b".repeat(10_000),
    );

    expect(mapped).toBe(stored);
  });

  it("leaves a parked view unchanged when line-token alignment exceeds its budget", () => {
    const oldValue = Array.from({ length: 342 }, (_, index) => `a${index}b`).join("\n");
    const changedValue = Array.from({ length: 342 }, (_, index) => `a${index}\nb`).join("\n");
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
      oldValue,
      stored,
      changedValue,
    );

    expect(mapped).toBe(stored);
  });

  it("preserves the whole view when reverse alignment exceeds the shared line budget", () => {
    const stored = {
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };

    const mapped = mapCodeEditorViewState("A", stored, "A\nB", {
      lineDiffBudget: { maxDistance: 1, maxComparisons: 3 },
    });

    expect(mapped).toBe(stored);
  });

  it.each(["baseline", "changed"] as const)(
    "leaves a parked view untouched when the %s exceeds the logical-line cap",
    (oversizedSide) => {
      const oversized = "\n".repeat(MAX_VIEW_STATE_LOGICAL_LINES);
      const stored = new Proxy(
        {
          cursorState: [],
          viewState: {
            scrollLeft: 0,
            firstPosition: { lineNumber: 1, column: 1 },
            firstPositionDeltaTop: 0,
          },
          contributionsState: {},
        },
        {
          get() {
            throw new Error("view-state mapping must not start above the logical-line cap");
          },
        },
      );

      const mapped = externalEditFactory().mapViewStateThroughExternalEdit?.(
        oversizedSide === "baseline" ? oversized : "one line",
        stored,
        oversizedSide === "changed" ? oversized : "one changed line",
      );

      expect(mapped).toBe(stored);
    },
  );

  it("edits only the changed span rather than replacing the whole model", () => {
    const model = new FakeTextModel("one\ntwo\nthree\n");

    externalEditFactory().applyExternalEdit(model as never, "one\nTWO\nthree\n");

    expect(model.getValue()).toBe("one\nTWO\nthree\n");
    expect(model.operationBatches[0]).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 },
        text: "TWO",
      },
    ]);
  });

  it("isolates the external write in its own undo element, above the user's typing", () => {
    const model = new FakeTextModel("alpha\nbravo\n");
    model.placeCaretAfter("alpha");
    model.type(" typed");
    model.calls.length = 0; // only the external write's own calls from here

    externalEditFactory().applyExternalEdit(model as never, "alpha typed\nbravo\nagent tail\n");

    expect(model.calls).toEqual(["pushStackElement", "pushEditOperations", "pushStackElement"]);
    expect(model.getValue()).toBe("alpha typed\nbravo\nagent tail\n");

    // One ⌘Z takes back the agent's write and nothing else…
    model.undo();
    expect(model.getValue()).toBe("alpha typed\nbravo\n");
    // …and only the next one takes back what the user typed.
    model.undo();
    expect(model.getValue()).toBe("alpha\nbravo\n");
  });

  it("falls back to a bracketed full-range replace when the diff exceeds its budget", () => {
    const model = new FakeTextModel("a".repeat(10_000));

    externalEditFactory().applyExternalEdit(model as never, "b".repeat(10_000));

    expect(model.getValue()).toBe("b".repeat(10_000));
    expect(model.operationBatches[0]).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10_001 },
        text: "b".repeat(10_000),
      },
    ]);
    // Even the fallback stays its own undo element, and never uses setValue
    // (which would drop the model's whole undo history).
    expect(model.calls).toEqual(["pushStackElement", "pushEditOperations", "pushStackElement"]);
  });

  it("passes a cursor computer that leaves Monaco's own cursor mapping alone", () => {
    const model = new FakeTextModel("one\n");
    const pushEditOperations = vi.spyOn(model, "pushEditOperations");

    externalEditFactory().applyExternalEdit(model as never, "one\ntwo\n");

    const cursorComputer = pushEditOperations.mock.calls[0][2];
    expect(cursorComputer()).toBeNull();
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

describe("externalEditOperations", () => {
  it("keeps every range of a multi-edit batch in pre-edit coordinates, in order", () => {
    const model = new FakeTextModel("one\ntwo\nthree\nfour\n");

    const operations = externalEditOperations(model as never, "ONE\ntwo\nthree\nFOUR\n");

    // Two edits, sorted and non-overlapping, both addressed against the text as
    // it stands BEFORE either lands — the only coordinate space Monaco resolves
    // a single `pushEditOperations` batch in.
    expect(operations).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
        text: "ONE",
      },
      {
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 5 },
        text: "FOUR",
      },
    ]);
  });

  it("reports null rather than a guess once the change is past the diff budget", () => {
    const model = new FakeTextModel("a".repeat(10_000));

    expect(externalEditOperations(model as never, "b".repeat(10_000))).toBeNull();
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
