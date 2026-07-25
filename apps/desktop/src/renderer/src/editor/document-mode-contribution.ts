/**
 * Document Mode, attached to a live Monaco editor.
 *
 * This is the thin, untestable half of the port — everything that decides
 * anything lives in a pure module beside it (`markdown-projection.ts` →
 * `document-decorations.ts` → `file-refs.ts`), because renderer tests here run
 * in Node with no DOM and a Monaco editor cannot be constructed in one. What is
 * left is genuinely mechanical: run the projection, hand the descriptors to a
 * decorations collection, diff the image view zones, and route three kinds of
 * click.
 *
 * ## When it re-projects
 *
 * The projection depends on the text, the selection, AND focus — a blurred
 * editor reveals nothing, because an invisible caret leaving raw `**` on screen
 * reads as a rendering bug. So all four events feed one coalesced pass:
 * typing fires a content change and a cursor change back to back, and a
 * microtask fold makes that one projection rather than two.
 *
 * ## The one document-mutating widget
 *
 * A task checkbox writes `[ ]`/`[x]` back into the model, byte for byte — the
 * markdown IS the checkbox state (CONCEPT #60), so a click is an ordinary edit
 * that autosave then persists like any keystroke.
 *
 * ## Completion registration
 *
 * The `@file` provider is registered ONCE per Monaco namespace, not once per
 * editor: `initializeMonacoRuntime` is a module-level singleton with no
 * extension slot, and a per-mount `registerCompletionItemProvider` would stack
 * a duplicate provider on every ticket you open. Instead a module-level table
 * maps a model URI to the host config that owns it; the single provider looks
 * the model up and declines when it finds nothing, which is also exactly the
 * behaviour repository Markdown in Source Mode needs (it shares the `markdown`
 * language id but must get no `@` picker).
 */
import type * as Monaco from "monaco-editor";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import { errorMessage } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

import "./document-mode.css";
import {
  type DocumentDecoration,
  type DocumentImage,
  renderProjection,
  targetAt,
} from "./document-decorations";
import { type EmphasisMark, planEmphasisWrap } from "./emphasis-wrap";
import {
  fileRefTokenAt,
  type FileRefsConfig,
  rankFileRefCompletions,
  renderFileRefChips,
} from "./file-refs";
import { shouldOpenLink } from "./link-open";
import { projectMarkdown } from "./markdown-projection";
import type { SelRange } from "./reveal";

/** The class the stylesheet scopes every Document Mode rule under. */
export const DOCUMENT_MODE_CLASS = "volli-document-mode";

/** Command id for "the user picked the Create artifact row". */
const CREATE_ARTIFACT_COMMAND = "volli.documentMode.createArtifact";

/** Height a not-yet-loaded image reserves, so the zone does not pop into being. */
const IMAGE_ZONE_PLACEHOLDER_PX = 24;
/** A tall image is scrolled inside the document, not allowed to own the viewport. */
const IMAGE_ZONE_MAX_PX = 420;

/**
 * Model URI → the host config for that document. The completion provider and
 * the create-artifact command are global; this is how they find the project,
 * index, and callbacks belonging to the model they were invoked on.
 */
const configsByModelUri = new Map<string, () => FileRefsConfig | undefined>();

/** Identity of one image view zone: the same picture on the same line is the same zone. */
function zoneKey(image: DocumentImage): string {
  return `${image.afterLineNumber} ${image.src}`;
}

let globalsRegistered = false;

/**
 * Registers the `@file` completion provider and its create-artifact command on
 * the Monaco namespace, at most once. Deliberately never disposed: the
 * registration belongs to the runtime singleton, and `configsByModelUri` is
 * what actually gates whether any given model gets completions.
 */
function ensureGlobalRegistrations(monaco: typeof Monaco): void {
  if (globalsRegistered) return;
  globalsRegistered = true;

  monaco.editor.registerCommand(CREATE_ARTIFACT_COMMAND, (_accessor, ...args: unknown[]) => {
    const [modelUri, name] = args as [string, string];
    const config = configsByModelUri.get(modelUri)?.();
    if (config === undefined) return;
    // The `@ref` is already in the document — the completion's `insertText` put
    // it there synchronously, using the still-valid replacement range, because
    // the created path is deterministic. Awaiting the IPC first would mean
    // applying an edit with offsets a concurrent keystroke may have invalidated.
    void (async () => {
      try {
        const result = await config.createArtifact(name);
        if (!result.ok) {
          // The inserted text stays: it degrades to a plain unresolved ref
          // (no chip, since the file does not exist), which is recoverable.
          toastError(`Couldn't create artifact: ${result.error}`);
          return;
        }
        config.onOpenFile(result.relPath);
      } catch (error) {
        toastError(`Couldn't create artifact: ${errorMessage(error)}`);
      }
    })();
  });

  monaco.languages.registerCompletionItemProvider("markdown", {
    triggerCharacters: ["@", "/"],
    provideCompletionItems(model, position) {
      const config = configsByModelUri.get(model.uri.toString())?.();
      if (config === undefined) return { suggestions: [] };
      const text = model.getValue();
      const token = fileRefTokenAt({ text, offset: model.getOffsetAt(position) });
      if (token === null) return { suggestions: [] };

      // Cache-gated in the host; the list renders from the cached copy while any
      // refresh lands.
      config.refreshIndex();

      const start = model.getPositionAt(token.from);
      const end = model.getPositionAt(token.to);
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
      const suggestions = rankFileRefCompletions({
        query: token.query,
        index: config.getIndex(),
      }).map((entry): Monaco.languages.CompletionItem => {
        if (entry.kind === "create") {
          return {
            label: entry.label,
            insertText: entry.insertText,
            filterText: entry.filterText,
            sortText: entry.sortText,
            range,
            kind: monaco.languages.CompletionItemKind.Event,
            command: {
              id: CREATE_ARTIFACT_COMMAND,
              title: "Create artifact",
              arguments: [model.uri.toString(), entry.name],
            },
          };
        }
        return {
          label: entry.label,
          insertText: entry.insertText,
          filterText: entry.filterText,
          sortText: entry.sortText,
          range,
          detail: entry.detail,
          // Artifacts read apart from ordinary repo files at a glance.
          kind: entry.artifact
            ? monaco.languages.CompletionItemKind.Snippet
            : monaco.languages.CompletionItemKind.File,
        };
      });
      // `incomplete` re-invokes the provider on every keystroke, so the ranking
      // stays ours instead of Monaco narrowing a stale list with its own matcher.
      return { suggestions, incomplete: true };
    },
  });
}

export interface DocumentModeContext {
  editor: MonacoEditor.IStandaloneCodeEditor;
  model: MonacoEditor.ITextModel;
  monaco: typeof Monaco;
}

export interface DocumentModeOptions {
  /** Latest `@file` wiring, or undefined for a document with no ref support. */
  getFileRefs(): FileRefsConfig | undefined;
}

/** What the host keeps hold of: a way to force a rebuild, and teardown. */
export interface DocumentModeAttachment extends IDisposable {
  /**
   * Re-project now. The host calls this when a fresh file index arrives, which
   * can change which refs resolve without the document changing at all.
   */
  refresh(): void;
}

/**
 * Attach Document Mode to one editor. Returns a disposable the caller MUST
 * dispose when the editor goes: the decorations collection, the view zones and
 * the model-config registration all outlive the editor otherwise.
 */
export function attachDocumentMode(
  context: DocumentModeContext,
  options: DocumentModeOptions,
): DocumentModeAttachment {
  const { editor, model, monaco } = context;
  ensureGlobalRegistrations(monaco);

  const modelUri = model.uri.toString();
  configsByModelUri.set(modelUri, options.getFileRefs);

  const collection = editor.createDecorationsCollection([]);
  const subscriptions: IDisposable[] = [];

  let links: ReturnType<typeof renderProjection>["links"] = [];
  let checkboxes: ReturnType<typeof renderProjection>["checkboxes"] = [];
  let chips: ReturnType<typeof renderFileRefChips>["chips"] = [];

  // Image view zones, keyed by line+source so a keystroke elsewhere does not
  // tear down and re-request every image in the document.
  const zones = new Map<string, { id: string; zone: MonacoEditor.IViewZone }>();

  let disposed = false;
  let scheduled = false;

  function selectionOffsets(): readonly SelRange[] {
    const selections = editor.getSelections() ?? [];
    return selections.map((selection) => {
      const a = model.getOffsetAt(selection.getStartPosition());
      const b = model.getOffsetAt(selection.getEndPosition());
      return { from: Math.min(a, b), to: Math.max(a, b) };
    });
  }

  function syncImageZones(images: readonly DocumentImage[]): void {
    const wanted = new Set(images.map(zoneKey));
    const missing = images.filter((image) => !zones.has(zoneKey(image)));
    const stale = [...zones.keys()].filter((key) => !wanted.has(key));
    if (missing.length === 0 && stale.length === 0) return;

    editor.changeViewZones((accessor) => {
      for (const key of stale) {
        const existing = zones.get(key);
        if (existing !== undefined) accessor.removeZone(existing.id);
        zones.delete(key);
      }
      for (const image of missing) {
        const dom = document.createElement("div");
        dom.className = "volli-document-mode-image";
        const element = new Image();
        element.src = image.src;
        element.alt = image.alt;
        dom.appendChild(element);
        const zone: MonacoEditor.IViewZone = {
          afterLineNumber: image.afterLineNumber,
          heightInPx: IMAGE_ZONE_PLACEHOLDER_PX,
          domNode: dom,
        };
        const id = accessor.addZone(zone);
        const key = zoneKey(image);
        zones.set(key, { id, zone });
        // The zone reserves space before the bytes arrive, so its real height is
        // only knowable on load; re-laying it out then is what stops a tall
        // image from being clipped to the placeholder.
        element.addEventListener("load", () => {
          if (disposed || zones.get(key)?.id !== id) return;
          zone.heightInPx = Math.min(dom.scrollHeight, IMAGE_ZONE_MAX_PX);
          editor.changeViewZones((later) => {
            later.layoutZone(id);
          });
        });
      }
    });
  }

  function project(): void {
    if (disposed) return;
    const text = model.getValue();
    const render = renderProjection({
      text,
      ops: projectMarkdown({
        text,
        selection: selectionOffsets(),
        focused: editor.hasTextFocus(),
      }),
    });

    const config = options.getFileRefs();
    const refRender =
      config === undefined
        ? { decorations: [] as readonly DocumentDecoration[], chips: [] }
        : renderFileRefChips({
            text,
            resolvedPaths: new Set(config.getIndex().map((file) => file.relPath)),
          });

    links = render.links;
    checkboxes = render.checkboxes;
    chips = refRender.chips;

    collection.set(
      [...render.decorations, ...refRender.decorations].map((decoration) => ({
        range: decoration.range,
        options: decoration.options,
      })),
    );
    syncImageZones(render.images);
  }

  /** Fold the burst of events one keystroke produces into a single pass. */
  function schedule(): void {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      project();
    });
  }

  subscriptions.push(
    model.onDidChangeContent(schedule),
    editor.onDidChangeCursorSelection(schedule),
    editor.onDidFocusEditorText(schedule),
    editor.onDidBlurEditorText(schedule),
  );

  // Escape leaves the document, the way it did under CodeMirror's keymap: the
  // ticket detail's own Escape-to-close is exempted for any Monaco surface
  // (issue #116), so without this the caret would be a one-way door — you could
  // get into the body but only a mouse click could get you out of it. The
  // precondition hands Escape back to Monaco whenever Monaco has something of
  // its own to dismiss, which is the only reason it owns the key at all.
  subscriptions.push(
    editor.addAction({
      id: "volli.documentMode.leave",
      label: "Leave the document",
      keybindings: [monaco.KeyCode.Escape],
      precondition: "!suggestWidgetVisible && !findWidgetVisible",
      run: () => {
        // Monaco has no `blur()`; the focused node is its input surface, and
        // dropping focus there is what lets the NEXT Escape bubble to the view.
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      },
    }),
  );

  /**
   * ⌘B / ⌘I, restored from the CodeMirror keymap (issue #107). Monaco ships no
   * markdown formatting commands of its own, so without this the two chords do
   * nothing at all on a document surface. Everything that decides anything is in
   * `planEmphasisWrap`; this is the apply.
   */
  function toggleEmphasis(mark: EmphasisMark): void {
    const selection = selectionOffsets();
    // `setSelections` throws on an empty array, and an editor with no cursor has
    // nothing to wrap anyway.
    if (selection.length === 0) return;
    const plan = planEmphasisWrap({ text: model.getValue(), selection, mark });
    // One batch, in original coordinates: Monaco re-bases the edits against each
    // other, so a multi-cursor toggle stays a single undo step.
    editor.executeEdits(
      "volli.documentMode.emphasis",
      plan.edits.map((edit) => ({ range: edit.range, text: edit.text })),
    );
    editor.setSelections(
      plan.selections.map((range) => ({
        selectionStartLineNumber: range.startLineNumber,
        selectionStartColumn: range.startColumn,
        positionLineNumber: range.endLineNumber,
        positionColumn: range.endColumn,
      })),
    );
  }

  subscriptions.push(
    editor.addAction({
      id: "volli.documentMode.toggleBold",
      label: "Toggle bold",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      run: () => {
        toggleEmphasis("**");
      },
    }),
    editor.addAction({
      id: "volli.documentMode.toggleItalic",
      label: "Toggle italic",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      run: () => {
        toggleEmphasis("*");
      },
    }),
  );

  subscriptions.push(
    editor.onMouseDown((event) => {
      const position = event.target.position;
      if (position === null) return;

      // Checkbox first: it is the only target that mutates the document, and it
      // must win over the caret placement Monaco would otherwise do here.
      const checkbox = targetAt(checkboxes, position);
      if (checkbox !== null && shouldOpenLink(event.event.browserEvent)) {
        event.event.preventDefault();
        event.event.stopPropagation();
        editor.executeEdits("volli.documentMode.toggleTask", [
          { range: checkbox.range, text: checkbox.toggledText, forceMoveMarkers: true },
        ]);
        return;
      }

      if (!shouldOpenLink(event.event.browserEvent)) return;

      const chip = targetAt(chips, position);
      if (chip !== null) {
        event.event.preventDefault();
        options.getFileRefs()?.onOpenFile(chip.relPath);
        return;
      }

      const link = targetAt(links, position);
      if (link !== null) {
        event.event.preventDefault();
        // Routed through main's window-open handler (shell.openExternal).
        window.open(link.href, "_blank", "noopener");
      }
    }),
  );

  project();

  return {
    refresh: project,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      collection.clear();
      if (zones.size > 0) {
        editor.changeViewZones((accessor) => {
          for (const { id } of zones.values()) accessor.removeZone(id);
        });
        zones.clear();
      }
      if (configsByModelUri.get(modelUri) === options.getFileRefs) {
        configsByModelUri.delete(modelUri);
      }
    },
  };
}
