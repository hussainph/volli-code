import type * as Monaco from "monaco-editor";

import {
  DEFAULT_EDITOR_THEME_ID,
  editorThemeImporterFor,
  resolveEditorThemeId,
} from "./editor-theme-catalog";
import { DocumentRegistry, type RegistryModelFactory } from "./document-registry";
import { allShikiLanguageIds } from "./shiki-langs";
import {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  type ShikiMonacoBootstrap,
} from "./shiki-monaco";
import {
  bindMonacoEditorThemeEnsure,
  bindMonacoEditorThemeHost,
  ensureMonacoEditorTheme,
} from "./monaco-theme";
import { findTextEdits, type TextEdit } from "./text-reconciliation";
import { startUnsavedDocumentReporting } from "./unsaved-report";

export function createLazyInitializer<Value>(
  initialize: () => Promise<Value>,
): () => Promise<Value> {
  let initialization: Promise<Value> | undefined;
  return () => {
    initialization ??= initialize();
    return initialization;
  };
}

export type MonacoWorkerKind = "editor" | "json" | "css" | "html" | "typescript";

export function workerKindForLabel(label: string): MonacoWorkerKind {
  if (label === "json") return "json";
  if (label === "css" || label === "scss" || label === "less") return "css";
  if (label === "html" || label === "handlebars" || label === "razor") return "html";
  if (label === "typescript" || label === "javascript") return "typescript";
  return "editor";
}

interface LanguageWorkerRegistrationOptions {
  attempts?: number;
  waitForNextAttempt?: () => Promise<void>;
}

function registrationIsPending(error: unknown): boolean {
  return /^(TypeScript|JavaScript) not registered!$/.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Creating the first model requests rich language features, whose mode module
 * registers asynchronously. Monaco's public worker accessor rejects during
 * that short activation window, so yield and retry only that exact condition.
 */
export async function waitForLanguageWorkerRegistration<Worker>(
  getWorker: () => Promise<Worker>,
  options: LanguageWorkerRegistrationOptions = {},
): Promise<Worker> {
  const attempts = options.attempts ?? 50;
  const waitForNextAttempt =
    options.waitForNextAttempt ??
    (() => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getWorker();
    } catch (error) {
      if (!registrationIsPending(error) || attempt >= attempts) throw error;
      await waitForNextAttempt();
    }
  }
}

export interface MonacoRuntime {
  monaco: typeof Monaco;
  registry: DocumentRegistry<Monaco.editor.ITextModel, Monaco.editor.ICodeEditorViewState>;
  /** Shiki session from bootstrap — langs/themes beyond the default load on demand. */
  shiki: ShikiMonacoBootstrap;
}

type WorkerConstructor = new (options?: WorkerOptions) => Worker;

type MonacoModelHost = {
  editor: {
    createModel: (value: string, language?: string, uri?: Monaco.Uri) => Monaco.editor.ITextModel;
  };
  Uri: { parse: (value: string) => Monaco.Uri };
  languages: Pick<typeof Monaco.languages, "getLanguages" | "register">;
};

/** The slice of a Monaco model an external write touches. */
type ExternalEditModel = Pick<
  Monaco.editor.ITextModel,
  "getValue" | "getPositionAt" | "getFullModelRange" | "pushStackElement" | "pushEditOperations"
>;

function mapOffsetThroughTextEdits(offset: number, edits: readonly TextEdit[]): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset < edit.start) break;
    const mappedStart = edit.start + shift;
    if (edit.end === edit.start) {
      if (offset === edit.start) return mappedStart + edit.replacement.length;
    } else {
      if (offset === edit.start) return mappedStart;
      if (offset < edit.end) {
        return mappedStart + Math.min(offset - edit.start, edit.replacement.length);
      }
      if (offset === edit.end) return mappedStart + edit.replacement.length;
    }
    shift += edit.replacement.length - (edit.end - edit.start);
  }
  return offset + shift;
}

function lineStartOffsets(value: string): number[] {
  const starts = [0];
  for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function offsetAtTextPosition(
  value: string,
  lineStarts: readonly number[],
  position: Monaco.IPosition,
): number {
  const lineIndex = Math.max(0, Math.min(position.lineNumber - 1, lineStarts.length - 1));
  const lineStart = lineStarts[lineIndex];
  const lineEnd =
    lineStarts[lineIndex + 1] === undefined ? value.length : lineStarts[lineIndex + 1] - 1;
  return Math.max(lineStart, Math.min(lineStart + position.column - 1, lineEnd));
}

function positionAtText(
  value: string,
  lineStarts: readonly number[],
  offset: number,
): Monaco.IPosition {
  const bounded = Math.max(0, Math.min(offset, value.length));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= bounded) low = middle;
    else high = middle - 1;
  }
  return { lineNumber: low + 1, column: bounded - lineStarts[low] + 1 };
}

function mapCodeEditorViewState(
  oldValue: string,
  state: Monaco.editor.ICodeEditorViewState,
  value: string,
): Monaco.editor.ICodeEditorViewState {
  const edits = findTextEdits(oldValue, value);
  if (edits === null) return state;
  const oldLineStarts = lineStartOffsets(oldValue);
  const newLineStarts = lineStartOffsets(value);
  const mapPosition = (position: Monaco.IPosition): Monaco.IPosition =>
    positionAtText(
      value,
      newLineStarts,
      mapOffsetThroughTextEdits(offsetAtTextPosition(oldValue, oldLineStarts, position), edits),
    );
  return {
    ...state,
    cursorState: state.cursorState.map((cursor) => ({
      ...cursor,
      selectionStart: mapPosition(cursor.selectionStart),
      position: mapPosition(cursor.position),
    })),
    viewState: {
      ...state.viewState,
      firstPosition: mapPosition(state.viewState.firstPosition),
    },
  };
}

/**
 * The MINIMAL edit operations that turn the model's current text into `value`,
 * or `null` when the diff exceeded its budget and only a full replace is left.
 *
 * Minimality is the whole point: Monaco maps every cursor, selection, marker and
 * folding region THROUGH an edit's ranges, so a caret sitting in text the agent
 * did not touch has to sit inside no range at all to come out where it went in.
 * A full-model-range replace touches everything and therefore preserves nothing.
 *
 * Coordinates line up because both sides speak the model's own text: `getValue`
 * and `getPositionAt` share the model's EOL, `findTextEdits` reports offsets
 * into exactly the string it was handed, and Monaco resolves every range in one
 * `pushEditOperations` call against the PRE-edit model — the same space. The
 * edits are non-overlapping and sorted (see `findTextEdits`), which is what lets
 * them travel as a single batch.
 */
export function externalEditOperations(
  model: ExternalEditModel,
  value: string,
): Monaco.editor.IIdentifiedSingleEditOperation[] | null {
  const edits = findTextEdits(model.getValue(), value);
  if (edits === null) return null;
  return edits.map((edit) => {
    const start = model.getPositionAt(edit.start);
    const end = edit.end === edit.start ? start : model.getPositionAt(edit.end);
    return {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      text: edit.replacement,
    };
  });
}

/**
 * Document-registry model factory: creates the Monaco text model and kicks a
 * best-effort grammar+provider bind.
 *
 * `createModel` stays sync (DocumentRegistry requires it). The ensure is
 * fire-and-forget: the model may paint unhighlighted until the grammar loads
 * and `setTokensProvider` lands — Monaco re-tokenizes when the provider appears.
 */
export function createShikiBackedModelFactory(
  monaco: MonacoModelHost,
  session: ShikiMonacoBootstrap,
): RegistryModelFactory<Monaco.editor.ITextModel, Monaco.editor.ICodeEditorViewState> {
  return {
    createModel({ value, language, uri }) {
      void ensureShikiLanguageBound(session, monaco, language).catch((error: unknown) => {
        console.warn(`[volli] failed to load Shiki grammar "${language}":`, error);
      });
      return monaco.editor.createModel(value, language, monaco.Uri.parse(uri));
    },
    applyExternalEdit(model, value) {
      // A whole-file fallback when the change is past the diff budget. It still
      // goes through the edit stack (never `setValue`), so undo survives even
      // when precise cursor mapping cannot.
      const operations = externalEditOperations(model, value) ?? [
        { range: model.getFullModelRange(), text: value },
      ];
      // The external write is its own undo element. Without these boundaries
      // Monaco coalesces it into whatever the user is currently typing, so one
      // ⌘Z would revert the agent's write AND the user's edit together — and the
      // advanced externalRevision would then let a guarded save clobber disk.
      model.pushStackElement();
      model.pushEditOperations([], operations, () => null);
      model.pushStackElement();
    },
    mapViewStateThroughExternalEdit(oldValue, viewState, value) {
      return mapCodeEditorViewState(oldValue, viewState, value);
    },
  };
}

/**
 * Wire shiki once with the default catalog theme and empty langs, then register
 * every document language id as an empty Monaco shell so late providers can
 * attach. Call `wireShikiToMonaco` / bootstrap exactly once — late langs use
 * `registerLanguage`, late themes use `registerTheme` (shared themeMap/colorMap).
 * Catalog themes beyond the default load via the theme-ensure seam before
 * `setTheme` (no flash of an undefined theme).
 */
export async function prepareMonacoEditorThemes(
  monaco: typeof Monaco,
): Promise<ShikiMonacoBootstrap> {
  // Empty shells first so the one-shot wire (and later registerLanguage) can
  // see every document-identity id in monaco.languages.getLanguages().
  ensureMonacoLanguagesRegistered(monaco, allShikiLanguageIds());

  const defaultThemeLoad = editorThemeImporterFor(DEFAULT_EDITOR_THEME_ID);
  const shiki = await bootstrapShikiMonaco(monaco, {
    themes: defaultThemeLoad === null ? [] : [defaultThemeLoad],
    langs: [],
  });

  bindMonacoEditorThemeEnsure(async (themeId) => {
    if (shiki.highlighter.getLoadedThemes().includes(themeId)) return;
    const load = editorThemeImporterFor(themeId);
    if (load === null) return;
    await shiki.highlighter.loadTheme(load);
    await shiki.registerTheme(shiki.highlighter.getTheme(themeId));
  });
  bindMonacoEditorThemeHost(monaco);
  // If the theme store already refreshed before runtime init, bind applied it.
  // Otherwise activate the shipped default so the first editor isn't unthemed.
  ensureMonacoEditorTheme(resolveEditorThemeId({ editorThemeId: null }));
  return shiki;
}

export async function initializeMonacoRuntime(): Promise<MonacoRuntime> {
  // Vite turns each ?worker import into a same-origin worker constructor. Load
  // those wrappers first so MonacoEnvironment is configured before Monaco's
  // public ESM entry evaluates.
  const [
    { default: EditorWorker },
    { default: JsonWorker },
    { default: CssWorker },
    { default: HtmlWorker },
    { default: TypeScriptWorker },
  ] = (await Promise.all([
    import("monaco-editor/editor/editor.worker?worker"),
    import("monaco-editor/language/json/json.worker?worker"),
    import("monaco-editor/language/css/css.worker?worker"),
    import("monaco-editor/language/html/html.worker?worker"),
    import("monaco-editor/language/typescript/ts.worker?worker"),
  ])) as [
    { default: WorkerConstructor },
    { default: WorkerConstructor },
    { default: WorkerConstructor },
    { default: WorkerConstructor },
    { default: WorkerConstructor },
  ];

  const workers: Record<MonacoWorkerKind, WorkerConstructor> = {
    editor: EditorWorker,
    json: JsonWorker,
    css: CssWorker,
    html: HtmlWorker,
    typescript: TypeScriptWorker,
  };
  globalThis.MonacoEnvironment = {
    getWorker(_workerId, label) {
      const WorkerClass = workers[workerKindForLabel(label)];
      return new WorkerClass({ name: `volli-monaco-${label}` });
    },
  };

  const monaco = await import("monaco-editor");
  const shiki = await prepareMonacoEditorThemes(monaco);

  const registry = new DocumentRegistry<
    Monaco.editor.ITextModel,
    Monaco.editor.ICodeEditorViewState
  >(createShikiBackedModelFactory(monaco, shiki));
  // Wired here rather than from a hook because this is the moment a registry
  // starts existing, and a hook would have to call `loadMonacoRuntime()` at boot
  // — dragging the whole editor bundle into startup to ask a question whose
  // answer is "nothing" until an editor opens. Never disposed: the reporting
  // lives exactly as long as the runtime, which lives as long as the renderer.
  startUnsavedDocumentReporting(registry);
  return { monaco, registry, shiki };
}

export const loadMonacoRuntime = createLazyInitializer(initializeMonacoRuntime);

/**
 * Forces a real TypeScript/JavaScript worker handshake for the supplied model.
 * The packaged smoke uses this public API path rather than inferring success
 * merely from editor DOM.
 */
export async function startModelLanguageWorker(
  runtime: MonacoRuntime,
  model: Monaco.editor.ITextModel,
): Promise<"typescript" | null> {
  const language = model.getLanguageId();
  if (language !== "typescript" && language !== "javascript") return null;
  const getWorker =
    language === "typescript"
      ? runtime.monaco.typescript.getTypeScriptWorker
      : runtime.monaco.typescript.getJavaScriptWorker;
  const workerFor = await waitForLanguageWorkerRegistration(getWorker);
  await workerFor(model.uri);
  return "typescript";
}
