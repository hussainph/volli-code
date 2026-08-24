import type { ReadImageProcessor } from "@earendil-works/pi-agent-core/node";

/** The longest edge sent by `read`; beyond this vision quality falls faster than request cost. */
export const MAX_READ_IMAGE_EDGE_PX = 2_000;
/** Base64 payload headroom below Anthropic's 5 MiB image-request ceiling. */
export const MAX_READ_IMAGE_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);

const JPEG_QUALITIES = [80, 70, 60, 50] as const;
const COMPRESSION_PASSES = 7;
const RESIZE_STEP = 0.75;

interface ReadImageProcessorOptions {
  maxBase64Bytes?: number;
  maxEdgePx?: number;
}

interface Dimensions {
  width: number;
  height: number;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function fitWithin({ width, height }: Dimensions, maxEdgePx: number): Dimensions {
  const scale = Math.min(1, maxEdgePx / width, maxEdgePx / height);
  return {
    width: Math.min(maxEdgePx, Math.max(1, Math.round(width * scale))),
    height: Math.min(maxEdgePx, Math.max(1, Math.round(height * scale))),
  };
}

function nextSmaller({ width, height }: Dimensions): Dimensions {
  return {
    width: Math.max(1, Math.floor(width * RESIZE_STEP)),
    height: Math.max(1, Math.floor(height * RESIZE_STEP)),
  };
}

const OMITTED_IMAGE = "[Image omitted: could not make a provider-safe copy.]";

/**
 * Builds the `read` tool's image processor.
 *
 * Pi's generic read tool sends image bytes verbatim. PNG screenshots can be
 * much larger than their visual detail warrants, and one oversized tool result
 * remains in the conversation for every later provider request. This processor
 * preserves already-safe images, otherwise bounds their dimensions, transcodes
 * them to a lossy JPEG, and verifies the encoded payload before it reaches Pi.
 *
 * Pi's `autoResizeImages` flag is deliberately unread: it exists so a host can
 * install a processor and still opt out of resizing, and this one is installed
 * for exactly the opposite reason. `tools.ts` never sets it, so it is always
 * Pi's `true` default — honouring it would be a branch nothing can reach.
 */
export function createReadImageProcessor(
  options: ReadImageProcessorOptions = {},
): ReadImageProcessor {
  const maxBase64Bytes = options.maxBase64Bytes ?? MAX_READ_IMAGE_BASE64_BYTES;
  const maxEdgePx = options.maxEdgePx ?? MAX_READ_IMAGE_EDGE_PX;

  return async (bytes, mimeType, _readOptions) => {
    try {
      // Dynamic loading keeps a missing native image codec a failed image read,
      // rather than a failure to attach the whole runtime.
      const { default: sharp } = await import("sharp");
      // No `limitInputPixels` override: sharp's default (~268 MP) is the
      // decompression-bomb guard, and a tighter one here only omits images this
      // processor could otherwise have delivered. A 240 MP PNG measured at
      // 330 ms and +67 MiB RSS through the pipeline below — libvips streams the
      // resize rather than materializing the full raster — so pixel count is
      // not the cost that needed bounding. Encoded payload is, and the loop
      // below bounds that directly.
      const metadata = await sharp(bytes).metadata();
      // Dimensions after any EXIF rotation, which is what `.rotate()` produces
      // below. Sharp types `autoOrient` as always present; a file Pi's
      // magic-byte detector accepted but libvips cannot decode rejects here and
      // takes the safe catch instead.
      const original = metadata.autoOrient;

      // A small, already-cheap image ships byte-for-byte: a screenshot of code
      // or a UI reads better as its original lossless PNG than as anything this
      // processor could re-encode. BMP is excluded because no provider accepts
      // it as image input, so it must be transcoded however small it is.
      if (
        mimeType !== "image/bmp" &&
        original.width <= maxEdgePx &&
        original.height <= maxEdgePx &&
        base64Length(bytes.byteLength) <= maxBase64Bytes
      ) {
        return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType, hints: [] };
      }

      let box = fitWithin(original, maxEdgePx);
      for (let pass = 0; pass < COMPRESSION_PASSES; pass += 1) {
        for (const quality of JPEG_QUALITIES) {
          // `resolveWithObject` so the hint below reports the size the model is
          // actually looking at. `fit: "inside"` preserves the aspect ratio, so
          // the encoded image can come out a pixel short of the requested box —
          // and a coordinate scale derived from the box rather than the result
          // is then wrong in the one direction that matters.
          const { data: encoded, info } = await sharp(bytes)
            .rotate()
            .resize({
              width: box.width,
              height: box.height,
              fit: "inside",
              withoutEnlargement: true,
            })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
            .toBuffer({ resolveWithObject: true });
          if (base64Length(encoded.byteLength) <= maxBase64Bytes) {
            const hints = ["[Image recompressed as JPEG to fit provider limits.]"];
            // Only when the pixels actually moved: telling a model to multiply
            // coordinates by 1.00 spends its attention on a no-op.
            if (info.width !== original.width) {
              const scale = original.width / info.width;
              hints.push(
                `[Image: original ${original.width}x${original.height}, displayed at ${info.width}x${info.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
              );
            }
            return { ok: true, data: encoded.toString("base64"), mimeType: "image/jpeg", hints };
          }
        }
        box = nextSmaller(box);
      }
      return { ok: false, message: OMITTED_IMAGE };
    } catch {
      return { ok: false, message: OMITTED_IMAGE };
    }
  };
}

/** The provider-safe processor used by every Pi `read` tool. */
export const processReadImage = createReadImageProcessor();
