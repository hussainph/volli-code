/**
 * Reading a markdown message without a markdown renderer.
 *
 * The fallback in `markdown-boundary.tsx` has one job: when the renderer is the
 * thing that broke, show what the message says. Dumping the raw source into a
 * `<pre>` does not do that — it leaves the fence markers on screen, so the
 * reader sees ``` ``` ``` and a language tag wrapped around the code instead of
 * the code, and prose set in monospace as if it were a program.
 *
 * Splitting the source into fenced runs and prose runs is enough to fix both:
 * the fences become the frame around a code block rather than characters inside
 * one, and the prose goes back to being prose. This is deliberately NOT a
 * markdown parser — inline syntax is left exactly as written, because a
 * half-applied renderer is more confusing than an unapplied one, and the point
 * is to be legible rather than to be right.
 */

/** A fenced code run, or the prose between two of them. */
export interface MarkdownSegment {
  readonly kind: "code" | "prose";
  /** Segment text with the fence lines removed; never has a trailing newline. */
  readonly text: string;
  /** The fence's info string, when it named one. Prose segments have none. */
  readonly language: string | null;
  /**
   * 0-based line in the source where this segment starts. Two segments can hold
   * the same text; no two can start on the same line, which makes this the
   * React key — one that tracks a block as it grows rather than its position.
   */
  readonly line: number;
}

/** ```lang / ~~~lang — captures the run of markers and the info string. */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * Split `source` into alternating prose and fenced-code segments.
 *
 * An unterminated fence — which is every fence in a message that is still
 * streaming — closes at the end of the source, so a half-written code block
 * reads as code rather than swallowing the rest of the message as prose.
 * Segments that are empty once trimmed are dropped, so the caller can render
 * the result directly without checking for blank runs.
 */
export function splitMarkdownSource(source: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = source.split("\n");

  let prose: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  let language: string | null = null;
  let start = 0;

  const flushProse = (at: number): void => {
    const text = prose.join("\n").trim();
    if (text !== "") segments.push({ kind: "prose", text, language: null, line: start });
    prose = [];
    start = at;
  };
  const flushCode = (at: number): void => {
    // Only the trailing blank lines go: leading indentation inside a block is
    // part of the program, and stripping it would misreport the code.
    /* v8 ignore next -- both call sites only run once `code` has been set to an array; the fallback is for the closure's wider type. */
    const text = (code ?? []).join("\n").replace(/\s+$/, "");
    if (text !== "") segments.push({ kind: "code", text, language, line: start });
    code = null;
    language = null;
    start = at;
  };

  for (const [index, line] of lines.entries()) {
    const match = FENCE_RE.exec(line);
    if (code === null) {
      if (match) {
        flushProse(index);
        code = [];
        fence = match[2];
        language = match[3] === "" ? null : match[3];
      } else {
        prose.push(line);
      }
      continue;
    }
    // A closing fence is the same marker character, at least as long, alone on
    // its line. Anything else — including a shorter run — is still code.
    const closes =
      match !== null &&
      match[2][0] === fence[0] &&
      match[2].length >= fence.length &&
      match[3] === "";
    if (closes) flushCode(index + 1);
    else code.push(line);
  }

  if (code === null) flushProse(lines.length);
  else flushCode(lines.length);

  return segments;
}
