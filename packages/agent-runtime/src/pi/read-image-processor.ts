import type { ReadImageProcessor } from "@earendil-works/pi-agent-core/node";
import { DEFAULT_MAX_IMAGE_BASE64_BYTES, DEFAULT_MAX_IMAGE_EDGE_PX, fitImage } from "./image-fit";

/** The longest edge sent by `read`; beyond this vision quality falls faster than request cost. */
export const MAX_READ_IMAGE_EDGE_PX = DEFAULT_MAX_IMAGE_EDGE_PX;
/** Base64 payload headroom below Anthropic's 5 MiB image-request ceiling. */
export const MAX_READ_IMAGE_BASE64_BYTES = DEFAULT_MAX_IMAGE_BASE64_BYTES;

interface ReadImageProcessorOptions {
  maxBase64Bytes?: number;
  maxEdgePx?: number;
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
 * The pipeline itself is `image-fit.ts`, shared with the send-time guard so one
 * picture has one provider-safe encoding whichever door it came in by; what is
 * `read`'s own is the hints, which tell the model what changed.
 *
 * Pi's `autoResizeImages` flag is deliberately unread: it exists so a host can
 * install a processor and still opt out of resizing, and this one is installed
 * for exactly the opposite reason. `tools.ts` never sets it, so it is always
 * Pi's `true` default — honouring it would be a branch nothing can reach.
 *
 * The chord `Context` Pi added to this callback in 0.85 is unread for a
 * narrower reason: the only cancellable thing here is a `sharp` pipeline, and
 * libvips owns that work in a thread pool with no abort to hand it. Reading
 * `context.abortSignal` could only decide whether to throw away a result the
 * process has already paid for, which is not a saving worth a branch — so the
 * parameter is named and ignored rather than quietly absent, so that a reader
 * can see the decision was taken.
 */
export function createReadImageProcessor(
  options: ReadImageProcessorOptions = {},
): ReadImageProcessor {
  const maxBase64Bytes = options.maxBase64Bytes ?? MAX_READ_IMAGE_BASE64_BYTES;
  const maxEdgePx = options.maxEdgePx ?? MAX_READ_IMAGE_EDGE_PX;

  return async (bytes, mimeType, _readOptions, _context) => {
    const fit = await fitImage(bytes, mimeType, {
      maxWidthPx: maxEdgePx,
      maxHeightPx: maxEdgePx,
      maxBase64Bytes,
    });
    if (fit.kind === "unchanged") {
      return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType, hints: [] };
    }
    if (fit.kind === "failed") return { ok: false, message: OMITTED_IMAGE };
    const hints = ["[Image recompressed as JPEG to fit provider limits.]"];
    // Only when the pixels actually moved: telling a model to multiply
    // coordinates by 1.00 spends its attention on a no-op.
    const { original, displayed } = fit;
    if (displayed.width !== original.width) {
      const scale = original.width / displayed.width;
      hints.push(
        `[Image: original ${original.width}x${original.height}, displayed at ${displayed.width}x${displayed.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
      );
    }
    return { ok: true, data: fit.data, mimeType: fit.mimeType, hints };
  };
}

/** The provider-safe processor used by every Pi `read` tool. */
export const processReadImage = createReadImageProcessor();
