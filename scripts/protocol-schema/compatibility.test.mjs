import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

import { protocolChanges, schemaChanges, unapprovedChanges } from "./compatibility.mjs";

// Exercise the actual generator's pinned Zod, not a hand-written approximation.
const { z } = createRequire(new URL("../../packages/session-rpc/package.json", import.meta.url))(
  "zod",
);
const text = { type: "string" };
const shape = { type: "object", properties: { id: text, label: text }, required: ["id"] };
const protocol = (input = shape, output = shape) => ({
  protocolVersion: 1,
  features: { sessions: ["session.snapshot"] },
  tiers: {
    public: { "session.snapshot": { kind: "query", input, output } },
    desktop: { read: { kind: "query", input: {}, output: text } },
  },
});

test("allows optional fields, new entries/tiers, enum/union expansion and relaxed bounds", () => {
  assert.deepEqual(
    schemaChanges(shape, { ...shape, properties: { ...shape.properties, extra: text } }),
    [],
  );
  assert.deepEqual(schemaChanges({ enum: ["a"] }, { enum: ["a", "b"] }, "", "output"), []);
  assert.deepEqual(schemaChanges({ anyOf: [text] }, { anyOf: [{ type: "number" }, text] }), []);
  assert.deepEqual(
    schemaChanges(
      { type: "integer", minimum: 1, maximum: 10 },
      { type: "number", minimum: 0, maximum: 20 },
    ),
    [],
  );
  const next = protocol();
  next.tiers.public.new = { kind: "query", input: {}, output: text };
  next.tiers.extra = {};
  next.features.board = ["board.read"];
  assert.deepEqual(protocolChanges(protocol(), next), []);
});

test("refuses field/entry removals, narrowing and newly required input", () => {
  assert.equal(
    schemaChanges(shape, { ...shape, properties: { id: text } })[0].reason,
    "field removed",
  );
  assert.equal(
    schemaChanges(shape, { ...shape, required: ["id", "label"] })[0].reason,
    "optional input field made required",
  );
  assert.equal(schemaChanges({ type: ["string", "null"] }, text)[0].reason, "type narrowed");
  assert.ok(schemaChanges({ type: "number" }, { type: "integer" }).length);
  assert.ok(schemaChanges({}, { type: "string" }).length);
  assert.ok(schemaChanges({ enum: ["a", "b"] }, { enum: ["a"] }, "", "output").length);
  const next = protocol();
  delete next.tiers.public["session.snapshot"];
  delete next.tiers.desktop.read;
  assert.equal(protocolChanges(protocol(), next).length, 2);
});

test("bounds, objects, arrays, literal alternatives and unknown assertions fail closed", () => {
  for (const [before, after] of [
    [{ minimum: 0 }, { minimum: 1 }],
    [{ maximum: 10 }, { maximum: 9 }],
    [{}, { minLength: 1 }],
    [{}, { maxItems: 1 }],
    [{ const: "a" }, { const: "b" }],
    [{ additionalProperties: true }, { additionalProperties: false }],
    [{}, { additionalProperties: false }],
    [{ items: text }, { items: { type: "number" } }],
    [{ anyOf: [text, { type: "null" }] }, { anyOf: [text] }],
    [{ pattern: "a" }, { pattern: "b" }],
    [
      { $ref: "#/$defs/a", $defs: { a: text } },
      { $ref: "#/$defs/b", $defs: { b: { type: "number" } } },
    ],
    [{ required: ["id"] }, { required: [] }],
  ])
    assert.ok(schemaChanges(before, after, "", "output").length, JSON.stringify({ before, after }));
  assert.deepEqual(schemaChanges({ minimum: 0, maximum: 10 }, {}), []);
  assert.deepEqual(schemaChanges({ description: "old" }, { description: "new" }), []);
  assert.deepEqual(schemaChanges(false, text), []);
  assert.deepEqual(schemaChanges(text, true), []);
});

test("feature sets cannot widen or shrink; operation kinds cannot change", () => {
  const next = protocol();
  next.features.sessions.push("board.read");
  next.tiers.public["session.snapshot"].kind = "mutation";
  assert.deepEqual(
    protocolChanges(protocol(), next).map(({ path }) => path),
    ["/tiers/public/session.snapshot/kind", "/features/sessions"],
  );
});

test("intentional break needs exact allowlist and a protocol bump", () => {
  const old = protocol();
  const next = protocol();
  delete next.tiers.desktop.read;
  const exception = {
    path: "/tiers/desktop/read",
    protocolVersion: 2,
    reason: "HP2 removes obsolete desktop read",
  };
  assert.throws(() => unapprovedChanges(old, next, [exception]), /bumped protocolVersion/);
  next.protocolVersion = 2;
  assert.deepEqual(unapprovedChanges(old, next, [exception]), []);
  assert.equal(
    unapprovedChanges(old, next, [{ ...exception, path: "/tiers/public/read" }]).length,
    1,
  );
  assert.throws(() => unapprovedChanges(old, next, [{ ...exception, reason: "" }]), /reason/);
  assert.equal(unapprovedChanges(old, next).length, 1);
});

test("oneOf expansion is not assumed additive (real Zod XOR)", () => {
  const old = z.xor([z.string(), z.number()]);
  const next = z.xor([z.string(), z.number(), z.literal("a")]);
  assert.equal(old.safeParse("a").success, true);
  assert.equal(next.safeParse("a").success, false);
  assert.ok(
    schemaChanges(z.toJSONSchema(old), z.toJSONSchema(next)).some(({ path }) => path === "/oneOf"),
  );
});

test("optional recursive JSON fields tolerate generated ref renumbering", () => {
  const old = z.toJSONSchema(z.object({ data: z.json() }));
  const next = z.toJSONSchema(z.object({ extra: z.json().optional(), data: z.json() }));
  assert.notEqual(old.properties.data.$ref, next.properties.data.$ref);
  assert.deepEqual(schemaChanges(old, next), []);
  const narrowed = structuredClone(next);
  const ref = narrowed.properties.data.$ref.split("/").at(-1);
  narrowed.$defs[ref].anyOf = narrowed.$defs[ref].anyOf.filter(({ type }) => type !== "string");
  assert.ok(schemaChanges(old, narrowed).length);
});

test("dangling/external references and assertion siblings fail closed", () => {
  for (const next of [
    { $ref: "#/$defs/missing" },
    { $ref: "https://example.invalid/schema" },
    { $ref: "#/$defs/text", maxLength: 1, $defs: { text } },
    { $ref: "#/$defs/alias", $defs: { alias: { $ref: "#/$defs/alias" } } },
  ])
    assert.throws(() => schemaChanges(text, next), /schema reference|reference alias/);
  const alias = { $ref: "#/$defs/alias", $defs: { alias: { $ref: "#/$defs/body" }, body: text } };
  assert.deepEqual(schemaChanges(text, alias), []);
});
