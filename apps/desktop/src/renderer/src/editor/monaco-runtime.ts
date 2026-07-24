import type * as Monaco from "monaco-editor";

import { DocumentRegistry } from "./document-registry";
import { createVolliMonacoTheme, readVolliMonacoTokens } from "./monaco-theme";

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

export interface MonacoRuntime {
  monaco: typeof Monaco;
  registry: DocumentRegistry<Monaco.editor.ITextModel, Monaco.editor.ICodeEditorViewState>;
}

type WorkerConstructor = new (options?: WorkerOptions) => Worker;

async function initializeMonacoRuntime(): Promise<MonacoRuntime> {
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
  monaco.editor.defineTheme("volli-dark", createVolliMonacoTheme(readVolliMonacoTokens()));
  monaco.editor.setTheme("volli-dark");

  const registry = new DocumentRegistry<
    Monaco.editor.ITextModel,
    Monaco.editor.ICodeEditorViewState
  >({
    createModel({ value, language, uri }) {
      return monaco.editor.createModel(value, language, monaco.Uri.parse(uri));
    },
  });
  return { monaco, registry };
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
  const workerFor = await getWorker();
  await workerFor(model.uri);
  return "typescript";
}
