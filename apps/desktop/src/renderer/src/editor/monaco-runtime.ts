import type * as Monaco from "monaco-editor";

import {
  findBoundedSequenceDiff,
  type SequenceDiffBudget,
  type SequenceEditStep,
  STANDARD_SEQUENCE_DIFF_BUDGET,
} from "./bounded-sequence-diff";
// Ships with the Monaco chunk, like `document-mode.css` ships with its
// contribution: the furniture tokens must be in the document before the first
// editor paints, and nothing outside an editor is selected by them.
import "./source-mode.css";
import { editorThemeImporterFor } from "./editor-theme-catalog";
import { DocumentRegistry, type RegistryModelFactory } from "./document-registry";
import { allShikiLanguageIds } from "./shiki-langs";
import {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  type ShikiMonacoBootstrap,
} from "./shiki-monaco";
import {
  activeMonacoEditorThemeId,
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

function matchedLineIndexes(
  steps: readonly SequenceEditStep<number>[],
  oldLength: number,
  newLength: number,
): Map<number, number> {
  const matches = new Map<number, number>();
  let oldIndex = 0;
  let newIndex = 0;
  for (const step of steps) {
    while (oldIndex < step.index) {
      matches.set(oldIndex, newIndex);
      oldIndex += 1;
      newIndex += 1;
    }
    if (step.kind === "delete") oldIndex += 1;
    else newIndex += 1;
  }
  while (oldIndex < oldLength && newIndex < newLength) {
    matches.set(oldIndex, newIndex);
    oldIndex += 1;
    newIndex += 1;
  }
  return matches;
}

function lineOccurrences(tokens: readonly number[]): Map<number, number[]> {
  const occurrences = new Map<number, number[]>();
  tokens.forEach((token, index) => {
    const indexes = occurrences.get(token);
    if (indexes === undefined) occurrences.set(token, [index]);
    else indexes.push(index);
  });
  return occurrences;
}

interface LinePlan {
  lineMatches: ReadonlyMap<number, number>;
  oldLines: readonly string[];
  newLines: readonly string[];
}

/** Avoid allocating or diffing pathological newline-dense external writes. */
export const MAX_VIEW_STATE_LOGICAL_LINES = 20_000;

function exceedsViewStateLogicalLineCap(value: string): boolean {
  let newlineIndex = -1;
  for (let lineCount = 1; lineCount <= MAX_VIEW_STATE_LOGICAL_LINES; lineCount += 1) {
    newlineIndex = value.indexOf("\n", newlineIndex + 1);
    if (newlineIndex === -1) return false;
  }
  return true;
}

/**
 * Plan how logical lines travel through one bounded external edit.
 *
 * Forward and reverse shortest scripts reveal the two deterministic edges of
 * duplicate ambiguity. A duplicate inserted before the first stable context is
 * right-aligned; one appended after the last stable context is left-aligned.
 * Disagreement between stable anchors is deliberately not treated as identity.
 * Globally unique moved lines and equal-cardinality duplicates can still travel
 * directly. Truly indistinguishable duplicates have no hidden identity; their
 * occurrence order is only a deterministic convention.
 */
function linePlan(
  oldValue: string,
  value: string,
  lineDiffBudget: SequenceDiffBudget,
): LinePlan | null {
  if (exceedsViewStateLogicalLineCap(oldValue) || exceedsViewStateLogicalLineCap(value))
    return null;
  const oldLines = logicalLines(oldValue);
  const newLines = logicalLines(value);
  const tokenIds = new Map<string, number>();
  let nextTokenId = 0;
  const intern = (line: string): number => {
    const existing = tokenIds.get(line);
    if (existing !== undefined) return existing;
    const id = nextTokenId;
    nextTokenId += 1;
    tokenIds.set(line, id);
    return id;
  };
  const oldTokens = oldLines.map(intern);
  const newTokens = newLines.map(intern);
  const forwardSteps = findBoundedSequenceDiff(oldTokens, newTokens, lineDiffBudget);
  if (forwardSteps === null) return null;
  const reversedOldLines = oldTokens.toReversed();
  const reversedNewLines = newTokens.toReversed();
  const reverseSteps = findBoundedSequenceDiff(reversedOldLines, reversedNewLines, lineDiffBudget);
  if (reverseSteps === null) return null;

  const reversedMatches = matchedLineIndexes(
    reverseSteps,
    reversedOldLines.length,
    reversedNewLines.length,
  );
  const reverseMatches = new Map<number, number>();
  for (const [reversedOldIndex, reversedNewIndex] of reversedMatches) {
    reverseMatches.set(
      oldTokens.length - reversedOldIndex - 1,
      newTokens.length - reversedNewIndex - 1,
    );
  }

  const forwardMatches = matchedLineIndexes(forwardSteps, oldTokens.length, newTokens.length);
  const agreedOldIndexes = [...forwardMatches].flatMap(([oldIndex, newIndex]) =>
    reverseMatches.get(oldIndex) === newIndex ? [oldIndex] : [],
  );
  const firstAgreed = agreedOldIndexes[0];
  const lastAgreed = agreedOldIndexes.at(-1);
  const lineMatches = new Map<number, number>();
  for (let oldIndex = 0; oldIndex < oldTokens.length; oldIndex += 1) {
    const forward = forwardMatches.get(oldIndex);
    const reverse = reverseMatches.get(oldIndex);
    if (forward !== undefined && forward === reverse) lineMatches.set(oldIndex, forward);
    else if (firstAgreed !== undefined && oldIndex < firstAgreed && reverse !== undefined) {
      lineMatches.set(oldIndex, reverse);
    } else if (lastAgreed !== undefined && oldIndex > lastAgreed && forward !== undefined) {
      lineMatches.set(oldIndex, forward);
    } else if (firstAgreed === undefined && forward !== undefined) {
      lineMatches.set(oldIndex, forward);
    }
  }

  pairChangedLineRuns(lineMatches, new Map(lineMatches), oldTokens.length, newTokens.length);

  const oldOccurrences = lineOccurrences(oldTokens);
  const newOccurrences = lineOccurrences(newTokens);
  for (const [token, oldIndexes] of oldOccurrences) {
    const newIndexes = newOccurrences.get(token);
    if (newIndexes === undefined || oldIndexes.length !== newIndexes.length) continue;
    oldIndexes.forEach((oldIndex, occurrence) => {
      lineMatches.set(oldIndex, newIndexes[occurrence]);
    });
  }

  return { lineMatches, oldLines, newLines };
}

function logicalLines(value: string): string[] {
  return value.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function pairChangedLineRuns(
  lineMatches: Map<number, number>,
  stableMatches: ReadonlyMap<number, number>,
  oldLength: number,
  newLength: number,
): void {
  const anchors = [
    [-1, -1],
    ...[...stableMatches.entries()].toSorted(([left], [right]) => left - right),
    [oldLength, newLength],
  ] as const;
  for (let anchorIndex = 1; anchorIndex < anchors.length; anchorIndex += 1) {
    const [previousOld, previousNew] = anchors[anchorIndex - 1];
    const [nextOld, nextNew] = anchors[anchorIndex];
    const oldCount = nextOld - previousOld - 1;
    const newCount = nextNew - previousNew - 1;
    if (oldCount <= 0) continue;
    const prefixRun = previousOld === -1;
    const suffixRun = nextOld === oldLength;
    if (!prefixRun && !suffixRun && oldCount !== newCount) continue;
    if (newCount <= 0) {
      const boundary = nextNew < newLength ? nextNew : Math.max(0, previousNew);
      for (let offset = 1; offset <= oldCount; offset += 1) {
        lineMatches.set(previousOld + offset, boundary);
      }
      continue;
    }
    const pairCount = Math.min(oldCount, newCount);
    for (let offset = 0; offset < pairCount; offset += 1) {
      const oldIndex = prefixRun ? nextOld - pairCount + offset : previousOld + 1 + offset;
      const newIndex = prefixRun ? nextNew - pairCount + offset : previousNew + 1 + offset;
      lineMatches.set(oldIndex, newIndex);
    }
  }
}

function mapColumn(oldLine: string, newLine: string, column: number): number | null {
  if (oldLine === newLine) return Math.max(1, Math.min(column, newLine.length + 1));
  const edits = findTextEdits(oldLine, newLine);
  if (edits === null) return null;
  const oldOffset = Math.max(0, Math.min(column - 1, oldLine.length));
  return mapOffsetThroughTextEdits(oldOffset, edits) + 1;
}

function comparePositions(left: Monaco.IPosition, right: Monaco.IPosition): number {
  return left.lineNumber === right.lineNumber
    ? left.column - right.column
    : left.lineNumber - right.lineNumber;
}

export interface MonacoViewStateMappingOptions {
  /** One shared bound applied independently to forward and reverse line alignment. */
  readonly lineDiffBudget?: SequenceDiffBudget;
}

export function mapCodeEditorViewState(
  oldValue: string,
  state: Monaco.editor.ICodeEditorViewState,
  value: string,
  options: MonacoViewStateMappingOptions = {},
): Monaco.editor.ICodeEditorViewState {
  if (oldValue === value) return state;
  const plan = linePlan(oldValue, value, options.lineDiffBudget ?? STANDARD_SEQUENCE_DIFF_BUDGET);
  if (plan === null) return state;
  const mapPosition = (position: Monaco.IPosition): Monaco.IPosition | null => {
    const oldLineIndex = Math.max(0, Math.min(position.lineNumber - 1, plan.oldLines.length - 1));
    const newLineIndex = plan.lineMatches.get(oldLineIndex);
    if (newLineIndex === undefined) return null;
    const column = mapColumn(
      plan.oldLines[oldLineIndex]!,
      plan.newLines[newLineIndex]!,
      position.column,
    );
    return column === null ? null : { lineNumber: newLineIndex + 1, column };
  };

  const firstPosition = mapPosition(state.viewState.firstPosition);
  if (firstPosition === null) return state;
  const cursorState: typeof state.cursorState = [];
  for (const cursor of state.cursorState) {
    const selectionStart = mapPosition(cursor.selectionStart);
    const position = mapPosition(cursor.position);
    if (selectionStart === null || position === null) return state;
    const oldOrder = comparePositions(cursor.selectionStart, cursor.position);
    const selectionStartLineShift = selectionStart.lineNumber - cursor.selectionStart.lineNumber;
    const positionLineShift = position.lineNumber - cursor.position.lineNumber;
    if (oldOrder !== 0 && selectionStartLineShift !== positionLineShift) return state;
    cursorState.push({ ...cursor, selectionStart, position });
  }
  return {
    ...state,
    cursorState,
    viewState: {
      ...state.viewState,
      firstPosition,
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
 * Wire shiki once with the appearance's theme and empty langs, then register
 * every document language id as an empty Monaco shell so late providers can
 * attach. Call `wireShikiToMonaco` / bootstrap exactly once — late langs use
 * `registerLanguage`, late themes use `registerTheme` (shared themeMap/colorMap).
 * The OTHER of the two themes loads via the theme-ensure seam before `setTheme`
 * (no flash of an undefined theme on a light↔dark flip).
 */
export async function prepareMonacoEditorThemes(
  monaco: typeof Monaco,
): Promise<ShikiMonacoBootstrap> {
  // Empty shells first so the one-shot wire (and later registerLanguage) can
  // see every document-identity id in monaco.languages.getLanguages().
  ensureMonacoLanguagesRegistered(monaco, allShikiLanguageIds());

  // Boot into the mode the window is ALREADY wearing (preload stamped it before
  // the first frame), so the very first editor is built light in a light app
  // rather than correcting itself once the theme store hydrates.
  const bootThemeLoad = editorThemeImporterFor(activeMonacoEditorThemeId());
  const shiki = await bootstrapShikiMonaco(monaco, {
    themes: bootThemeLoad === null ? [] : [bootThemeLoad],
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
  // Otherwise activate the appearance's theme so the first editor isn't unthemed.
  ensureMonacoEditorTheme();
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
