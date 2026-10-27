import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { jsonWireSchema } from "./json-wire-schema";
import { uiMessageWireSchema } from "./output-schema";

describe("JSON wire values", () => {
  it("rejects object and array cycles, including inside transcript metadata and parts", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push({ nested: array });
    for (const value of [object, array]) {
      expect(jsonWireSchema.safeParse(value).success).toBe(false);
      expect(
        uiMessageWireSchema.safeParse({
          id: "message",
          role: "assistant",
          metadata: value,
          parts: [{ type: "data-custom", data: value }],
        }).success,
      ).toBe(false);
    }
  });

  it("preserves shared but acyclic references and ordinary JSON", () => {
    const shared = { value: [null, true, 1, "text"] };
    const value = { left: shared, right: shared };
    expect(jsonWireSchema.parse(value)).toEqual(value);
    expect(jsonWireSchema.parse(null)).toBeNull();
  });

  it("publishes a JSON schema without a custom parser or transform", () => {
    expect(() => z.toJSONSchema(jsonWireSchema)).not.toThrow();
  });
});
