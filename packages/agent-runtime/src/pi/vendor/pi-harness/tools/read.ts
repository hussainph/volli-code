import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { Context } from "../context";
import type { AgentHarnessTool, FileByteReader } from "../types";
import { getOrThrow } from "../types";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
  utf8ByteLength,
} from "../utils/truncate";
import { detectSupportedImageMimeType, encodeBase64 } from "./image";
import { resolveReadToolPath } from "./path-utils";
import type { ExecutionToolContext } from "./tool-context";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

export type ReadImageProcessorResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string };

export type ReadImageProcessor = (
  bytes: Uint8Array,
  mimeType: string,
  options: { autoResizeImages: boolean },
  context: Context,
) => Promise<ReadImageProcessorResult>;

export interface ReadToolOptions {
  /** Whether an injected image processor should resize images. Default: true. */
  autoResizeImages?: boolean;
  /** Optional image conversion/resizing implementation. */
  imageProcessor?: ReadImageProcessor;
}

export function createReadTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
  options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readSchema, ReadToolDetails | undefined> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, _onUpdate, { env }, _invocation, context) {
      const absolutePath = await resolveReadToolPath(env, path, context);
      // Never the whole file up front (VC-801): this runs in the host process,
      // so a 300 MB log, /dev/zero or a FIFO must not be read to its end first.
      const reader = getOrThrow(await env.openFileReader(absolutePath, context));
      try {
        const head = getOrThrow(await reader.read(0, SNIFF_BYTES, context));
        if (detectSupportedImageMimeType(head)) {
          const bytes = getOrThrow(
            await reader.read(0, Math.max(reader.size, head.length), context),
          );
          const image = await readImage(bytes, options, context);
          if (image) return image;
        }
        if (head.includes(0)) {
          const utf16 =
            (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
          const text = utf16
            ? `[UTF-16 text (${formatSize(reader.size)}), not shown as text. Use bash: iconv -f UTF-16 -t UTF-8 ${path} | head -c ${DEFAULT_MAX_BYTES}]`
            : `[Binary file (${formatSize(reader.size)}), not shown as text. Use bash: file ${path}, or xxd ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
          return { content: [{ type: "text", text }], details: undefined };
        }
        return await readText(reader, head, { path, offset, limit }, context);
      } finally {
        await reader.close(context);
      }
    },
  };
}

/** How much of a file is judged for an image signature and for NUL bytes (VC-801). */
const SNIFF_BYTES = 8 * 1024;
/** How much of a text file one streamed read takes (VC-801). */
const CHUNK_BYTES = 256 * 1024;

/** How many LF bytes `bytes` holds. */
function countLf(bytes: Uint8Array): number {
  let count = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) count++;
  return count;
}

type ReadToolResult = {
  content: Array<TextContent | ImageContent>;
  details: ReadToolDetails | undefined;
};

/** The image path, unchanged: the whole file, as it always was, once its signature says image. */
async function readImage(
  bytes: Uint8Array,
  options: ReadToolOptions | undefined,
  context: Context,
): Promise<ReadToolResult | undefined> {
  const mimeType = detectSupportedImageMimeType(bytes);
  if (!mimeType) return undefined;
  if (options?.imageProcessor) {
    const processed = await options.imageProcessor(
      bytes,
      mimeType,
      { autoResizeImages: options.autoResizeImages ?? true },
      context,
    );
    if (!processed.ok) {
      return {
        content: [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }],
        details: undefined,
      };
    }
    const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
    return {
      content: [
        { type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
        { type: "image", data: processed.data, mimeType: processed.mimeType },
      ] satisfies Array<TextContent | ImageContent>,
      details: undefined,
    };
  }
  if (mimeType === "image/bmp") {
    return {
      content: [
        {
          type: "text",
          text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
        },
      ],
      details: undefined,
    };
  }
  return {
    content: [
      { type: "text", text: `Read image file [${mimeType}]` },
      { type: "image", data: encodeBase64(bytes), mimeType },
    ] satisfies Array<TextContent | ImageContent>,
    details: undefined,
  };
}

/**
 * A text file streamed from its first byte (VC-801), giving what decoding the
 * whole file, splitting it on LF and slicing out the requested lines gave,
 * without holding more than the cut and one chunk.
 *
 * Every byte is still read, because the continuation hint names the file's line
 * count, but only bytes: lines are found by their LF byte, which UTF-8 never
 * uses inside a character and the decoder never swallows. Only what the cut can
 * show is decoded. Keeping stops once the kept prefix of the selection is past
 * both limits (more than `DEFAULT_MAX_BYTES + 1` bytes or more than
 * `DEFAULT_MAX_LINES` newlines): `truncateHead` judges that prefix exactly as it
 * judges the whole selection, and only its totals are replaced. Those totals,
 * and the size of an oversized first line, are counted in the file's own bytes,
 * less a leading BOM the decoder drops: the same number for valid UTF-8, where
 * decoding everything counted each invalid byte as a 3-byte U+FFFD.
 */
async function readText(
  reader: FileByteReader,
  head: Uint8Array,
  { path, offset, limit }: ReadToolInput,
  context: Context,
): Promise<ReadToolResult> {
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  // The selection is lines [first, end), as Array.prototype.slice truncated
  // them. A negative end selects nothing.
  const first = Math.trunc(startLine);
  const end = limit === undefined ? Infinity : Math.trunc(startLine + limit);
  const bom =
    first === 0 && end > 0 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;

  // Only the file's own first BOM is dropped; one opening a later line is text.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: first > 0 });
  let lineIndex = 0;
  let newlines = 0;
  let selectedBytes = -bom;
  let selectionEndsWithNewline = false;
  let firstLineBytes = -bom;
  let firstLineOpen = true;
  const kept: string[] = [];
  let keeping = true;
  let keptBytes = 0;
  let keptNewlines = 0;

  const consume = (bytes: Uint8Array): void => {
    let selectionStart = lineIndex >= first && lineIndex < end ? 0 : -1;
    let selectionEnd = bytes.length;
    for (
      let newline = bytes.indexOf(0x0a);
      newline !== -1;
      newline = bytes.indexOf(0x0a, newline + 1)
    ) {
      newlines++;
      lineIndex++;
      if (lineIndex === first && first < end) selectionStart = newline + 1;
      else if (lineIndex === end && selectionStart !== -1) selectionEnd = newline;
    }
    if (selectionStart === -1 || selectionStart >= selectionEnd) return;
    const selected = bytes.subarray(selectionStart, selectionEnd);
    selectedBytes += selected.length;
    selectionEndsWithNewline = selected[selected.length - 1] === 0x0a;
    if (firstLineOpen) {
      const firstNewline = selected.indexOf(0x0a);
      firstLineOpen = firstNewline === -1;
      firstLineBytes += firstLineOpen ? selected.length : firstNewline;
    }
    if (keeping) {
      const text = decoder.decode(selected, { stream: true });
      kept.push(text);
      keptBytes += utf8ByteLength(text);
      keptNewlines += countLf(selected);
      keeping = keptBytes <= DEFAULT_MAX_BYTES + 1 && keptNewlines <= DEFAULT_MAX_LINES;
    }
  };

  // One buffer for every chunk: a fresh one per read would pile up as external
  // memory between collections, which is the growth this exists to avoid.
  const buffer = new Uint8Array(CHUNK_BYTES);
  let chunk = head;
  let position = 0;
  while (chunk.length > 0) {
    consume(chunk);
    position += chunk.length;
    chunk = getOrThrow(await reader.read(position, CHUNK_BYTES, context, buffer));
  }
  // A torn final character decodes as U+FFFD, as it did when the whole file was decoded.
  if (keeping) kept.push(decoder.decode());

  const totalFileLines = newlines + 1;
  if (startLine >= totalFileLines) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
  }
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, totalFileLines);
    userLimitedLines = endLine - startLine;
  }

  const selectedLines = Math.max(0, Math.min(end, totalFileLines) - first);
  const truncation: TruncationResult = {
    ...truncateHead(kept.join("")),
    totalLines: selectedBytes === 0 ? 0 : selectedLines - (selectionEndsWithNewline ? 1 : 0),
    totalBytes: selectedBytes,
  };
  let outputText: string;
  let details: ReadToolDetails | undefined;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(firstLineBytes);
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
    const remaining = totalFileLines - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }

  return { content: [{ type: "text", text: outputText }], details };
}
