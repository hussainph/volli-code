/**
 * The `@file` reference layer for the markdown editor (global-artifacts
 * decisions #3/#4/#8): a Claude-Code-style `@` autocomplete over the project
 * file index plus the chip decoration that turns resolved `@relative/path`
 * tokens into clickable chips. Both share the one `parseFileRefs`/
 * `scoreFileMatch` domain in `@volli/shared`, so the picker's ranking and the
 * chip's ref-parsing can't drift from main's index builder.
 *
 * The stored form is always plain text (`@relative/path`) — the chip is a pure
 * display overlay that vanishes the instant the caret touches its span (the
 * same reveal rule the live-preview layer uses), so the buffer stays
 * byte-faithful and directly editable. Refs that don't resolve against the
 * current index degrade to plain text.
 *
 * The index is provisioned through a caller-supplied {@link FileRefsConfig}
 * (backed by a React ref so the mount-once editor reads the latest without
 * remounting). A `bumpFileIndex` effect lets the host force a chip rebuild when
 * a fresh index arrives without any document change.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { type Extension, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  baseNameOf,
  dirNameOf,
  type FileRef,
  type IndexedFile,
  isExpressibleRefPath,
  isValidNewArtifactName,
  parseFileRefs,
  scoreFileMatch,
  VOLLI_ARTIFACTS_REL_DIR,
  withMarkdownExtension,
} from "@volli/shared";
import { toast } from "sonner";

import { selectionTouches, type SelRange } from "./reveal";

/** The result of creating a new artifact from the picker — the shape of `api.files.createArtifact`. */
export type CreateArtifactResult = { ok: true; relPath: string } | { ok: false; error: string };

/**
 * The host-supplied hooks the `@file` layer needs. The editor stores this behind
 * a ref (latest-callback pattern) so index refreshes and callback identity
 * changes never force a remount.
 */
export interface FileRefsConfig {
  /** The current cached project file index (chip resolution + picker ranking read this). */
  getIndex(): readonly IndexedFile[];
  /** Kick a background index refresh (cache-gated in the host) — invoked when the picker opens. */
  refreshIndex(): void;
  /** Open (or focus) a file tab for a resolved chip / freshly-created artifact. */
  onOpenFile(relPath: string): void;
  /** Create a templated `.md` artifact for the "Create artifact" picker row. */
  createArtifact(name: string): Promise<CreateArtifactResult>;
}

/** How many ranked picker results to render at once — a peek surface, not a full search. */
const MAX_PICKER_RESULTS = 50;

/**
 * Dispatched by the host when a newly-fetched index might change which refs
 * resolve, so the chip decoration rebuilds even though the document is
 * unchanged (a plain doc/selection update wouldn't trigger it otherwise).
 */
export const bumpFileIndex = StateEffect.define<null>();

// ---- @ autocomplete -----------------------------------------------------------

/**
 * The completion source: fires on an `@`-token at a ref boundary (start-of-line,
 * after whitespace, or after `(` — the same boundary `parseFileRefs` honours, so
 * an email's `foo@bar` never opens the picker), ranks the index with
 * `scoreFileMatch`, and appends a "Create artifact" row when the token is a
 * valid new artifact name with no exact match.
 */
function fileCompletionSource(config: FileRefsConfig): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/@[A-Za-z0-9._/-]*/);
    if (!token) return null;
    // Boundary check mirroring parseFileRefs: the char before `@` must be
    // start-of-doc, whitespace, or `(` — otherwise it's part of a larger word
    // (e.g. an email) and not a file ref.
    const before = token.from === 0 ? "" : context.state.sliceDoc(token.from - 1, token.from);
    if (before !== "" && !/\s/.test(before) && before !== "(") return null;

    // Refresh from main (cache-gated) so the picker ranks a current index; the
    // list renders immediately from the cached copy while any refresh lands.
    config.refreshIndex();
    const query = token.text.slice(1);
    const index = config.getIndex();

    const ranked = index
      // Drop paths the v1 ref grammar can't express (spaces, `[slug]`, `+`, …):
      // inserting `@${relPath}` for one would silently degrade to plain text
      // since parseFileRefs wouldn't consume it back. See isExpressibleRefPath.
      .filter((file) => isExpressibleRefPath(file.relPath))
      .map((file) => ({ file, score: scoreFileMatch(query, file.relPath) }))
      .filter((entry): entry is { file: IndexedFile; score: number } => entry.score !== null)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, MAX_PICKER_RESULTS);

    const options: Completion[] = ranked.map(({ file }) => ({
      label: baseNameOf(file.relPath),
      detail: dirNameOf(file.relPath),
      // Distinct icon types so artifacts read apart from ordinary repo files
      // (styled in `fileRefsTheme`).
      type: file.artifact ? "volli-artifact" : "volli-file",
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const insert = `@${file.relPath}`;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      },
    }));

    // The created artifact's relPath is deterministic (the artifacts dir + the
    // `.md`-forced name), so we can both detect an existing match by that full
    // relPath — a bare-name compare would never hit (index holds relPaths), so
    // the create row stayed pinned even when the artifact existed and selecting
    // it EEXISTed — and insert the ref synchronously below.
    const createdRelPath = `${VOLLI_ARTIFACTS_REL_DIR}/${withMarkdownExtension(query.trim())}`;
    const exactMatch = index.some((file) => file.relPath === createdRelPath);
    if (isValidNewArtifactName(query) && !exactMatch) {
      const displayName = withMarkdownExtension(query.trim());
      options.push({
        label: `Create artifact "${displayName}"`,
        type: "volli-create",
        // Keep it pinned regardless of the fuzzy order above.
        boost: 99,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          // Insert the `@ref` synchronously with the still-valid from/to range:
          // the created path is deterministic, so we don't need the IPC result
          // to know it. Dispatching after the await would use stale offsets that
          // a concurrent edit could have invalidated (mangled text / RangeError).
          const insert = `@${createdRelPath}`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
          });
          // Then fire the create; on success open the tab, on failure toast and
          // leave the inserted text — it degrades to a plain unresolved ref (the
          // chip won't render since the file doesn't exist).
          void (async () => {
            const result = await config.createArtifact(query.trim());
            if (!result.ok) {
              toast.error(`Could not create artifact: ${result.error}`);
              return;
            }
            config.onOpenFile(result.relPath);
          })();
        },
      });
    }

    // `filter: false` — we already ranked with scoreFileMatch; let CodeMirror
    // render the list as-is rather than re-filtering by its own prefix logic.
    return { from: token.from, to: token.to, options, filter: false };
  };
}

// ---- chip decoration ----------------------------------------------------------

/** The inline chip that stands in for a resolved `@path` token (icon + basename). */
class FileChipWidget extends WidgetType {
  constructor(private readonly relPath: string) {
    super();
  }

  override eq(other: FileChipWidget): boolean {
    return other.relPath === this.relPath;
  }

  // The default (true) makes CodeMirror drop events that originate inside the
  // widget BEFORE the plugin's mousedown handler ever runs — chips would be
  // unclickable. Returning false lets the event reach the handler chain; the
  // handler returns true on a plain left-click, which still stops the editor's
  // own selection handling.
  override ignoreEvent(): boolean {
    return false;
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-file-chip";
    chip.setAttribute("data-file-ref", this.relPath);
    chip.title = this.relPath;
    const icon = document.createElement("span");
    icon.className = "cm-file-chip-icon";
    icon.textContent = "@";
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode(baseNameOf(this.relPath)));
    return chip;
  }
}

/**
 * Builds the chip decoration set from already-parsed `refs` (the caller caches
 * them across selection/viewport-only updates so we don't re-parse the whole
 * doc on every caret move or scroll). Only refs that resolve, are in view, and
 * aren't touched by the caret become chips.
 */
function buildChipDecorations(
  view: EditorView,
  refs: readonly FileRef[],
  resolves: (relPath: string) => boolean,
): DecorationSet {
  const { state } = view;
  const selection: SelRange[] = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  for (const ref of refs) {
    // Only decorate refs that resolve against the current index (decision #4:
    // dangling refs degrade to plain text) and only while the caret is outside
    // the span, so the raw `@path` reappears for editing.
    if (!resolves(ref.path)) continue;
    const visible = view.visibleRanges.some((r) => ref.from <= r.to && r.from <= ref.to);
    if (!visible) continue;
    if (selectionTouches(selection, ref.from, ref.to)) continue;
    decos.push({
      from: ref.from,
      to: ref.to,
      deco: Decoration.replace({ widget: new FileChipWidget(ref.path) }),
    });
  }

  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

/** The chip decoration plugin — rebuilds on doc/selection/viewport changes and on `bumpFileIndex`. */
function fileChipsPlugin(config: FileRefsConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      // Parsed refs cached across selection/viewport-only updates: caret moves
      // and scrolls re-filter these but never re-parse the doc.
      private refs: readonly FileRef[];

      // Resolution lookup cached by index-array identity: a fresh index array
      // rebuilds the O(1) Set once, so `resolves` is a `.has` instead of a
      // linear scan per ref per rebuild.
      private resolveIndex: readonly IndexedFile[] | null = null;
      private resolveSet: Set<string> = new Set();

      constructor(view: EditorView) {
        this.refs = parseFileRefs(view.state.doc.toString());
        this.decorations = buildChipDecorations(view, this.refs, (p) => this.resolves(p));
      }

      private resolves(relPath: string): boolean {
        const index = config.getIndex();
        if (index !== this.resolveIndex) {
          this.resolveIndex = index;
          this.resolveSet = new Set(index.map((file) => file.relPath));
        }
        return this.resolveSet.has(relPath);
      }

      update(update: ViewUpdate): void {
        const indexChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(bumpFileIndex)),
        );
        // Re-parse only when the text changed or a fresh index arrived; caret
        // moves (selectionSet) and scrolls (viewportChanged) reuse the cache.
        if (update.docChanged || indexChanged) {
          this.refs = parseFileRefs(update.state.doc.toString());
        }
        if (update.docChanged || update.viewportChanged || update.selectionSet || indexChanged) {
          this.decorations = buildChipDecorations(update.view, this.refs, (p) => this.resolves(p));
        }
      }
    },
    {
      decorations: (value) => value.decorations,
      eventHandlers: {
        mousedown(event) {
          const target = event.target as HTMLElement | null;
          const chip = target?.closest<HTMLElement>("[data-file-ref]");
          if (!chip) return false;
          // Only a plain left-click opens; right/middle-click and the macOS
          // ctrl-click context-menu chord fall through (mirrors live-preview's
          // data-md-href handler).
          if (event.button !== 0 || event.ctrlKey) return false;
          event.preventDefault();
          const relPath = chip.getAttribute("data-file-ref");
          if (relPath) config.onOpenFile(relPath);
          return true;
        },
      },
    },
  );
}

/** Chip + picker-icon styling — every value maps to a globals.css token. */
const fileRefsTheme = EditorView.theme({
  ".cm-file-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.15em",
    padding: "0.05em 0.4em",
    margin: "0 0.05em",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--accent)",
    color: "var(--foreground)",
    fontSize: "0.85em",
    cursor: "pointer",
    verticalAlign: "baseline",
    whiteSpace: "nowrap",
  },
  ".cm-file-chip:hover": {
    borderColor: "var(--border-hover)",
    background: "var(--muted)",
  },
  ".cm-file-chip-icon": {
    color: "var(--primary)",
    fontWeight: "600",
  },
  ".cm-completionIcon-volli-artifact::after": { content: "'◆'", color: "var(--primary)" },
  ".cm-completionIcon-volli-file::after": { content: "'○'", color: "var(--muted-foreground)" },
  ".cm-completionIcon-volli-create::after": { content: "'+'", color: "var(--primary)" },
});

/**
 * The full `@file` extension: the chip decoration plugin, the `@` autocomplete
 * source, and their shared theme. Added by `MarkdownLiveEditor` only when a
 * caller supplies a {@link FileRefsConfig}; absent it, the editor behaves
 * exactly as before.
 */
export function fileRefsExtension(config: FileRefsConfig): Extension {
  return [
    fileChipsPlugin(config),
    autocompletion({ override: [fileCompletionSource(config)] }),
    fileRefsTheme,
  ];
}
