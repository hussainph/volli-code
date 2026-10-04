/** File service results, independent of any transport. */
import type { FileKind, FileSource } from "@volli/shared";
export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };
export type RevealResult = Result;
/**
 * What the create/rename/duplicate track resolves with: the project-relative
 * path the entry now has (plan §4.5). Named rather than echoed back from the
 * request because the caller does not always know it — `duplicate` derives a
 * free name in main, and the renderer opens exactly what was created.
 */
export type FileMutationResult = { ok: true; relPath: string } | { ok: false; error: string };

/**
 * A read file's content, discriminated by how the renderer must render it:
 * `text` (utf8, `truncated` when the ~1 MiB cap was hit), `image` (inline
 * `data:` URI), or `binary` (NUL-sniffed or oversize — stub + reveal only).
 */
export type FileContent =
  | { type: "text"; text: string; truncated: boolean }
  | { type: "image"; dataUrl: string }
  | { type: "binary" };

/**
 * A resolved file read — returned by `volli:file-read`. `source` says which
 * checkout it came from (drives the worktree tab badge); `size`/`mtime` are the
 * on-disk stats; `content` carries the render-ready payload.
 */
export type FileReadResult = Result<{
  source: FileSource;
  kind: FileKind;
  size: number;
  mtime: number;
  content: FileContent;
}>;

/** The post-write mtime (the renderer's fresh conflict-guard baseline) — returned by `volli:file-write`. */
export type FileWriteResult = Result<{ mtime: number }>;

/**
 * One matched line, as the Search page draws it and opens it.
 *
 * `line`/`column` are 1-based — Monaco's own numbering, so the click that opens
 * the file hands them straight to `revealLineInCenter`/`setPosition` without a
 * translation step nobody would think to test. `preview` is the matched line,
 * possibly windowed around the match (a minified bundle's single 400 KB line is
 * not a preview), and `start`/`end` are the match's offsets INSIDE that
 * preview — never into the original line, which the renderer never sees.
 */
export interface FileSearchMatch {
  line: number;
  column: number;
  preview: string;
  /** 0-based, half-open `[start, end)` offsets of the match within `preview`. */
  start: number;
  end: number;
}

/** Every match in one file, in file order — the Search page's group. */
export interface FileSearchFile {
  relPath: string;
  matches: readonly FileSearchMatch[];
}

/**
 * Which cap ended the search, if any — the honest twin of the 1 MiB read cap's
 * `truncated` flag, saying WHICH bound was hit rather than only that one was:
 *
 *  - `none`    — ripgrep ran to completion; this is everything there is.
 *  - `matches` — the match cap was reached and the search was stopped there.
 *  - `time`    — the time budget ran out; what is here is what had arrived.
 */
export type FileSearchLimit = "none" | "matches" | "time";

/**
 * A completed search — returned by `volli:search`. `matches` counts what is
 * carried in `files` (not what exists on disk, which a capped search cannot
 * know), and `limit` is why counting stopped.
 */
export type FileSearchResult = Result<{
  files: readonly FileSearchFile[];
  matches: number;
  limit: FileSearchLimit;
}>;

/**
 * A newly-created artifact's project-relative path (`.volli/artifacts/<name>.md`),
 * insertable directly as an `@ref` — returned by `volli:artifact-create`.
 */
export type ArtifactCreateResult = Result<{ relPath: string }>;
