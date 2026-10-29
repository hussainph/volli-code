import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { accepts, contractChanges, latestAppTag, unapprovedChanges } from "./compatibility.mjs";

// Use the pinned SDK's actual wire vocabulary (number/bigint, not TS names).
const { v } = createRequire(new URL("../../convex/package.json", import.meta.url))("convex/values");
const string = v.string().json,
  number = v.number().json,
  any = v.any().json;
const literal = (value) => v.literal(value).json;
const union = (...value) => ({ type: "union", value });
const field = (fieldType = string, optional = false) => ({ fieldType, optional });
const object = (value) => ({ type: "object", value });
const array = (value) => ({ type: "array", value });
const record = (keys, value) => ({ type: "record", keys, values: field(value) });
const api = (args = object({ id: field() }), returns = null, kind = "query") => ({
  format: 1,
  functions: { "board:get": { kind, args, returns } },
});
const codes = (a, b) => contractChanges(a, b).map((change) => change.code);

test("removed function, including public -> internal, fails; new function passes", () => {
  assert.deepEqual(codes(api(), { format: 1, functions: {} }), ["function_removed_or_internal"]);
  assert.deepEqual(codes({ format: 1, functions: {} }, api()), []);
});
test("query, mutation and action kind changes fail", () => {
  for (const kind of ["mutation", "action"])
    assert.deepEqual(codes(api(), api(undefined, null, kind)), ["function_kind_changed"]);
});
test("removed required or optional arguments fail", () => {
  for (const optional of [true, false])
    assert.deepEqual(codes(api(object({ id: field(string, optional) })), api(object({}))), [
      "argument_removed",
    ]);
});
test("argument retyping, union narrowing and optional -> required fail", () => {
  assert.deepEqual(codes(api(), api(object({ id: field(number) }))), [
    "argument_retyped_or_narrowed",
  ]);
  assert.deepEqual(codes(api(object({ id: field(union(string, number)) })), api()), [
    "argument_retyped_or_narrowed",
  ]);
  assert.deepEqual(codes(api(object({ id: field(string, true) })), api()), [
    "argument_made_required",
  ]);
});
test("a requiredness exception cannot mask a simultaneous type narrowing", () => {
  const changes = contractChanges(
    api(object({ id: field(string, true) })),
    api(object({ id: field(number) })),
  );
  assert.deepEqual(
    changes.map((change) => change.code),
    ["argument_made_required", "argument_retyped_or_narrowed"],
  );
  const exception = { ...changes[0], reason: "Retired optional caller", retiresIn: "v0.4.0" };
  assert.deepEqual(unapprovedChanges(changes, [exception]), [changes[1]]);
});
test("new required arguments fail; new optional arguments and required -> optional pass", () => {
  assert.deepEqual(codes(api(), api(object({ id: field(), extra: field() }))), [
    "required_argument_added",
  ]);
  assert.deepEqual(
    codes(api(), api(object({ id: field(string, true), extra: field(string, true) }))),
    [],
  );
});
test("input unions may widen and reorder, and literals may widen", () => {
  assert.deepEqual(codes(api(), api(object({ id: field(union(number, string)) }))), []);
  assert(
    accepts(union(literal("a"), literal("b")), union(literal("b"), literal("c"), literal("a"))),
  );
  assert(accepts(literal("a"), string));
  assert(accepts(literal(2), number));
  assert(accepts(literal(NaN), number));
  assert(accepts(literal(2n), v.int64().json));
  assert(accepts(v.id("tickets").json, string));
  assert(!accepts(string, v.id("tickets").json));
  assert(!accepts(string, literal("a")));
});
test("nested objects, arrays, records and discriminated unions cannot narrow inputs", () => {
  const shapes = [
    [object({ x: field() }), object({})],
    [object({ x: field(string, true) }), object({ x: field() })],
    [object({}), object({ x: field() })],
    [array(string), array(number)],
    [record(string, any), record(string, number)],
    [record(string, string), record(literal("a"), string)],
    [
      union(
        object({ kind: field(literal("a")), id: field() }),
        object({ kind: field(literal("b")) }),
      ),
      object({ kind: field(literal("a")), id: field() }),
    ],
    [
      { type: "id", tableName: "a" },
      { type: "id", tableName: "b" },
    ],
    [any, string],
    [{ type: "future" }, string],
  ];
  for (const [before, after] of shapes)
    assert(!accepts(before, after), JSON.stringify({ before, after }));
  assert(accepts(array(string), array(any)));
  assert(accepts(record(string, string), record(string, any)));
  assert(accepts(object({ id: field() }), object({ id: field(), extra: field(string, true) })));
});
test("unvalidated arguments cannot be narrowed", () => {
  assert.deepEqual(codes(api(any), api()), ["arguments_narrowed"]);
  assert.deepEqual(codes(api(), api(any)), []);
});
test("removed, retyped, optionalized or unvalidated declared returns fail", () => {
  const before = api(
    undefined,
    object({ id: field(), nested: field(array(object({ value: field(number) }))) }),
  );
  for (const returns of [
    null,
    any,
    object({}),
    object({ id: field(number) }),
    object({ id: field(string, true) }),
    object({ id: field(), nested: field(array(object({}))) }),
  ]) {
    assert.deepEqual(codes(before, api(undefined, returns)), ["return_removed_or_retyped"]);
  }
});
test("new optional return fields pass, existing optional return fields stay present", () => {
  const before = api(undefined, object({ id: field() }));
  assert.deepEqual(
    codes(before, api(undefined, object({ id: field(), extra: field(string, true) }))),
    [],
  );
  assert.deepEqual(
    codes(api(undefined, object({ id: field(string, true) })), api(undefined, object({}))),
    ["return_removed_or_retyped"],
  );
});
test("return unions may widen, but existing arms and fields cannot be retyped", () => {
  assert.deepEqual(codes(api(undefined, string), api(undefined, union(string, number))), []);
  assert.deepEqual(
    codes(
      api(undefined, union(string, number)),
      api(undefined, union(string, number, v.boolean().json)),
    ),
    [],
  );
  assert.deepEqual(
    codes(api(undefined, union(string, number)), api(undefined, union(string, v.boolean().json))),
    ["return_removed_or_retyped"],
  );
  assert.deepEqual(codes(api(undefined, union(string, number)), api(undefined, string)), []);
  assert.deepEqual(
    codes(
      api(undefined, object({ id: field(string, true) })),
      api(undefined, object({ id: field() })),
    ),
    [],
  );
  assert.deepEqual(codes(api(undefined, array(string)), api(undefined, array(number))), [
    "return_removed_or_retyped",
  ]);
  assert.deepEqual(
    codes(api(undefined, record(string, string)), api(undefined, record(string, number))),
    ["return_removed_or_retyped"],
  );
});
test("adding a return validator where none was declared passes; format changes fail closed", () => {
  assert.deepEqual(codes(api(), api(undefined, string)), []);
  assert.throws(() => contractChanges({ format: 2 }, api()), /Unsupported/);
});
test("an exception must match the exact break, give a reason, and expire at a release", () => {
  const changes = contractChanges(api(), api(object({})));
  const entry = { ...changes[0], reason: "Retired caller", retiresIn: "v0.3.1" };
  assert.deepEqual(unapprovedChanges(changes, [entry], "v0.3.0-canary.1"), []);
  assert.deepEqual(unapprovedChanges(changes, [{ ...entry, path: "args.other" }]), changes);
  for (const invalid of [
    { ...entry, reason: " " },
    { ...entry, retiresIn: "eventually" },
    { ...entry, code: "" },
  ])
    assert.throws(() => unapprovedChanges(changes, [invalid]), /require/);
  assert.throws(() => unapprovedChanges(changes, [entry], "v0.3.1"), /Expired/);
  assert.throws(() => unapprovedChanges(changes, {}), /array/);
});
test("latest app release includes canaries, sorts numerically, stable wins same version", () => {
  assert.equal(
    latestAppTag(["v0.2.9", "v0.3.0-canary.1", "v0.3.0-canary.10", "v0.3.0-canary.9", "nope"]),
    "v0.3.0-canary.10",
  );
  assert.equal(latestAppTag(["v0.3.0-canary.10", "v0.3.0", "v0.2.10"]), "v0.3.0");
  assert.equal(latestAppTag([]), null);
});
