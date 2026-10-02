import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "./vendor/pi-harness/context";
import { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import { createEditTool } from "./vendor/pi-harness/tools/edit";
import { createBashTool } from "./vendor/pi-harness/tools/bash";
import { resolveReadToolPath } from "./vendor/pi-harness/tools/path-utils";
import { truncateTail } from "./vendor/pi-harness/utils/truncate";
import { createReadTool } from "./vendor/pi-harness/tools/read";
import { createWriteTool } from "./vendor/pi-harness/tools/write";
import { detectSupportedImageMimeType, encodeBase64 } from "./vendor/pi-harness/tools/image";
import {
  applyEditsToNormalizedContent,
  applyReplacementsPreservingUnchangedLines,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./vendor/pi-harness/tools/edit-diff";
import {
  err,
  ExecutionError,
  FileError,
  ok,
  type AgentHarnessToolInvocation,
  type ShellExecOptions,
  type ShellOutputView,
} from "./vendor/pi-harness/types";

const context = BACKGROUND_CONTEXT;
const invocation: AgentHarnessToolInvocation = {
  invocationId: "call",
  operationId: "op",
  turnId: "turn",
  getMemo: async () => undefined,
  setMemo: async () => {},
};
const textEncoder = new TextEncoder();
function png(...chunks: { type: string; length: number }[]): Uint8Array {
  const bytes = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.length + 12, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const chunk of chunks) {
    new DataView(bytes.buffer).setUint32(offset, chunk.length);
    bytes.set(textEncoder.encode(chunk.type), offset + 4);
    offset += chunk.length + 12;
  }
  return bytes;
}
function bmp(dib = 12, planes = 1, depth = 24): Uint8Array {
  const bytes = new Uint8Array(dib === 12 ? 26 : 30);
  bytes.set(textEncoder.encode("BM"));
  const view = new DataView(bytes.buffer);
  view.setUint32(2, 100, true);
  view.setUint32(10, 14 + dib, true);
  view.setUint32(14, dib, true);
  view.setUint16(dib === 12 ? 22 : 26, planes, true);
  view.setUint16(dib === 12 ? 24 : 28, depth, true);
  return bytes;
}

describe("retained image format validation", () => {
  it("accepts supported signatures but not APNG or JPEG lossless markers", () => {
    expect(detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xf7]))).toBeUndefined();
    expect(detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(
      detectSupportedImageMimeType(png({ type: "IHDR", length: 13 }, { type: "IDAT", length: 0 })),
    ).toBe("image/png");
    expect(
      detectSupportedImageMimeType(png({ type: "IHDR", length: 13 }, { type: "acTL", length: 8 })),
    ).toBeUndefined();
    expect(detectSupportedImageMimeType(png({ type: "IHDR", length: 12 }))).toBeUndefined();
    expect(detectSupportedImageMimeType(png({ type: "WRNG", length: 13 }))).toBeUndefined();
    const truncated = png({ type: "IHDR", length: 13 }).slice(0, 16);
    expect(detectSupportedImageMimeType(truncated)).toBe("image/png");
    expect(detectSupportedImageMimeType(truncated.slice(0, 8))).toBeUndefined();
    for (const signature of ["GIF87a", "GIF89a"])
      expect(detectSupportedImageMimeType(textEncoder.encode(signature))).toBe("image/gif");
    expect(detectSupportedImageMimeType(textEncoder.encode("RIFFxxxxWEBP"))).toBe("image/webp");
    expect(detectSupportedImageMimeType(textEncoder.encode("RIFFxxxxWRNG"))).toBeUndefined();
  });

  it("validates BMP headers, pixel offsets, color planes and bit depth", () => {
    expect(detectSupportedImageMimeType(bmp())).toBe("image/bmp");
    expect(detectSupportedImageMimeType(bmp(40))).toBe("image/bmp");
    expect(detectSupportedImageMimeType(bmp().slice(0, 25))).toBeUndefined();
    expect(detectSupportedImageMimeType(bmp(40).slice(0, 26))).toBeUndefined();
    for (const dib of [11, 39, 125]) expect(detectSupportedImageMimeType(bmp(dib))).toBeUndefined();
    expect(detectSupportedImageMimeType(bmp(12, 2))).toBeUndefined();
    expect(detectSupportedImageMimeType(bmp(12, 1, 2))).toBeUndefined();
    for (const size of [0, 25]) {
      const bytes = bmp();
      new DataView(bytes.buffer).setUint32(2, size, true);
      expect(detectSupportedImageMimeType(bytes)).toBe(size === 0 ? "image/bmp" : undefined);
    }
    for (const offset of [25, 100]) {
      const bytes = bmp();
      new DataView(bytes.buffer).setUint32(10, offset, true);
      expect(detectSupportedImageMimeType(bytes)).toBeUndefined();
    }
  });

  it("encodes empty and all three base64 padding cases without a Node dependency", () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([0, 255]),
      new Uint8Array([0, 255, 128]),
      new Uint8Array([0, 1, 2, 3]),
    ])
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("retained fuzzy editing and display diffs", () => {
  it("normalizes only touched lines and preserves duplicate normalized context blocks", () => {
    const original = "keep ‘quotes’  \nchange “this”  \nkeep ‘quotes’  \n";
    const result = applyEditsToNormalizedContent(
      original,
      [{ oldText: 'change "this"', newText: "changed" }],
      "file",
    );
    expect(result).toEqual({
      baseContent: original,
      newContent: "keep ‘quotes’  \nchanged\nkeep ‘quotes’  \n",
    });
    const sameLine = applyEditsToNormalizedContent(
      "‘left’ + ‘right’\n",
      [
        { oldText: "'left'", newText: "left" },
        { oldText: "'right'", newText: "right" },
      ],
      "file",
    );
    expect(sameLine.newContent).toBe("left + right\n");
    expect(normalizeForFuzzyMatch("“quoted” —  \n")).toBe('"quoted" -\n');
    expect(fuzzyFindText("a", "missing")).toMatchObject({
      found: false,
      index: -1,
      matchLength: 0,
    });
    expect(stripBom("\uFEFFtext")).toEqual({ bom: "\uFEFF", text: "text" });
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(normalizeToLF("a\rb\r\n")).toBe("a\nb\n");
    expect(restoreLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
  });

  it("rejects missing, duplicate, empty, overlapping and no-op edits atomically", () => {
    for (const edits of [
      [{ oldText: "", newText: "x" }],
      [{ oldText: "absent", newText: "x" }],
      [{ oldText: "a", newText: "x" }],
      [{ oldText: "b", newText: "b" }],
    ])
      expect(() => applyEditsToNormalizedContent("aba", edits, "file")).toThrow();
    for (const edits of [
      [
        { oldText: "b", newText: "b" },
        { oldText: "", newText: "x" },
      ],
      [
        { oldText: "b", newText: "b" },
        { oldText: "absent", newText: "x" },
      ],
      [
        { oldText: "b", newText: "b" },
        { oldText: "a", newText: "x" },
      ],
      [
        { oldText: "b", newText: "b" },
        { oldText: "aba", newText: "aba" },
      ],
    ])
      expect(() => applyEditsToNormalizedContent("aba", edits, "file")).toThrow();
    expect(() =>
      applyEditsToNormalizedContent(
        "abc",
        [
          { oldText: "a", newText: "a" },
          { oldText: "b", newText: "b" },
        ],
        "file",
      ),
    ).toThrow("replacements produced identical content");
    expect(() => applyReplacementsPreservingUnchangedLines("two\nlines", "one", [])).toThrow(
      "different line count",
    );
    expect(() =>
      applyReplacementsPreservingUnchangedLines("abc", "abc", [
        { matchIndex: 9, matchLength: 1, newText: "x" },
      ]),
    ).toThrow("outside the base content");
    expect(() =>
      applyReplacementsPreservingUnchangedLines("abc", "abc", [
        { matchIndex: 1, matchLength: 9, newText: "x" },
      ]),
    ).toThrow("outside the base content");
    expect(applyReplacementsPreservingUnchangedLines("", "", [])).toBe("");
  });

  it("shows bounded context between changes with stable line numbers and usable patches", () => {
    const oldContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const newContent = oldContent
      .replace("line 5\n", "changed 5\n")
      .replace("line 25\n", "changed 25\n");
    const diff = generateDiffString(oldContent, newContent, 2);
    expect(diff.firstChangedLine).toBe(5);
    expect(diff.diff).toContain("- 5 line 5");
    expect(diff.diff).toContain("+25 changed 25");
    expect(diff.diff).toContain("...");
    expect(generateUnifiedPatch("file", oldContent, newContent, 2)).toContain("@@ -3,5 +3,5 @@");
    expect(generateDiffString("a\nb\nc\nd", "A\nb\nc\nD", 2).diff).toContain(" 2 b");
    expect(generateDiffString("same", "same")).toEqual({ diff: "", firstChangedLine: undefined });
    expect(generateDiffString("a", "b").diff).toContain("+1 b");
  });
});

let directory: string;
let env: NodeExecutionEnv;
beforeEach(async () => {
  const root = resolve("../../.bench-tmp/pi-migration-vc496/vendor-tool-tests");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, "case-"));
  env = new NodeExecutionEnv({ cwd: directory });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup(context);
  await rm(directory, { recursive: true, force: true });
});

describe("retained read and edit tools", () => {
  it("projects images through optional conversion, including omitted BMP and conversion failures", async () => {
    const bytes = png({ type: "IHDR", length: 13 });
    await writeFile(join(directory, "image"), bytes);
    const read = async (options?: Parameters<typeof createReadTool>[0]) =>
      createReadTool(options).execute(
        "call",
        { path: "image" },
        () => {},
        { env },
        invocation,
        context,
      );
    expect(await read()).toMatchObject({
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", mimeType: "image/png", data: encodeBase64(bytes) },
      ],
    });
    for (const hints of [[], ["hint"]]) {
      const processor = vi
        .fn()
        .mockResolvedValue({ ok: true, data: "converted", mimeType: "image/jpeg", hints });
      expect(await read({ imageProcessor: processor })).toMatchObject({
        content: [
          { type: "text", text: "Read image file [image/jpeg]" + (hints.length ? "\nhint" : "") },
          { type: "image", data: "converted" },
        ],
      });
      expect(processor.mock.calls[0][2]).toEqual({ autoResizeImages: true });
    }
    const failure = vi.fn().mockResolvedValue({ ok: false, message: "conversion failed" });
    expect(await read({ imageProcessor: failure, autoResizeImages: false })).toMatchObject({
      content: [{ type: "text", text: "Read image file [image/png]\nconversion failed" }],
    });
    expect(failure.mock.calls[0][2]).toEqual({ autoResizeImages: false });
    await writeFile(join(directory, "image"), bmp());
    expect(await read()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Image omitted") }],
    });
  });

  it("explains oversized first lines and offers exact continuation offsets", async () => {
    const read = async (offset?: number, limit?: number) =>
      createReadTool().execute(
        "call",
        { path: "text", offset, limit },
        () => {},
        { env },
        invocation,
        context,
      );
    await writeFile(join(directory, "text"), "x".repeat(51201));
    expect(await read()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Line 1 is 50.0KB") }],
      details: { truncation: { firstLineExceedsLimit: true } },
    });
    await writeFile(join(directory, "text"), "line\n".repeat(2002));
    expect(await read()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Use offset=2001 to continue") }],
      details: { truncation: { truncatedBy: "lines" } },
    });
    await writeFile(join(directory, "text"), ("x".repeat(1000) + "\n").repeat(60));
    expect(await read()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("50.0KB limit") }],
      details: { truncation: { truncatedBy: "bytes" } },
    });
    await writeFile(join(directory, "text"), "a\nb\nc");
    expect(await read(1, 2)).toMatchObject({
      content: [
        { type: "text", text: "a\nb\n\n[1 more lines in file. Use offset=3 to continue.]" },
      ],
    });
    expect(await read(2, 2)).toMatchObject({ content: [{ type: "text", text: "b\nc" }] });
    await expect(read(4)).rejects.toThrow("beyond end of file");
  });

  it("accepts recovered legacy edit argument shapes but rejects an empty edit list", () => {
    const prepare = createEditTool().prepareArguments!;
    expect(prepare(undefined)).toBeUndefined();
    expect(prepare(null)).toBeNull();
    expect(prepare(7)).toBe(7);
    for (const edits of [
      '[{"oldText":"a","newText":"b"}]',
      '{"oldText":"a","newText":"b"}',
      { oldText: "a", newText: "b" },
    ])
      expect(prepare({ path: "file", edits })).toEqual({
        path: "file",
        edits: [{ oldText: "a", newText: "b" }],
      });
    expect(prepare({ path: "file", oldText: "a", newText: "b" })).toEqual({
      path: "file",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(
      prepare({
        path: "file",
        edits: [{ oldText: "x", newText: "y" }],
        oldText: "a",
        newText: "b",
      }),
    ).toEqual({
      path: "file",
      edits: [
        { oldText: "x", newText: "y" },
        { oldText: "a", newText: "b" },
      ],
    });
    for (const edits of ["invalid JSON", "null", "{}", { oldText: 1 }, []])
      expect(prepare({ path: "file", edits })).toEqual({ path: "file", edits });
  });

  it("preserves BOM and CRLF bytes while returning fuzzy-edit patches", async () => {
    await writeFile(join(directory, "file"), "\uFEFFkeep ‘quotes’  \r\nchange “this”  \r\n");
    const result = await createEditTool().execute(
      "call",
      { path: "file", edits: [{ oldText: 'change "this"', newText: "changed" }] },
      () => {},
      { env },
      invocation,
      context,
    );
    expect(await readFile(join(directory, "file"), "utf8")).toBe(
      "\uFEFFkeep ‘quotes’  \r\nchanged\r\n",
    );
    expect(result.details?.firstChangedLine).toBe(2);
    expect(result.details?.patch).toContain("+changed");
  });

  it("surfaces file access/write failures and aborts before mutating", async () => {
    const edit = async (callContext = context) =>
      createEditTool().execute(
        "call",
        { path: "file", edits: [{ oldText: "a", newText: "b" }] },
        () => {},
        { env },
        invocation,
        callContext,
      );
    await expect(edit()).rejects.toThrow("Error code: not_found");
    await mkdir(join(directory, "file"));
    await expect(edit()).rejects.toThrow("Path is not a file");
    await rm(join(directory, "file"), { recursive: true });
    await writeFile(join(directory, "file"), "a");
    const readSpy = vi
      .spyOn(env, "readTextFile")
      .mockResolvedValueOnce(err(new FileError("permission_denied", "denied", "file")));
    await expect(edit()).rejects.toThrow("Error code: permission_denied");
    readSpy.mockRestore();
    const writeSpy = vi
      .spyOn(env, "writeFile")
      .mockResolvedValueOnce(err(new FileError("permission_denied", "denied", "file")));
    await expect(edit()).rejects.toThrow("Error code: permission_denied");
    writeSpy.mockRestore();
    const controller = new AbortController();
    vi.spyOn(env, "readTextFile").mockImplementationOnce(async () => {
      controller.abort();
      return ok("a");
    });
    await expect(edit(withAbortSignal(controller.signal, context))).rejects.toThrow(
      "Operation aborted",
    );
    expect(await readFile(join(directory, "file"), "utf8")).toBe("a");
    await expect(
      createEditTool().execute(
        "call",
        { path: "file", edits: [] },
        () => {},
        { env },
        invocation,
        context,
      ),
    ).rejects.toThrow("at least one replacement");
    vi.spyOn(env, "writeFile").mockResolvedValueOnce(
      err(new FileError("permission_denied", "denied", "file")),
    );
    await expect(
      createWriteTool().execute(
        "call",
        { path: "file", content: "b" },
        () => {},
        { env },
        invocation,
        context,
      ),
    ).rejects.toThrow("denied");
  });

  it("honors cancellation raised by path resolution or file writes and returns unresolved read paths", async () => {
    expect(await resolveReadToolPath(env, "@missing", context)).toBe(join(directory, "missing"));
    await writeFile(join(directory, "file"), "a");
    for (const factory of [createWriteTool, createEditTool]) {
      const controller = new AbortController();
      vi.spyOn(env, "canonicalPath").mockImplementationOnce(async () => {
        controller.abort();
        return ok(join(directory, "file"));
      });
      const tool = factory();
      const args = { path: "file", content: "b", edits: [{ oldText: "a", newText: "b" }] };
      await expect(
        tool.execute(
          "call",
          args,
          () => {},
          { env },
          invocation,
          withAbortSignal(controller.signal, context),
        ),
      ).rejects.toThrow("Operation aborted");
      expect(await readFile(join(directory, "file"), "utf8")).toBe("a");
      vi.restoreAllMocks();
      const afterWrite = new AbortController();
      const realWrite = env.writeFile.bind(env);
      vi.spyOn(env, "writeFile").mockImplementationOnce(async (...writeArgs) => {
        const result = await realWrite(...writeArgs);
        afterWrite.abort();
        return result;
      });
      await expect(
        tool.execute(
          "call",
          args,
          () => {},
          { env },
          invocation,
          withAbortSignal(afterWrite.signal, context),
        ),
      ).rejects.toThrow("Operation aborted");
      expect(await readFile(join(directory, "file"), "utf8")).toBe("b");
      vi.restoreAllMocks();
      await writeFile(join(directory, "file"), "a");
    }
  });
});

function shellView(text: string, maxBytes = 51200, maxLines = 2000): ShellOutputView {
  const { content, ...truncation } = truncateTail(text, { maxBytes, maxLines });
  return { text: content, truncation, spillPath: "/full-output" };
}

describe("retained bash compatibility diagnostics and checkpoints", () => {
  it("preserves truncation guidance for partial lines, byte limits and line limits", async () => {
    for (const [text, maxBytes, maxLines, diagnostic] of [
      ["123456789", 5, 2000, "Showing last 5B of line 1 (line is 5B)"],
      ["123\n456\n789", 5, 2000, "50.0KB limit"],
      ["a\nb\nc", 51200, 2, "Showing lines 2-3 of 3"],
    ] as const) {
      const view = shellView(text, maxBytes, maxLines);
      vi.spyOn(env, "exec").mockImplementationOnce(async (_command, options, currentContext) => {
        options?.onUpdate?.({ kind: "replace", output: view }, currentContext);
        return ok({ exitCode: 0, ...view });
      });
      const result = await createBashTool().execute(
        "call",
        { command: "command" },
        () => {},
        { env },
        invocation,
        context,
      );
      expect(result.content).toMatchObject([
        { type: "text", text: expect.stringContaining(diagnostic) },
      ]);
      expect(result.details?.fullOutputPath).toBe("/full-output");
      expect(result.details?.truncation).toEqual(view.truncation);
    }
    const view = { ...shellView("123456789", 5), lastLineBytes: 9 };
    vi.spyOn(env, "exec").mockImplementationOnce(async (_command, options, currentContext) => {
      options?.onUpdate?.({ kind: "replace", output: view }, currentContext);
      return ok({ exitCode: 0, ...view });
    });
    expect(
      (
        await createBashTool().execute(
          "call",
          { command: "command" },
          () => {},
          { env },
          invocation,
          context,
        )
      ).content,
    ).toMatchObject([{ text: expect.stringContaining("line is 9B") }]);
  });

  it("reports timeouts, cancellation and exit failures with any captured output", async () => {
    for (const [code, expected] of [
      ["timeout", "Command timed out after 3 seconds"],
      ["aborted", "Command aborted"],
      ["spawn_error", "provider detail"],
    ] as const) {
      for (const text of ["", "captured"]) {
        vi.spyOn(env, "exec").mockImplementationOnce(async (_command, options, currentContext) => {
          if (text)
            options?.onUpdate?.({ kind: "replace", output: shellView(text) }, currentContext);
          return err(new ExecutionError(code, "provider detail"));
        });
        await expect(
          createBashTool().execute(
            "call",
            { command: "command", timeout: 3 },
            () => {},
            { env },
            invocation,
            context,
          ),
        ).rejects.toThrow(text ? `${text}\n\n${expected}` : expected);
      }
    }
    for (const text of ["", "captured"]) {
      vi.spyOn(env, "exec").mockImplementationOnce(async (_command, options, currentContext) => {
        if (text) options?.onUpdate?.({ kind: "replace", output: shellView(text) }, currentContext);
        return ok({ exitCode: 2, truncation: shellView(text).truncation });
      });
      await expect(
        createBashTool().execute(
          "call",
          { command: "command" },
          () => {},
          { env },
          invocation,
          context,
        ),
      ).rejects.toThrow(
        text ? `${text}\n\nCommand exited with code 2` : "Command exited with code 2",
      );
    }
    vi.spyOn(env, "exec").mockResolvedValueOnce(
      ok({ exitCode: 0, truncation: shellView("").truncation }),
    );
    expect(
      (
        await createBashTool().execute(
          "call",
          { command: "command" },
          () => {},
          { env },
          invocation,
          context,
        )
      ).content,
    ).toEqual([{ type: "text", text: "(no output)" }]);
    for (const timeout of [0, Number.NaN, Number.POSITIVE_INFINITY, 2147483648 / 1000])
      await expect(
        createBashTool().execute(
          "call",
          { command: "command", timeout },
          () => {},
          { env },
          invocation,
          context,
        ),
      ).rejects.toThrow("Invalid timeout");
  });

  it("checks changed snapshots at two-second intervals and ignores updates after completion", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let update: ShellExecOptions["onUpdate"];
    const onUpdate = vi.fn();
    const prepare = vi.fn((execution: { command: string; cwd: string }) => {
      execution.cwd = "/resolved";
    });
    vi.spyOn(env, "exec").mockImplementationOnce(async (command, options, currentContext) => {
      expect(command).toBe("prefix\ncommand");
      expect(options?.cwd).toBe("/resolved");
      update = options?.onUpdate;
      for (const [time, text] of [
        [1000, "one"],
        [3100, "two"],
        [5200, "two"],
        [5201, "three"],
      ] as const) {
        now.mockReturnValue(time);
        update?.({ kind: "replace", output: shellView(text) }, currentContext);
      }
      return ok({ exitCode: 0, truncation: shellView("three").truncation });
    });
    const result = await createBashTool({ commandPrefix: "prefix", prepare }).execute(
      "call",
      { command: "command" },
      onUpdate,
      { env },
      invocation,
      context,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.content).toMatchObject([{ text: "three" }]);
    expect(onUpdate.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      undefined,
      { checkpoint: true },
      undefined,
      { checkpoint: true },
    ]);
    update?.({ kind: "replace", output: shellView("late") }, context);
    expect(onUpdate).toHaveBeenCalledTimes(5);
  });
});
