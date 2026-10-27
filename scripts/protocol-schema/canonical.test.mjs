import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizeProtocol, canonicalizeSchema, stable } from "./canonical.mjs";
import { schemaChanges } from "./compatibility.mjs";

const canonical = (schema) => stable(canonicalizeSchema(schema));

test("canonicalizes a type array to the equivalent existing union spelling", () => {
  const before = { anyOf: [{ type: "string" }, { type: "null" }] };
  assert.deepEqual(canonical({ type: ["string", "null"] }), before);
  assert.deepEqual(schemaChanges(before, canonical({ type: ["string", "null"] })), []);
});

test("retains constraints, annotations, array order and existing anyOf assertions", () => {
  const schema = {
    type: ["number", "null"],
    minimum: 0,
    enum: [2, 1, null],
    description: "count",
  };
  assert.deepEqual(canonical(schema), {
    anyOf: [{ type: "number" }, { type: "null" }],
    description: "count",
    enum: [2, 1, null],
    minimum: 0,
  });
  const constrained = { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] };
  assert.ok(schemaChanges(canonical({ type: ["number", "null"] }), canonical(constrained)).length);
  const combined = { ...schema, anyOf: [{ minimum: 1 }] };
  assert.deepEqual(canonical(combined).type, ["number", "null"]);
  assert.deepEqual(canonical(combined).anyOf, [{ minimum: 1 }]);
});

test("only walks schema positions, preserving literal objects that look like schemas", () => {
  const literal = { type: ["a", "b"], properties: { value: { type: ["c", "d"] } } };
  const nullable = { type: ["string", "null"] };
  const schema = {
    $defs: { nullable },
    properties: { value: nullable },
    items: nullable,
    anyOf: [nullable, false],
    default: literal,
    const: literal,
    enum: [literal],
    examples: [literal],
  };
  const result = canonical(schema);
  for (const key of ["default", "const", "enum", "examples"]) {
    assert.deepEqual(result[key], schema[key]);
  }
  assert.deepEqual(result.$defs.nullable, canonical(nullable));
  assert.deepEqual(result.properties.value, canonical(nullable));
  assert.deepEqual(result.items, canonical(nullable));
  assert.deepEqual(result.anyOf, [canonical(nullable), false]);
  assert.deepEqual(schema.properties.value, nullable);
});

test("canonicalizes only protocol schema roots and keeps arbitrary entry metadata", () => {
  const nullable = { type: ["string", "null"] };
  const protocol = {
    envelope: { trace: nullable },
    tiers: { public: { read: { input: nullable, output: nullable, metadata: nullable } } },
  };
  const result = canonicalizeProtocol(protocol);
  assert.deepEqual(result.envelope.trace, canonical(nullable));
  assert.deepEqual(result.tiers.public.read.input, canonical(nullable));
  assert.deepEqual(result.tiers.public.read.output, canonical(nullable));
  assert.deepEqual(result.tiers.public.read.metadata, nullable);
  assert.deepEqual(stable({ type: ["z", "a"] }), { type: ["z", "a"] });
});
