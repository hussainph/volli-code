import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_READ_IMAGE_BASE64_BYTES,
  MAX_READ_IMAGE_EDGE_PX,
  createReadImageProcessor,
  processReadImage,
} from "./read-image-processor";

async function png(width: number, height: number, compressionLevel = 9): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#e96942" },
  })
    .png({ compressionLevel })
    .toBuffer();
}

function tinyBmp(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(4, 34);
  bytes[56] = 0xff;
  return bytes;
}

function resultImage(result: Awaited<ReturnType<typeof processReadImage>>): {
  data: string;
  mimeType: string;
  hints: string[];
} {
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("read image processor", () => {
  it("passes through a small supported image without changing its pixels", async () => {
    const source = await png(4, 3);

    const result = resultImage(
      await processReadImage(source, "image/png", { autoResizeImages: false }),
    );

    expect(result).toEqual({
      ok: true,
      data: source.toString("base64"),
      mimeType: "image/png",
      hints: [],
    });
  });

  it("downscales an oversized screenshot and labels the coordinate change", async () => {
    const source = await png(MAX_READ_IMAGE_EDGE_PX + 401, 1_200);

    const result = resultImage(
      await processReadImage(source, "image/png", { autoResizeImages: true }),
    );
    const output = await sharp(Buffer.from(result.data, "base64")).metadata();

    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.byteLength(result.data, "utf8")).toBeLessThanOrEqual(MAX_READ_IMAGE_BASE64_BYTES);
    expect(output.autoOrient).toEqual({ width: MAX_READ_IMAGE_EDGE_PX, height: 1_000 });
    expect(result.hints).toEqual([
      "[Image recompressed as JPEG to fit provider limits.]",
      "[Image: original 2401x1200, displayed at 2000x1000. Multiply coordinates by 1.20 to map to original image.]",
    ]);
  });

  it("lossily recompresses a byte-heavy PNG even when its dimensions already fit", async () => {
    // A level-zero PNG has more than the provider-safe base64 budget despite
    // containing an ordinary screenshot-sized raster. It is the regression
    // shape: Pi used to return these original PNG bytes directly.
    const source = await png(1_200, 1_200, 0);
    expect(Buffer.byteLength(source.toString("base64"), "utf8")).toBeGreaterThan(
      MAX_READ_IMAGE_BASE64_BYTES,
    );

    const result = resultImage(
      await processReadImage(source, "image/png", { autoResizeImages: true }),
    );
    const output = await sharp(Buffer.from(result.data, "base64")).metadata();

    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.byteLength(result.data, "utf8")).toBeLessThanOrEqual(MAX_READ_IMAGE_BASE64_BYTES);
    expect(output.autoOrient).toEqual({ width: 1_200, height: 1_200 });
    expect(result.hints.at(-1)).toContain("original 1200x1200, displayed at 1200x1200");
  });

  it("omits a BMP that the image codec cannot convert instead of sending its unsupported mime type", async () => {
    await expect(
      processReadImage(tinyBmp(), "image/bmp", { autoResizeImages: true }),
    ).resolves.toEqual({
      ok: false,
      message: "[Image omitted: could not make a provider-safe copy.]",
    });
  });

  it("omits an image when even a reduced JPEG cannot fit the configured bound", async () => {
    const processor = createReadImageProcessor({ maxBase64Bytes: 64, maxEdgePx: 2 });

    await expect(
      processor(await png(5, 5), "image/png", { autoResizeImages: true }),
    ).resolves.toEqual({
      ok: false,
      message: "[Image omitted: could not make a provider-safe copy.]",
    });
  });

  it("omits malformed image bytes instead of returning an unsafe tool result", async () => {
    await expect(
      processReadImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", {
        autoResizeImages: true,
      }),
    ).resolves.toEqual({
      ok: false,
      message: "[Image omitted: could not make a provider-safe copy.]",
    });
  });
});
