import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { hostSignInUpdateSchema, sessionProcedureSchemas } from "./index";
import {
  attentionSchema,
  eventSchema,
  receiptSchema,
  sessionCommandWireSchema,
  streamEmissionWireSchema,
} from "./output-schema";

const marker = "x-volli-open-union";
type Node = Record<string, unknown>;
function markedUnions(value: unknown, annotation = marker): Node[] {
  if (Array.isArray(value)) return value.flatMap((node) => markedUnions(node, annotation));
  if (value === null || typeof value !== "object") return [];
  const node = value as Node;
  return [
    ...(annotation in node ? [node] : []),
    ...Object.values(node).flatMap((child) => markedUnions(child, annotation)),
  ];
}
function vocabulary(node: Node): string {
  const discriminator = node[marker];
  expect(["kind", "status", "op"]).toContain(discriminator);
  expect(node.oneOf).toBeInstanceOf(Array);
  const variants = node.oneOf as Node[];
  const values = variants.flatMap((variant) => {
    const properties = variant.properties as Record<string, Node>;
    const field = properties[discriminator as string]!;
    expect(variant.required).toContain(discriminator);
    expect(field).toBeDefined();
    return "const" in field ? [field.const] : (field.enum as unknown[]);
  });
  expect(values.every((value) => typeof value === "string")).toBe(true);
  expect(new Set(values).size).toBe(values.length);
  return JSON.stringify([discriminator, values.toSorted()]);
}

describe("explicit tolerant-read output scalars", () => {
  it("marks only command refusal severity, on the enum before its nullable wrapper", () => {
    const enumMarker = "x-volli-open-enum";
    const refusal = z.toJSONSchema(sessionCommandWireSchema).properties!.refusal as Node;
    expect(refusal[enumMarker]).toBeUndefined();
    const nodes = markedUnions(refusal, enumMarker);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]![enumMarker]).toBe(true);
    expect(nodes[0]!.enum).toEqual(["benign", "failure"]);
    // Metadata is a reader promise, not a widening of the host's validator.
    expect(sessionCommandWireSchema.shape.refusal.safeParse("future-severity").success).toBe(false);
    const sites = new Set<string>();
    for (const [key, procedure] of Object.entries(sessionProcedureSchemas())) {
      expect(markedUnions(z.toJSONSchema(procedure.input, { io: "input" }), enumMarker)).toEqual(
        [],
      );
      const marked = markedUnions(z.toJSONSchema(procedure.output), enumMarker);
      if (marked.length > 0) {
        sites.add(key);
        expect(marked).toEqual(nodes);
      }
    }
    expect(sites).toEqual(
      new Set(["session.command", "session.cancelQueued", "session.editQueued"]),
    );
  });
});

describe("explicit tolerant-read output unions", () => {
  const open = [
    eventSchema.shape.payload,
    streamEmissionWireSchema.options[1].shape.delta,
    // A sign-in flow's updates (VC-702): a Client ignores a kind it does not
    // know, and `done`, `failed` and `cancelled` stay the only ends.
    hostSignInUpdateSchema,
  ];

  it("marks only payload kind, overlay op and sign-in update kind; receipt status and attention kind stay closed", () => {
    const expectedDiscriminators = ["kind", "op", "kind"];
    expect(markedUnions(z.toJSONSchema(receiptSchema))).toEqual([]);
    expect(markedUnions(z.toJSONSchema(attentionSchema))).toEqual([]);
    open.forEach((schema, index) => {
      const document = z.toJSONSchema(schema);
      expect(document[marker]).toBe(expectedDiscriminators[index]);
      vocabulary(document);
    });
    // Envelope/intent/origin/stop actor are not tolerant-read extension points.
    expect(z.toJSONSchema(streamEmissionWireSchema)[marker]).toBeUndefined();
    expect(z.toJSONSchema(eventSchema.shape.commandOrigin)[marker]).toBeUndefined();
    const payloadDocument = z.toJSONSchema(eventSchema.shape.payload);
    const variants = payloadDocument.oneOf! as Node[];
    const recorded = variants.find(
      (variant) => (variant.properties as Record<string, Node>).kind?.const === "command.recorded",
    )!;
    expect(markedUnions(recorded)).toEqual([]);
    const stopped = variants.find(
      (variant) => (variant.properties as Record<string, Node>).kind?.const === "session.stopped",
    )!;
    expect(markedUnions(stopped)).toEqual([]);
  });

  it("publishes only these three vocabularies on outputs, never on inputs", () => {
    const expected = new Set(open.map((schema) => vocabulary(z.toJSONSchema(schema))));
    expect(expected.size).toBe(3);
    const found = new Set<string>();
    for (const procedure of Object.values(sessionProcedureSchemas())) {
      expect(markedUnions(z.toJSONSchema(procedure.input, { io: "input" }))).toEqual([]);
      for (const union of markedUnions(z.toJSONSchema(procedure.output))) {
        const key = vocabulary(union);
        expect(expected.has(key)).toBe(true);
        found.add(key);
      }
    }
    expect(found).toEqual(expected);
  });
});
