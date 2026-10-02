/**
 * How each tool's answer is typed for a program (VC-471). The results
 * themselves are shaped through a real sandbox in `tool.test.ts`; this pins
 * the declared types, and above all that a verb's own `details` schema
 * reaches the TypeScript a program is written against.
 */

import { schemaToType } from "@earendil-works/pi-codemode";
import { verbEntry } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { outputSchemaFor, VERB_DETAILS_ABSENT } from "./shape";

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
