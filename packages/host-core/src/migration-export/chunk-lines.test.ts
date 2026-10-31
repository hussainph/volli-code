import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  PiRecordLine,
  PiRecordLineError,
  scanChunkLines,
  wholeLine,
  type PiRecordBody,
} from "./chunk-lines";

const MiB = 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-chunk-lines-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scanChunkLines", () => {
  const scan = async (content: Buffer | string, fail?: number) => {
    const path = join(root, "chunk.ndjson");
    writeFileSync(path, content);
    const lines: string[] = [];
    const scanned = await scanChunkLines(path, Buffer.byteLength(content), (index) =>
      wholeLine((text) => {
        if (index === fail) throw new Error(`line ${index}`);
        lines.push(text);
      }),
    );
    return { ...scanned, lines: scanned.lines, texts: lines };
  };

  it("hands on every line, the empty ones and the ones across blocks", async () => {
    const long = "x".repeat(2 * MiB + 3);
    const content = `a\n\n${long}\nb\n`;
    const scanned = await scan(content);
    expect(scanned).toMatchObject({
      bytes: Buffer.byteLength(content),
      sha256: sha(content),
      lines: 4,
      endsWithNewline: true,
      fault: null,
    });
    expect(scanned.texts).toEqual(["a", "", long, "b"]);
  });

  it("stops one byte past what the file should hold", async () => {
    const path = join(root, "long.ndjson");
    writeFileSync(path, "x".repeat(3 * MiB));
    const scanned = await scanChunkLines(path, MiB + 5, () => wholeLine(() => {}));
    expect(scanned.bytes).toBe(MiB + 6);
  });

  it("says when the file ends mid-line, and when it is empty", async () => {
    expect(await scan("a\nb")).toMatchObject({ lines: 1, endsWithNewline: false });
    expect(await scan("")).toMatchObject({ bytes: 0, lines: 0, endsWithNewline: false });
  });

  it("keeps the first fault and still reads, and hashes, to the end", async () => {
    const content = `a\n${"y".repeat(MiB + 5)}\nc\n`;
    const scanned = await scan(content, 2);
    expect((scanned.fault as Error).message).toBe("line 2");
    expect(scanned).toMatchObject({ sha256: sha(content), lines: 3 });
    expect(scanned.texts).toEqual(["a"]);
  });
});

const record = (body: Buffer, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    sessionId: "s",
    sourceBytes: body.length,
    ...extra,
    base64: body.toString("base64"),
  });
/** A body long enough that its line streams (over 2 MiB of base64). */
const longBody = (newlineAt?: number) => {
  const body = Buffer.alloc(2 * MiB, 0x61);
  for (let at = 0; at < body.length; at += 997) body[at] = 32 + (at % 200);
  if (newlineAt !== undefined) body[newlineAt] = 0x0a;
  body[body.length - 1] = 0x0a;
  return body;
};

/** Feeds `line` in pieces of the given sizes (cycled), as blocks of a file would arrive. */
function feed(line: string | Buffer, sizes: number[]) {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line);
  const out: { fields?: Record<string, unknown>; body?: PiRecordBody; whole?: string } = {};
  const sink = new PiRecordLine(
    (fields, body) => Object.assign(out, { fields, body }),
    (whole) => Object.assign(out, { whole }),
  );
  for (let at = 0, n = 0; at < bytes.length; n += 1) {
    const size = sizes[n % sizes.length]!;
    sink.piece(bytes.subarray(at, at + size));
    at += size;
  }
  sink.end();
  return out;
}
const kindOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof PiRecordLineError) return error.kind;
    throw error;
  }
  return "ok";
};

describe("PiRecordLine", () => {
  it("hands a line within a couple of MiB on whole", () => {
    const line = record(Buffer.from("a\n"));
    expect(feed(line, [3])).toEqual({ whole: line });
  });

  it.each([
    ["one block", [MiB * 4]],
    ["blocks", [MiB]],
    ["ragged pieces", [2 * MiB + 1, 1, 2, 3, 5, 7, 4093]],
  ])("decodes a long line's base64 as it streams, in %s", (_name, sizes) => {
    const body = longBody(5);
    const out = feed(record(body, { piFileId: "f" }), sizes);
    expect(out.fields).toEqual({ sessionId: "s", sourceBytes: body.length, piFileId: "f" });
    expect(out.body).toEqual({
      bytes: body.length,
      sha256: sha(body),
      newlines: 2,
      lastByte: 0x0a,
    });
  });

  it("takes the closing brace in a piece of its own", () => {
    const body = longBody();
    const line = record(body);
    expect(feed(line, [line.length - 1, 1]).body).toMatchObject({ bytes: body.length });
  });

  it.each<[string, () => string | Buffer, string]>([
    [
      "base64 not last",
      () => JSON.stringify({ base64: longBody().toString("base64"), sessionId: "s" }),
      "record",
    ],
    [
      "fields too long to be a Pi record's",
      () => record(longBody(), { pad: "p".repeat(70 * 1024) }),
      "record",
    ],
    ["fields that are not JSON", () => `{"sessionId":,${record(longBody()).slice(1)}`, "json"],
    [
      "a second base64 field",
      () => `{"base64":"","sessionId":"s",${record(longBody()).slice(1)}`,
      "record",
    ],
    ["an unterminated string", () => record(longBody()).slice(0, -2), "record"],
    ["no closing brace", () => record(longBody()).slice(0, -1), "record"],
    ["something after the record", () => `${record(longBody())} `, "record"],
    ["a character base64 does not have", () => record(longBody()).replace(/A/u, "*"), "base64"],
    [
      "padding inside the string",
      () => {
        const line = record(longBody());
        const at = line.indexOf('"base64":"') + 20;
        return `${line.slice(0, at)}==${line.slice(at + 2)}`;
      },
      "base64",
    ],
    [
      "a length that is not whole groups",
      () => record(longBody()).replace(/"\}$/u, 'Q"}'),
      "base64",
    ],
    [
      "padding bits that are not zero",
      () => record(Buffer.concat([longBody(), Buffer.from("AB")])).replace(/Qg=="\}$/u, 'Qh=="}'),
      "base64",
    ],
  ])("refuses a long line with %s", (_name, line, kind) => {
    expect(kindOf(() => feed(line(), [MiB]))).toBe(kind);
    expect(kindOf(() => feed(line(), [2 * MiB + 1, 3, 1]))).toBe(kind);
  });
});
