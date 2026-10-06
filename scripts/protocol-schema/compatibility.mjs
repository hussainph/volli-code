import { isDeepStrictEqual } from "node:util";

const annotations = new Set(["$schema", "title", "description", "default", "examples", "$comment"]);
const lowerBounds = new Set([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
]);
const upperBounds = new Set([
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);
const list = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const escape = (key) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Conservative JSON-Schema subset check. Unknown assertion changes fail closed.
 * Field/entry removal is forbidden even when removing an input field would widen
 * JSON Schema acceptance: a router strips that field and loses its semantics.
 */
export function schemaChanges(before, after, path = "", direction = "input", context) {
  // Resolve local references against EACH original schema, not a nested branch.
  // Definition labels are generated traversal identities, not wire field names.
  const state = context ?? {
    roots: [before, after],
    ancestors: [],
    caches: [new WeakMap(), new WeakMap()],
  };
  before = resolveLocalRef(before, state.roots[0], state.caches[0]);
  after = resolveLocalRef(after, state.roots[1], state.caches[1]);
  if (isDeepStrictEqual(before, after) || after === true || before === false) return [];
  if (state.ancestors.some(([old, next]) => old === before && next === after)) return [];
  const nested = { ...state, ancestors: [...state.ancestors, [before, after]] };
  const compare = (old, next, at) => schemaChanges(old, next, at, direction, nested);
  const changes = [];
  const fail = (at, reason) => changes.push({ path: at, reason });
  if (!object(before) || !object(after)) return [{ path, reason: "schema narrowed or replaced" }];
  if (after.type !== undefined) {
    const oldTypes = list(before.type);
    const newTypes = list(after.type);
    if (
      !oldTypes.length ||
      oldTypes.some(
        (type) => !newTypes.includes(type) && !(type === "integer" && newTypes.includes("number")),
      )
    ) {
      fail(`${path}/type`, "type narrowed");
    }
  }
  for (const keyword of ["enum", "const"]) {
    if (after[keyword] === undefined) continue;
    const oldValues =
      keyword === "enum" ? before.enum : before.const === undefined ? undefined : [before.const];
    const newValues = keyword === "enum" ? after.enum : [after.const];
    if (
      oldValues === undefined ||
      oldValues.some((value) => !newValues.some((next) => isDeepStrictEqual(value, next)))
    ) {
      fail(`${path}/${keyword}`, "enum member removed or literal narrowed");
    }
  }
  const oldRequired = list(before.required);
  const newRequired = list(after.required);
  if (direction === "input" && newRequired.some((key) => !oldRequired.includes(key))) {
    fail(`${path}/required`, "optional input field made required");
  }
  if (direction === "output" && oldRequired.some((key) => !newRequired.includes(key))) {
    fail(`${path}/required`, "required output field made optional");
  }
  for (const keyword of ["properties", "patternProperties"]) {
    for (const [key, oldSchema] of Object.entries(before[keyword] ?? {})) {
      const at = `${path}/${keyword}/${escape(key)}`;
      if (!Object.hasOwn(after[keyword] ?? {}, key)) fail(at, "field removed");
      else changes.push(...compare(oldSchema, after[keyword][key], at));
    }
  }
  // Adding a oneOf branch can invalidate an old value that now matches TWO
  // branches. Without a disjointness proof, any oneOf change fails closed.
  if (!isDeepStrictEqual(before.oneOf, after.oneOf)) {
    fail(`${path}/oneOf`, "exclusive union changed (requires explicit review)");
  }
  if (before.anyOf !== undefined || after.anyOf !== undefined) {
    const oldBranches = before.anyOf ?? [
      Object.fromEntries(Object.entries(before).filter(([key]) => key !== "anyOf")),
    ];
    const newBranches = after.anyOf ?? [
      Object.fromEntries(Object.entries(after).filter(([key]) => key !== "anyOf")),
    ];
    for (const [index, branch] of oldBranches.entries()) {
      if (!newBranches.some((next) => compare(branch, next, path).length === 0)) {
        fail(`${path}/anyOf/${index}`, "union alternative removed or narrowed");
      }
    }
  }
  for (const keyword of ["items", "additionalProperties"]) {
    if (before[keyword] !== undefined && after[keyword] !== undefined) {
      changes.push(...compare(before[keyword], after[keyword], `${path}/${keyword}`));
    } else if (
      before[keyword] === undefined &&
      after[keyword] !== undefined &&
      after[keyword] !== true
    ) {
      fail(`${path}/${keyword}`, "unconstrained values narrowed");
    }
  }
  const handled = new Set([
    "type",
    "enum",
    "const",
    "required",
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
    "anyOf",
    "oneOf",
    "items",
    "additionalProperties",
  ]);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (handled.has(key) || annotations.has(key) || isDeepStrictEqual(before[key], after[key]))
      continue;
    if (lowerBounds.has(key)) {
      if (after[key] !== undefined && (before[key] === undefined || after[key] > before[key]))
        fail(`${path}/${key}`, "lower bound tightened");
    } else if (upperBounds.has(key)) {
      if (after[key] !== undefined && (before[key] === undefined || after[key] < before[key]))
        fail(`${path}/${key}`, "upper bound tightened");
    } else {
      fail(`${path}/${escape(key)}`, "assertion changed (requires explicit review)");
    }
  }
  return changes;
}

/** Only local references are supported by the generated schema projection.
 * Cache expanded nodes so recursive definitions keep stable object identities;
 * the comparison's active ancestor pairs terminate cycles without letting a
 * failed anyOf candidate contaminate another candidate's result.
 */
function resolveLocalRef(schema, root, cache, resolving = new Set()) {
  if (!object(schema) || schema.$ref === undefined) return schema;
  if (cache.has(schema)) return cache.get(schema);
  if (resolving.has(schema)) throw new Error("Circular reference alias without a schema body");
  resolving.add(schema);
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/"))
    throw new Error(`Unsupported schema reference: ${ref}`);
  let target = root;
  for (const segment of ref.slice(2).split("/")) {
    const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!object(target) || !Object.hasOwn(target, key))
      throw new Error(`Dangling schema reference: ${ref}`);
    target = target[key];
  }
  const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
  // Zod emits assertion-free $ref nodes; refusing assertion siblings avoids
  // accidentally replacing an intersection with a permissive object merge.
  if (
    Object.keys(siblings).some(
      (key) => !annotations.has(key) && key !== "$defs" && key !== "definitions",
    )
  )
    throw new Error(`Assertion beside schema reference: ${ref}`);
  const resolved = resolveLocalRef(target, root, cache, resolving);
  cache.set(schema, resolved);
  return resolved;
}

/** Both tiers are compared; adding a provider/tier cannot hide existing entries. */
export function protocolChanges(before, after) {
  const changes = [];
  for (const [tier, entries] of Object.entries(before.tiers)) {
    for (const [key, entry] of Object.entries(entries)) {
      const path = `/tiers/${escape(tier)}/${escape(key)}`;
      const next = after.tiers[tier]?.[key];
      if (!next) {
        changes.push({ path, reason: "catalog entry removed" });
        continue;
      }
      if (entry.kind !== next.kind)
        changes.push({ path: `${path}/kind`, reason: "operation kind changed" });
      for (const flag of ["noInput", "voidOutput"]) {
        if (entry[flag] !== next[flag])
          changes.push({ path: `${path}/${flag}`, reason: "wire value presence changed" });
      }
      for (const direction of ["input", "output"])
        changes.push(
          ...schemaChanges(entry[direction], next[direction], `${path}/${direction}`, direction),
        );
    }
  }
  // Public operation membership is frozen, even when widening it seems additive.
  for (const [feature, operations] of Object.entries(before.features ?? {})) {
    if (!isDeepStrictEqual(operations, after.features?.[feature]))
      changes.push({
        path: `/features/${escape(feature)}`,
        reason: "frozen feature membership changed",
      });
  }
  return changes;
}

/** An exception is exact-path, explained, and tied to a real breaking version bump. */
export function unapprovedChanges(before, after, allowlist = []) {
  for (const exception of allowlist) {
    if (
      typeof exception.path !== "string" ||
      typeof exception.reason !== "string" ||
      !exception.reason.trim() ||
      !Number.isSafeInteger(exception.protocolVersion) ||
      exception.protocolVersion <= before.protocolVersion ||
      exception.protocolVersion !== after.protocolVersion
    ) {
      throw new Error(
        "Every compatibility exception needs a path, reason and bumped protocolVersion",
      );
    }
  }
  return protocolChanges(before, after).filter(
    (change) => !allowlist.some((exception) => exception.path === change.path),
  );
}
