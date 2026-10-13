/**
 * How each tool's answer is typed for a program (VC-471). The results
 * themselves are shaped through a real sandbox in `tool.test.ts`; this pins
 * the declared types, and above all that a verb's own `details` schema
 * reaches the TypeScript a program is written against.
 */

import { schemaToType } from "@earendil-works/pi-codemode";
import { verbEntry } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
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
});

describe("image shaping", () => {
  it("keeps legacy image placeholders, string reads and MCP omission counts unchanged", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const result = { content: [image], details: undefined };
    const capture = () => {
      throw new Error(`legacy ${image.mimeType} bytes must not be captured`);
    };
    const placeholder = "[image image/png left out: Code Mode passes no images to programs]";
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
