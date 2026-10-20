/**
 * The send-time image guard: every image in every provider request is legal
 * for the model that request goes to, whichever path put it in the history.
 *
 * Images reach a Session through many doors — `read` (bounded since VC-177),
 * `browser_screenshot`, MCP tool results, composer attachments, and whatever is
 * added next — and only some of them bound what they produce. Bounding each
 * door is still worth doing (it keeps the durable transcript small), but it
 * cannot be the guarantee: a door nobody thought of, or a limit that changes
 * with the request rather than the image, gets through. So the guarantee lives
 * here, at the one point every request passes through: the live turn's
 * `streamFn` (`runtime.ts`) and provider-native compaction's hand-built
 * request (`provider-compaction.ts`). Pi's local summarizer needs no guard —
 * it serializes the conversation to text and sends no images at all — and a
 * utility completion carries only the text it was given.
 *
 * The rules, in the order they apply:
 *
 * 1. **Count.** A request carries at most the model's `maxPerRequest` images.
 * 2. **Per image.** Each image is fitted inside the model's cache-safe resize
 *    profile (pi-ai's catalog `inputLimits.images.resize`), never beyond
 *    Anthropic's absolute 8000 px edge. When more than {@link MANY_IMAGES_ABOVE}
 *    images remain, the edge tightens to {@link MANY_IMAGES_MAX_EDGE_PX} for
 *    ALL of them — Anthropic's many-image rule, and the reason long
 *    browser-driving Sessions used to fail: the 21st screenshot made every
 *    earlier large one illegal at once. Every catalog profile today is already
 *    2000 px, so crossing the line changes no bytes; the switch is the
 *    backstop for a profile that is more lenient than the rule.
 * 3. **Total.** The images' base64 bytes stay under
 *    {@link REQUEST_IMAGE_BUDGET_FRACTION} of the model's `maxRequestBytes`,
 *    leaving the rest for text, tools and JSON framing.
 *
 * **What goes when something must, and why the oldest.** When rule 1 or 3
 * cannot be met, the OLDEST images are replaced by a short text placeholder
 * and the newest are kept: the newest are what the model is looking at, and an
 * old screenshot of a page that has since changed is the cheapest thing in the
 * conversation to forget. Evictions are rounded up to a multiple of
 * {@link EVICTION_STEP} images, and that rounding is for the prompt cache: an
 * eviction rewrites an early message, so evicting exactly one more image per
 * turn would bust the cached prefix on every turn of a long Session. In steps,
 * the prefix is rewritten once per step and is byte-stable in between. A step
 * that would reach every image falls back to the exact count: ten large
 * screenshots one byte over budget lose the oldest, not all ten.
 *
 * **Prompt-cache safety.** The same image under the same profile always
 * becomes the same bytes (`image-fit.ts` is deterministic), an already-legal
 * image is passed through untouched, and nothing here depends on the clock or
 * on anything but the request itself — so a request rebuilt from the same
 * history is the same request, and the provider's cache prefix survives.
 * Results are memoized by content hash in a bounded LRU, so each image is
 * decoded once per profile rather than on every request.
 *
 * **The durable transcript is never touched.** Only the outgoing request is
 * rewritten; the person's history, and the full-resolution pictures in it,
 * stay as they were recorded.
 */

import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_MAX_IMAGE_BASE64_BYTES,
  DEFAULT_MAX_IMAGE_EDGE_PX,
  fitImage,
  type ImageFitProfile,
} from "./image-fit";

/** Anthropic's hard per-image edge, whatever a profile says. */
export const ABSOLUTE_MAX_IMAGE_EDGE_PX = 8_000;
/** Anthropic's many-image rule: above this many images in one request... */
export const MANY_IMAGES_ABOVE = 20;
/** ...each image must fit this edge. */
export const MANY_IMAGES_MAX_EDGE_PX = 2_000;
/** Images per request when the catalog states none: Anthropic's lowest published cap. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 100;
/** Request ceiling when the catalog states none: Anthropic's 32 MiB. */
export const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** Share of the request ceiling images may take; the rest is text, tools and framing. */
export const REQUEST_IMAGE_BUDGET_FRACTION = 0.6;
/** Evictions happen in multiples of this, so the cached prefix moves once per step. */
export const EVICTION_STEP = 10;

/** Where an evicted image was. Deterministic, so the rewritten prefix is too. */
export const EVICTED_IMAGE_TEXT =
  "[Image omitted: an older image was dropped to keep this request within the model's image limits.]";
/** Where an image no provider-safe copy could be made of was. */
export const UNUSABLE_IMAGE_TEXT = "[Image omitted: could not make a provider-safe copy.]";

const DEFAULT_MEMO_ENTRIES = 256;
/** Re-encoded bytes held; originals belong to the transcript and are not counted. */
const DEFAULT_MEMO_BYTES = 64 * 1024 * 1024;

export interface ProviderImageLimits {
  /** The per-image profile below the many-image threshold. */
  profile: Required<ImageFitProfile>;
  maxImagesPerRequest: number;
  /** Base64 bytes all of a request's images may add up to. */
  requestImageBudgetBytes: number;
}

/**
 * One model's image limits, read from pi-ai's generated catalog
 * (`Model.inputLimits`, added in pi-ai 0.87.0) and defaulted to Anthropic's
 * documented limits where the catalog is silent — the strictest provider this
 * runtime talks to, so a model with no entry is treated as conservatively as
 * the one that produced every failure this guard exists for.
 */
export function providerImageLimits(model: Model<Api>): ProviderImageLimits {
  const images = model.inputLimits?.images;
  const resize = images?.resize;
  const maxRequestBytes = model.inputLimits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  return {
    profile: {
      maxWidthPx: Math.min(
        ABSOLUTE_MAX_IMAGE_EDGE_PX,
        resize?.maxWidth ?? DEFAULT_MAX_IMAGE_EDGE_PX,
      ),
      maxHeightPx: Math.min(
        ABSOLUTE_MAX_IMAGE_EDGE_PX,
        resize?.maxHeight ?? DEFAULT_MAX_IMAGE_EDGE_PX,
      ),
      maxBase64Bytes: resize?.maxBytes ?? DEFAULT_MAX_IMAGE_BASE64_BYTES,
      jpegQuality: resize?.jpegQuality ?? DEFAULT_JPEG_QUALITY,
    },
    maxImagesPerRequest: images?.maxPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST,
    requestImageBudgetBytes: Math.floor(maxRequestBytes * REQUEST_IMAGE_BUDGET_FRACTION),
  };
}

/** The profile every image in a request carrying `count` images is fitted to. */
function profileFor(limits: ProviderImageLimits, count: number): Required<ImageFitProfile> {
  if (count <= MANY_IMAGES_ABOVE) return limits.profile;
  return {
    ...limits.profile,
    maxWidthPx: Math.min(limits.profile.maxWidthPx, MANY_IMAGES_MAX_EDGE_PX),
    maxHeightPx: Math.min(limits.profile.maxHeightPx, MANY_IMAGES_MAX_EDGE_PX),
  };
}

/**
 * The fewest oldest images that must go, rounded up to a whole step — unless
 * the step would take every image, when the cache is not worth the newest
 * ones and exactly as many go as must.
 */
function evictionCount(atLeast: number, total: number): number {
  const exact = Math.min(total, Math.max(0, atLeast));
  const rounded = Math.ceil(exact / EVICTION_STEP) * EVICTION_STEP;
  return rounded < total ? rounded : exact;
}

type ImageOutcome = { kind: "keep" } | { kind: "replace"; image: ImageContent } | { kind: "omit" };

interface MemoEntry {
  outcome: ImageOutcome;
  /** Re-encoded bytes this entry holds. */
  bytes: number;
}

interface ImageSlot {
  message: number;
  block: number;
  image: ImageContent;
}

export interface ProviderImageGuardOptions {
  /** Most distinct (image, profile) results remembered. */
  maxEntries?: number;
  /** Most re-encoded base64 bytes remembered. */
  maxBytes?: number;
  /** The pipeline; injectable so memoization is observable in tests. */
  fit?: typeof fitImage;
}

export interface ProviderImageGuard {
  /**
   * The same messages with every image made legal for `model`. Messages with
   * no change are returned as the same objects; changed ones are copies. The
   * input is never mutated.
   */
  sanitize<M extends { role: string }>(messages: readonly M[], model: Model<Api>): Promise<M[]>;
}

export function createProviderImageGuard(
  options: ProviderImageGuardOptions = {},
): ProviderImageGuard {
  const maxEntries = options.maxEntries ?? DEFAULT_MEMO_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MEMO_BYTES;
  const fit = options.fit ?? fitImage;
  /** Insertion order is recency: a hit is re-inserted, the first key is the coldest. */
  const memo = new Map<string, MemoEntry>();
  let heldBytes = 0;
  /**
   * Digest per block object: a long Session re-sends the same block objects
   * on every request, and hashing megabytes of base64 each time is the one
   * cost the memo would otherwise still pay. The stored string guards against
   * a block whose data was replaced in place.
   */
  const digests = new WeakMap<ImageContent, { data: string; digest: string }>();

  const digestOf = (image: ImageContent): string => {
    const known = digests.get(image);
    if (known !== undefined && known.data === image.data) return known.digest;
    const digest = createHash("sha256").update(image.data).digest("hex");
    digests.set(image, { data: image.data, digest });
    return digest;
  };

  const forget = (key: string, entry: MemoEntry): void => {
    memo.delete(key);
    heldBytes -= entry.bytes;
  };

  const outcomeFor = async (
    image: ImageContent,
    profile: Required<ImageFitProfile>,
  ): Promise<ImageOutcome> => {
    const key = [
      digestOf(image),
      image.mimeType,
      profile.maxWidthPx,
      profile.maxHeightPx,
      profile.maxBase64Bytes,
      profile.jpegQuality,
    ].join(":");
    const hit = memo.get(key);
    if (hit !== undefined) {
      memo.delete(key);
      memo.set(key, hit);
      return hit.outcome;
    }
    const fitted = await fit(Buffer.from(image.data, "base64"), image.mimeType, profile);
    const outcome: ImageOutcome =
      fitted.kind === "unchanged"
        ? { kind: "keep" }
        : fitted.kind === "fitted"
          ? {
              kind: "replace",
              image: { type: "image", data: fitted.data, mimeType: fitted.mimeType },
            }
          : { kind: "omit" };
    // Two requests can race to the same image; both computed the same bytes,
    // so the later one simply takes the earlier one's place.
    const raced = memo.get(key);
    if (raced !== undefined) forget(key, raced);
    const entry: MemoEntry = {
      outcome,
      bytes: outcome.kind === "replace" ? outcome.image.data.length : 0,
    };
    memo.set(key, entry);
    heldBytes += entry.bytes;
    for (const [coldKey, cold] of memo) {
      if (memo.size <= maxEntries && heldBytes <= maxBytes) break;
      forget(coldKey, cold);
    }
    return outcome;
  };

  return {
    async sanitize(messages, model) {
      // A model that takes no images has them downgraded to text by pi-ai's
      // own message transform; there is nothing here to fit.
      if (!model.input.includes("image")) return [...messages];
      const slots: ImageSlot[] = [];
      messages.forEach((message, index) => {
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;
        (content as readonly { type: string }[]).forEach((block, blockIndex) => {
          if (block.type === "image")
            slots.push({ message: index, block: blockIndex, image: block as ImageContent });
        });
      });
      if (slots.length === 0) return [...messages];

      const limits = providerImageLimits(model);
      const byCount = evictionCount(slots.length - limits.maxImagesPerRequest, slots.length);
      const profile = profileFor(limits, slots.length - byCount);

      // Newest first, and only until the budget is spent: every image older
      // than the one that overflows it goes anyway, so fitting it would hold a
      // re-encoded copy nothing sends. What one request holds is then about
      // its own budget however long the history is. The answer is the one an
      // oldest-first walk gives — the fewest oldest images whose removal
      // brings the rest under budget — because sizes are never negative.
      //
      // Sequential on purpose: a 4K screenshot decodes to ~28 MB of raster,
      // and a first request after a long Session resumes may carry dozens.
      // Every later request is a memo hit, so the latency is paid once.
      const outcomes = new Map<number, ImageOutcome>();
      let total = 0;
      let byBytes = byCount;
      for (let index = slots.length - 1; index >= byCount; index -= 1) {
        const image = slots[index]!.image;
        const outcome = await outcomeFor(image, profile);
        total +=
          outcome.kind === "keep"
            ? image.data.length
            : outcome.kind === "replace"
              ? outcome.image.data.length
              : 0;
        if (total > limits.requestImageBudgetBytes) {
          byBytes = index + 1;
          break;
        }
        outcomes.set(index, outcome);
      }
      const evicted = evictionCount(byBytes, slots.length);

      const edits = new Map<number, Map<number, ImageContent | TextContent>>();
      slots.forEach((slot, index) => {
        // Every image the eviction keeps was fitted: `evicted` never falls
        // below the point the budget walk stopped at.
        const outcome = index < evicted ? null : outcomes.get(index)!;
        const replacement: ImageContent | TextContent | undefined =
          outcome === null
            ? { type: "text", text: EVICTED_IMAGE_TEXT }
            : outcome.kind === "replace"
              ? outcome.image
              : outcome.kind === "omit"
                ? { type: "text", text: UNUSABLE_IMAGE_TEXT }
                : undefined;
        if (replacement === undefined) return;
        const inMessage = edits.get(slot.message) ?? new Map();
        inMessage.set(slot.block, replacement);
        edits.set(slot.message, inMessage);
      });

      return messages.map((message, index) => {
        const inMessage = edits.get(index);
        if (inMessage === undefined) return message;
        const content = (message as unknown as { content: readonly unknown[] }).content;
        return {
          ...message,
          content: content.map((block, blockIndex) => inMessage.get(blockIndex) ?? block),
        };
      });
    },
  };
}

/** The process-wide guard: one memo shared by every Session and every request path. */
export const providerImageGuard = createProviderImageGuard();

/**
 * Run every request of a `streamFn` through the image guard, against the
 * model that request is actually going to.
 */
export function withProviderSafeImages(inner: StreamFn, guard: ProviderImageGuard): StreamFn {
  return async (model, context, options) =>
    inner(model, { ...context, messages: await guard.sanitize(context.messages, model) }, options);
}
