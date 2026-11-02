/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";

/**
 * The matching view of a file: CRLF and lone CR both become LF. Only matching
 * and the display diff use it; bytes written back come from the original.
 */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

/**
 * Split into lines that keep their own terminator. CRLF, LF and lone CR each
 * end one line, exactly as `normalizeToLF` maps each of them to one LF, so a
 * file and its normalized view always have the same line count.
 */
function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) ?? [];
}

function lineEndingOf(line: string): string {
  if (line.endsWith("\r\n")) return "\r\n";
  if (line.endsWith("\n")) return "\n";
  return line.endsWith("\r") ? "\r" : "";
}

/**
 * The line ending an edited region is written with: the first ending among
 * its own original lines. An unterminated last line takes the ending of the
 * line before it; a single unterminated line falls back to LF.
 */
function regionLineEnding(originalLines: string[], startLine: number, endLine: number): string {
  for (let i = startLine; i < endLine; i++) {
    const ending = lineEndingOf(originalLines[i]);
    if (ending) return ending;
  }
  return startLine > 0 ? lineEndingOf(originalLines[startLine - 1]) : "\n";
}

interface LineSpan {
  start: number;
  end: number;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * `baseContent` is an LF-only normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base with the line ending that region used
 * in the original, and all other lines, terminators included, are copied back
 * from `originalContent` unchanged. The actual replacement ranges drive
 * preservation so duplicate normalized lines cannot be aligned to the wrong
 * occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  // eslint-disable-next-line unicorn/no-array-sort -- Upstream sorts a fresh copy, leaving the caller's replacements untouched.
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");

    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    const ending = regionLineEnding(originalLines, group.startLine, group.endLine);
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    ).replaceAll("\n", ending);
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");

  return result;
}

export interface FuzzyMatchResult {
  /** Whether a match was found */
  found: boolean;
  /** The index where the match starts (in the content that should be used for replacement) */
  index: number;
  /** Length of the matched text */
  matchLength: number;
  /** Whether fuzzy matching was used (false = exact match) */
  usedFuzzyMatch: boolean;
  /**
   * The content to use for replacement operations.
   * When exact match: original content. When fuzzy match: normalized content.
   */
  contentForReplacement: string;
}

export interface Edit {
  oldText: string;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // Try fuzzy match - work entirely in normalized space
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // When fuzzy matching, return offsets in normalized space. Callers can use
  // the normalized content to compute replacements, then decide how much of
  // that normalized output should be written back.
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to file content.
 *
 * All edits are matched against the same LF-normalized view of the content.
 * If any edit needs fuzzy matching, matching runs in fuzzy-normalized content
 * space instead. Either way the line-level changes are then overlaid onto the
 * original content, so unchanged lines keep their original bytes and line
 * endings (CRLF, LF or lone CR) and edited lines keep their region's ending.
 * `newContent` is in the original's line-ending space, not the normalized one.
 */
export function applyEditsToContent(
  content: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedContent = normalizeToLF(content);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText),
  );
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const newContent = applyReplacementsPreservingUnchangedLines(
    content,
    replacementBaseContent,
    matchedEdits,
  );

  // Judged in the normalized view: an edit whose only effect would be to
  // rewrite a line ending is no change, not a reason to touch the file.
  if (normalizeToLF(newContent) === normalizedContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent: content, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
    headerOptions: Diff.FILE_HEADERS_ONLY,
  });
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  return renderDiffString(
    Diff.diffLines(oldContent, newContent),
    oldContent,
    newContent,
    contextLines,
  );
}

/**
 * How long the edit tool may spend comparing a file, and how many changed
 * lines a comparison may hold (VC-1074). jsdiff's line diff is O((N+M)·D) and
 * runs synchronously on the host's main thread: scattered changes across a
 * 20k-line file took seconds. Past either bound the edit still lands; only its
 * diff is summarized.
 */
export const EDIT_DIFF_BOUNDS: EditDiffBounds = { timeoutMs: 100, maxEditLength: 20_000 };

export interface EditDiffBounds {
  /** Wall time shared by every comparison of one edit. */
  timeoutMs: number;
  /** Most inserted plus removed lines one comparison may report. */
  maxEditLength: number;
}

export interface EditDiffInput {
  path: string;
  /** The file as read, BOM and line endings included. */
  original: string;
  /** The file as written. */
  written: string;
  /** `original` without its BOM, LF-normalized: what the display diff shows. */
  oldView: string;
  /** `written` without its BOM, LF-normalized. */
  newView: string;
}

export interface EditDiffResult {
  diff: string;
  /** Byte-faithful unified patch; absent when the comparison was bounded out. */
  patch?: string;
  firstChangedLine: number | undefined;
}

/**
 * The edit tool's display diff and patch from one bounded line diff.
 *
 * The display diff compares the LF views. When the file has neither a BOM nor
 * a CR, those views are the bytes themselves, so the same comparison also
 * yields the patch, exactly as `generateUnifiedPatch` would have written it.
 * Otherwise the patch needs its own comparison of the bytes, inside what is
 * left of the same time budget. Either comparison running out of budget
 * leaves a summary instead of a diff, and no patch.
 */
export function generateEditDiff(
  input: EditDiffInput,
  bounds: EditDiffBounds = EDIT_DIFF_BOUNDS,
): EditDiffResult {
  const deadline = Date.now() + bounds.timeoutMs;
  const parts = Diff.diffLines(input.oldView, input.newView, {
    timeout: bounds.timeoutMs,
    maxEditLength: bounds.maxEditLength,
  });
  if (parts === undefined) return boundedOutDiff(input.oldView, input.newView);
  const display = renderDiffString(parts, input.oldView, input.newView, 4);

  if (input.original === input.oldView && input.written === input.newView) {
    return { ...display, patch: unifiedPatchFromParts(input.path, parts, 4) };
  }
  const remaining = deadline - Date.now();
  const patch =
    remaining > 0
      ? Diff.createTwoFilesPatch(
          input.path,
          input.path,
          input.original,
          input.written,
          undefined,
          undefined,
          {
            context: 4,
            headerOptions: Diff.FILE_HEADERS_ONLY,
            timeout: remaining,
            maxEditLength: bounds.maxEditLength,
          },
        )
      : undefined;
  return patch === undefined ? display : { ...display, patch };
}

function boundedOutDiff(oldView: string, newView: string): EditDiffResult {
  const limit = Math.min(oldView.length, newView.length);
  let index = 0;
  while (index < limit && oldView.charCodeAt(index) === newView.charCodeAt(index)) index++;
  let line = 1;
  for (
    let at = newView.indexOf("\n");
    at !== -1 && at < index;
    at = newView.indexOf("\n", at + 1)
  ) {
    line++;
  }
  return {
    diff: "(diff omitted: the change is too large to compare)",
    firstChangedLine: line,
  };
}

/** A line diff's text as lines, each keeping its LF; the last may have none. */
function partLines(value: string): string[] {
  const lines = value.split("\n");
  const last = lines.pop()!;
  const result = lines.map((line) => `${line}\n`);
  if (last !== "") result.push(last);
  return result;
}

/**
 * The unified patch `Diff.createTwoFilesPatch` writes with `FILE_HEADERS_ONLY`
 * for the comparison `parts` describes: hunks of changed lines with up to
 * `context` unchanged lines either side, merged when the unchanged run
 * between them is at most twice that, and a no-newline marker after a final
 * line without one.
 */
function unifiedPatchFromParts(path: string, parts: Diff.ChangeObject<string>[], context: number) {
  const hunks: Diff.StructuredPatchHunk[] = [];
  let hunk: Diff.StructuredPatchHunk | undefined;
  let oldLine = 1;
  let newLine = 1;
  let previousUnchanged: string[] = [];

  const close = (trailing: string[]) => {
    hunk!.lines.push(...trailing.map((line) => ` ${line}`));
    hunk!.oldLines += trailing.length;
    hunk!.newLines += trailing.length;
    hunks.push(hunk!);
    hunk = undefined;
  };

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const lines = partLines(part.value);
    if (part.added || part.removed) {
      if (hunk === undefined) {
        const leading = previousUnchanged.slice(Math.max(0, previousUnchanged.length - context));
        hunk = {
          oldStart: oldLine - leading.length,
          oldLines: leading.length,
          newStart: newLine - leading.length,
          newLines: leading.length,
          lines: leading.map((line) => ` ${line}`),
        };
      }
      const sign = part.added ? "+" : "-";
      hunk.lines.push(...lines.map((line) => `${sign}${line}`));
      if (part.added) {
        hunk.newLines += lines.length;
        newLine += lines.length;
      } else {
        hunk.oldLines += lines.length;
        oldLine += lines.length;
      }
      continue;
    }
    if (hunk !== undefined) {
      const isLast = index === parts.length - 1;
      if (lines.length <= context * 2 && !isLast) {
        hunk.lines.push(...lines.map((line) => ` ${line}`));
        hunk.oldLines += lines.length;
        hunk.newLines += lines.length;
      } else {
        close(lines.slice(0, context));
      }
    }
    previousUnchanged = lines;
    oldLine += lines.length;
    newLine += lines.length;
  }
  if (hunk !== undefined) close([]);

  for (const each of hunks) {
    each.lines = each.lines.flatMap((line) =>
      line.endsWith("\n") ? [line.slice(0, -1)] : [line, "\\ No newline at end of file"],
    );
  }
  return Diff.formatPatch(
    { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
    Diff.FILE_HEADERS_ONLY,
  );
}

function renderDiffString(
  parts: Diff.ChangeObject<string>[],
  oldContent: string,
  newContent: string,
  contextLines: number,
): { diff: string; firstChangedLine: number | undefined } {
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      // Capture the first changed line (in the new file)
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      // Show the change
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          // removed
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines - only show a few before/after changes
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }

          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;

          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;

        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }

        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }

        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        // Skip these context lines entirely
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}
