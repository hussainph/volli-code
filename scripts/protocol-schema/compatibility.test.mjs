import { readFileSync } from "node:fs";
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

test("allows optional fields, new entries/tiers, input enum/union expansion and relaxed bounds", () => {
  assert.deepEqual(
    schemaChanges(shape, { ...shape, properties: { ...shape.properties, extra: text } }),
    [],
  );
  assert.deepEqual(schemaChanges({ enum: ["a"] }, { enum: ["a", "b"] }, "", "input"), []);
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

const enumMarker = "x-volli-open-enum";

test("output enum/const growth requires scalar reader tolerance in both versions (real Zod)", () => {
  for (const before of [z.literal("a"), z.enum(["a", "b"])]) {
    const after = z.enum(["a", "b", "c"]);
    const publish = (schema, markerValue) =>
      z.toJSONSchema(schema.meta({ [enumMarker]: markerValue }));
    for (const [oldMarker, newMarker] of [
      [undefined, undefined],
      [undefined, true],
      [true, undefined],
      ["true", "true"],
      [false, false],
    ]) {
      assert.deepEqual(
        schemaChanges(publish(before, oldMarker), publish(after, newMarker), "", "output"),
        [{ path: "/enum", reason: "output enum widened (requires tolerant reader)" }],
      );
    }
    assert.deepEqual(schemaChanges(publish(before, true), publish(after, true), "", "output"), []);
    assert.deepEqual(schemaChanges(publish(before), publish(after), "", "input"), []);
  }
});

test("scalar tolerance never permits member removal or type growth, and annotations alone are additive", () => {
  const mark = (schema) => ({ ...schema, [enumMarker]: true });
  for (const [before, after] of [
    [{ enum: ["a", "b"] }, { enum: ["a"] }],
    [{ enum: ["a", "b"] }, { const: "a" }],
    [{ const: "a" }, { const: "b" }],
    [
      { type: "string", enum: ["a"] },
      { type: ["string", "null"], enum: ["a", null] },
    ],
    [
      { type: "string", const: "a" },
      { type: "number", const: 1 },
    ],
  ]) {
    assert.ok(schemaChanges(mark(before), mark(after), "", "output").length);
  }
  assert.deepEqual(schemaChanges({ const: "a" }, { enum: ["a"] }, "", "output"), []);
  assert.deepEqual(schemaChanges({ enum: ["a"] }, { const: "a" }, "", "output"), []);
  assert.deepEqual(schemaChanges(text, mark(text), "", "output"), []);
  assert.deepEqual(schemaChanges(mark(text), text, "", "output"), []);
  for (const before of [{ enum: ["a"] }, { const: "a" }]) {
    assert.ok(schemaChanges(before, {}, "", "output").length);
    assert.deepEqual(schemaChanges(before, {}, "", "input"), []);
    assert.ok(schemaChanges(mark(before), mark({}), "", "output").length);
    assert.deepEqual(
      schemaChanges(mark({ ...before, type: "string" }), mark({ type: "string" }), "", "output"),
      [],
    );
  }
  // Both assertions apply when present; changing the enum cannot hide const.
  assert.ok(
    schemaChanges({ enum: ["a", "b"], const: "a" }, { enum: ["a", "b"] }, "", "output").length,
  );
  const old = { enum: [{ title: "a" }] };
  assert.ok(schemaChanges(old, { enum: [...old.enum, { title: "b" }] }, "", "output").length);
});

test("marked mixed literals cannot gain new JSON value types when Zod omits type", () => {
  const publish = (values) => z.toJSONSchema(z.literal(values).meta({ [enumMarker]: true }));
  const old = publish(["a", 1]);
  assert.equal(old.type, undefined);
  for (const value of [null, true]) {
    assert.deepEqual(schemaChanges(old, publish(["a", 1, value]), "", "output"), [
      { path: "/type", reason: "output enum value type widened" },
    ]);
  }
  assert.deepEqual(schemaChanges(old, publish(["a", 1, "b", 2]), "", "output"), []);
  const marked = { enum: ["a"], [enumMarker]: true };
  assert.ok(schemaChanges(marked, { ...marked, enum: ["a", { x: 1 }] }, "", "output").length);
});

test("scalar tolerance is local through nullable/array/ref containers", () => {
  const publish = (values, marked) =>
    z.toJSONSchema(
      z.object({
        values: z.array(
          z
            .enum(values)
            .meta({ [enumMarker]: marked })
            .nullable(),
        ),
      }),
    );
  const old = publish(["a", "b"], true);
  const next = publish(["a", "b", "c"], true);
  assert.deepEqual(schemaChanges(old, next, "", "output"), []);
  assert.ok(schemaChanges(publish(["a", "b"]), publish(["a", "b", "c"]), "", "output").length);
  const ref = (values, marked) => ({
    $ref: "#/$defs/value",
    $defs: { value: { type: "string", enum: values, [enumMarker]: marked } },
  });
  assert.deepEqual(schemaChanges(ref(["a"], true), ref(["a", "b"], true), "", "output"), []);
  assert.ok(schemaChanges(ref(["a"]), ref(["a", "b"]), "", "output").length);
  // Metadata on a reference is site-local, not a change to the shared target.
  const shared = (values) => ({
    type: "object",
    properties: {
      tolerant: { $ref: "#/$defs/value", [enumMarker]: true },
      strict: { $ref: "#/$defs/value" },
    },
    $defs: { value: { type: "string", enum: values } },
  });
  assert.deepEqual(schemaChanges(shared(["a"]), shared(["a", "b"]), "", "output"), [
    {
      path: "/properties/strict/enum",
      reason: "output enum widened (requires tolerant reader)",
    },
  ]);
  assert.deepEqual(
    schemaChanges(
      { type: "string", enum: ["a"], [enumMarker]: true },
      { anyOf: [{ type: "string", enum: ["a", "b"], [enumMarker]: true }] },
      "",
      "output",
    ),
    [],
  );
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

test("a desktop-only entry leaves its tier only by promotion, under its key, compatibly", () => {
  const before = protocol();
  const read = before.tiers.desktop.read;
  const promoted = (entry) => ({
    ...before,
    tiers: { public: { ...before.tiers.public, read: entry }, desktop: {} },
  });
  assert.deepEqual(protocolChanges(before, promoted(read)), []);
  assert.deepEqual(protocolChanges(before, promoted({ ...read, kind: "mutation" })), [
    { path: "/tiers/desktop/read/kind", reason: "operation kind changed" },
  ]);
  assert.deepEqual(
    protocolChanges(before, { ...before, tiers: { ...before.tiers, desktop: {} } }),
    [{ path: "/tiers/desktop/read", reason: "catalog entry removed" }],
  );
  // A public entry never leaves for the desktop tier.
  const demoted = {
    ...before,
    tiers: { public: {}, desktop: { ...before.tiers.desktop, ...before.tiers.public } },
  };
  assert.deepEqual(protocolChanges(before, demoted), [
    { path: "/tiers/public/session.snapshot", reason: "catalog entry removed" },
  ]);
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

test("unchanged refs do not hide json definition mutations (N3/N12/F1)", () => {
  const old = z.toJSONSchema(z.object({ data: z.json() }));
  const name = old.properties.data.$ref.split("/").at(-1);
  for (const direction of ["input", "output"]) {
    for (const mutation of ["integer", "removeObject"]) {
      const next = structuredClone(old);
      if (mutation === "integer") {
        next.$defs[name].anyOf.find(({ type }) => type === "number").type = "integer";
      } else {
        next.$defs[name].anyOf = next.$defs[name].anyOf.filter(({ type }) => type !== "object");
      }
      assert.deepEqual(old.properties, next.properties);
      assert.ok(schemaChanges(old, next, "", direction).length, `${direction}: ${mutation}`);
    }
  }
});

test("refs under closed oneOf and unknown assertions follow changed definitions (N13)", () => {
  for (const keyword of ["oneOf", "allOf"]) {
    const old = { [keyword]: [{ $ref: "#/$defs/value" }], $defs: { value: text } };
    const next = structuredClone(old);
    next.$defs.value.maxLength = 5;
    assert.deepEqual(old[keyword], next[keyword]);
    assert.ok(schemaChanges(old, next, "", "output").length, keyword);
    const renamed = { [keyword]: [{ $ref: "#/$defs/renamed" }], $defs: { renamed: text } };
    assert.deepEqual(schemaChanges(old, renamed, "", "output"), []);
  }
});

const marker = "x-volli-open-union";
const variant = (discriminator, values, value = z.string()) =>
  z.object({
    [discriminator]: values.length === 1 ? z.literal(values[0]) : z.enum(values),
    value,
  });
const openUnion = (discriminator, branches) =>
  z.toJSONSchema(z.discriminatedUnion(discriminator, branches).meta({ [marker]: discriminator }));

test("only explicitly open output discriminated unions permit disjoint additions (real Zod meta)", () => {
  for (const discriminator of ["kind", "status", "op"]) {
    const branches = [variant(discriminator, ["a"]), variant(discriminator, ["b", "c"])];
    const old = openUnion(discriminator, branches);
    const next = openUnion(discriminator, [...branches, variant(discriminator, ["d", "e"])]);
    assert.equal(old[marker], discriminator);
    assert.ok(old.oneOf[1].properties[discriminator].enum, "grouped enum is preserved");
    assert.deepEqual(schemaChanges(old, next, "", "output"), []);
    assert.ok(schemaChanges(old, next, "", "input").length, "input unions are never open");
    for (const [beforeMarker, afterMarker] of [
      [undefined, undefined],
      [undefined, discriminator],
      [discriminator, undefined],
      [true, true],
      ["unknown", "unknown"],
      [discriminator, "unknown"],
    ]) {
      const before = { ...old, [marker]: beforeMarker };
      const after = { ...next, [marker]: afterMarker };
      assert.ok(
        schemaChanges(before, after, "", "output").length,
        JSON.stringify({ discriminator, beforeMarker, afterMarker }),
      );
    }
  }
});

test("annotation-only changes under closed unions are additive, but never hide wire fields/literals", () => {
  const old = openUnion("kind", [variant("kind", ["a"]), variant("kind", ["b"])]);
  delete old[marker];
  const next = structuredClone(old);
  next[marker] = "kind";
  next.oneOf[0].description = "annotation only";
  next.oneOf[0].properties.value.title = "annotation only";
  assert.deepEqual(schemaChanges(old, next, "", "output"), []);
  assert.deepEqual(schemaChanges(old, next, "", "input"), []);
  for (const name of ["title", "description", "$defs", marker, enumMarker]) {
    const before = { type: "object", properties: { [name]: text } };
    assert.ok(schemaChanges(before, { type: "object", properties: {} }).length, name);
    assert.ok(schemaChanges({ const: { [name]: "a" } }, { const: { [name]: "b" } }).length, name);
  }
  const literal = { enum: [{ $ref: "literal, not a schema reference" }] };
  assert.deepEqual(schemaChanges(literal, structuredClone(literal)), []);
});

test("open output variants stay additive inside nullable/array containers (real Zod)", () => {
  const publish = (values) =>
    z.toJSONSchema(
      z.object({
        receipts: z.array(
          z
            .discriminatedUnion(
              "status",
              values.map((value) => variant("status", [value])),
            )
            .meta({ [marker]: "status" })
            .nullable(),
        ),
      }),
    );
  const old = publish(["accepted", "rejected"]);
  const next = publish(["accepted", "rejected", "deferred"]);
  assert.deepEqual(schemaChanges(old, next, "", "output"), []);
  assert.ok(schemaChanges(old, next, "", "input").length);
  const unmarked = structuredClone(next);
  delete unmarked.properties.receipts.items.anyOf.find((branch) => branch.oneOf)[marker];
  assert.ok(schemaChanges(old, unmarked, "", "output").length);
  // A marker on anyOf cannot opt that union into the oneOf-only exception.
  assert.ok(
    schemaChanges(
      { anyOf: [text], [marker]: "kind" },
      { anyOf: [text, { type: "null" }], [marker]: "kind" },
      "",
      "output",
    ).length,
  );
});

test("open unions fail closed without a pairwise discriminator disjointness proof", () => {
  const old = openUnion("kind", [variant("kind", ["a"]), variant("kind", ["b", "c"])]);
  const next = openUnion("kind", [
    variant("kind", ["a"]),
    variant("kind", ["b", "c"]),
    variant("kind", ["d", "e"]),
  ]);
  const invalid = [
    (s) => {
      s.oneOf[2].properties.kind = { type: "string", const: "b" };
    },
    (s) => {
      s.oneOf[2].properties.kind.enum.push("c");
    },
    (s) => {
      s.oneOf[2].required = ["value"];
    },
    (s) => {
      delete s.oneOf[2].properties.kind;
    },
    (s) => {
      s.oneOf[2].properties.kind = { type: "string" };
    },
    (s) => {
      s.oneOf[2].properties.kind = { enum: [] };
    },
    (s) => {
      s.oneOf[2].properties.kind = { enum: [1] };
    },
    (s) => {
      s.oneOf[2].type = "string";
    },
  ];
  for (const mutate of invalid) {
    const after = structuredClone(next);
    mutate(after);
    assert.ok(schemaChanges(old, after, "", "output").length, mutate.toString());
  }
  const overlappingBefore = structuredClone(old);
  overlappingBefore.oneOf[1].properties.kind.enum.push("a");
  assert.ok(schemaChanges(overlappingBefore, next, "", "output").length);
});

test("open unions preserve every old member and recursively check its fields", () => {
  const old = openUnion("status", [variant("status", ["a"]), variant("status", ["b", "c"])]);
  for (const mutate of [
    (s) => {
      s.oneOf.pop();
    },
    (s) => {
      s.oneOf[1].properties.status.enum.pop();
    },
    (s) => {
      s.oneOf[0].properties.status.const = "changed";
    },
    (s) => {
      s.oneOf[0].properties.value.maxLength = 5;
    },
    (s) => {
      delete s.oneOf[0].properties.value;
    },
    (s) => {
      s.oneOf[0].required = ["status"];
    },
    (s) => {
      s.oneOf[0].properties.value = { anyOf: [text, { type: "null" }] };
    },
  ]) {
    const next = structuredClone(old);
    mutate(next);
    assert.ok(schemaChanges(old, next, "", "output").length, mutate.toString());
  }
  const groupedAddition = structuredClone(old);
  groupedAddition.oneOf[1].properties.status.enum.push("d");
  assert.deepEqual(schemaChanges(old, groupedAddition, "", "output"), []);
  const strictChild = structuredClone(old);
  strictChild.oneOf[1].properties.value = { type: "string", enum: ["known"] };
  const widenedChild = structuredClone(strictChild);
  widenedChild.oneOf[1].properties.value.enum.push("future");
  widenedChild.oneOf[1].properties.status.enum.push("d");
  assert.ok(schemaChanges(strictChild, widenedChild, "", "output").length);
  const overlap = structuredClone(old);
  overlap.oneOf[1].properties.status.enum.push("a");
  assert.ok(schemaChanges(old, overlap, "", "output").length);
  const additive = structuredClone(old);
  additive.oneOf.reverse();
  additive.oneOf[0].properties.extra = text;
  additive.oneOf[0].required.push("extra");
  assert.deepEqual(schemaChanges(old, additive, "", "output"), []);
});

test("open unions recursively compare identical branch refs and discriminator refs", () => {
  const old = {
    [marker]: "kind",
    oneOf: [{ $ref: "#/$defs/branch" }],
    $defs: {
      tag: { type: "string", const: "a" },
      branch: {
        type: "object",
        properties: { kind: { $ref: "#/$defs/tag" }, value: text },
        required: ["kind", "value"],
      },
    },
  };
  const narrowed = structuredClone(old);
  narrowed.$defs.branch.properties.value = { type: "string", maxLength: 5 };
  assert.ok(schemaChanges(old, narrowed, "", "output").length);
  const changedTag = structuredClone(old);
  changedTag.$defs.tag.const = "b";
  assert.ok(schemaChanges(old, changedTag, "", "output").length);
  const additive = structuredClone(old);
  additive.oneOf.push({ type: "object", properties: { kind: { const: "b" } }, required: ["kind"] });
  assert.deepEqual(schemaChanges(old, additive, "", "output"), []);
});

test("an open discriminator's proof does not open another field sharing its definition", () => {
  const old = {
    [marker]: "kind",
    oneOf: [{ $ref: "#/$defs/branch" }],
    $defs: {
      tag: { type: "string", enum: ["a", "b"] },
      branch: {
        type: "object",
        properties: { kind: { $ref: "#/$defs/tag" }, value: { $ref: "#/$defs/tag" } },
        required: ["kind", "value"],
      },
    },
  };
  const next = structuredClone(old);
  next.$defs.tag.enum.push("c");
  assert.deepEqual(schemaChanges(old, next, "", "output"), [
    {
      path: "/oneOf/0/properties/value/enum",
      reason: "output enum widened (requires tolerant reader)",
    },
  ]);
});

test("output type/anyOf/boolean widening breaks the N−1 promise, including nullable Zod", () => {
  for (const [before, after] of [
    [text, { type: ["string", "null"] }],
    [text, { type: ["string", "number"] }],
    [{ type: "integer" }, { type: "number" }],
    [text, {}],
    [text, true],
    [false, text],
    [text, { anyOf: [text, { type: "null" }] }],
    [text, { anyOf: [text, { type: "number" }] }],
    [text, { anyOf: [text, true] }],
    [
      { anyOf: [{ type: "string", maxLength: 5 }] },
      { anyOf: [{ type: "string", maxLength: 5 }, text] },
    ],
    [{ anyOf: [text, { type: "null" }] }, { anyOf: [text, { type: "null" }, { type: "number" }] }],
    [z.toJSONSchema(z.string()), z.toJSONSchema(z.string().nullable())],
  ]) {
    assert.ok(schemaChanges(before, after, "", "output").length, JSON.stringify({ before, after }));
    assert.deepEqual(schemaChanges(before, after, "", "input"), []);
  }
  // Equivalent wrapping/reordering is not widening. Scalar enum growth inside
  // a nullable wrapper still requires an explicit tolerant-reader contract.
  assert.deepEqual(schemaChanges(text, { anyOf: [text] }, "", "output"), []);
  const finite = { type: "string", enum: ["a"] };
  assert.deepEqual(schemaChanges(finite, { anyOf: [finite] }, "", "output"), []);
  assert.ok(
    schemaChanges(finite, { anyOf: [{ ...finite, enum: ["a", "b"] }] }, "", "output").length,
  );
  const union = { anyOf: [text, { type: "null" }] };
  assert.deepEqual(schemaChanges(union, { anyOf: union.anyOf.toReversed() }, "", "output"), []);
  assert.deepEqual(
    schemaChanges(
      { anyOf: [{ type: "string", enum: ["a"], [enumMarker]: true }, { type: "null" }] },
      { anyOf: [{ type: "string", enum: ["a", "b"], [enumMarker]: true }, { type: "null" }] },
      "",
      "output",
    ),
    [],
  );
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

test("the committed public feature/bootstrap sets are frozen independently of declaration order", () => {
  const old = JSON.parse(
    readFileSync(new URL("../../docs/protocol/protocol.schema.json", import.meta.url), "utf8"),
  );
  assert.ok(old.features.sessions.includes("session.command"));
  const next = structuredClone(old);
  next.features.sessions.reverse();
  assert.deepEqual(unapprovedChanges(old, next), []);
  next.features.sessions.push("new.area.read");
  next.baseOperations.push("protocol.newBootstrap");
  next.tiers.public["new.area.read"] = { kind: "query", input: {}, output: text };
  assert.deepEqual(
    unapprovedChanges(old, next).map(({ path }) => path),
    ["/baseOperations", "/features/sessions"],
  );
  for (const mutate of [
    (p) => {
      delete p.features.sessions;
    },
    (p) => {
      p.features.sessions.pop();
    },
    (p) => {
      delete p.baseOperations;
    },
  ]) {
    const after = structuredClone(old);
    mutate(after);
    assert.ok(unapprovedChanges(old, after).length);
  }
  const additive = structuredClone(old);
  additive.features["new.area"] = ["new.area.read"];
  additive.tiers.public["new.area.read"] = { kind: "query", input: {}, output: text };
  assert.deepEqual(unapprovedChanges(old, additive), []);
});

function outputUnionSites(value, discriminator, member) {
  if (Array.isArray(value))
    return value.flatMap((node) => outputUnionSites(node, discriminator, member));
  if (value === null || typeof value !== "object") return [];
  const matches = value.oneOf?.some((branch) => {
    const field = branch.properties?.[discriminator];
    return field?.const === member || field?.enum?.includes(member);
  });
  return [
    ...(matches ? [value] : []),
    ...Object.values(value).flatMap((node) => outputUnionSites(node, discriminator, member)),
  ];
}

test("published receipt statuses and attention kinds remain closed at every output site", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../docs/protocol/protocol.schema.json", import.meta.url), "utf8"),
  );

  for (const [discriminator, member] of [
    ["status", "accepted"],
    ["kind", "rate_limited"],
  ]) {
    let sites = 0;
    for (const entry of Object.values(document.tiers.public)) {
      const before = entry.output;
      for (const [index, union] of outputUnionSites(before, discriminator, member).entries()) {
        sites++;
        assert.equal(union[marker], undefined, `${discriminator} must not opt in to open reading`);
        const after = structuredClone(before);
        const changed = outputUnionSites(after, discriminator, member)[index];
        const branch = structuredClone(changed.oneOf[0]);
        branch.properties[discriminator] = { type: "string", const: "future.reader-unsupported" };
        changed.oneOf.push(branch);
        assert.ok(
          schemaChanges(before, after, "", "output").length,
          `${discriminator} addition at site ${index} must be breaking`,
        );
      }
    }
    assert.ok(sites > 0, `${discriminator} regression must exercise actual published sites`);
  }
});

const refusalEnum = (schema) => schema.properties.refusal.anyOf.find((node) => node.enum);

test("published command refusal severity is tolerant at every output site, without opening receipt status", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../docs/protocol/protocol.schema.json", import.meta.url), "utf8"),
  );
  for (const key of ["session.command", "session.cancelQueued", "session.editQueued"]) {
    const before = document.tiers.public[key].output;
    assert.equal(refusalEnum(before)[enumMarker], true, key);
    const after = structuredClone(before);
    refusalEnum(after).enum.push("future-severity");
    assert.deepEqual(schemaChanges(before, after, "", "output"), [], key);
    const unmarked = structuredClone(before);
    delete refusalEnum(unmarked)[enumMarker];
    assert.ok(schemaChanges(unmarked, after, "", "output").length, key);
  }
});

test("published sign-in status scalar enums remain closed", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../docs/protocol/protocol.schema.json", import.meta.url), "utf8"),
  );
  const output = document.tiers.public["signIns.status"].output;
  const sites = [];
  const visit = (node, segments = []) => {
    if (node === null || typeof node !== "object") return;
    if (node.enum) sites.push(segments);
    for (const [key, value] of Object.entries(node)) visit(value, [...segments, key]);
  };
  visit(output);
  assert.ok(sites.length > 0);
  for (const segments of sites) {
    const at = (root) => segments.reduce((node, key) => node[key], root);
    assert.equal(at(output)[enumMarker], undefined);
    const next = structuredClone(output);
    at(next).enum.push("future.reader-unsupported");
    assert.ok(
      schemaChanges(output, next, "", "output").length,
      `strict sign-in reader at /${segments.join("/")} must refuse growth`,
    );
  }
});

test("envelope fields beside a frame's id may be added, never removed or narrowed (VC-699)", () => {
  const trace = {
    type: "object",
    properties: { traceId: { type: "string", pattern: "^[0-9a-f]{32}$" }, spanId: text },
    required: ["traceId", "spanId"],
  };
  const before = { ...protocol(), envelope: { volliTrace: trace } };
  // A baseline with no envelope, and a new field beside an old one, are additive.
  assert.deepEqual(protocolChanges(protocol(), before), []);
  assert.deepEqual(
    protocolChanges(before, { ...before, envelope: { volliTrace: trace, volliOther: text } }),
    [],
  );
  assert.deepEqual(protocolChanges(before, { ...before, envelope: {} }), [
    { path: "/envelope/volliTrace", reason: "envelope field removed" },
  ]);
  assert.deepEqual(protocolChanges(before, protocol()), [
    { path: "/envelope/volliTrace", reason: "envelope field removed" },
  ]);
  const narrowed = { ...trace, required: ["traceId", "spanId", "flags"] };
  assert.deepEqual(protocolChanges(before, { ...before, envelope: { volliTrace: narrowed } }), [
    { path: "/envelope/volliTrace/required", reason: "optional input field made required" },
  ]);
});
