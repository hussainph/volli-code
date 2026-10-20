import { randomBytes } from "node:crypto";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import sharp from "sharp";
import { describe, expect, it, vi } from "vite-plus/test";
import { fitImage, type ImageFit } from "./image-fit";
import {
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_BYTES,
  EVICTED_IMAGE_TEXT,
  EVICTION_STEP,
  REQUEST_IMAGE_BUDGET_FRACTION,
  UNUSABLE_IMAGE_TEXT,
  createProviderImageGuard,
  providerImageLimits,
  withProviderSafeImages,
} from "./provider-images";

/** A real catalog entry: 32 MiB requests, 100 images, a 2000 px / 4.5 MiB profile. */
const opus: Model<Api> = getBuiltinModel("anthropic", "claude-opus-4-5");
/** The same model with no catalog limits, as a refreshed or custom entry may arrive. */
const bare: Model<Api> = { ...opus, inputLimits: undefined };

function withLimits(inputLimits: Model<Api>["inputLimits"]): Model<Api> {
  return { ...opus, inputLimits };
}

async function png(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: "#3a6ea5" },
  })
    .png()
    .toBuffer();
  return bytes.toString("base64");
}

function image(data: string, mimeType = "image/png"): ImageContent {
  return { type: "image", data, mimeType };
}

function screenshotResult(id: number, shot: ImageContent): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "browser_screenshot",
    content: [{ type: "text", text: `Screenshot ${id}` }, shot],
    isError: false,
    timestamp: id,
  };
}

function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 0 };
}

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Looking." }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: opus.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
};

function imagesOf(messages: readonly Message[]): ImageContent[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block): block is ImageContent => block.type === "image")
      : [],
  );
}

function textsOf(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
      : [],
  );
}

/** A stand-in pipeline: every image is already legal, so its size is its own. */
function keepAll(): ReturnType<typeof vi.fn<typeof fitImage>> {
  return vi.fn<typeof fitImage>(async () => ({ kind: "unchanged" }));
}

/**
 * Anthropic's documented image rules, checked the way the provider checks
 * them. Each string is the error the provider answers with; a request that
 * yields none of them is one it accepts.
 */
async function anthropicViolations(messages: readonly Message[]): Promise<string[]> {
  const images = imagesOf(messages);
  const violations: string[] = [];
  let total = 0;
  for (const [index, one] of images.entries()) {
    total += one.data.length;
    const { width, height } = await sharp(Buffer.from(one.data, "base64")).metadata();
    const edge = images.length > 20 ? 2_000 : 8_000;
    if (width > edge || height > edge)
      violations.push(
        `content.${index}.image.source.base64.data: At least one of the image dimensions exceed max allowed size`,
      );
    if (one.data.length > 5 * 1024 * 1024) violations.push(`image ${index} exceeds 5 MB`);
  }
  if (total > DEFAULT_MAX_REQUEST_BYTES) violations.push("request_too_large");
  return violations;
}

describe("provider image limits", () => {
  it("reads the per-model limits from pi-ai's generated catalog", () => {
    expect(providerImageLimits(opus)).toEqual({
      profile: {
        maxWidthPx: 2_000,
        maxHeightPx: 2_000,
        maxBase64Bytes: 4_718_592,
        jpegQuality: 80,
      },
      maxImagesPerRequest: 100,
      requestImageBudgetBytes: Math.floor(33_554_432 * REQUEST_IMAGE_BUDGET_FRACTION),
    });
    // A newer Claude takes more images; the guard follows the catalog, not a constant.
    expect(
      providerImageLimits(getBuiltinModel("anthropic", "claude-sonnet-4-5")).maxImagesPerRequest,
    ).toBe(600);
  });

  it("falls back to Anthropic's documented limits where the catalog is silent", () => {
    expect(providerImageLimits(bare)).toEqual({
      profile: {
        maxWidthPx: 2_000,
        maxHeightPx: 2_000,
        maxBase64Bytes: 4_718_592,
        jpegQuality: 80,
      },
      maxImagesPerRequest: DEFAULT_MAX_IMAGES_PER_REQUEST,
      requestImageBudgetBytes: Math.floor(
        DEFAULT_MAX_REQUEST_BYTES * REQUEST_IMAGE_BUDGET_FRACTION,
      ),
    });
  });

  it("never lets a profile exceed the absolute per-image edge", () => {
    const lenient = withLimits({ images: { resize: { maxWidth: 12_000, maxHeight: 9_000 } } });
    expect(providerImageLimits(lenient).profile).toMatchObject({
      maxWidthPx: 8_000,
      maxHeightPx: 8_000,
    });
  });
});

describe("provider image guard", () => {
  it("leaves a request with no images, and every non-image block, exactly as it was", async () => {
    const fit = keepAll();
    const guard = createProviderImageGuard({ fit });
    const messages: Message[] = [
      user("plain text"),
      assistant,
      user([{ type: "text", text: "x" }]),
    ];

    const sent = await guard.sanitize(messages, opus);

    expect(sent).toEqual(messages);
    sent.forEach((message, index) => expect(message).toBe(messages[index]));
    expect(sent).not.toBe(messages);
    expect(fit).not.toHaveBeenCalled();
  });

  it("does not fit images for a model that takes none; pi-ai downgrades those itself", async () => {
    const fit = keepAll();
    const guard = createProviderImageGuard({ fit });
    const textOnly: Model<Api> = { ...opus, input: ["text"] };
    const messages = [user([image("aGVsbG8=")])];

    const sent = await guard.sanitize(messages, textOnly);

    expect(sent[0]).toBe(messages[0]);
    expect(fit).not.toHaveBeenCalled();
  });

  it("passes an already-legal image through byte-for-byte and keeps its message object", async () => {
    const guard = createProviderImageGuard();
    const small = await png(640, 400);
    const messages: Message[] = [user([{ type: "text", text: "see" }, image(small)]), assistant];

    const sent = await guard.sanitize(messages, opus);

    expect(sent[0]).toBe(messages[0]);
    expect(imagesOf(sent)[0]!.data).toBe(small);
  });

  it("clamps an oversized image to the model's edge without touching the durable message", async () => {
    const guard = createProviderImageGuard();
    const retina = await png(3_668, 1_896);
    const original = screenshotResult(1, image(retina));
    const messages: Message[] = [original];

    const sent = await guard.sanitize(messages, opus);

    const [fitted] = imagesOf(sent);
    const size = await sharp(Buffer.from(fitted!.data, "base64")).metadata();
    expect(fitted!.mimeType).toBe("image/jpeg");
    expect(Math.max(size.width, size.height)).toBe(2_000);
    // The transcript keeps the capture as it was taken.
    expect(sent[0]).not.toBe(original);
    expect((original.content[1] as ImageContent).data).toBe(retina);
    expect(original.content[0]).toEqual({ type: "text", text: "Screenshot 1" });
    expect((sent[0] as ToolResultMessage).content[0]).toBe(original.content[0]);
  });

  it("tightens every image to the many-image edge once a request carries more than twenty", async () => {
    // A profile more lenient than the many-image rule, which is the one case
    // where crossing the line changes bytes.
    const lenient = withLimits({
      images: { maxPerRequest: 600, resize: { maxWidth: 4_000, maxHeight: 4_000 } },
    });
    const wide = await png(3_000, 200);
    const guard = createProviderImageGuard();

    const twenty = await guard.sanitize(
      Array.from({ length: 20 }, (_, id) => screenshotResult(id, image(wide))),
      lenient,
    );
    const twentyOne = await guard.sanitize(
      Array.from({ length: 21 }, (_, id) => screenshotResult(id, image(wide))),
      lenient,
    );

    expect(imagesOf(twenty).every((one) => one.data === wide)).toBe(true);
    const tightened = imagesOf(twentyOne);
    expect(tightened).toHaveLength(21);
    for (const one of tightened) {
      const size = await sharp(Buffer.from(one.data, "base64")).metadata();
      expect(one.mimeType).toBe("image/jpeg");
      // `fit: "inside"` keeps the aspect ratio, so a 133 px height lands a few
      // pixels short of the 2000 px box.
      expect(size.width).toBeLessThanOrEqual(2_000);
      expect(size.width).toBeGreaterThan(1_990);
    }
  });

  it("drops the oldest images, in whole steps, past the model's per-request image cap", async () => {
    const guard = createProviderImageGuard({ fit: keepAll() });
    const capped = withLimits({ images: { maxPerRequest: 25 } });
    const messages = Array.from({ length: 30 }, (_, id) =>
      screenshotResult(id, image(`shot-${id}`)),
    );

    const sent = await guard.sanitize(messages, capped);

    // Five over the cap, rounded up to one whole step.
    expect(EVICTION_STEP).toBe(10);
    const kept = imagesOf(sent).map((one) => one.data);
    expect(kept).toEqual(Array.from({ length: 20 }, (_, index) => `shot-${index + 10}`));
    for (const message of sent.slice(0, 10))
      expect((message as ToolResultMessage).content[1]).toEqual({
        type: "text",
        text: EVICTED_IMAGE_TEXT,
      });
    sent.slice(10).forEach((message, index) => expect(message).toBe(messages[index + 10]));
  });

  it("keeps the newest images inside the request byte budget and holds the cut still between steps", async () => {
    const guard = createProviderImageGuard({ fit: keepAll() });
    // A 1000-byte budget at 100 bytes an image: ten fit.
    const small = withLimits({ maxRequestBytes: Math.ceil(1_000 / REQUEST_IMAGE_BUDGET_FRACTION) });
    const shot = (id: number) => screenshotResult(id, image(String(id).padStart(100, "0")));

    const eleven = await guard.sanitize(
      Array.from({ length: 11 }, (_, id) => shot(id)),
      small,
    );
    const fifteen = await guard.sanitize(
      Array.from({ length: 15 }, (_, id) => shot(id)),
      small,
    );

    // One over the budget costs a whole step, so the next four screenshots
    // arrive without rewriting the prefix again.
    expect(imagesOf(eleven)).toHaveLength(1);
    expect(imagesOf(fifteen)).toHaveLength(5);
    expect(eleven.slice(0, 10)).toEqual(fifteen.slice(0, 10));
    expect(textsOf(fifteen).filter((text) => text === EVICTED_IMAGE_TEXT)).toHaveLength(10);
    expect(imagesOf(fifteen).at(-1)!.data).toBe(String(14).padStart(100, "0"));
  });

  it("never lets a step take every image: ten one byte over budget lose only the oldest", async () => {
    const guard = createProviderImageGuard({ fit: keepAll() });
    const small = withLimits({ maxRequestBytes: Math.ceil(1_000 / REQUEST_IMAGE_BUDGET_FRACTION) });
    // Ten images of 101 bytes: 1010 against a 1000-byte budget.
    const shots = Array.from({ length: 10 }, (_, id) =>
      screenshotResult(id, image(String(id).padStart(101, "0"))),
    );

    const sent = await guard.sanitize(shots, small);

    expect(imagesOf(sent).map((one) => one.data)).toEqual(
      Array.from({ length: 9 }, (_, index) => String(index + 1).padStart(101, "0")),
    );
    expect(textsOf(sent).filter((text) => text === EVICTED_IMAGE_TEXT)).toHaveLength(1);

    // The same holds for the count cap: six images against a cap of five.
    const capped = await guard.sanitize(
      Array.from({ length: 6 }, (_, id) => screenshotResult(id, image(`shot-${id}`))),
      withLimits({ images: { maxPerRequest: 5 } }),
    );
    expect(imagesOf(capped)).toHaveLength(5);
  });

  it("fits only the images the byte budget can keep, newest first", async () => {
    const fit = keepAll();
    const guard = createProviderImageGuard({ fit });
    const small = withLimits({ maxRequestBytes: Math.ceil(1_000 / REQUEST_IMAGE_BUDGET_FRACTION) });
    const shots = Array.from({ length: 25 }, (_, id) =>
      screenshotResult(id, image(String(id).padStart(100, "0"))),
    );

    await guard.sanitize(shots, small);

    // The ten that fit, and the one that overflowed the budget; the fourteen
    // older ones are evicted without being fitted.
    expect(fit).toHaveBeenCalledTimes(11);
  });

  it("replaces an image no safe copy can be made of with a placeholder", async () => {
    const guard = createProviderImageGuard();
    const messages = [user([image("bm90IGFuIGltYWdl"), { type: "text", text: "what is this" }])];

    const sent = await guard.sanitize(messages, opus);

    expect(sent[0]!.content).toEqual([
      { type: "text", text: UNUSABLE_IMAGE_TEXT },
      { type: "text", text: "what is this" },
    ]);
  });

  it("rewrites every changed image of one message, and only those", async () => {
    const guard = createProviderImageGuard();
    const retina = await png(2_400, 1_000);
    const small = await png(10, 10);
    const messages = [user([image(retina), image(small), image("bm90IGFuIGltYWdl")])];

    const [sent] = await guard.sanitize(messages, opus);

    const content = sent!.content as (TextContent | ImageContent)[];
    expect((content[0] as ImageContent).mimeType).toBe("image/jpeg");
    expect(content[1]).toBe(messages[0]!.content[1]);
    expect(content[2]).toEqual({ type: "text", text: UNUSABLE_IMAGE_TEXT });
  });

  it("makes the same bytes from the same image, in any guard, on any request", async () => {
    const retina = await png(3_668, 1_896);
    const first = await createProviderImageGuard().sanitize([user([image(retina)])], opus);
    const second = await createProviderImageGuard().sanitize(
      [assistant, user([image(retina)])],
      opus,
    );

    expect(imagesOf(second)[0]!.data).toBe(imagesOf(first)[0]!.data);
  });

  it("fits each image once per profile, however many requests or block copies carry it", async () => {
    const fit = vi.fn(fitImage);
    const guard = createProviderImageGuard({ fit });
    const retina = await png(2_400, 1_200);
    const block = image(retina);

    const first = await guard.sanitize([user([block])], opus);
    const again = await guard.sanitize([user([block])], opus);
    // A different object with the same bytes, as a reloaded transcript has.
    const reloaded = await guard.sanitize([user([image(retina)])], opus);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(imagesOf(again)[0]).toBe(imagesOf(first)[0]);
    expect(imagesOf(reloaded)[0]).toBe(imagesOf(first)[0]);

    // A block whose bytes were replaced in place is a different image.
    block.data = await png(2_500, 1_200);
    await guard.sanitize([user([block])], opus);
    expect(fit).toHaveBeenCalledTimes(2);

    // Another profile is another result.
    await guard.sanitize([user([block])], withLimits({ images: { resize: { maxWidth: 1_000 } } }));
    expect(fit).toHaveBeenCalledTimes(3);
  });

  it("forgets the coldest results past its entry bound", async () => {
    const fit = keepAll();
    const guard = createProviderImageGuard({ fit, maxEntries: 1 });

    await guard.sanitize([user([image("b25l")])], opus);
    await guard.sanitize([user([image("dHdv")])], opus);
    await guard.sanitize([user([image("b25l")])], opus);

    expect(fit).toHaveBeenCalledTimes(3);
  });

  it("does not hold a re-encoded image larger than its byte bound", async () => {
    const encoded: ImageFit = {
      kind: "fitted",
      data: "x".repeat(64),
      mimeType: "image/jpeg",
      original: { width: 4_000, height: 10 },
      displayed: { width: 2_000, height: 5 },
    };
    const fit = vi.fn<typeof fitImage>(async () => encoded);
    const guard = createProviderImageGuard({ fit, maxBytes: 32 });

    const first = await guard.sanitize([user([image("b25l")])], opus);
    await guard.sanitize([user([image("b25l")])], opus);

    expect(imagesOf(first)[0]).toEqual({
      type: "image",
      data: encoded.data,
      mimeType: "image/jpeg",
    });
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it("lets two requests racing to one image agree, and remembers it once", async () => {
    const fit = vi.fn(fitImage);
    const guard = createProviderImageGuard({ fit, maxEntries: 1 });
    const retina = await png(2_400, 1_200);

    const [left, right] = await Promise.all([
      guard.sanitize([user([image(retina)])], opus),
      guard.sanitize([user([image(retina)])], opus),
    ]);
    await guard.sanitize([user([image(retina)])], opus);

    expect(imagesOf(left)[0]!.data).toBe(imagesOf(right)[0]!.data);
    expect(fit).toHaveBeenCalledTimes(2);
  });
});

describe("the failures this guard exists to end", () => {
  it("sends twenty-five Retina screenshots as a request Anthropic accepts", async () => {
    const retina = await png(3_668, 1_896);
    const messages: Message[] = Array.from({ length: 25 }, (_, id) =>
      screenshotResult(id, image(retina)),
    );
    // What was refused on 2026-09-14 and 2026-09-28: every screenshot past the
    // twentieth made the earlier large ones illegal.
    expect(await anthropicViolations(messages)).toContain(
      "content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size",
    );

    const sent = await createProviderImageGuard().sanitize(messages, opus);

    expect(imagesOf(sent)).toHaveLength(25);
    expect(await anthropicViolations(sent)).toEqual([]);
  });

  it("keeps a request with many large, individually legal images under the request ceiling", async () => {
    // Random pixels: a PNG that barely compresses, ~1.9 MB of base64 each.
    const noise = randomBytes(800 * 600 * 3);
    const heavy = (
      await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } })
        .png()
        .toBuffer()
    ).toString("base64");
    const messages: Message[] = Array.from({ length: 30 }, (_, id) =>
      screenshotResult(id, image(heavy)),
    );
    expect(await anthropicViolations(messages)).toContain("request_too_large");

    const sent = await createProviderImageGuard().sanitize(messages, opus);

    expect(await anthropicViolations(sent)).toEqual([]);
    const total = imagesOf(sent).reduce((sum, one) => sum + one.data.length, 0);
    expect(total).toBeLessThanOrEqual(providerImageLimits(opus).requestImageBudgetBytes);
    // The newest screenshot is always among the ones kept.
    expect((sent.at(-1) as ToolResultMessage).content[1]).toBe(
      (messages.at(-1) as ToolResultMessage).content[1],
    );
  });
});

describe("withProviderSafeImages", () => {
  it("hands the inner stream function the guarded transcript for the request's own model", async () => {
    const stream = createAssistantMessageEventStream();
    const inner = vi.fn(() => stream);
    const guard = createProviderImageGuard({ fit: keepAll() });
    const capped = withLimits({ images: { maxPerRequest: 1 } });
    const context = normalizeContext({
      systemPrompt: "system",
      messages: [screenshotResult(1, image("b25l")), screenshotResult(2, image("dHdv"))],
    });
    const options = { maxTokens: 10 };

    const produced = await withProviderSafeImages(inner, guard)(capped, context, options);

    expect(produced).toBe(stream);
    const [model, sent, passed] = inner.mock.calls[0] as unknown as Parameters<
      Parameters<typeof withProviderSafeImages>[0]
    >;
    expect(model).toBe(capped);
    expect(passed).toBe(options);
    expect(sent.messages[0]).toBe(context.messages[0]);
    // One image allowed: the newest goes, the older one is evicted.
    expect(imagesOf(sent.messages)).toEqual([image("dHdv")]);
    expect(imagesOf(context.messages)).toHaveLength(2);
  });
});
