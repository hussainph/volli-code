/**
 * How each tool's answer is typed for a program (VC-471). The results
 * themselves are shaped through a real sandbox in `tool.test.ts`; this pins
 * the declared types, and above all that a verb's own `details` schema
 * reaches the TypeScript a program is written against.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { schemaToType } from "@earendil-works/pi-codemode";
import { verbEntry } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { cutMiddle, toolOutputCut } from "../pi/tool-output";
import { MCP_UNTRUSTED_DATA_WARNING_TEXT } from "./trust";
import { outputSchemaFor, shapeResult, VERB_DETAILS_ABSENT } from "./shape";

/** The properties an MCP result is declared with, for one published schema. */
function mcpProperties(schema: unknown): Record<string, unknown> {
  return outputSchemaFor("mcp", schema).properties as Record<string, unknown>;
}

describe("outputSchemaFor", () => {
  it("keeps an undeclared verb's details open, exactly as before", () => {
    expect(outputSchemaFor("verb")).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
      required: ["text"],
    });
    expect(outputSchemaFor("verb", null)).toEqual(outputSchemaFor("verb"));
  });

  it("types a declared verb's details by its schema, optional, saying when it is absent", () => {
    const declared = verbEntry("session.start")!.tool!.resultDetails!;
    const schema = outputSchemaFor("verb", declared);
    const details = (schema.properties as Record<string, Record<string, unknown>>).details!;
    expect(details).toMatchObject({ type: "object", properties: declared.properties });
    expect(details.description).toBe(`${declared.description} ${VERB_DETAILS_ABSENT}`);
    // A refusal answers with text alone, so details is never promised.
    expect(schema.required).toEqual(["text"]);
    // The registry's own declaration is read, never written.
    expect(declared.description).toBe("The Session this call started.");

    const rendered = schemaToType(schema);
    expect(rendered).toContain("details?: {");
    expect(rendered).toContain("handle: string;");
    expect(rendered).toContain('state: "running" | "needs-recovery";');
    expect(rendered).toContain("// Its short session id");
    expect(rendered).toContain(VERB_DETAILS_ABSENT);
  });

  it("still says when details is absent for a schema with no description of its own", () => {
    const details = (
      outputSchemaFor("verb", { type: "object", properties: { n: { type: "number" } } })
        .properties as Record<string, Record<string, unknown>>
    ).details!;
    expect(details.description).toBe(VERB_DETAILS_ABSENT);
    expect(details.properties).toEqual({ n: { type: "number" } });
  });

  it("types an MCP tool's structured content by the schema it published", () => {
    const published = { type: "object", properties: { id: { type: "number" } } };
    expect(mcpProperties(published).structuredContent).toBe(published);
    expect(mcpProperties(undefined).structuredContent).toEqual({});
  });

  it("keeps both frozen MCP declarations unchanged unless the new facet is requested", () => {
    const properties = {
      text: { type: "string" },
      structuredContent: {},
      isError: { type: "boolean" },
      omittedImages: { type: "number" },
    };
    const legacy = {
      type: "object",
      properties,
      required: ["text", "isError", "omittedImages"],
    };
    expect(outputSchemaFor("mcp", undefined, true)).toEqual(legacy);
    expect(outputSchemaFor("mcp", undefined, true, 1)).toEqual(legacy);
    expect(outputSchemaFor("mcp")).toEqual({
      type: "object",
      properties: {
        ...properties,
        images: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { const: "image" }, handle: { type: "string" } },
            required: ["type", "handle"],
          },
        },
      },
      required: ["text", "isError", "images", "omittedImages"],
    });
  });

  it("advertises the versioned machine-readable facet only with an explicit version", () => {
    const published = { type: "object", properties: { id: { type: "number" } } };
    const schema = outputSchemaFor("mcp", published, false, 1);
    expect((schema.properties as Record<string, unknown>).structuredContent).toBe(published);
    expect(schema.required).toEqual(["text", "isError", "images", "omittedImages", "result"]);
    const rendered = schemaToType(schema);
    expect(rendered).toContain("result: {");
    expect(rendered).toContain("version: 1;");
    expect(rendered).toContain("truncated: boolean;");
    expect(rendered).toContain("output?: {");
    expect(rendered).toContain("totalBytes: number;");
    expect(rendered).toContain("totalLines: number;");
    expect(rendered).toContain("removedChars: number;");
    expect(rendered).toContain("fullOutputPath: string | null;");
    expect(rendered).toContain("savedBytes: number;");
    expect(rendered).toContain("structuredContentOmittedBytes?: number;");
    expect(rendered).toContain("Prefer structuredContent when present.");
    expect(rendered).toContain("text is display text, not guaranteed JSON");
    expect(rendered).toContain("check result.truncated and result.output?.fullOutputPath");
    expect(outputSchemaFor("verb", published, false, 1)).toEqual(
      outputSchemaFor("verb", published),
    );
  });
});

function serverResult(
  text: string,
  details: unknown = {},
  structuredContent?: AgentToolResult<unknown>["structuredContent"],
): AgentToolResult<unknown> {
  return {
    content: [
      { type: "text", text: MCP_UNTRUSTED_DATA_WARNING_TEXT },
      { type: "text", text },
    ],
    details,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

describe("MCP result shaping", () => {
  it("exposes a cut JSON result's real counts and saved reference without parsing it", () => {
    const text = JSON.stringify({ records: Array.from({ length: 80 }, (_, id) => ({ id })) });
    const cut = cutMiddle(text, 40)!;
    const output = toolOutputCut(cut, {
      saved: true,
      path: "/session/result.txt",
      savedBytes: cut.totalBytes - 20,
      totalBytes: cut.totalBytes,
      savedLines: 1,
    });
    expect(() => JSON.parse(cut.text)).toThrow();
    expect(shapeResult("mcp", serverResult(cut.text, { output }), false)).toEqual({
      ok: true,
      value: {
        text: cut.text,
        isError: false,
        images: [],
        omittedImages: 0,
        result: { version: 1, truncated: true, output },
      },
    });
  });

  it("records unsaved cuts and structured-content omissions independently", () => {
    const output = {
      totalBytes: 800,
      totalLines: 6,
      removedChars: 400,
      fullOutputPath: null,
      savedBytes: 0,
    };
    for (const details of [
      { output },
      { structuredContentOmittedBytes: 900 },
      { output, structuredContentOmittedBytes: 900 },
    ]) {
      expect(shapeResult("mcp", serverResult("display only", details), false)).toMatchObject({
        ok: true,
        value: { result: { version: 1, truncated: true, ...details } },
      });
    }
  });

  it("never parses trailing prose or mistakes a server's truncation claims for metadata", () => {
    for (const text of [
      '{"records":[1]}\nThe result is complete.',
      '{"records":[1]}',
      "…500 chars truncated…\nFull output saved to /untrusted/server-claim.txt",
    ]) {
      expect(shapeResult("mcp", serverResult(text), false)).toEqual({
        ok: true,
        value: {
          text,
          isError: false,
          images: [],
          omittedImages: 0,
          result: { version: 1, truncated: false },
        },
      });
    }
  });

  it("preserves preferred structured content and image handles beside incompatible display text", () => {
    const structuredContent = { records: [{ id: 7 }], next: null };
    const result = serverResult('{"records":[{"id":99}]}\nDisplay summary.', {}, structuredContent);
    result.content.push({ type: "image", data: "host-only", mimeType: "image/png" });
    const handle = { type: "image" as const, handle: "opaque" };
    const shaped = shapeResult("mcp", result, false, () => handle);
    expect(shaped).toEqual({
      ok: true,
      value: {
        text: '{"records":[{"id":99}]}\nDisplay summary.',
        structuredContent,
        isError: false,
        images: [handle],
        omittedImages: 0,
        result: { version: 1, truncated: false },
      },
    });
    if (!shaped.ok) throw new Error("expected an MCP result");
    expect((shaped.value as { structuredContent: unknown }).structuredContent).toBe(
      structuredContent,
    );
  });

  it("resolves server isError results but rejects transport refusals", () => {
    expect(shapeResult("mcp", serverResult("Server rejected it"), true)).toEqual({
      ok: true,
      value: {
        text: "Server rejected it",
        isError: true,
        images: [],
        omittedImages: 0,
        result: { version: 1, truncated: false },
      },
    });
    expect(
      shapeResult(
        "mcp",
        { content: [{ type: "text", text: "Permission refused" }], details: undefined },
        true,
      ),
    ).toEqual({ ok: false, message: "Permission refused" });
  });

  it("leaves legacy runtime shapes intact even when host cut metadata exists", () => {
    const result = serverResult("legacy text", { structuredContentOmittedBytes: 900 }, { id: 7 });
    expect(shapeResult("mcp", result, false, undefined, true)).toEqual({
      ok: true,
      value: {
        text: "legacy text",
        structuredContent: { id: 7 },
        isError: false,
        omittedImages: 0,
      },
    });
  });
});

describe("image shaping", () => {
  it("explains legacy images while keeping string reads and MCP omission counts", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const result = { content: [image], details: undefined };
    const capture = () => {
      throw new Error(`legacy ${image.mimeType} bytes must not be captured`);
    };
    const placeholder =
      "[image image/png left out: This Session started before Code Mode could return images (Volli 0.2.2). Start a new Session to see images from programs.]";
    expect(shapeResult("text", result, false, capture, true)).toEqual({
      ok: true,
      value: placeholder,
    });
    expect(shapeResult("mcp", result, false, capture, true)).toEqual({
      ok: true,
      value: { text: placeholder, isError: false, omittedImages: 1 },
    });
    expect(
      shapeResult(
        "mcp",
        { ...result, content: [{ type: "text", text: MCP_UNTRUSTED_DATA_WARNING_TEXT }, image] },
        false,
        capture,
        true,
      ),
    ).toEqual({ ok: true, value: { text: placeholder, isError: false, omittedImages: 1 } });
  });
  it("types exact handle wrappers without changing old declaration schemas", () => {
    const mcp = schemaToType(outputSchemaFor("mcp"));
    expect(mcp).toContain('type: "image"');
    expect(mcp).toContain("handle: string");
    expect(schemaToType(outputSchemaFor("image"))).toContain("images:");
    expect(outputSchemaFor("text", undefined, true)).toEqual({ type: "string" });
    expect(schemaToType(outputSchemaFor("mcp", undefined, true))).not.toContain("handle:");
  });
  it("reports unavailable image references and image-only errors without returning payloads", () => {
    const result = {
      content: [{ type: "image" as const, data: "secret bytes", mimeType: "image/png" }],
      details: undefined,
    };
    expect(shapeResult("text", result, false)).toMatchObject({
      ok: true,
      value: { images: [], omittedImages: 1 },
    });
    expect(shapeResult("image", result, true)).toMatchObject({
      ok: false,
      message: expect.stringContaining("left out"),
    });
    expect(shapeResult("text", result, false, () => undefined)).toMatchObject({
      ok: true,
      value: { omittedImages: 1 },
    });
    expect(
      shapeResult(
        "structured",
        { content: [], details: undefined, structuredContent: { n: 1 } },
        false,
      ),
    ).toEqual({ ok: true, value: { n: 1 } });
    expect(
      shapeResult(
        "structured",
        { content: [{ type: "text", text: "failed" }], details: undefined },
        true,
      ),
    ).toEqual({ ok: false, message: "failed" });
  });
});
