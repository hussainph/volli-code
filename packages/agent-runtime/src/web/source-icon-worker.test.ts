/** Real threads and libvips, never an instantly completing decoder substitute. */
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = new URL("./source-icon-worker.ts", import.meta.url);
type Answer = { type: "omitted" } | { type: "ready"; bytes: Uint8Array };

async function ask(input: unknown, entry: URL = SOURCE): Promise<Answer> {
  // Native Node type stripping loads the source entry. The second entry tested
  // below is CommonJS, with sharp external, like the desktop packaged worker.
  const worker = new Worker(entry);
  try {
    return await new Promise<Answer>((resolve, reject) => {
      let answered = false;
      const deadline = setTimeout(() => reject(new Error("Icon worker did not answer")), 2_000);
      worker.once("message", (answer: Answer) => {
        answered = true;
        clearTimeout(deadline);
        resolve(answer);
      });
      worker.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(deadline);
        if (!answered) reject(new Error(`Icon worker exited ${code} before answering`));
      });
      worker.postMessage(input, []);
    });
  } finally {
    await worker.terminate();
  }
}

function ready(answer: Answer): Buffer {
  expect(answer.type).toBe("ready");
  if (answer.type !== "ready") throw new Error("Expected a decoded icon");
  return Buffer.from(answer.bytes);
}

async function png(width = 128, height = 64): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: "#c07a42" } })
    .png()
    .toBuffer();
}

describe("source icon raster worker", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "decodes %s and produces a bounded static PNG",
    async (format) => {
      const bytes = await sharp(await png())
        .toFormat(format)
        .toBuffer();
      const result = ready(await ask({ bytes, mime: `image/${format}` }));
      const metadata = await sharp(result).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 64, height: 32 });
      expect(metadata.pages ?? 1).toBe(1);
      expect(result.byteLength).toBeLessThanOrEqual(64 * 1024);
    },
  );

  it("re-encodes even a tiny PNG and strips embedded metadata", async () => {
    const bytes = await sharp(await png(2, 2))
      .withMetadata({ exif: { IFD0: { Copyright: "private-icon-metadata" } } })
      .png()
      .toBuffer();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    const result = ready(await ask({ bytes, mime: "image/png" }));
    expect(result.equals(bytes)).toBe(false);
    expect((await sharp(result).metadata()).exif).toBeUndefined();
    expect(result.includes(Buffer.from("private-icon-metadata"))).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { bytes: "not bytes", mime: "image/png" },
    { bytes: new Uint8Array(), mime: "image/png" },
    { bytes: new Uint8Array(256 * 1024 + 1), mime: "image/png" },
    { bytes: Buffer.from("<html>not pixels</html>"), mime: "image/png" },
    { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), mime: "image/svg+xml" },
    { bytes: Buffer.from([0, 0, 1, 0, 1, 0]), mime: "image/x-icon" },
  ])("omits invalid or unsupported input without exposing decoder text (%#)", async (input) => {
    expect(await ask(input)).toEqual({ type: "omitted" });
  });

  it("requires declared MIME, magic and real decoded format to agree", async () => {
    const bytes = await png();
    expect(await ask({ bytes, mime: "image/jpeg" })).toEqual({ type: "omitted" });
    expect(await ask({ bytes, mime: "application/octet-stream" })).toEqual({ type: "omitted" });
    expect(await ask({ bytes, mime: "image/png; charset=utf-8" })).toEqual({ type: "omitted" });
    // Correct initial magic is not enough: this reaches the real PNG codec.
    const corrupt = Buffer.from(bytes);
    corrupt.fill(0, 16, 24);
    expect(await ask({ bytes: corrupt, mime: "image/png" })).toEqual({ type: "omitted" });
  });

  it("rejects a highly compressed raster past the input pixel bound", async () => {
    const bytes = await png(1_001, 1_000);
    expect(bytes.byteLength).toBeLessThan(256 * 1024);
    expect(await ask({ bytes, mime: "image/png" })).toEqual({ type: "omitted" });
  });

  it("rejects an APNG control chunk and trailing/truncated PNG data", async () => {
    const bytes = await png(1, 1);
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8, 0);
    animation.write("acTL", 4, "ascii");
    // A marker is sufficient for refusal, regardless of its CRC. No decoder
    // gets an opportunity to silently flatten an animated image to frame one.
    const animated = Buffer.concat([bytes.subarray(0, 33), animation, bytes.subarray(33)]);
    for (const malformed of [
      animated,
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from([0])]),
    ]) {
      expect(await ask({ bytes: malformed, mime: "image/png" })).toEqual({ type: "omitted" });
    }
  });

  it("rejects a real animated WebP and malformed RIFF framing", async () => {
    // Self-authored two-frame one-pixel GIF, transcoded by the real codec.
    const header = "47494638396101000100800000000000ffffff";
    const black = "21f90400010000002c0000000001000100000202440100";
    const white = "21f90400010000002c00000000010001000002024c0100";
    const gif = Buffer.from(`${header}${black}${white}3b`, "hex");
    const animated = await sharp(gif, { animated: true }).webp().toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    expect(await ask({ bytes: animated, mime: "image/webp" })).toEqual({ type: "omitted" });
    const corrupt = await sharp(await png())
      .webp()
      .toBuffer();
    corrupt.writeUInt32LE(0xfffffff0, 4);
    expect(await ask({ bytes: corrupt, mime: "image/webp" })).toEqual({ type: "omitted" });
  });

  it("answers only the first queued message", async () => {
    const worker = new Worker(SOURCE);
    const answers: unknown[] = [];
    try {
      const exited = new Promise<void>((resolve, reject) => {
        worker.on("message", (answer: unknown) => answers.push(answer));
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Exit ${code}`));
        });
      });
      worker.postMessage(null, []);
      worker.postMessage(null, []);
      await exited;
      expect(answers).toEqual([{ type: "omitted" }]);
    } finally {
      await worker.terminate();
    }
  });

  it("also decodes through a file-backed CommonJS bundle with the native codec external", async () => {
    // Remains within this workspace; no app, display, network or system files.
    const directory = await mkdtemp(
      fileURLToPath(new URL("../../.source-icon-worker-", import.meta.url)),
    );
    try {
      const entry = join(directory, "source-icon-worker.cjs");
      await build({
        entryPoints: [fileURLToPath(SOURCE)],
        outfile: entry,
        bundle: true,
        platform: "node",
        target: "node24",
        format: "cjs",
        external: ["sharp"],
      });
      const result = ready(
        await ask({ bytes: await png(), mime: "image/png" }, pathToFileURL(entry)),
      );
      expect(await sharp(result).metadata()).toMatchObject({
        format: "png",
        width: 64,
        height: 32,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
