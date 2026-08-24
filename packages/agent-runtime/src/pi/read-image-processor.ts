import type { ReadImageProcessor } from "@earendil-works/pi-agent-core/node";

/** The longest edge sent by `read`; beyond this vision quality falls faster than request cost. */
export const MAX_READ_IMAGE_EDGE_PX = 2_000;
/** Base64 payload headroom below Anthropic's 5 MiB image-request ceiling. */
export const MAX_READ_IMAGE_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);

const JPEG_QUALITIES = [80, 70, 60, 50] as const;
const COMPRESSION_PASSES = 7;
const RESIZE_STEP = 0.75;
// Decoding an image well beyond the vision bound is work the model cannot use.
const MAX_INPUT_PIXELS = 64_000_000;

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
      const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      // Pi only calls this after its magic-byte image detector accepted the
      // file. A decodable raster image always has these dimensions; a corrupt
      // one makes sharp reject and takes the safe catch below.
      const original = metadata.autoOrient!;

      if (
        mimeType !== "image/bmp" &&
        original.width <= maxEdgePx &&
        original.height <= maxEdgePx &&
        base64Length(bytes.byteLength) <= maxBase64Bytes
      ) {
        return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType, hints: [] };
      }

      let displayed = fitWithin(original, maxEdgePx);
      for (let pass = 0; pass < COMPRESSION_PASSES; pass += 1) {
        for (const quality of JPEG_QUALITIES) {
          const encoded = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({
              width: displayed.width,
              height: displayed.height,
              fit: "inside",
              withoutEnlargement: true,
            })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
            .toBuffer();
          if (base64Length(encoded.byteLength) <= maxBase64Bytes) {
            const scale = original.width / displayed.width;
            return {
              ok: true,
              data: encoded.toString("base64"),
              mimeType: "image/jpeg",
              hints: [
                "[Image recompressed as JPEG to fit provider limits.]",
                `[Image: original ${original.width}x${original.height}, displayed at ${displayed.width}x${displayed.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
              ],
            };
          }
        }
        displayed = nextSmaller(displayed);
      }
      return { ok: false, message: OMITTED_IMAGE };
    } catch {
      return { ok: false, message: OMITTED_IMAGE };
    }
  };
}

/** The provider-safe processor used by every Pi `read` tool. */
export const processReadImage = createReadImageProcessor();
