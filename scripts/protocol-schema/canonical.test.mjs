import assert from "node:assert/strict";
import { test } from "node:test";

import { stable } from "./canonical.mjs";
import { schemaChanges } from "./compatibility.mjs";

test("canonicalizes a type array to the equivalent existing union spelling", () => {
  const before = { anyOf: [{ type: "string" }, { type: "null" }] };
  assert.deepEqual(stable({ type: ["string", "null"] }), before);
  assert.deepEqual(schemaChanges(before, stable({ type: ["string", "null"] })), []);
});

test("retains constraints, annotations, array order and existing anyOf assertions", () => {
  const schema = {
    type: ["number", "null"],
    minimum: 0,
    enum: [2, 1, null],
    description: "count",
  };
  assert.deepEqual(stable(schema), {
    anyOf: [{ type: "number" }, { type: "null" }],
    description: "count",
    enum: [2, 1, null],
    minimum: 0,
  });
  const constrained = { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] };
  assert.ok(schemaChanges(stable({ type: ["number", "null"] }), stable(constrained)).length);
  const combined = { ...schema, anyOf: [{ minimum: 1 }] };
  assert.deepEqual(stable(combined).type, ["number", "null"]);
  assert.deepEqual(stable(combined).anyOf, [{ minimum: 1 }]);
});
