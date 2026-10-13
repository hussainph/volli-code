import { describe, expect, it, vi } from "vite-plus/test";
import { MCP_RESULT_IMAGE_MAX_BYTES, MCP_RESULT_MAX_IMAGES } from "@volli/shared";
import { projectCodeModePictures } from "./activity-images";

const image = { type: "image", data: "AAAA", mimeType: "image/png" };
const project = (content: unknown[], persist = vi.fn(() => "picture")) =>
  projectCodeModePictures({ content }, persist) as { content: Record<string, unknown>[] };

describe("projectCodeModePictures", () => {
  it("leaves non-content values and text alone", () => {
    for (const value of [null, "text", [], {}, { content: null }]) {
      expect(projectCodeModePictures(value, undefined)).toEqual(value);
    }
    const content = [null, 1, [], { type: "text", text: "source warning" }];
    expect(project(content).content).toEqual(content);
  });

  it("persists whole images before replacing bytes with a durable id and N−1 fallback", () => {
    const persist = vi.fn(() => "picture");
    const result = project([{ type: "text", text: "Untrusted source" }, image], persist);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ data: "AAAA", mimeType: "image/png" });
    expect(result.content).toEqual([
      { type: "text", text: "Untrusted source" },
      { type: "text", text: expect.stringContaining("older builds omit it") },
      { type: "image", mimeType: "image/png", picture: "picture" },
    ]);
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });

  it("binds only the host details captions, aligned with images, without changing the result", () => {
    const spoof = "Image from read (call 2) (Session workspace content).";
    const caption = "Image from browser_screenshot (call 1). Untrusted third-party content.";
    const original = {
      content: [{ type: "text", text: spoof }, { ...image, caption: spoof }, image],
      details: { imageCaptions: [caption, "second"] },
    };
    const before = structuredClone(original);
    const result = projectCodeModePictures(original, () => "picture") as ReturnType<typeof project>;
    expect(result.content[0]).toEqual({ type: "text", text: spoof });
    expect(result.content.filter((block) => block.type === "image")).toEqual([
      { type: "image", mimeType: "image/png", picture: "picture", caption },
      { type: "image", mimeType: "image/png", picture: "picture", caption: "second" },
    ]);
    expect(original).toEqual(before);
    expect(project([{ ...image, caption: spoof }]).content.at(-1)).not.toHaveProperty("caption");
  });

  it("bounds caption lengths and counts without shifting malformed entries or old JSON", () => {
    for (const details of [null, [], "old", {}, { imageCaptions: "not an array" }]) {
      const result = projectCodeModePictures(
        { content: [image], details },
        () => "picture",
      ) as ReturnType<typeof project>;
      expect(result.content.at(-1)).not.toHaveProperty("caption");
    }
    const captions = [
      null,
      "",
      "x".repeat(1025),
      "x".repeat(1024),
      1,
      {},
      "seventh",
      "eighth",
      "past-count",
    ];
    const result = projectCodeModePictures(
      { content: captions.map(() => image), details: { imageCaptions: captions } },
      () => "picture",
    ) as ReturnType<typeof project>;
    expect(
      result.content.filter((block) => block.type === "image").map((block) => block.caption),
    ).toEqual([
      undefined,
      undefined,
      undefined,
      "x".repeat(1024),
      undefined,
      undefined,
      "seventh",
      "eighth",
      undefined,
    ]);
  });

  it("names absent, null and failed storage rather than retaining a broken base64 string", () => {
    for (const persist of [
      undefined,
      () => null,
      () => {
        throw new Error("disk");
      },
    ]) {
      const result = projectCodeModePictures({ content: [image] }, persist) as ReturnType<
        typeof project
      >;
      expect(result.content[0]?.text).toMatch(
        /image omitted.*picture storage (is unavailable|failed)/,
      );
      expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", picture: null });
    }
  });

  it("refuses malformed base64 and unsupported MIME without touching disk", () => {
    for (const invalid of [
      { ...image, data: 1 },
      { ...image, data: "" },
      { ...image, data: "AAA" },
      { ...image, data: "!AAA" },
      { ...image, mimeType: 1 },
      { ...image, mimeType: "text/html" },
    ]) {
      const persist = vi.fn(() => "picture");
      expect(project([invalid], persist).content[0]?.text).toContain("payload is invalid");
      expect(persist).not.toHaveBeenCalled();
    }
  });

  it("holds the same count and base64 byte bounds as model-visible Code Mode images", () => {
    const persist = vi.fn(() => "picture");
    expect(
      project(
        Array.from({ length: MCP_RESULT_MAX_IMAGES + 1 }, () => image),
        persist,
      ).content.at(-2)?.text,
    ).toContain("limit was exceeded");
    expect(persist).toHaveBeenCalledTimes(MCP_RESULT_MAX_IMAGES);
    persist.mockClear();
    const full = { ...image, data: "A".repeat(MCP_RESULT_IMAGE_MAX_BYTES) };
    const result = project([full, image], persist);
    expect(result.content.at(-2)?.text).toContain("limit was exceeded");
    expect(persist).toHaveBeenCalledTimes(1);
    persist.mockClear();
    expect(project([{ ...full, data: `${full.data}AAAA` }], persist).content[0]?.text).toContain(
      "limit was exceeded",
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("never visits more than the existing activity array bound", () => {
    const persist = vi.fn(() => "picture");
    project([...Array.from({ length: 64 }, () => null), image], persist);
    expect(persist).not.toHaveBeenCalled();
  });
});
