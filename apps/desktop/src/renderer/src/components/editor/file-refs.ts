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
  type IndexedFile,
  isValidNewArtifactName,
  parseFileRefs,
  scoreFileMatch,
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

/** The basename of a `/`-separated relPath (or the whole string when there's no separator). */
function baseNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? relPath : relPath.slice(slash + 1);
}

/** The directory portion of a relPath (empty at the repo root) — the picker's dim detail line. */
function dirNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

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

    const exactMatch = index.some((file) => file.relPath === query);
    if (isValidNewArtifactName(query) && !exactMatch) {
      const displayName = withMarkdownExtension(query.trim());
      options.push({
        label: `Create artifact "${displayName}"`,
        type: "volli-create",
        // Keep it pinned regardless of the fuzzy order above.
        boost: 99,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          void (async () => {
            const result = await config.createArtifact(query.trim());
            if (!result.ok) {
              toast.error(`Could not create artifact: ${result.error}`);
              return;
            }
            const insert = `@${result.relPath}`;
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
            });
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

function buildChipDecorations(
  view: EditorView,
  resolves: (relPath: string) => boolean,
): DecorationSet {
  const { state } = view;
  const selection: SelRange[] = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  const refs = parseFileRefs(state.doc.toString());
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

      constructor(view: EditorView) {
        this.decorations = buildChipDecorations(view, (p) => this.resolves(p));
      }

      private resolves(relPath: string): boolean {
        return config.getIndex().some((file) => file.relPath === relPath);
      }

      update(update: ViewUpdate): void {
        const indexChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(bumpFileIndex)),
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || indexChanged) {
          this.decorations = buildChipDecorations(update.view, (p) => this.resolves(p));
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
