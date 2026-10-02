import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type Context,
  type ShellOutputView,
  withAbortSignal,
} from "./harness-env";
import { createReadImageProcessor } from "./read-image-processor";
import type { BashExecution, ExecutionToolContext } from "./vendor/pi-harness/tools";
import { ok, err } from "./vendor/pi-harness/types";
import { withFileMutationQueue } from "./vendor/pi-harness/tools/file-mutation-queue";
import { detectSupportedImageMimeType, encodeBase64 } from "./vendor/pi-harness/tools/image";
import { resolveReadToolPath, resolveToolPath } from "./vendor/pi-harness/tools/path-utils";

const directories: string[] = [];
const environments: NodeExecutionEnv[] = [];
const scratch = resolve(import.meta.dirname, "../../../../.bench-tmp/pi-migration-vc496");
const inert = [undefined as never, BACKGROUND_CONTEXT] as const;

async function workspace(): Promise<NodeExecutionEnv> {
  await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(join(scratch, "tools-followup-files-"));
  directories.push(cwd);
  const env = new NodeExecutionEnv({ cwd });
  environments.push(env);
  // NodeExecutionEnv normally spills under the system tmpdir. Keep every byte
  // this suite creates in its own workspace directory, including shell spills.
  let spill = 0;
  vi.spyOn(env, "createTempFile").mockImplementation(async (options) => {
    const path = join(cwd, `${options?.prefix ?? ""}${spill++}${options?.suffix ?? ""}`);
    await writeFile(path, "");
    return ok(path);
  });
  return env;
}

afterEach(async () => {
  await Promise.all(environments.splice(0).map((env) => env.cleanup(BACKGROUND_CONTEXT)));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  expect(result.content[0]?.type).toBe("text");
  return result.content[0]?.text ?? "";
}

function png(
  ...chunks: Array<{ type: string; bytes?: number; declaredBytes?: number }>
): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    ...[{ type: "IHDR", bytes: 13 }, ...chunks].map((chunk) => {
      const data = Buffer.alloc(12 + (chunk.bytes ?? 0));
      data.writeUInt32BE(chunk.declaredBytes ?? chunk.bytes ?? 0);
      data.write(chunk.type, 4, "ascii");
      return data;
    }),
  ]);
}

function bmp(
  options: {
    length?: number;
    size?: number;
    offset?: number;
    dib?: number;
    planes?: number;
    bpp?: number;
  } = {},
): Uint8Array {
  const dib = options.dib ?? 40;
  const data = Buffer.alloc(options.length ?? 64);
  data.write("BM");
  data.writeUInt32LE(options.size ?? 100, 2);
  data.writeUInt32LE(options.offset ?? 14 + dib, 10);
  data.writeUInt32LE(dib, 14);
  if (data.length >= (dib === 12 ? 26 : 30)) {
    data.writeUInt16LE(options.planes ?? 1, dib === 12 ? 22 : 26);
    data.writeUInt16LE(options.bpp ?? 24, dib === 12 ? 24 : 28);
  }
  return data;
}

describe("vendored image sniffing and encoding", () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xf7]), undefined],
    [Buffer.from("GIF87a"), "image/gif"],
    [Buffer.from("GIF89a"), "image/gif"],
    [Buffer.from("RIFFxxxxWEBP"), "image/webp"],
    [Buffer.from("RIFFxxxxNOPE"), undefined],
    [Buffer.from("RIFF"), undefined],
    [Buffer.from("ordinary UTF-8 text"), undefined],
    [Buffer.alloc(0), undefined],
    [Buffer.from("BM"), undefined],
  ])("recognizes only supported signatures (%j)", (bytes, expected) => {
    expect(detectSupportedImageMimeType(bytes)).toBe(expected);
  });

  it("requires PNG IHDR and excludes APNG only when animation precedes pixel data", () => {
    const valid = png({ type: "IDAT" });
    expect(detectSupportedImageMimeType(valid)).toBe("image/png");
    expect(detectSupportedImageMimeType(valid.slice(0, 8))).toBeUndefined();
    const wrongLength = Buffer.from(valid);
    wrongLength.writeUInt32BE(12, 8);
    expect(detectSupportedImageMimeType(wrongLength)).toBeUndefined();
    const wrongHeader = Buffer.from(valid);
    wrongHeader.write("JUNK", 12);
    expect(detectSupportedImageMimeType(wrongHeader)).toBeUndefined();
    expect(
      detectSupportedImageMimeType(png({ type: "acTL", bytes: 8 }, { type: "IDAT" })),
    ).toBeUndefined();
    expect(detectSupportedImageMimeType(png({ type: "IDAT" }, { type: "acTL", bytes: 8 }))).toBe(
      "image/png",
    );
    expect(detectSupportedImageMimeType(png())).toBe("image/png");
    expect(detectSupportedImageMimeType(png({ type: "JUNK", declaredBytes: 0x1000000 }))).toBe(
      "image/png",
    );
  });

  it.each([
    [{ dib: 12, offset: 26 }, "image/bmp"],
    [{ dib: 40, size: 0 }, "image/bmp"],
    [{ dib: 124, offset: 138, size: 0x1000000 }, "image/bmp"],
    [{ length: 25 }, undefined],
    [{ size: 25 }, undefined],
    [{ offset: 53 }, undefined],
    [{ size: 54, offset: 54 }, undefined],
    [{ dib: 13, offset: 27 }, undefined],
    [{ dib: 125, offset: 139, size: 200 }, undefined],
    [{ length: 26 }, undefined],
    [{ planes: 2 }, undefined],
    [{ bpp: 2 }, undefined],
  ] as const)("checks BMP bounds, headers and pixel format: %j", (options, expected) => {
    expect(detectSupportedImageMimeType(bmp(options))).toBe(expected);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 257])(
    "base64 encodes %i bytes with correct tail padding",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 47 + 255) % 256);
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(bytes));
    },
  );
});

describe("vendored read contracts", () => {
  it("reads UTF-8, clamps nonpositive offsets and reports limit continuation and EOF", async () => {
    const env = await workspace();
    await writeFile(join(env.cwd, "note.txt"), "\ufefffirst\nβeta\nlast");
    const read = createReadTool();
    for (const offset of [undefined, 0, -3]) {
      expect(
        await read.execute("read", { path: "note.txt", offset }, () => {}, { env }, ...inert),
      ).toEqual({ content: [{ type: "text", text: "first\nβeta\nlast" }], details: undefined });
    }
    expect(
      text(
        await read.execute(
          "read",
          { path: "note.txt", offset: 2, limit: 1 },
          () => {},
          { env },
          ...inert,
        ),
      ),
    ).toBe("βeta\n\n[1 more lines in file. Use offset=3 to continue.]");
    expect(
      text(
        await read.execute(
          "read",
          { path: "note.txt", offset: 3, limit: 99 },
          () => {},
          { env },
          ...inert,
        ),
      ),
    ).toBe("last");
    expect(
      text(await read.execute("read", { path: "note.txt", limit: 0 }, () => {}, { env }, ...inert)),
    ).toBe("\n\n[3 more lines in file. Use offset=1 to continue.]");
    await expect(
      read.execute("read", { path: "note.txt", offset: 4 }, () => {}, { env }, ...inert),
    ).rejects.toThrow("Offset 4 is beyond end of file (3 lines total)");
    await writeFile(join(env.cwd, "empty"), "");
    expect(text(await read.execute("read", { path: "empty" }, () => {}, { env }, ...inert))).toBe(
      "",
    );
  });

  it("truncates by lines with resumable offsets and returns remaining file bytes", async () => {
    const env = await workspace();
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 3 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(env.cwd, "large.txt"), lines.join("\n"));
    const read = createReadTool();
    const result = await read.execute("read", { path: "large.txt" }, () => {}, { env }, ...inert);
    expect(text(result)).toBe(
      `${lines.slice(0, DEFAULT_MAX_LINES).join("\n")}\n\n[Showing lines 1-2000 of 2003. Use offset=2001 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      outputLines: 2000,
      totalLines: 2003,
    });
    expect(
      text(
        await read.execute(
          "read",
          { path: "large.txt", offset: 2001 },
          () => {},
          { env },
          ...inert,
        ),
      ),
    ).toBe(lines.slice(2000).join("\n"));
  });

  it("truncates at complete UTF-8 lines by bytes and diagnoses a too-large first line", async () => {
    const env = await workspace();
    const line = "é".repeat(600);
    const lines = Array.from({ length: 100 }, () => line);
    await writeFile(join(env.cwd, "bytes.txt"), lines.join("\n"));
    const result = await createReadTool().execute(
      "read",
      { path: "bytes.txt", offset: 2 },
      () => {},
      { env },
      ...inert,
    );
    const count = result.details?.truncation?.outputLines;
    expect(count).toBe(42);
    expect(text(result)).toBe(
      `${lines.slice(1, 43).join("\n")}\n\n[Showing lines 2-43 of 100 (50.0KB limit). Use offset=44 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
      outputBytes: 50441,
    });
    await writeFile(join(env.cwd, "huge.txt"), `ok\n${"x".repeat(DEFAULT_MAX_BYTES + 1)}`);
    const huge = await createReadTool().execute(
      "read",
      { path: "huge.txt", offset: 2 },
      () => {},
      { env },
      ...inert,
    );
    expect(text(huge)).toBe(
      "[Line 2 is 50.0KB, exceeds 50.0KB limit. Use bash: sed -n '2p' huge.txt | head -c 51200]",
    );
    expect(huge.details?.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it("propagates read failures and the exact cancellation context", async () => {
    const env = await workspace();
    const read = createReadTool();
    await expect(
      read.execute("read", { path: "missing.txt" }, () => {}, { env }, ...inert),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      read.execute("read", { path: null as unknown as string }, () => {}, { env }, ...inert),
    ).rejects.toThrow(TypeError);
    const failure = new FileError("permission_denied", "binary denied");
    const binary = vi.spyOn(env, "readBinaryFile").mockResolvedValue(err(failure));
    await expect(
      read.execute("read", { path: "note.txt" }, () => {}, { env }, ...inert),
    ).rejects.toBe(failure);
    expect(binary.mock.calls[0]?.[1]).toBe(BACKGROUND_CONTEXT);
    binary.mockRestore();
    const context = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
    await expect(
      read.execute("read", { path: "note.txt" }, () => {}, { env }, undefined as never, context),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("returns raw supported images and omits unconverted BMP", async () => {
    const env = await workspace();
    for (const [bytes, mimeType] of [
      [png(), "image/png"],
      [Buffer.from("GIF89a"), "image/gif"],
      [Buffer.from("RIFFxxxxWEBP"), "image/webp"],
    ] as const) {
      await writeFile(join(env.cwd, "image.bin"), bytes);
      expect(
        await createReadTool().execute("read", { path: "image.bin" }, () => {}, { env }, ...inert),
      ).toEqual({
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
        ],
        details: undefined,
      });
    }
    await writeFile(join(env.cwd, "image.bmp"), bmp());
    expect(
      await createReadTool().execute("read", { path: "image.bmp" }, () => {}, { env }, ...inert),
    ).toEqual({
      content: [
        {
          type: "text",
          text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
        },
      ],
      details: undefined,
    });
  });

  it("forwards bytes, MIME, resize preference and context to the image processor", async () => {
    const env = await workspace();
    const source = bmp();
    await writeFile(join(env.cwd, "image.bmp"), source);
    const processor = vi.fn(async () => ({
      ok: true as const,
      mimeType: "image/png",
      data: "cGl4ZWxz",
      hints: ["converted", "resized"],
    }));
    const context = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
    const result = await createReadTool({
      imageProcessor: processor,
      autoResizeImages: false,
    }).execute("read", { path: "image.bmp" }, () => {}, { env }, undefined as never, context);
    expect(processor).toHaveBeenCalledWith(
      source,
      "image/bmp",
      { autoResizeImages: false },
      context,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "Read image file [image/png]\nconverted\nresized" },
        { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
      ],
      details: undefined,
    });
    const noHints = vi.fn(async () => ({
      ok: true as const,
      mimeType: "image/png",
      data: "cGl4ZWxz",
      hints: [],
    }));
    expect(
      text(
        await createReadTool({ imageProcessor: noHints }).execute(
          "read",
          { path: "image.bmp" },
          () => {},
          { env },
          ...inert,
        ),
      ),
    ).toBe("Read image file [image/png]");
    expect(noHints).toHaveBeenCalledWith(
      source,
      "image/bmp",
      { autoResizeImages: true },
      BACKGROUND_CONTEXT,
    );
  });

  it("omits failed conversions and propagates processor exceptions without fake image parts", async () => {
    const env = await workspace();
    await writeFile(join(env.cwd, "image.png"), png());
    const failed = createReadTool({
      imageProcessor: async () => ({ ok: false, message: "decode failed" }),
    });
    expect(
      await failed.execute("read", { path: "image.png" }, () => {}, { env }, ...inert),
    ).toEqual({
      content: [{ type: "text", text: "Read image file [image/png]\ndecode failed" }],
      details: undefined,
    });
    const failure = new Error("processor crashed");
    const throwing = createReadTool({
      imageProcessor: async () => {
        throw failure;
      },
    });
    await expect(
      throwing.execute("read", { path: "image.png" }, () => {}, { env }, ...inert),
    ).rejects.toBe(failure);
    const decoder = createReadTool({ imageProcessor: createReadImageProcessor() });
    expect(
      text(await decoder.execute("read", { path: "image.png" }, () => {}, { env }, ...inert)),
    ).toContain("[Image omitted: could not make a provider-safe copy.]");
  });

  it("returns a decodable resized image with coordinate hints, leaving source bytes intact", async () => {
    const env = await workspace();
    const source = await sharp({
      create: { width: 120, height: 60, channels: 3, background: "#abcdef" },
    })
      .png()
      .toBuffer();
    await writeFile(join(env.cwd, "shot.png"), source);
    const result = await createReadTool({
      imageProcessor: createReadImageProcessor({ maxEdgePx: 40 }),
    }).execute("read", { path: "shot.png" }, () => {}, { env }, ...inert);
    const image = result.content.find((part) => part.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("missing resized image");
    expect(image.mimeType).toBe("image/jpeg");
    expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
      width: 40,
      height: 20,
      format: "jpeg",
    });
    expect(text(result)).toContain(
      "original 120x60, displayed at 40x20. Multiply coordinates by 3.00",
    );
    expect(await readFile(join(env.cwd, "shot.png"))).toEqual(source);
  });
});

describe("vendored edit tool input and filesystem safety", () => {
  it("prepares JSON, object and legacy edits without discarding existing replacements", () => {
    const prepare = createEditTool().prepareArguments;
    if (!prepare) throw new Error("edit must normalize provider arguments");
    const replacement = { oldText: "old", newText: "new" };
    for (const edits of [JSON.stringify([replacement]), JSON.stringify(replacement), replacement]) {
      expect(prepare({ path: "file.txt", edits })).toEqual({
        path: "file.txt",
        edits: [replacement],
      });
    }
    expect(
      prepare({ path: "file.txt", edits: [replacement], oldText: "last", newText: "final" }),
    ).toEqual({ path: "file.txt", edits: [replacement, { oldText: "last", newText: "final" }] });
    expect(prepare({ path: "file.txt", oldText: "old", newText: "new" })).toEqual({
      path: "file.txt",
      edits: [replacement],
    });
    for (const input of [
      null,
      7,
      "raw",
      { edits: "not JSON" },
      { edits: "7" },
      { edits: "null" },
      { edits: "[]" },
      { edits: [replacement], oldText: 7, newText: "new" },
      { edits: '{"oldText":"old"}' },
    ]) {
      const expected =
        typeof input === "object" && input !== null && input.edits === "[]" ? { edits: [] } : input;
      expect(prepare(input)).toEqual(expected);
    }
    for (const edits of [
      [],
      null,
      0,
      { oldText: 1, newText: "new" },
      { oldText: "old", newText: 1 },
    ]) {
      expect(prepare({ edits })).toEqual({ edits });
    }
  });

  it("rejects malformed edit collections and unsafe multi-edits before any bytes change", async () => {
    const env = await workspace();
    const source = "alpha\nbeta\nsame same\n";
    await writeFile(join(env.cwd, "file.txt"), source);
    const edit = createEditTool();
    for (const edits of [undefined, [], { oldText: "alpha", newText: "changed" }]) {
      await expect(
        edit.execute(
          "edit",
          { path: "file.txt", edits: edits as never },
          () => {},
          { env },
          ...inert,
        ),
      ).rejects.toThrow("edits must contain at least one replacement");
    }
    for (const [edits, message] of [
      [
        [
          { oldText: "alpha", newText: "changed" },
          { oldText: "missing", newText: "X" },
        ],
        "Could not find edits[1]",
      ],
      [
        [
          { oldText: "alpha", newText: "changed" },
          { oldText: "same", newText: "X" },
        ],
        "Found 2 occurrences",
      ],
      [
        [
          { oldText: "alpha\nbeta", newText: "changed" },
          { oldText: "beta", newText: "X" },
        ],
        "overlap",
      ],
    ] as const) {
      await expect(
        edit.execute("edit", { path: "file.txt", edits: [...edits] }, () => {}, { env }, ...inert),
      ).rejects.toThrow(message);
      expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe(source);
    }
  });

  it("writes only touched fuzzy lines while retaining BOM, CRLF, and untouched Unicode bytes", async () => {
    const env = await workspace();
    await writeFile(
      join(env.cwd, "file.txt"),
      "\ufeff‘keep’  \r\n‘alpha’ and ‘beta’  \r\n‘tail’\t\r\n",
    );
    const result = await createEditTool().execute(
      "edit",
      {
        path: "file.txt",
        edits: [
          { oldText: "'beta'", newText: "B" },
          { oldText: "'alpha'", newText: "A" },
        ],
      },
      () => {},
      { env },
      ...inert,
    );
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe(
      "\ufeff‘keep’  \r\nA and B\r\n‘tail’\t\r\n",
    );
    expect(result.details).toMatchObject({
      firstChangedLine: 2,
      diff: expect.stringContaining("+2 A and B"),
      patch: expect.stringContaining("-‘alpha’ and ‘beta’  \n+A and B\n"),
    });
  });

  it.each(["fileInfo", "readTextFile", "writeFile"] as const)(
    "retains typed %s failure as an edit error cause",
    async (method) => {
      const env = await workspace();
      await writeFile(join(env.cwd, "file.txt"), "original");
      const failure = new FileError(
        "permission_denied",
        `${method} denied`,
        join(env.cwd, "file.txt"),
      );
      vi.spyOn(env, method).mockResolvedValue({ ok: false, error: failure });
      await expect(
        createEditTool().execute(
          "edit",
          { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] },
          () => {},
          { env },
          ...inert,
        ),
      ).rejects.toMatchObject({
        message: "Could not edit file: file.txt. Error code: permission_denied.",
        cause: failure,
      });
      expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("original");
    },
  );

  it("refuses directories and edits symlink targets without replacing the symlink", async () => {
    const env = await workspace();
    await mkdir(join(env.cwd, "dir"));
    const edit = createEditTool();
    await expect(
      edit.execute(
        "edit",
        { path: "dir", edits: [{ oldText: "a", newText: "b" }] },
        () => {},
        { env },
        ...inert,
      ),
    ).rejects.toThrow("Path is not a file");
    await writeFile(join(env.cwd, "file.txt"), "original");
    await symlink(join(env.cwd, "file.txt"), join(env.cwd, "alias"));
    await edit.execute(
      "edit",
      { path: "alias", edits: [{ oldText: "original", newText: "changed" }] },
      () => {},
      { env },
      ...inert,
    );
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("changed");
    expect(await env.fileInfo("alias", BACKGROUND_CONTEXT)).toMatchObject({
      ok: true,
      value: { kind: "symlink" },
    });
  });

  it.each(["before-read", "after-read", "after-write"] as const)(
    "checks cancellation %s",
    async (stage) => {
      const env = await workspace();
      await writeFile(join(env.cwd, "file.txt"), "original");
      const controller = new AbortController();
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      if (stage === "before-read") {
        const canonical = env.canonicalPath.bind(env);
        vi.spyOn(env, "canonicalPath").mockImplementation(async (...args) => {
          const result = await canonical(...args);
          controller.abort();
          return result;
        });
      } else if (stage === "after-read") {
        const read = env.readTextFile.bind(env);
        vi.spyOn(env, "readTextFile").mockImplementation(async (...args) => {
          const result = await read(...args);
          controller.abort();
          return result;
        });
      } else if (stage === "after-write") {
        const write = env.writeFile.bind(env);
        vi.spyOn(env, "writeFile").mockImplementation(async (...args) => {
          const result = await write(...args);
          controller.abort();
          return result;
        });
      }
      await expect(
        createEditTool().execute(
          "edit",
          { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] },
          () => {},
          { env },
          undefined as never,
          context,
        ),
      ).rejects.toThrow("Operation aborted");
      expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe(
        stage === "after-write" ? "changed" : "original",
      );
    },
  );
});

describe("vendored write and mutation queue", () => {
  it("propagates write failures unchanged and checks cancellation before and after writing", async () => {
    const env = await workspace();
    await writeFile(join(env.cwd, "file.txt"), "original");
    const write = createWriteTool();
    const failure = new FileError("permission_denied", "write denied");
    const spy = vi.spyOn(env, "writeFile").mockResolvedValue(err(failure));
    await expect(
      write.execute("write", { path: "file.txt", content: "changed" }, () => {}, { env }, ...inert),
    ).rejects.toBe(failure);
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("original");
    spy.mockRestore();
    const controller = new AbortController();
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    const actualWrite = env.writeFile.bind(env);
    vi.spyOn(env, "writeFile").mockImplementation(async (...args) => {
      const result = await actualWrite(...args);
      controller.abort();
      return result;
    });
    await expect(
      write.execute(
        "write",
        { path: "file.txt", content: "changed" },
        () => {},
        { env },
        undefined as never,
        context,
      ),
    ).rejects.toThrow("Operation aborted");
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("changed");
    vi.restoreAllMocks();
    const canonical = env.canonicalPath.bind(env);
    const cancelled = new AbortController();
    vi.spyOn(env, "canonicalPath").mockImplementation(async (...args) => {
      const result = await canonical(...args);
      cancelled.abort();
      return result;
    });
    await expect(
      write.execute(
        "write",
        { path: "file.txt", content: "should not write" },
        () => {},
        { env },
        undefined as never,
        withAbortSignal(cancelled.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow("Operation aborted");
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("changed");
  });

  it.each(["not_found", "not_supported"] as const)(
    "queues addressed paths when canonicalization is %s",
    async (code) => {
      const env = await workspace();
      vi.spyOn(env, "canonicalPath").mockResolvedValue(
        err(new FileError(code, "no canonical identity")),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const order: string[] = [];
      const first = withFileMutationQueue(
        env,
        "file.txt",
        async () => {
          order.push("first");
          entered.resolve();
          await release.promise;
          order.push("released");
          return 1;
        },
        BACKGROUND_CONTEXT,
      );
      await entered.promise;
      const second = withFileMutationQueue(
        env,
        "file.txt",
        async () => {
          order.push("second");
          return 2;
        },
        BACKGROUND_CONTEXT,
      );
      // An independent file is not held by file.txt's active mutation.
      expect(await withFileMutationQueue(env, "other.txt", async () => 3, BACKGROUND_CONTEXT)).toBe(
        3,
      );
      expect(order).toEqual(["first"]);
      release.resolve();
      expect(await Promise.all([first, second])).toEqual([1, 2]);
      expect(order).toEqual(["first", "released", "second"]);
    },
  );

  it("rejects canonical/absolute path errors without calling a mutation and recovers registration", async () => {
    const env = await workspace();
    const mutation = vi.fn(async () => "mutated");
    const failure = new FileError("permission_denied", "canonical denied");
    vi.spyOn(env, "canonicalPath").mockResolvedValueOnce(err(failure));
    await expect(withFileMutationQueue(env, "file.txt", mutation, BACKGROUND_CONTEXT)).rejects.toBe(
      failure,
    );
    const absoluteFailure = new FileError("invalid", "bad absolute path");
    vi.spyOn(env, "absolutePath").mockResolvedValueOnce(err(absoluteFailure));
    await expect(withFileMutationQueue(env, "file.txt", mutation, BACKGROUND_CONTEXT)).rejects.toBe(
      absoluteFailure,
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(await withFileMutationQueue(env, "file.txt", mutation, BACKGROUND_CONTEXT)).toBe(
      "mutated",
    );
  });

  it("releases a failed mutation so the next write cannot deadlock", async () => {
    const env = await workspace();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("mutation failed");
    const first = withFileMutationQueue(
      env,
      "file.txt",
      async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      },
      BACKGROUND_CONTEXT,
    );
    const rejected = expect(first).rejects.toBe(failure);
    await entered.promise;
    const second = createWriteTool().execute(
      "write",
      { path: "file.txt", content: "recovered" },
      () => {},
      { env },
      ...inert,
    );
    release.resolve();
    await rejected;
    expect(text(await second)).toBe("Successfully wrote to file.txt");
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("recovered");
  });
});

describe("vendored tool path helpers", () => {
  it("normalizes @ and Unicode spaces while forwarding failures and context", async () => {
    const env = await workspace();
    const context = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
    const absolute = vi.spyOn(env, "absolutePath");
    expect(
      await resolveToolPath(env, "@a\u00a0b\u2000c\u200ad\u202fe\u205ff\u3000g", context),
    ).toBe(join(env.cwd, "a b c d e f g"));
    expect(absolute).toHaveBeenCalledWith("a b c d e f g", context);
    expect(await resolveToolPath(env, "plain.txt", context)).toBe(join(env.cwd, "plain.txt"));
    const failure = new FileError("invalid", "invalid path");
    absolute.mockResolvedValueOnce(err(failure));
    await expect(resolveToolPath(env, "path", context)).rejects.toBe(failure);
  });

  it.each([
    ["Screenshot 1 PM.png", "Screenshot 1\u202fPM.png"],
    ["Screenshot 1 am.png", "Screenshot 1\u202fam.png"],
    ["café.txt", "cafe\u0301.txt"],
    ["it's.txt", "it’s.txt"],
    ["café's.txt", "cafe\u0301’s.txt"],
  ])("finds filesystem variant %j for %j", async (requested, stored) => {
    const env = await workspace();
    // Capability double makes Unicode lookup deterministic on both macOS
    // normalization-insensitive filesystems and Linux's byte-sensitive ones.
    const exists = vi
      .spyOn(env, "exists")
      .mockImplementation(async (path) => ok(path === join(env.cwd, stored)));
    expect(await resolveReadToolPath(env, requested, BACKGROUND_CONTEXT)).toBe(
      join(env.cwd, stored),
    );
    expect(exists.mock.calls.every((call) => call[1] === BACKGROUND_CONTEXT)).toBe(true);
    expect(new Set(exists.mock.calls.map((call) => call[0])).size).toBe(exists.mock.calls.length);
  });

  it("prefers the exact file, falls back to the addressed path, and rejects existence failures", async () => {
    const env = await workspace();
    await writeFile(join(env.cwd, "exact.txt"), "exact");
    const exists = vi.spyOn(env, "exists");
    expect(await resolveReadToolPath(env, "exact.txt", BACKGROUND_CONTEXT)).toBe(
      join(env.cwd, "exact.txt"),
    );
    expect(exists).toHaveBeenCalledTimes(1);
    exists.mockClear();
    expect(await resolveReadToolPath(env, "missing.txt", BACKGROUND_CONTEXT)).toBe(
      join(env.cwd, "missing.txt"),
    );
    expect(exists).toHaveBeenCalledTimes(1);
    const failure = new FileError("permission_denied", "exists denied");
    exists.mockResolvedValueOnce(err(failure));
    await expect(resolveReadToolPath(env, "exact.txt", BACKGROUND_CONTEXT)).rejects.toBe(failure);
  });
});

function outputView(textValue: string, overrides: Partial<ShellOutputView> = {}): ShellOutputView {
  const bytes = Buffer.byteLength(textValue);
  return {
    text: textValue,
    truncation: {
      truncated: false,
      truncatedBy: null,
      totalLines: 1,
      totalBytes: bytes,
      outputLines: 1,
      outputBytes: bytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    },
    ...overrides,
  };
}

describe("vendored bash contracts", () => {
  it.each([0, -1, NaN, Infinity, -Infinity, 2_147_483_647 / 1000 + 1])(
    "rejects timeout %j before starting or emitting progress",
    async (timeout) => {
      const env = await workspace();
      const exec = vi.spyOn(env, "exec");
      const update = vi.fn();
      await expect(
        createBashTool().execute("bash", { command: "true", timeout }, update, { env }, ...inert),
      ).rejects.toThrow(
        timeout > 2_147_483_647 / 1000 && Number.isFinite(timeout)
          ? "maximum is"
          : "must be a finite number",
      );
      expect(exec).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("runs prepared commands with prefix and explicit environment, cwd, context and bounded capture", async () => {
    const env = await workspace();
    const subdirectory = join(env.cwd, "subdir");
    await mkdir(subdirectory);
    const context = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
    const prepare = vi.fn(
      async (
        execution: BashExecution,
        toolContext: ExecutionToolContext,
        receivedContext: Context,
      ) => {
        expect(toolContext.env).toBe(env);
        expect(receivedContext).toBe(context);
        expect(execution.command).toBe(
          'PREFIX=prefix\nprintf \'%s:%s:%s\' "$PREFIX" "$FLAG" "${PWD##*/}"',
        );
        execution.cwd = subdirectory;
        execution.env = { FLAG: "explicit" };
        execution.inheritEnv = false;
      },
    );
    const exec = vi.spyOn(env, "exec");
    const result = await createBashTool({ commandPrefix: "PREFIX=prefix", prepare }).execute(
      "bash",
      { command: 'printf \'%s:%s:%s\' "$PREFIX" "$FLAG" "${PWD##*/}"', timeout: 1 },
      () => {},
      { env },
      undefined as never,
      context,
    );
    expect(text(result)).toBe("prefix:explicit:subdir");
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: subdirectory,
        env: { FLAG: "explicit" },
        inheritEnv: false,
        timeout: 1,
        capture: {
          limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" },
          spill: true,
        },
      }),
      context,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    const failure = new Error("prepare denied");
    exec.mockClear();
    await expect(
      createBashTool({
        prepare: async () => {
          throw failure;
        },
      }).execute("bash", { command: "true" }, () => {}, { env }, ...inert),
    ).rejects.toBe(failure);
    expect(exec).not.toHaveBeenCalled();
  });

  it("represents silent success and silent nonzero exits without synthetic output", async () => {
    const env = await workspace();
    expect(
      await createBashTool().execute("bash", { command: "true" }, () => {}, { env }, ...inert),
    ).toEqual({ content: [{ type: "text", text: "(no output)" }], details: undefined });
    await expect(
      createBashTool().execute("bash", { command: "exit 9" }, () => {}, { env }, ...inert),
    ).rejects.toThrow("Command exited with code 9");
  });

  it.each([
    "timeout",
    "aborted",
    "shell_unavailable",
    "spawn_error",
    "callback_error",
    "unknown",
  ] as const)(
    "retains typed %s execution failures with and without partial output",
    async (code) => {
      const env = await workspace();
      const failure = new ExecutionError(code, "backend failed");
      for (const partial of ["", "partial output"]) {
        vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
          if (partial)
            options?.onUpdate?.({ kind: "replace", output: outputView(partial) }, context);
          return err(failure);
        });
        const status =
          code === "timeout"
            ? "Command timed out after 2 seconds"
            : code === "aborted"
              ? "Command aborted"
              : "backend failed";
        await expect(
          createBashTool().execute(
            "bash",
            { command: "ignored", timeout: 2 },
            () => {},
            { env },
            ...inert,
          ),
        ).rejects.toMatchObject({
          message: `${partial ? `${partial}\n\n` : ""}${status}`,
          cause: failure,
        });
      }
    },
  );

  it("checkpoints changed snapshots only after two seconds and ignores post-completion updates", async () => {
    const env = await workspace();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let lateUpdate: (() => void) | undefined;
    vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
      const publish = (value: string) =>
        options?.onUpdate?.({ kind: "replace", output: outputView(value) }, context);
      now = 1999;
      publish("one");
      now = 2000;
      publish("two");
      now = 4000;
      publish("two");
      now = 4001;
      publish("three");
      lateUpdate = () => publish("late");
      return ok({ exitCode: 0, ...outputView("three") });
    });
    const update = vi.fn();
    expect(
      text(
        await createBashTool().execute("bash", { command: "ignored" }, update, { env }, ...inert),
      ),
    ).toBe("three");
    expect(update.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      undefined,
      { checkpoint: true },
      undefined,
      { checkpoint: true },
    ]);
    const count = update.mock.calls.length;
    lateUpdate?.();
    expect(update).toHaveBeenCalledTimes(count);
  });

  it.each(["lines", "bytes", "partial-line"] as const)(
    "spills full %s output while returning only the bounded tail",
    async (kind) => {
      const env = await workspace();
      const source =
        kind === "lines"
          ? Array.from({ length: 2003 }, (_, index) => `line-${index + 1}`).join("\n") + "\n"
          : kind === "bytes"
            ? Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n") + "\n"
            : "x".repeat(DEFAULT_MAX_BYTES + 77);
      await writeFile(join(env.cwd, "source.txt"), source);
      const result = await createBashTool().execute(
        "bash",
        { command: "cat source.txt" },
        () => {},
        { env },
        ...inert,
      );
      const path = result.details?.fullOutputPath;
      expect(path).toBeDefined();
      if (!path) throw new Error("missing full-output spill");
      expect(dirname(path)).toBe(env.cwd);
      expect(await readFile(path, "utf8")).toBe(source);
      const truncation = result.details?.truncation;
      expect(truncation?.truncated).toBe(true);
      const tail = text(result).split("\n\n[Showing")[0];
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect((kind === "partial-line" ? source : source.slice(0, -1)).endsWith(tail)).toBe(true);
      if (kind === "lines")
        expect(text(result)).toContain(`[Showing lines 4-2003 of 2003. Full output: ${path}]`);
      if (kind === "bytes")
        expect(text(result)).toContain(`of 100 (50.0KB limit). Full output: ${path}]`);
      if (kind === "partial-line")
        expect(text(result)).toContain(
          `[Showing last 50.0KB of line 1 (line is 50.1KB). Full output: ${path}]`,
        );
    },
  );

  it("retains truncation and spill location when execution fails after output", async () => {
    const env = await workspace();
    const source = "x".repeat(DEFAULT_MAX_BYTES + 1);
    await writeFile(join(env.cwd, "source.txt"), source);
    const failure = new ExecutionError("aborted", "cancelled");
    const tail = "x".repeat(DEFAULT_MAX_BYTES);
    const view = outputView(tail);
    view.spillPath = join(env.cwd, "full-output.log");
    await writeFile(view.spillPath, source);
    view.truncation = {
      ...view.truncation,
      truncated: true,
      truncatedBy: "bytes",
      totalBytes: source.length,
      lastLinePartial: true,
    };
    vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
      options?.onUpdate?.({ kind: "replace", output: view }, context);
      return err(failure);
    });
    await expect(
      createBashTool().execute("bash", { command: "ignored" }, () => {}, { env }, ...inert),
    ).rejects.toMatchObject({
      message: `${tail}\n\n[Showing last 50.0KB of line 1 (line is 50.0KB). Full output: ${view.spillPath}]\n\nCommand aborted`,
      cause: failure,
    });
    expect(await readFile(view.spillPath, "utf8")).toBe(source);
  });
});
