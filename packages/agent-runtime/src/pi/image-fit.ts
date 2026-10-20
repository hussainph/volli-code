/**
 * The one sharp pipeline that turns an arbitrary image into a provider-legal one.
 *
 * Three callers share it, and sharing is the point: `read`'s image processor
 * (VC-177), `browser_screenshot`'s capture-time bound, and the send-time guard
 * in `provider-images.ts` that every provider request passes through. Were
 * each to carry its own encoder, the same picture could reach the model as
 * three different byte strings depending on which door it came in by — and
 * byte identity is what the send-time guard's prompt-cache safety rests on.
 *
 * **Deterministic by construction.** The output is a pure function of the
 * input bytes, the declared type and the profile: no clock, no randomness, no
 * dependence on what else is in the request. libvips and mozjpeg encode the
 * same raster with the same settings to the same bytes, so a request rebuilt
 * from the same history re-derives the same image and the provider's cache
 * prefix survives.
 */

/** The longest edge sent by default; beyond this vision quality falls faster than request cost. */
export const DEFAULT_MAX_IMAGE_EDGE_PX = 2_000;
/** Base64 payload headroom below Anthropic's 5 MiB image-request ceiling. */
export const DEFAULT_MAX_IMAGE_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);
/** The first quality tried; each later pass steps down from it. */
export const DEFAULT_JPEG_QUALITY = 80;

const JPEG_QUALITY_STEP = 10;
const JPEG_QUALITY_STEPS = 4;
const COMPRESSION_PASSES = 7;
const RESIZE_STEP = 0.75;

/**
 * The image types a provider accepts as-is. Anything else (BMP, TIFF, SVG, an
 * MCP server's idea of an image) is transcoded however small it is, because
 * the size is not what makes it illegal.
 */
const PROVIDER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface ImageFitProfile {
  maxWidthPx: number;
  maxHeightPx: number;
  maxBase64Bytes: number;
  /** First JPEG quality tried when the image has to be re-encoded. */
  jpegQuality?: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageFit =
  /** Already legal: ship the original bytes. */
  | { kind: "unchanged" }
  /** Re-encoded to fit. `displayed` is the encoded result, not the box it was fitted into. */
  | {
      kind: "fitted";
      data: string;
      mimeType: "image/jpeg";
      original: ImageDimensions;
      displayed: ImageDimensions;
    }
  /** Undecodable, or no smaller copy fits the byte bound. */
  | { kind: "failed" };

export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function fitWithin(
  { width, height }: ImageDimensions,
  maxWidthPx: number,
  maxHeightPx: number,
): ImageDimensions {
  const scale = Math.min(1, maxWidthPx / width, maxHeightPx / height);
  return {
    width: Math.min(maxWidthPx, Math.max(1, Math.round(width * scale))),
    height: Math.min(maxHeightPx, Math.max(1, Math.round(height * scale))),
  };
}

function nextSmaller({ width, height }: ImageDimensions): ImageDimensions {
  return {
    width: Math.max(1, Math.floor(width * RESIZE_STEP)),
    height: Math.max(1, Math.floor(height * RESIZE_STEP)),
  };
}

/**
 * Fit one image inside a profile: untouched when it already is, otherwise
 * bounded, flattened and re-encoded as JPEG, verifying the encoded payload.
 *
 * Never throws: a missing native codec, a file the magic-byte detector
 * accepted but libvips cannot decode, and an image no reduction can fit all
 * come back as `failed`, which every caller turns into a text placeholder.
 */
export async function fitImage(
  bytes: Uint8Array,
  mimeType: string,
  profile: ImageFitProfile,
): Promise<ImageFit> {
  const { maxWidthPx, maxHeightPx, maxBase64Bytes } = profile;
  const firstQuality = profile.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const qualities = Array.from({ length: JPEG_QUALITY_STEPS }, (_, step) =>
    Math.max(1, firstQuality - step * JPEG_QUALITY_STEP),
  );
  try {
    // Dynamic loading keeps a missing native image codec a failed image,
    // rather than a failure to attach the whole runtime.
    const { default: sharp } = await import("sharp");
    // No `limitInputPixels` override: sharp's default (~268 MP) is the
    // decompression-bomb guard, and a tighter one here only omits images this
    // pipeline could otherwise have delivered. A 240 MP PNG measured at
    // 330 ms and +67 MiB RSS through the pipeline below — libvips streams the
    // resize rather than materializing the full raster — so pixel count is
    // not the cost that needed bounding. Encoded payload is, and the loop
    // below bounds that directly.
    const metadata = await sharp(bytes).metadata();
    // Dimensions after any EXIF rotation, which is what `.rotate()` produces
    // below. Sharp types `autoOrient` as always present; a file libvips cannot
    // decode rejects above and takes the safe catch instead.
    const original = metadata.autoOrient;

    // A small, already-cheap image ships byte-for-byte: a screenshot of code
    // or a UI reads better as its original lossless PNG than as anything this
    // pipeline could re-encode.
    if (
      PROVIDER_IMAGE_TYPES.has(mimeType.toLowerCase()) &&
      original.width <= maxWidthPx &&
      original.height <= maxHeightPx &&
      base64Length(bytes.byteLength) <= maxBase64Bytes
    ) {
      return { kind: "unchanged" };
    }

    let box = fitWithin(original, maxWidthPx, maxHeightPx);
    for (let pass = 0; pass < COMPRESSION_PASSES; pass += 1) {
      for (const quality of qualities) {
        // `resolveWithObject` so callers report the size the model is
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
          return {
            kind: "fitted",
            data: encoded.toString("base64"),
            mimeType: "image/jpeg",
            original: { width: original.width, height: original.height },
            displayed: { width: info.width, height: info.height },
          };
        }
      }
      box = nextSmaller(box);
    }
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
