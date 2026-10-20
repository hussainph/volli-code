import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
import {
  ok,
  type ExecutionEnv,
  type FileByteReader,
  type FileError,
  type Result,
} from "./vendor/pi-harness/types";
import { formatSize, truncateHead } from "./vendor/pi-harness/utils/truncate";

/** The length of every string `read` hands `truncateHead`: what it kept and decoded. */
const truncated = vi.hoisted(() => ({ inputs: [] as number[] }));
vi.mock("./vendor/pi-harness/utils/truncate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vendor/pi-harness/utils/truncate")>();
  return {
    ...actual,
    truncateHead: (...args: Parameters<typeof actual.truncateHead>) => {
      truncated.inputs.push(args[0].length);
      return actual.truncateHead(...args);
    },
  };
});

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

/** The streamed read's buffer, which no single read may exceed. */
const CHUNK_BYTES = 256 * 1024;
const VIRTUAL_BYTES = 500 * 1024 * 1024;

/**
 * A 500 MB file that exists only as a repeating pattern: every read is served
 * from one small block and recorded, so the test sees exactly what `read` asked
 * for without anything that size touching disk or memory.
 */
function virtualFile(pattern: string, size = VIRTUAL_BYTES) {
  const unit = Buffer.from(pattern);
  const block = Buffer.from(pattern.repeat(Math.ceil((CHUNK_BYTES * 2) / unit.length)));
  const reads: Array<{ position: number; length: number; into?: Uint8Array }> = [];
  const reader: FileByteReader = {
    size,
    async read(position, length, _context, into) {
      reads.push({ position, length, into });
      const count = Math.max(0, Math.min(length, size - position));
      const target = into ?? new Uint8Array(length);
      const start = position % unit.length;
      target.set(block.subarray(start, start + count));
      return ok(target.subarray(0, count));
    },
    async close() {},
  };
  return { reader, reads };
}

/** A real env whose `openFileReader` hands `read` the virtual file for an existing placeholder. */
async function servingVirtual(name: string, reader: FileByteReader) {
  const env = new NodeExecutionEnv({ cwd: scratch });
  await fs.writeFile(join(scratch, name), "placeholder");
  vi.spyOn(env, "openFileReader").mockResolvedValue(ok(reader));
  return env;
}

describe("read streams text instead of loading the file (VC-801)", () => {
  it("returns the first 2,000 lines of a 500 MB log with its hint, one bounded read at a time", async () => {
    const line = "log entry 123456789\n"; // 20 bytes: 2,000 lines fit under 50 KB
    const lines = VIRTUAL_BYTES / line.length;
    const { reader, reads } = virtualFile(line);
    const env = await servingVirtual("big.log", reader);
    truncated.inputs.length = 0;
    const result = await read(env, "big.log");
    expect(text(result)).toBe(
      `${line.repeat(DEFAULT_MAX_LINES - 1)}${line.slice(0, -1)}\n\n[Showing lines 1-2000 of ${lines + 1}. Use offset=2001 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: lines,
      totalBytes: VIRTUAL_BYTES,
      outputLines: DEFAULT_MAX_LINES,
    });
    // Every byte is read (the hint names the line count), but never more than
    // one chunk at a time, always into the same buffer after the sniffed head.
    expect(Math.max(...reads.map((call) => call.length))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(new Set(reads.slice(1).map((call) => call.into)).size).toBe(1);
    expect(reads.at(-1)?.position).toBe(VIRTUAL_BYTES);
    // And only the prefix the cut can show was kept and decoded.
    expect(truncated.inputs).toHaveLength(1);
    expect(truncated.inputs[0]).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 1 + CHUNK_BYTES);
  }, 120_000); // 26 M lines are scanned, slowly under coverage instrumentation

  it("reads an offset and limit from the middle of a large file", async () => {
    const line = "log entry 123456789\n";
    const size = 800_000 * line.length;
    const lines = size / line.length;
    const env = await servingVirtual("big.log", virtualFile(line, size).reader);
    const middle = await read(env, "big.log", 500_001, 2);
    expect(text(middle)).toBe(
      `${line}${line.slice(0, -1)}\n\n[${lines + 1 - 500_002} more lines in file. Use offset=500003 to continue.]`,
    );
  });

  it("measures a single 500 MB line without holding it", async () => {
    const { reader, reads } = virtualFile("x");
    const env = await servingVirtual("minified.json", reader);
    truncated.inputs.length = 0;
    const result = await read(env, "minified.json");
    expect(text(result)).toBe(
      `[Line 1 is 500.0MB, exceeds 50.0KB limit. Use bash: sed -n '1p' minified.json | head -c ${DEFAULT_MAX_BYTES}]`,
    );
    expect(result.details?.truncation).toMatchObject({
      firstLineExceedsLimit: true,
      totalLines: 1,
      totalBytes: VIRTUAL_BYTES,
    });
    expect(Math.max(...reads.map((call) => call.length))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(truncated.inputs[0]).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 1 + CHUNK_BYTES);
  }, 120_000);

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

  it("refuses a socket behind a symlink as not a regular file", async () => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    // A short directory: a socket path must fit in sun_path.
    const short = await fs.mkdtemp(join(tmpdir(), "vc801-"));
    const server = createServer();
    try {
      const socket = join(short, "s");
      await new Promise<void>((listening) => server.listen(socket, listening));
      await fs.symlink(socket, join(scratch, "socket-link"));
      await expect(read(env, "socket-link")).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("Not a regular file"),
      });
    } finally {
      await new Promise((closed) => server.close(closed));
      await fs.rm(short, { recursive: true, force: true });
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

  it.each([
    ["UTF-16LE", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]), true],
    ["UTF-16BE", Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), true],
    ["0xFF then NUL", Buffer.from([0xff, 0x00, 0x41]), false],
    ["0xFE then NUL", Buffer.from([0xfe, 0x00, 0x41]), false],
  ])("tells %s text from binary", async (_name, bytes, utf16) => {
    const env = new NodeExecutionEnv({ cwd: scratch });
    await fs.writeFile(join(scratch, "f.txt"), bytes);
    const size = formatSize(bytes.length);
    expect(text(await read(env, "f.txt"))).toBe(
      utf16
        ? `[UTF-16 text (${size}), not shown as text. Use bash: iconv -f UTF-16 -t UTF-8 f.txt | head -c ${DEFAULT_MAX_BYTES}]`
        : `[Binary file (${size}), not shown as text. Use bash: file f.txt, or xxd f.txt | head -c ${DEFAULT_MAX_BYTES}]`,
    );
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

  it("opens without a controlling terminal and judges the open descriptor", async () => {
    const flags: number[] = [];
    let closes = 0;
    let kind = { isFile: () => false, isDirectory: () => false, size: 0 };
    const swapped = await mockedEnv({
      open: async (_path: string, flag: number) => {
        flags.push(flag);
        return {
          stat: async () => kind,
          close: async () => {
            closes++;
          },
        };
      },
    });
    const refused = await swapped.openFileReader("f", context);
    failure(refused, "invalid");
    expect(refused).toMatchObject({ error: { message: expect.stringContaining("Not a regular") } });
    kind = { isFile: () => false, isDirectory: () => true, size: 0 };
    failure(await swapped.openFileReader("f", context), "is_directory");
    expect(closes).toBe(2);
    expect(flags[0]).toBe(constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);

    await fs.writeFile(join(scratch, "f"), "regular, but the open is refused");
    const denied = Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
    const unopenable = await mockedEnv({
      open: async () => {
        throw denied;
      },
    });
    failure(await unopenable.openFileReader("f", context), "permission_denied");
    const odd = await mockedEnv({
      open: async () => {
        throw new Error("no code at all");
      },
    });
    failure(await odd.openFileReader("f", context), "unknown");
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
