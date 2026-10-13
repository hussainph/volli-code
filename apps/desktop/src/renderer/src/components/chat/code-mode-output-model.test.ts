import { MCP_RESULT_IMAGE_MAX_BYTES } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  codeModeImageContent,
  codeModeImageDataUrl,
  readCodeModePicture,
} from "./code-mode-output-model";

function part(output: unknown): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "codemode",
    toolCallId: "run-1",
    state: "output-available",
    input: {},
    output,
  };
}

describe("Code Mode content", () => {
  it("keeps text and image blocks in their source order without changing bytes", () => {
    const content = [
      { type: "text", text: "Source and trust" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "text", text: "Another source and trust" },
      { type: "image", data: "ZGVm", mimeType: "image/jpeg" },
    ];
    expect(codeModeImageContent(part({ content }))).toEqual(content);
  });

  it("reads persisted picture ids without copying the bytes into the activity", () => {
    expect(
      codeModeImageContent(
        part({ content: [{ type: "image", mimeType: "image/png", picture: "picture-1" }] }),
      ),
    ).toEqual([{ type: "image", data: undefined, mimeType: "image/png", picture: "picture-1" }]);
  });

  it("does not change other tools or unfinished calls", () => {
    expect(codeModeImageContent({ ...part({}), toolName: "read" })).toBeNull();
    expect(
      codeModeImageContent({
        type: "dynamic-tool",
        toolName: "codemode",
        toolCallId: "bad",
        state: "output-error",
        input: null,
        errorText: "failed",
      }),
    ).toBeNull();
    expect(
      codeModeImageContent({
        type: "dynamic-tool",
        toolName: "codemode",
        toolCallId: "run-1",
        state: "input-available",
        input: {},
      }),
    ).toBeNull();
  });

  it.each([null, [], "text", 1, {}, { content: "text" }, { content: [] }])(
    "leaves non-image output on the existing path: %j",
    (output) => expect(codeModeImageContent(part(output))).toBeNull(),
  );

  it("ignores malformed and unrelated blocks but names an image with missing bytes", () => {
    expect(
      codeModeImageContent(
        part({
          content: [
            null,
            [],
            "text",
            3,
            {},
            { type: "text", text: 3 },
            { type: "audio" },
            { type: "image" },
          ],
        }),
      ),
    ).toEqual([{ type: "image", data: undefined, mimeType: undefined }]);
  });
});

describe("Code Mode image data URLs", () => {
  it.each(["png", "jpeg", "gif", "webp", "bmp"])("accepts a %s image", (mime) => {
    expect(
      codeModeImageDataUrl({ type: "image", data: "YWJjZA==", mimeType: `image/${mime}` }),
    ).toBe(`data:image/${mime};base64,YWJjZA==`);
  });

  it.each([
    {},
    { data: "YWJj", mimeType: 3 },
    { data: "YWJj", mimeType: "text/html" },
    { data: 3, mimeType: "image/png" },
    { data: "", mimeType: "image/png" },
    { data: "[image]", mimeType: "image/png" },
    { data: "YWJj…", mimeType: "image/png" },
  ])("names unavailable bytes rather than rendering a broken image: %j", (block) => {
    expect(codeModeImageDataUrl({ type: "image", ...block })).toBeNull();
  });
});

describe("Code Mode picture chunks", () => {
  it("joins bounded chunks and reads the failed result input facet without changing state", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: "YWJj", mimeType: "image/png", nextOffset: 3 })
      .mockResolvedValueOnce({ data: "ZA==", mimeType: "image/png", nextOffset: null });
    expect(await readCodeModePicture(query, "s", "pic")).toBe("data:image/png;base64,YWJjZA==");
    expect(query.mock.calls).toEqual([
      [{ sessionId: "s", pictureId: "pic", offset: 0 }],
      [{ sessionId: "s", pictureId: "pic", offset: 3 }],
    ]);
    expect(
      codeModeImageContent({
        type: "dynamic-tool",
        toolName: "codemode",
        toolCallId: "run",
        state: "output-error",
        input: { "volli.activity.output": { content: [{ type: "image", picture: "pic" }] } },
        errorText: "failed",
      }),
    ).toEqual([{ type: "image", data: undefined, mimeType: undefined, picture: "pic" }]);
  });
  it.each([
    { data: null, mimeType: null, nextOffset: null },
    { data: "", mimeType: "image/png", nextOffset: null },
    { data: "invalid!", mimeType: "image/png", nextOffset: null },
    { data: "YWJj", mimeType: null, nextOffset: null },
    { data: "YWJj", mimeType: "text/html", nextOffset: null },
    { data: "YWJj", mimeType: "image/png", nextOffset: 0 },
    { data: "YWJj", mimeType: "image/png", nextOffset: 1 },
    { data: "YWJj", mimeType: "image/png", nextOffset: NaN },
    { data: "ZA==", mimeType: "image/png", nextOffset: 3 },
    { data: "A".repeat(MCP_RESULT_IMAGE_MAX_BYTES + 4), mimeType: "image/png", nextOffset: null },
  ])("names an invalid or unavailable picture without returning partial bytes", async (result) => {
    expect(await readCodeModePicture(async () => result, "s", "pic")).toBeNull();
  });
  it("rejects changing MIME types and a host returning an endless stream of tiny chunks", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: "YWJj", mimeType: "image/png", nextOffset: 3 })
      .mockResolvedValueOnce({ data: "ZA==", mimeType: "image/jpeg", nextOffset: null });
    expect(await readCodeModePicture(query, "s", "pic")).toBeNull();
    const endless = vi.fn(async ({ offset = 0 }) => ({
      data: "YWJj",
      mimeType: "image/png",
      nextOffset: offset + 3,
    }));
    expect(await readCodeModePicture(endless, "s", "pic")).toBeNull();
    expect(endless).toHaveBeenCalledTimes(128);
  });
});
