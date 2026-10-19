import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { refusingCredentialReads } from "./credential-env";
import {
  BACKGROUND_CONTEXT,
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  NodeExecutionEnv,
  withAbortSignal,
} from "./harness-env";
import { ScopedExecutionEnv } from "./scoped-execution-env";
import type { ExecutionEnv, FileError, Result } from "./vendor/pi-harness/types";
import { formatSize, truncateHead } from "./vendor/pi-harness/utils/truncate";

/**
 * VC-801: `read` runs in the host process, so it must never read a file whole
 * before its 2,000-line / 50 KB cut, never wait on a FIFO or read a device to
 * an end that never comes, and never hand the model a binary file as text.
 */

const context = BACKGROUND_CONTEXT;
const inert = [undefined as never, context] as const;
const scratchRoot = resolve(import.meta.dirname, "../../../../.bench-tmp/vc-801-read");
let scratch: string;

beforeEach(async () => {
  await fs.mkdir(scratchRoot, { recursive: true });
  scratch = await fs.mkdtemp(join(scratchRoot, "case-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await fs.rm(scratch, { recursive: true, force: true });
});

function read(env: ExecutionEnv, path: string, offset?: number, limit?: number) {
  return createReadTool().execute("read", { path, offset, limit }, () => {}, { env }, ...inert);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

/**
 * The read tool's text path before VC-801, verbatim but for `bytes` being
 * handed in: decode it all, split it all, slice, then truncate. The streamed
 * path must answer exactly this for every input it can see whole.
 */
function wholeFileRead(bytes: Uint8Array, path: string, offset?: number, limit?: number) {
  const textContent = new TextDecoder().decode(bytes);
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  let outputText: string;
  let details: { truncation: typeof truncation } | undefined;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine]).byteLength);
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
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return { content: [{ type: "text", text: outputText }], details };
}

/** One PNG chunk: length, type and zeroed data and CRC. */
function pngChunk(type: string, length: number): Buffer {
  const data = Buffer.alloc(12 + length);
  data.writeUInt32BE(length);
  data.write(type, 4, "ascii");
  return data;
}

function failure(result: Result<unknown, FileError>, code: string) {
  expect(result).toMatchObject({ ok: false, error: { name: "FileError", code } });
}

/** Byte index where 1-indexed `line` starts. */
function lineStart(bytes: Uint8Array, line: number): number {
  let index = 0;
  for (let seen = 1; seen < line; seen++) index = bytes.indexOf(0x0a, index) + 1;
  return index;
}

/** Run `work`, sampling RSS while it yields; resolves with its result and the peak growth. */
async function peakRssGrowth<T>(work: () => Promise<T>): Promise<{ value: T; growth: number }> {
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 1);
  try {
    const value = await work();
    peak = Math.max(peak, process.memoryUsage.rss());
    return { value, growth: peak - baseline };
  } finally {
    clearInterval(sample);
  }
}

/** Write `total` bytes of `block` repeated, without holding them. */
async function writeRepeated(path: string, block: string, total: number): Promise<void> {
  const bytes = Buffer.from(block);
  const file = await fs.open(path, "w");
  try {
    for (let written = 0; written < total; written += bytes.length) await file.write(bytes);
  } finally {
    await file.close();
  }
}

describe("read streams text instead of loading the file (VC-801)", () => {
  it("returns the first 2,000 lines of a large log with its continuation hint and bounded memory", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const line = "log entry 123456789\n"; // 20 bytes: 2,000 lines fit under 50 KB
    const block = line.repeat(50_000); // 1,000,000 bytes
    const total = 128 * block.length;
    await writeRepeated(join(scratch, "big.log"), block, total);
    const { value: result, growth } = await peakRssGrowth(() => read(env, "big.log"));
    const lines = total / line.length;
    expect(text(result)).toBe(
      `${line.repeat(DEFAULT_MAX_LINES - 1)}${line.slice(0, -1)}\n\n[Showing lines 1-2000 of ${lines + 1}. Use offset=2001 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: lines,
      totalBytes: total,
      outputLines: DEFAULT_MAX_LINES,
    });
    // The whole-file read held the 128 MB buffer, a 128 M-character string and
    // its line array at once.
    expect(growth).toBeLessThan(24 * 1024 * 1024);
    const middle = await read(env, "big.log", 1_000_001, 2);
    expect(text(middle)).toBe(
      `${line}${line.slice(0, -1)}\n\n[${lines + 1 - 1_000_002} more lines in file. Use offset=1000003 to continue.]`,
    );
  }, 60_000);

  it("measures a single enormous line without holding it", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const block = "x".repeat(1024 * 1024);
    await writeRepeated(join(scratch, "minified.json"), block, 64 * block.length);
    const { value: result, growth } = await peakRssGrowth(() => read(env, "minified.json"));
    expect(text(result)).toBe(
      `[Line 1 is 64.0MB, exceeds 50.0KB limit. Use bash: sed -n '1p' minified.json | head -c ${DEFAULT_MAX_BYTES}]`,
    );
    expect(result.details?.truncation).toMatchObject({
      firstLineExceedsLimit: true,
      totalLines: 1,
      totalBytes: 64 * block.length,
    });
    expect(growth).toBeLessThan(24 * 1024 * 1024);
  }, 60_000);

  it.each([
    ["empty", ""],
    ["one newline", "\n"],
    ["blank lines", "\n\n\n"],
    ["BOM, CRLF and an unterminated tail", "\ufeffa\r\nb\r\n\r\nlast"],
    ["trailing newline", "a\nb\nc\n"],
    ["multibyte at every boundary", "é😀ab\n".repeat(30_000)],
    ["lines at the byte cut", `${"y".repeat(1023)}\n`.repeat(120)],
    ["just over the line cut", "z\n".repeat(DEFAULT_MAX_LINES + 1)],
    ["exactly the line cut", "z\n".repeat(DEFAULT_MAX_LINES - 1) + "z"],
    ["long line after short ones", `a\nb\n${"q".repeat(200_000)}\nc`],
    ["a leading BOM before a long first line", `\ufeff${"w".repeat(60_000)}\nx`],
    ["U+FF21, whose first byte is a BOM's", "\uff21 fullwidth\nx"],
    ["U+FEC0, whose first two bytes are a BOM's", "\ufec0\nx"],
    ["a BOM opening a later line", "a\n\ufeffb\nc"],
  ])("answers exactly what the whole-file read answered: %s", async (_name, content) => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "file.txt"), content);
    const bytes = new TextEncoder().encode(content);
    const lines = content.split("\n").length;
    const offsets = [undefined, 0, 1, 2, 3, Math.floor(lines / 2), lines, 2.5];
    const limits = [undefined, 0, 1, 2, 3, DEFAULT_MAX_LINES, 2.5];
    for (const offset of offsets) {
      for (const limit of limits) {
        let expected: unknown;
        try {
          expected = wholeFileRead(bytes, "file.txt", offset, limit);
        } catch (error) {
          await expect(read(env, "file.txt", offset, limit)).rejects.toThrow(
            (error as Error).message,
          );
          continue;
        }
        if (offset === 2.5) {
          // A fractional offset named `allLines[1.5]` (undefined) in the
          // first-line message; everything else is the same.
          const actual = await read(env, "file.txt", offset, limit);
          if (!actual.details?.truncation?.firstLineExceedsLimit)
            expect(actual, `offset=${offset} limit=${limit}`).toEqual(expected);
          continue;
        }
        expect(
          await read(env, "file.txt", offset, limit),
          `offset=${offset} limit=${limit}`,
        ).toEqual(expected);
      }
    }
  });

  it("answers the whole-file read for invalid UTF-8 split across chunks, counting raw bytes", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 97 === 0 ? 0x0a : index % 13 === 0 ? 0xc3 : 0x41 + (index % 26);
    }
    bytes[8191] = 0xf0; // a torn four-byte lead right at the sniff boundary
    bytes[65_535 + 8192] = 0xe2; // and one at a chunk boundary
    await fs.writeFile(join(scratch, "latin.txt"), bytes);
    for (const offset of [undefined, 10, 1500]) {
      const actual = await read(env, "latin.txt", offset);
      const expected = wholeFileRead(bytes, "latin.txt", offset);
      expect(text(actual)).toBe(text(expected));
      // Counted in the file's bytes, not in U+FFFDs: the one figure that differs.
      expect(actual.details?.truncation).toEqual({
        ...expected.details?.truncation,
        totalBytes: bytes.length - lineStart(bytes, offset ?? 1),
      });
    }
  });

  it("selects nothing for a negative limit instead of counting lines from the end", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "file.txt"), "a\nb\nc");
    expect(text(await read(env, "file.txt", 1, -1))).toBe(
      "\n\n[4 more lines in file. Use offset=0 to continue.]",
    );
    expect(text(await read(env, "file.txt", 3, -1))).toBe(
      "\n\n[2 more lines in file. Use offset=2 to continue.]",
    );
  });
});

describe("read refuses what is not a regular file at once (VC-801)", () => {
  // A FIFO or device named directly never reached the read: the path
  // resolution's `exists` already refused its file type. A symlink to one did,
  // and read it to an end that never comes.
  it("refuses /dev/zero, named directly or through a symlink, instead of reading forever", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await expect(read(env, "/dev/zero")).rejects.toMatchObject({ code: "invalid" });
    await fs.symlink("/dev/zero", join(scratch, "zeros"));
    await expect(read(env, "zeros")).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("Not a regular file"),
    });
  });

  it.each([
    ["directly", "pipe"],
    ["through a symlink", "pipe-link"],
  ])("refuses a FIFO named %s without waiting for a writer", async (_how, name) => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const fifo = join(scratch, "pipe");
    execFileSync("mkfifo", [fifo]);
    await fs.symlink(fifo, join(scratch, "pipe-link"));
    const pending = read(env, name);
    try {
      const outcome = await Promise.race([
        pending.then(
          () => "returned",
          (error: FileError) => error.code,
        ),
        new Promise((settle) => setTimeout(() => settle("still waiting"), 2_000)),
      ]);
      expect(outcome).toBe("invalid");
    } finally {
      // Whatever happened, release a reader still blocked on the open.
      await fs
        .open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
        .then((writer) => writer.close())
        .catch(() => undefined);
      await pending.catch(() => undefined);
    }
  });

  it("refuses a directory", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.mkdir(join(scratch, "dir"));
    await expect(read(env, "dir")).rejects.toMatchObject({
      code: "is_directory",
      message: "Path is a directory",
    });
  });

  it("still reads through a symlink to a regular file", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "target.txt"), "through the link");
    await fs.symlink(join(scratch, "target.txt"), join(scratch, "alias"));
    expect(text(await read(env, "alias"))).toBe("through the link");
  });
});

describe("read names a binary file instead of decoding it (VC-801)", () => {
  it("answers a file with a NUL in its first 8 KB with a binary notice", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const bytes = Buffer.alloc(20_000, 0x41);
    bytes[8191] = 0;
    await fs.writeFile(join(scratch, "data.sqlite"), bytes);
    expect(await read(env, "data.sqlite")).toEqual({
      content: [
        {
          type: "text",
          text: `[Binary file (19.5KB), not shown as text. Use bash: file data.sqlite, or xxd data.sqlite | head -c ${DEFAULT_MAX_BYTES}]`,
        },
      ],
      details: undefined,
    });
  });

  it("still decodes a file whose first NUL is past 8 KB", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const bytes = Buffer.alloc(9000, 0x41);
    bytes[8192] = 0;
    await fs.writeFile(join(scratch, "late.txt"), bytes);
    expect(await read(env, "late.txt")).toEqual(wholeFileRead(bytes, "late.txt"));
  });

  it("calls an animated PNG binary even when its acTL is past the sniffed head", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = Buffer.concat([
      signature,
      pngChunk("IHDR", 13),
      pngChunk("tEXt", 10_000),
      pngChunk("acTL", 8),
      pngChunk("IDAT", 4),
    ]);
    await fs.writeFile(join(scratch, "anim.png"), png);
    expect(text(await read(env, "anim.png"))).toBe(
      `[Binary file (${formatSize(png.length)}), not shown as text. Use bash: file anim.png, or xxd anim.png | head -c ${DEFAULT_MAX_BYTES}]`,
    );
  });
});

describe("openFileReader (VC-801)", () => {
  async function mockedEnv(files: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...fs, ...files }));
    const { NodeExecutionEnv: Env } = await import("./vendor/pi-harness/env/nodejs");
    return new Env({ cwd: scratch });
  }

  it("reads positionally, short only at end of file, and refuses use after close", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "f"), "0123456789");
    const opened = await env.openFileReader("f", context);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    expect(reader.size).toBe(10);
    expect(await reader.read(3, 4, context)).toEqual({ ok: true, value: Buffer.from("3456") });
    expect(await reader.read(8, 64, context)).toEqual({ ok: true, value: Buffer.from("89") });
    expect(await reader.read(10, 64, context)).toEqual({ ok: true, value: Buffer.alloc(0) });
    failure(await reader.read(0, -1, context), "unknown");
    await reader.close(context);
    await reader.close(context);
    failure(await reader.read(0, 1, context), "invalid");
    failure(await env.openFileReader("missing", context), "not_found");
  });

  it("honours cancellation before opening, after opening and around each read", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "f"), "data");
    const stopped = withAbortSignal(AbortSignal.abort(), context);
    failure(await env.openFileReader("f", stopped), "aborted");
    const opened = await env.openFileReader("f", context);
    if (!opened.ok) throw opened.error;
    failure(await opened.value.read(0, 4, stopped), "aborted");
    await opened.value.close(context);

    const controller = new AbortController();
    let closed = false;
    const aborting = await mockedEnv({
      open: async () => {
        controller.abort();
        return {
          close: async () => {
            closed = true;
            throw new Error("already closed");
          },
        };
      },
    });
    failure(
      await aborting.openFileReader("f", withAbortSignal(controller.signal, context)),
      "aborted",
    );
    expect(closed).toBe(true);
  });

  it("returns stat, read and close failures instead of rejecting", async () => {
    const io = Object.assign(new Error("fixture EIO"), { code: "EIO" });
    const statFails = await mockedEnv({
      open: async () => ({
        stat: async () => {
          throw io;
        },
        close: async () => undefined,
      }),
    });
    failure(await statFails.openFileReader("f", context), "unknown");

    const controller = new AbortController();
    let onRead: () => { bytesRead: number } = () => {
      throw io;
    };
    const reads = await mockedEnv({
      open: async () => ({
        stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 4 }),
        read: async () => onRead(),
        close: async () => {
          throw io;
        },
      }),
    });
    const opened = await reads.openFileReader("f", context);
    if (!opened.ok) throw opened.error;
    failure(await opened.value.read(0, 4, context), "unknown");
    onRead = () => {
      controller.abort();
      return { bytesRead: 1 };
    };
    failure(await opened.value.read(0, 4, withAbortSignal(controller.signal, context)), "aborted");
    await expect(opened.value.close(context)).resolves.toBeUndefined();
  });

  it("is guarded like readBinaryFile in the scoped environment and refused for credential files", async () => {
    await fs.writeFile(join(scratch, "inside.txt"), "inside");
    const scoped = await ScopedExecutionEnv.create(scratch);
    const opened = await scoped.openFileReader("inside.txt");
    if (!opened.ok) throw opened.error;
    expect(await opened.value.read(0, 64, context)).toEqual({
      ok: true,
      value: Buffer.from("inside"),
    });
    await opened.value.close(context);
    failure(
      await scoped.openFileReader(join(scratchRoot, "outside.txt"), context),
      "permission_denied",
    );

    await fs.writeFile(join(scratch, ".env"), "SECRET=1");
    const guarded = refusingCredentialReads(new NodeExecutionEnv({ cwd: scratch }), scratch);
    await expect(guarded.openFileReader(".env", context)).rejects.toThrow(
      "refuses credential-file reads",
    );
    await expect(read(guarded, ".env")).rejects.toThrow("refuses credential-file reads");
  });
});
