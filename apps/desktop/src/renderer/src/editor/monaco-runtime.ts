import vitesseLight from "@shikijs/themes/vitesse-light";
import vitesseDark from "@shikijs/themes/vitesse-dark";
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
import { DocumentRegistry, type RegistryModelFactory } from "./document-registry";
import { detectDocumentLanguage, type DocumentIdentity } from "./document-identity";
import { allShikiLanguageIds } from "./shiki-langs";
import {
  bootstrapShikiMonaco,
  ensureMonacoLanguagesRegistered,
  ensureShikiLanguageBound,
  type ShikiMonacoBootstrap,
} from "./shiki-monaco";
import { bindMonacoEditorThemeHost, ensureMonacoEditorTheme } from "./monaco-theme";
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
 * Wire shiki once with the fixed Vitesse light/dark pair and empty langs, then
 * register every document language id as an empty Monaco shell so late
 * providers can attach. Both themes are static imports in this Monaco chunk:
 * there is no per-theme catalog or on-demand theme request left to race an
 * appearance flip.
 */
export async function prepareMonacoEditorThemes(
  monaco: typeof Monaco,
): Promise<ShikiMonacoBootstrap> {
  // Empty shells first so the one-shot wire (and later registerLanguage) can
  // see every document-identity id in monaco.languages.getLanguages().
  ensureMonacoLanguagesRegistered(monaco, allShikiLanguageIds());

  const shiki = await bootstrapShikiMonaco(monaco, {
    themes: [vitesseLight, vitesseDark],
    langs: [],
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
  // Before any model can exist, so the first TS/JS file ever opened is checked
  // under the honest configuration rather than under Monaco's unconfigured
  // defaults (plan §4.2). The project's own `tsconfig.json` refines this later,
  // per opened file, through `ensureProjectTypeScriptDefaults`.
  applyTypeScriptDefaults(monaco, {});
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

// ---------------------------------------------------------------------------
// Honest TS/JS diagnostics on single-file models (plan §4.2)
// ---------------------------------------------------------------------------
//
// Monaco does not check a project; it checks MODELS. Its TypeScript worker's
// file set is exactly the documents this renderer happens to have open (see
// `getScriptFileNames` in monaco's `tsWorker`) — no `node_modules`, no
// `tsconfig.json`, no filesystem to walk. Left unconfigured, that renders a
// healthy repository as a wall of red. Measured on THIS repository, over its
// 721 non-test `.ts`/`.tsx` files (monaco 0.56 / TypeScript 5.9.3):
//
//   monaco's stock options       9,048 diagnostics, 644 of 721 files marked
//   the configuration below        537 diagnostics, 185 of 721 files marked
//
// Of the 9,048, two classes were 92%: 4,056 "Cannot find module" and 4,265
// "Cannot use JSX unless the '--jsx' flag is provided", with the module-flag
// family (top-level `await`, dynamic `import()`, `import.meta`) behind them.
// Nothing was made blind to remove them — a typo'd property, a wrong
// assignment, a bad call arity, a missing brace and an `unknown` catch
// variable all still report, and an unresolved import quietly types as `any`
// instead of erroring loudly (`monaco-ts-diagnostics.test.ts` holds that line
// against monaco's own bundled service).
//
// What is left is mostly one thing this tier cannot fix: a type, a global or a
// namespace that another FILE declares. That is the cross-file question the
// LSP decision gate exists for (plan §4.8) — not this slice, which subtracts
// falsehood rather than adding intelligence.
//
// Two moves, and only two. Compiler options that answer questions the worker
// would otherwise get wrong (which JSX, which target, which lib, how strict),
// and an ignore list for the diagnostics whose SUBJECT is a module or a types
// package rather than anything written in the file.

/**
 * The compiler options a project states that this configuration adopts.
 *
 * Deliberately five fields, in tsconfig's own spelling — the questions a
 * single-file model cannot guess and gets loudly wrong. Everything else is
 * fixed by {@link typeScriptCompilerOptions}, because everything else is about
 * emit, module resolution or project layout: things no model-only worker does.
 */
export interface ProjectTypeScriptOptions {
  jsx?: string;
  target?: string;
  lib?: readonly string[];
  strict?: boolean;
  experimentalDecorators?: boolean;
}

/**
 * Diagnostics suppressed on every TS/JS model, and the whole rule behind the
 * list: **each one's subject is a module path or a types package, never
 * anything written in the file.** A model-only worker has no `node_modules` and
 * no sibling files on disk, so it can never satisfy one of these no matter how
 * correct the code is; a person cannot act on one either. Every diagnostic that
 * names something IN the file — an unresolved identifier (TS2304), a missing
 * property (TS2339), a bad assignment (TS2322) — stays red.
 *
 * Codes were enumerated empirically against this repository by running monaco
 * 0.56's own bundled TypeScript service over real files as isolated models, not
 * read off a list: the dominant one here is TS2792 rather than the TS2307 one
 * would expect, because the options below leave `moduleResolution` at
 * TypeScript's default.
 */
export const UNRESOLVABLE_MODULE_DIAGNOSTIC_CODES: readonly number[] = [
  2307, // Cannot find module '{0}' or its corresponding type declarations.
  2792, // Cannot find module '{0}'. Did you mean to set the 'moduleResolution' option…
  2306, // File '{0}' is not a module.
  2688, // Cannot find type definition file for '{0}'.
  2875, // This JSX tag requires the module path '{0}' to exist, but none could be found.
  7016, // Could not find a declaration file for module '{0}'. '{1}' implicitly has an 'any' type.
  // "Cannot find name '{0}'. Do you need to install type definitions for
  // node / jQuery / a test runner / Bun?" — TypeScript emits these INSTEAD of
  // the plain TS2304 when the unresolved name is a known global from an @types
  // package, so suppressing them cannot hide a typo: they hide exactly the
  // `process`/`Buffer`/`describe` reds no single-file model can resolve (68 of
  // them across this repository's Node-side files).
  //
  // The set is closed and worth naming as one, because it is a literal `switch`
  // on the identifier in TypeScript's own `getCannotFindNameDiagnosticForName`:
  // `$`, `describe`/`suite`/`it`/`test`, `process`/`require`/`Buffer`/`module`,
  // `Bun`, and nothing else. Each arm has a plain variant and an "…and then add
  // it to the types field" variant that fires when the project states `types`.
  // The sibling arm of that same switch — `Map`, `Promise`, `document` and
  // friends, "do you need to change your target library?" — is deliberately NOT
  // here: `lib` and `target` DO come from the project, so that one is a true
  // claim about a configuration we actually read.
  2580, // …for node? ("and then add 'node' to the types field" variant: 2591)
  2591,
  2581, // …for jQuery? (2592)
  2592,
  2582, // …for a test runner? (2593)
  2593,
  2867, // …for Bun? (2868). None in this repository; the switch arm is the reason.
  2868,
];

/** tsconfig `target` spellings → the `ScriptTarget` numbers the worker compares. */
const SCRIPT_TARGETS: Readonly<Record<string, number>> = {
  es3: 0,
  es5: 1,
  es6: 2,
  es2015: 2,
  es2016: 3,
  es2017: 4,
  es2018: 5,
  es2019: 6,
  es2020: 7,
  es2021: 8,
  es2022: 9,
  es2023: 10,
  es2024: 11,
  esnext: 99,
  latest: 99,
};

/** tsconfig `jsx` spellings → the worker's `JsxEmit` numbers. */
const JSX_EMIT: Readonly<Record<string, number>> = {
  none: 0,
  preserve: 1,
  react: 2,
  "react-native": 3,
  "react-jsx": 4,
  "react-jsxdev": 5,
};

/** `ModuleKind.ESNext` — see {@link typeScriptCompilerOptions} for why it is fixed. */
const MODULE_ESNEXT = 99;

/** `ScriptTarget.ESNext`, and `JsxEmit.ReactJSX`: what a project that says nothing gets. */
const DEFAULT_SCRIPT_TARGET = 99;
const DEFAULT_JSX_EMIT = 4;

/**
 * The lib names monaco 0.56 actually ships to its worker (`libFileMap`), minus
 * the `.full` variants no tsconfig can name.
 *
 * Validating against this is not pedantry, it is the difference between a
 * configured editor and a broken one: a `lib` entry the worker cannot produce
 * silently replaces the whole standard library with nothing, and the same 9
 * files that report 7 diagnostics with a good lib report 151 with a bad one —
 * `Cannot find name 'Error'`, `Cannot find name 'Promise'`, all the way down.
 * An unrecognised name is therefore dropped rather than passed through; if that
 * empties the list, `lib` is omitted entirely and the target's default applies.
 */
const MONACO_LIB_NAMES: ReadonlySet<string> = new Set(
  (
    "decorators decorators.legacy dom dom.asynciterable dom.iterable es5 es6 " +
    "es2015 es2015.collection es2015.core es2015.generator es2015.iterable " +
    "es2015.promise es2015.proxy es2015.reflect es2015.symbol es2015.symbol.wellknown " +
    "es2016 es2016.array.include es2016.intl " +
    "es2017 es2017.arraybuffer es2017.date es2017.intl es2017.object " +
    "es2017.sharedmemory es2017.string es2017.typedarrays " +
    "es2018 es2018.asyncgenerator es2018.asynciterable es2018.intl es2018.promise es2018.regexp " +
    "es2019 es2019.array es2019.intl es2019.object es2019.string es2019.symbol " +
    "es2020 es2020.bigint es2020.date es2020.intl es2020.number es2020.promise " +
    "es2020.sharedmemory es2020.string es2020.symbol.wellknown " +
    "es2021 es2021.intl es2021.promise es2021.string es2021.weakref " +
    "es2022 es2022.array es2022.error es2022.intl es2022.object es2022.regexp es2022.string " +
    "es2023 es2023.array es2023.collection es2023.intl " +
    "es2024 es2024.arraybuffer es2024.collection es2024.object es2024.promise " +
    "es2024.regexp es2024.sharedmemory es2024.string " +
    "esnext esnext.array esnext.collection esnext.decorators esnext.disposable " +
    "esnext.error esnext.float16 esnext.intl esnext.iterator esnext.promise " +
    "esnext.sharedmemory scripthost " +
    "webworker webworker.asynciterable webworker.importscripts webworker.iterable"
  ).split(" "),
);

/** tsconfig lib spellings (`"ESNext"`, `"DOM.Iterable"`) → the worker's file names. */
function monacoLibFileNames(lib: readonly string[]): string[] {
  return lib.flatMap((entry) => {
    const name = entry.toLowerCase();
    return MONACO_LIB_NAMES.has(name) ? [`lib.${name}.d.ts`] : [];
  });
}

/**
 * The compiler options one TS/JS model is checked under: what the project said,
 * over what a model-only worker needs to be told.
 *
 * The fixed half is not preference, it is arithmetic on what was measured:
 *
 *  - `module: ESNext` — without it the worker's default module setting calls
 *    dynamic `import()`, `import.meta` and top-level `await` errors (49 of them
 *    across this repo). Not read from the project: the model is never emitted,
 *    so the only thing `module` decides here is which syntax is legal, and the
 *    answer that makes modern source legal is the honest one.
 *  - `noImplicitAny: false` — applied AFTER the project's `strict`, and the
 *    single most important line in this function. An unresolved import types as
 *    `any`, so under `noImplicitAny` every callback parameter, JSX intrinsic and
 *    destructured binding downstream of it errors for a reason that is entirely
 *    our own: in a nine-file sample, 82 of the 89 diagnostics that survived the
 *    ignore list were that cascade. The project's other `strict` checks stay on
 *    and stay true.
 *  - `allowNonTsExtensions`/`allowJs` — monaco's own defaults, kept so a `.js`
 *    or `.mjs` model is parsed as JavaScript rather than as TypeScript.
 *  - `esModuleInterop`, `allowSyntheticDefaultImports`, `resolveJsonModule`,
 *    `skipLibCheck`, `noEmit` — statements about a build this worker will never
 *    perform, all of them in the direction of fewer false claims.
 *
 * `moduleResolution` is deliberately NOT set. Left at TypeScript's default the
 * unresolved-import complaint is TS2792; forcing `bundler` or `node` only
 * renames it (TS2307) and adds TS2875 on every JSX file. Both are ignored
 * anyway, and the one thing resolution CAN do here — join two open models whose
 * URIs happen to line up — works without it.
 */
export function typeScriptCompilerOptions(
  project: ProjectTypeScriptOptions,
): Monaco.typescript.CompilerOptions {
  const lib = monacoLibFileNames(project.lib ?? []);
  return {
    allowNonTsExtensions: true,
    allowJs: true,
    module: MODULE_ESNEXT,
    target: SCRIPT_TARGETS[project.target?.toLowerCase() ?? ""] ?? DEFAULT_SCRIPT_TARGET,
    jsx: JSX_EMIT[project.jsx?.toLowerCase() ?? ""] ?? DEFAULT_JSX_EMIT,
    ...(lib.length > 0 ? { lib } : {}),
    strict: project.strict ?? false,
    experimentalDecorators: project.experimentalDecorators ?? false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    noImplicitAny: false,
  };
}

/** The slice of Monaco's TS/JS language-service defaults this configuration writes. */
export interface TypeScriptLanguageDefaults {
  setCompilerOptions(options: Monaco.typescript.CompilerOptions): void;
  setDiagnosticsOptions(options: Monaco.typescript.DiagnosticsOptions): void;
}

/** Monaco's two language-service default objects — the whole host this needs. */
export interface TypeScriptDefaultsHost {
  typescript: {
    typescriptDefaults: TypeScriptLanguageDefaults;
    javascriptDefaults: TypeScriptLanguageDefaults;
  };
}

/**
 * Writes one set of compiler options and the ignore list onto both defaults.
 *
 * Every diagnostics field is stated rather than only the one being changed:
 * `setDiagnosticsOptions` REPLACES the object wholesale, so passing
 * `diagnosticCodesToIgnore` alone would silently switch JavaScript's semantic
 * validation ON (monaco ships it off) and hand every `.js` file a fresh crop of
 * errors while we were busy removing them.
 *
 * Syntax validation is on for both, always: a missing brace is true about the
 * file no matter what else the worker cannot see. Semantic validation follows
 * monaco's own split — on for TypeScript, off for JavaScript, where without
 * `checkJs` there are no types to check against and turning it on would be
 * guessing out loud.
 */
export function configureTypeScriptDefaults(
  host: TypeScriptDefaultsHost,
  compilerOptions: Monaco.typescript.CompilerOptions,
): void {
  const diagnosticCodesToIgnore = [...UNRESOLVABLE_MODULE_DIAGNOSTIC_CODES];
  host.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  host.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: false,
    noSemanticValidation: false,
    noSuggestionDiagnostics: false,
    onlyVisible: false,
    diagnosticCodesToIgnore,
  });
  host.typescript.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });
  host.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: false,
    noSemanticValidation: true,
    noSuggestionDiagnostics: false,
    onlyVisible: false,
    diagnosticCodesToIgnore,
  });
}

/**
 * The last compiler options actually pushed into Monaco, encoded for
 * comparison. Monaco re-validates EVERY open model whenever the defaults fire
 * their change event, so an answer identical to the live one is not written at
 * all — opening a second file in the same project must not re-check the first.
 */
let appliedCompilerOptions: string | null = null;

function applyTypeScriptDefaults(
  host: TypeScriptDefaultsHost,
  project: ProjectTypeScriptOptions,
): void {
  const compilerOptions = typeScriptCompilerOptions(project);
  const encoded = JSON.stringify(compilerOptions);
  if (encoded === appliedCompilerOptions) return;
  appliedCompilerOptions = encoded;
  configureTypeScriptDefaults(host, compilerOptions);
}

/** Reads one repo-relative text file, or `null` for anything that is not readable text. */
export type ProjectFileReader = (relPath: string) => Promise<string | null>;

/** Where a document's `tsconfig.json` search runs — one checkout, one file. */
export interface ProjectFileScope {
  projectId: string;
  ticketId?: string;
  relPath: string;
}

/** The scope a TS/JS document's project configuration is read from, or `null` for kinds that have none. */
export function projectFileScope(identity: DocumentIdentity): ProjectFileScope | null {
  if (identity.kind !== "file") return null;
  return identity.checkout.kind === "main"
    ? { projectId: identity.projectId, relPath: identity.relPath }
    : {
        projectId: identity.projectId,
        ticketId: identity.checkout.ticketId,
        relPath: identity.relPath,
      };
}

/**
 * `tsconfig.json` candidates for a file, nearest directory first, ending at the
 * checkout root. `"a/b/c.ts"` → `a/b`, `a`, root.
 */
export function tsconfigCandidatePaths(relPath: string): string[] {
  const directories = relPath.split("/").slice(0, -1);
  const paths: string[] = [];
  for (let depth = directories.length; depth >= 0; depth -= 1) {
    paths.push([...directories.slice(0, depth), "tsconfig.json"].join("/"));
  }
  return paths;
}

/**
 * `tsconfig.json` is JSON with comments and trailing commas — this repository's
 * own `apps/desktop/tsconfig.json` opens with a comment block — and `JSON.parse`
 * refuses both. Strings are tracked while scanning so a `//` inside a path and
 * an escaped quote survive intact.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  const commaPositions: number[] = [];
  while (index < text.length) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") {
        out += char + (text[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === ",") commaPositions.push(out.length);
    out += char;
    index += 1;
  }
  // Trailing commas last, over the comment-free text, from the back so each
  // recorded position is still valid when it is reached.
  for (const position of commaPositions.toReversed()) {
    const rest = out.slice(position + 1).trimStart();
    if (rest.startsWith("}") || rest.startsWith("]")) {
      out = out.slice(0, position) + out.slice(position + 1);
    }
  }
  return out;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One `tsconfig.json`'s adopted options and the configs it extends.
 *
 * Tolerant on read, like every other durable-shape reader in the app: a file
 * that is not JSON, an options block that is not an object, a `strict` that is
 * a string — each yields "this config did not say", never a thrown error, and
 * absent fields are absent rather than `undefined`, so merging cannot erase an
 * answer a further config gave.
 */
export function parseTsconfigOptions(
  text: string,
): { options: ProjectTypeScriptOptions; extends: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const options: ProjectTypeScriptOptions = {};
  const compilerOptions = parsed["compilerOptions"];
  if (isRecord(compilerOptions)) {
    const jsx = stringField(compilerOptions, "jsx");
    if (jsx !== undefined) options.jsx = jsx;
    const target = stringField(compilerOptions, "target");
    if (target !== undefined) options.target = target;
    const lib = compilerOptions["lib"];
    if (Array.isArray(lib) && lib.every((entry) => typeof entry === "string")) options.lib = lib;
    const strict = booleanField(compilerOptions, "strict");
    if (strict !== undefined) options.strict = strict;
    const decorators = booleanField(compilerOptions, "experimentalDecorators");
    if (decorators !== undefined) options.experimentalDecorators = decorators;
  }
  const extended = parsed["extends"];
  const extendsList =
    typeof extended === "string"
      ? [extended]
      : Array.isArray(extended)
        ? extended.filter((entry): entry is string => typeof entry === "string")
        : [];
  return { options, extends: extendsList };
}

/**
 * Resolves a RELATIVE `extends` against the config that declared it, in the
 * checkout-relative space every file read here speaks.
 *
 * Bare specifiers (`"@tsconfig/strict"`, `"astro/tsconfigs/strict"`) resolve
 * into `node_modules`, which is outside both the file index and the read seam's
 * root — so they are skipped rather than guessed at, and the project simply
 * says less than it does to `tsc`. A path that would climb out of the checkout
 * is refused for the same reason the read itself would refuse it.
 */
export function resolveExtendedTsconfigPath(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const segments = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const path = segments.join("/");
  return path.endsWith(".json") ? path : `${path}.json`;
}

/** Merges two configs' answers: `nearer` wins, `further` fills only what it left unsaid. */
function withFallbacks(
  nearer: ProjectTypeScriptOptions,
  further: ProjectTypeScriptOptions,
): ProjectTypeScriptOptions {
  return { ...further, ...nearer };
}

async function readTsconfigOptions(
  read: ProjectFileReader,
  path: string,
  seen: Set<string>,
): Promise<ProjectTypeScriptOptions> {
  if (seen.has(path)) return {};
  seen.add(path);
  const text = await read(path);
  if (text === null) return {};
  const parsed = parseTsconfigOptions(text);
  if (parsed === null) return {};
  let inherited: ProjectTypeScriptOptions = {};
  for (const specifier of parsed.extends) {
    const basePath = resolveExtendedTsconfigPath(path, specifier);
    if (basePath === null) continue;
    // A later `extends` entry wins over an earlier one, as it does for `tsc`.
    inherited = withFallbacks(await readTsconfigOptions(read, basePath, seen), inherited);
  }
  return withFallbacks(parsed.options, inherited);
}

/**
 * The project's answer for one file: the nearest `tsconfig.json` first, with
 * ancestors filling only what it left unsaid, and each config's own
 * `compilerOptions` beating the ones it extends.
 *
 * The ancestor walk is what makes this work in a monorepo, and it is not
 * decoration: the nearest config to a renderer file here is
 * `apps/desktop/tsconfig.json`, a references-only solution file that states no
 * `target` and no `strict` at all — the real answers live two directories up in
 * `tsconfig.base.json`, reached through the root config's `extends`.
 *
 * A miss is not a failure. Every read that finds nothing, cannot be parsed, or
 * points outside the checkout simply contributes nothing, and a file with no
 * project above it lands on {@link typeScriptCompilerOptions}' permissive
 * defaults — which is also exactly what a lone scratch file deserves.
 */
export async function readProjectTypeScriptOptions(
  read: ProjectFileReader,
  relPath: string,
): Promise<ProjectTypeScriptOptions> {
  const seen = new Set<string>();
  let merged: ProjectTypeScriptOptions = {};
  for (const path of tsconfigCandidatePaths(relPath)) {
    merged = withFallbacks(merged, await readTsconfigOptions(read, path, seen));
  }
  return merged;
}

/**
 * The default reader: the same scoped `{ projectId, ticketId }` file seam every
 * other read in the app goes through, so a ticket workspace reads the
 * `tsconfig.json` in ITS worktree.
 *
 * Guarded on `window` for the two surfaces that mount editors without a preload
 * bridge (the node renderer tests, the UI lab). A truncated read is treated as
 * absent: half a `tsconfig.json` is not a `tsconfig.json`.
 */
function scopedProjectFileReader(scope: ProjectFileScope): ProjectFileReader {
  return async (relPath) => {
    if (typeof window === "undefined") return null;
    const result = await window.api.files.read({
      projectId: scope.projectId,
      ...(scope.ticketId === undefined ? {} : { ticketId: scope.ticketId }),
      relPath,
    });
    if (!result.ok) return null;
    return result.content.type === "text" && !result.content.truncated ? result.content.text : null;
  };
}

/** Per directory, the project options read for it — one walk each, per runtime load. */
const projectOptionsByDirectory = new Map<string, Promise<ProjectTypeScriptOptions>>();

/**
 * Teaches the TS worker about the project the given document belongs to, then
 * re-checks every open model under that answer.
 *
 * Called beside {@link startModelLanguageWorker} — the one place a TS/JS model
 * is known to be opening — because Monaco's compiler options are per RUNTIME,
 * not per model: there is exactly one answer, and the honest one is the project
 * of the file most recently opened. Two projects open at once therefore share
 * the last answer, which is why identical answers are never re-applied and why
 * the fallback is permissive rather than opinionated.
 *
 * Everything about it is best-effort. Non-TS/JS documents, ticket bodies and
 * diff bases return immediately without reading anything; a failed read leaves
 * the permissive defaults in place. Nobody is waiting on the result — the
 * squiggles simply become more accurate a moment later — so a failure logs and
 * keeps the fallback rather than raising a toast at someone who did not ask for
 * this and could not act on it.
 */
export async function ensureProjectTypeScriptDefaults(
  host: TypeScriptDefaultsHost,
  identity: DocumentIdentity,
  readerFor: (scope: ProjectFileScope) => ProjectFileReader = scopedProjectFileReader,
): Promise<void> {
  const language = detectDocumentLanguage(identity);
  if (language !== "typescript" && language !== "javascript") return;
  const scope = projectFileScope(identity);
  if (scope === null) return;
  const directory = scope.relPath.split("/").slice(0, -1).join("/");
  const key = `${scope.projectId}\u0000${scope.ticketId ?? ""}\u0000${directory}`;
  let pending = projectOptionsByDirectory.get(key);
  if (pending === undefined) {
    pending = readProjectTypeScriptOptions(readerFor(scope), scope.relPath);
    projectOptionsByDirectory.set(key, pending);
  }
  applyTypeScriptDefaults(host, await pending);
}

/** Test-only: clear the module state this configuration remembers between cases. */
export function resetProjectTypeScriptDefaultsForTests(): void {
  appliedCompilerOptions = null;
  projectOptionsByDirectory.clear();
}

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
