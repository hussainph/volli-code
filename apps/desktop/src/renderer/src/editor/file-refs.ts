/**
 * The `@file` reference layer, as pure data (global-artifacts decisions #3/#4/#8).
 *
 * Two behaviours, one grammar: the `@` picker that ranks the project file index
 * as you type, and the chip decoration that marks a resolved `@relative/path`.
 * Both delegate every grammar question to `@volli/shared`'s `parseFileRefs` /
 * `scoreFileMatch` / `isExpressibleRefPath`, which is also what main's index
 * builder uses — so the picker's ranking, the chip's parsing, and the CLI's view
 * of a ref cannot drift apart. Nothing here re-implements the grammar; it only
 * decides what the editor should show.
 *
 * Departure from the CodeMirror implementation, and the reason it is safe: the
 * chip used to be a `Decoration.replace` widget, which meant the raw `@path` had
 * to reappear whenever the caret touched it or the user could not edit the text
 * underneath. Monaco's chip is an inline class over the token itself (decision
 * #8's acceptance criterion: decorate without replacing), so the markdown is
 * always on screen and always editable, and there is no reveal rule to get
 * wrong.
 */
import {
  baseNameOf,
  dirNameOf,
  type IndexedFile,
  isExpressibleRefPath,
  isValidNewArtifactName,
  parseFileRefs,
  scoreFileMatch,
  VOLLI_ARTIFACTS_REL_DIR,
  withMarkdownExtension,
} from "@volli/shared";

import { type DocumentDecoration, NEVER_GROWS_WHEN_TYPING_AT_EDGES } from "./document-decorations";
import { buildLineIndex, spanToRange, type TextRange } from "./text-position";

/** How many ranked picker results to render at once — a peek surface, not a search. */
const MAX_PICKER_RESULTS = 50;

/** Path-token character class, mirroring `parseFileRefs`. */
const PATH_CHAR = /[A-Za-z0-9._/-]/;

/** The `@…` token the caret sits at the end of: what a completion replaces. */
export interface FileRefToken {
  /** Offset of the `@` sigil — the start of the range a completion overwrites. */
  readonly from: number;
  /** The caret. A completion never consumes text to its right. */
  readonly to: number;
  /** The path fragment typed so far (may be empty for a bare `@`). */
  readonly query: string;
}

/**
 * The `@` token immediately before `offset`, or null when the caret is not in
 * one.
 *
 * The boundary rule is `parseFileRefs`': an `@` only starts a ref at
 * start-of-text, after whitespace, or after `(`. Without it, typing an email
 * address would open a file picker at `me@`. Newlines are whitespace, so the
 * search is naturally confined to the current line without checking for it.
 */
export function fileRefTokenAt(input: { text: string; offset: number }): FileRefToken | null {
  const { text } = input;
  if (input.offset < 0) return null;
  const offset = Math.min(input.offset, text.length);
  let start = offset;
  while (start > 0 && PATH_CHAR.test(text.charAt(start - 1))) start -= 1;
  if (start === 0 || text.charAt(start - 1) !== "@") return null;
  const sigil = start - 1;
  const before = sigil === 0 ? "" : text.charAt(sigil - 1);
  if (before !== "" && !/\s/.test(before) && before !== "(") return null;
  return { from: sigil, to: offset, query: text.slice(start, offset) };
}

interface FileRefCompletionBase {
  readonly label: string;
  /** The full `@relPath` written into the document. */
  readonly insertText: string;
  /**
   * Identical for every row on purpose. Monaco re-filters a completion list
   * against the typed word and would drop matches `scoreFileMatch` deliberately
   * kept (it is a subsequence matcher; Monaco's is not the same one). Giving
   * every row the typed text as its filter makes them all score equally, so the
   * list Monaco shows is the list this module ranked, ordered by `sortText`.
   */
  readonly filterText: string;
  /** Zero-padded so Monaco's lexicographic sort reproduces the ranking. */
  readonly sortText: string;
}

export type FileRefCompletion =
  | (FileRefCompletionBase & {
      readonly kind: "file";
      /** Directory, shown beside the name — the index is full of same-named files. */
      readonly detail: string;
      readonly relPath: string;
      readonly artifact: boolean;
    })
  | (FileRefCompletionBase & {
      readonly kind: "create";
      /** The raw name to hand `createArtifact` (no extension forced yet). */
      readonly name: string;
      /** Where that artifact will land — deterministic, so the ref can be inserted first. */
      readonly relPath: string;
    });

/**
 * Rank the index for one `@` query.
 *
 * Artifacts sort above ordinary files because `scoreFileMatch` gives them a
 * shape bonus, not because of anything here — the ranking is the shared one.
 * Paths the grammar can't express are dropped rather than offered: inserting
 * `@my notes.md` would look like it worked and then silently degrade to plain
 * text, because `parseFileRefs` would stop at the space.
 *
 * The "Create artifact" row is pinned above the matches (it is an intent, not a
 * match) and appears only when the query names a *new* artifact — a query that
 * already resolves to an existing artifact would EEXIST on selection.
 */
export function rankFileRefCompletions(input: {
  query: string;
  index: readonly IndexedFile[];
}): readonly FileRefCompletion[] {
  const { query, index } = input;
  const filterText = `@${query}`;
  const ranked = index
    .filter((file) => isExpressibleRefPath(file.relPath))
    .map((file) => ({ file, score: scoreFileMatch(query, file.relPath) }))
    .filter((entry): entry is { file: IndexedFile; score: number } => entry.score !== null)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, MAX_PICKER_RESULTS);

  const results: FileRefCompletion[] = [];

  // The created path is deterministic (artifacts dir + `.md`-forced name), which
  // is what lets the ref be inserted synchronously later and what makes this
  // full-relPath existence check possible — comparing bare names against an
  // index of relPaths never matched, so the row stayed pinned even when the
  // artifact existed and selecting it failed.
  const createdRelPath = `${VOLLI_ARTIFACTS_REL_DIR}/${withMarkdownExtension(query.trim())}`;
  if (isValidNewArtifactName(query) && !index.some((file) => file.relPath === createdRelPath)) {
    results.push({
      kind: "create",
      label: `Create artifact "${withMarkdownExtension(query.trim())}"`,
      name: query.trim(),
      relPath: createdRelPath,
      insertText: `@${createdRelPath}`,
      filterText,
      sortText: "00",
    });
  }

  results.push(
    ...ranked.map(({ file }, position): FileRefCompletion => {
      return {
        kind: "file",
        label: baseNameOf(file.relPath),
        detail: dirNameOf(file.relPath),
        relPath: file.relPath,
        artifact: file.artifact,
        insertText: `@${file.relPath}`,
        filterText,
        sortText: String(position + 1).padStart(2, "0"),
      };
    }),
  );

  return results;
}

/** A chipped `@path` token and where it sits, for the editor's click handler. */
export interface FileRefChip {
  readonly range: TextRange;
  readonly relPath: string;
}

export interface FileRefChipRender {
  readonly decorations: readonly DocumentDecoration[];
  readonly chips: readonly FileRefChip[];
}

/**
 * Chip every `@path` that resolves against the current index. A ref that does
 * not resolve stays plain text (decision #4: dangling refs degrade rather than
 * lie), which is also what a half-typed path looks like while the picker is
 * open.
 */
export function renderFileRefChips(input: {
  text: string;
  resolvedPaths: ReadonlySet<string>;
}): FileRefChipRender {
  const index = buildLineIndex(input.text);
  const decorations: DocumentDecoration[] = [];
  const chips: FileRefChip[] = [];
  for (const ref of parseFileRefs(input.text)) {
    if (!input.resolvedPaths.has(ref.path)) continue;
    const range = spanToRange(index, ref.from, ref.to);
    decorations.push({
      range,
      options: {
        inlineClassName: "volli-md-file-chip",
        inlineClassNameAffectsLetterSpacing: true,
        stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
      },
    });
    chips.push({ range, relPath: ref.path });
  }
  return { decorations, chips };
}

/** The result of creating an artifact from the picker — `api.files.createArtifact`'s shape. */
export type CreateArtifactResult = { ok: true; relPath: string } | { ok: false; error: string };

/**
 * The host-supplied hooks the `@file` layer needs. Held behind an accessor by
 * the editor (latest-callback pattern) so an index refresh or a callback
 * identity change never forces the editor to remount.
 */
export interface FileRefsConfig {
  /** The current cached project file index — chip resolution and picker ranking. */
  getIndex(): readonly IndexedFile[];
  /** Kick a cache-gated background refresh; invoked when the picker opens. */
  refreshIndex(): void;
  /** Open (or focus) a file tab for a clicked chip / freshly created artifact. */
  onOpenFile(relPath: string): void;
  /** Create a templated `.md` artifact for the "Create artifact" picker row. */
  createArtifact(name: string): Promise<CreateArtifactResult>;
}

/**
 * What to actually insert at the caret for a ref the user picked from outside
 * the editor (the composer's paperclip).
 *
 * A space is prepended when the caret is pressed up against a word, because
 * `parseFileRefs` only recognises an `@` at a ref boundary — start-of-text,
 * whitespace, or `(`. Without it the insert would look like it worked and then
 * never resolve, which is the failure mode this whole grammar is built to
 * avoid. `(` is excluded because it is already a boundary: `(@a.md)` parses.
 */
export function refInsertion(input: { precedingChar: string; text: string }): string {
  const { precedingChar } = input;
  const needsSpace = precedingChar !== "" && !/\s/.test(precedingChar) && precedingChar !== "(";
  return needsSpace ? ` ${input.text}` : input.text;
}

/**
 * Append a ref token to a body whose editor cannot be reached (VC-106).
 *
 * The counterpart of `refInsertion` for the case with no caret: a repository
 * file attached from the Files rail while the Body tab is closed. The ref goes
 * on a line of its own at the end — a newline is opened only when the body does
 * not already end on one, so a body that does never gains a blank line — and a
 * start-of-line `@` is a boundary `parseFileRefs` already recognises, so unlike
 * a space-glued inline append it can never weld the ref onto a sentence.
 */
export function appendFileRef(body: string, text: string): string {
  if (body === "") return text;
  return body.endsWith("\n") ? `${body}${text}` : `${body}\n${text}`;
}
