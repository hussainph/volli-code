import { isDeepStrictEqual } from "node:util";

const openUnionMarker = "x-volli-open-union";
const openEnumMarker = "x-volli-open-enum";
const annotations = new Set([
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  openUnionMarker,
  openEnumMarker,
]);
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
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
const assertionKeys = (value, kind) =>
  Object.keys(value)
    .filter(
      (key) =>
        kind === "map" || (key !== "$defs" && key !== "definitions" && !annotations.has(key)),
    )
    .toSorted();

/** Conservative JSON-Schema subset check. Unknown assertion changes fail closed.
 * Field/entry removal is forbidden even when removing an input field would widen
 * JSON Schema acceptance: a router strips that field and loses its semantics.
 */
export function schemaChanges(before, after, path = "", direction = "input", context) {
  // Resolve local references against EACH original schema, not a nested branch.
  // Definition labels are generated traversal identities, not wire field names.
  const state = context?.roots
    ? context
    : {
        roots: [before, after],
        ancestors: [],
        caches: [new WeakMap(), new WeakMap()],
        ...context,
      };
  before = resolveLocalRef(before, state.roots[0], state.caches[0]);
  after = resolveLocalRef(after, state.roots[1], state.caches[1]);
  // Equality must follow $ref into each document's own definitions: two
  // textually identical subtrees can point at different $defs bodies.
  const same = (old, next) => resolvedEqual(old, next, state);
  if (same(before, after)) return [];
  if (direction === "input" && (after === true || before === false)) return [];
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
  // Output types are a promise to N−1 readers: admitting null (or any new
  // type) breaks that promise. Input widening remains additive. anyOf wrappers
  // are checked branch-by-branch below, rather than mistaken for type removal.
  if (direction === "output" && before.type !== undefined) {
    const oldTypes = list(before.type);
    const newTypes = list(after.type);
    if (
      (after.type === undefined && after.anyOf === undefined) ||
      newTypes.some(
        (type) => !oldTypes.includes(type) && !(type === "integer" && oldTypes.includes("number")),
      )
    ) {
      fail(`${path}/type`, "output type widened");
    }
  }
  // const and enum describe the same finite vocabulary, even when Zod changes
  // representation (a singleton literal becoming an enum). Removing the finite
  // constraint also widens output acceptance. Tolerance must already exist in
  // the baseline: adding a marker cannot retroactively teach an N−1 reader.
  const oldValues = literalValues(before);
  const newValues = literalValues(after);
  const literalKeyword = after.enum !== undefined || before.enum !== undefined ? "enum" : "const";
  if (
    newValues !== undefined &&
    (oldValues === undefined ||
      oldValues.some((value) => !newValues.some((next) => isDeepStrictEqual(value, next))))
  ) {
    fail(`${path}/${literalKeyword}`, "enum member removed or literal narrowed");
  }
  const tolerantEnum =
    (before[openEnumMarker] === true && after[openEnumMarker] === true) ||
    state.tolerantEnumPaths?.includes(path);
  if (
    direction === "output" &&
    oldValues !== undefined &&
    !tolerantEnum &&
    ((newValues === undefined && after.anyOf === undefined) ||
      newValues?.some((next) => !oldValues.some((value) => isDeepStrictEqual(value, next))))
  ) {
    fail(`${path}/${literalKeyword}`, "output enum widened (requires tolerant reader)");
  }
  // Mixed Zod literals omit `type`. Even a tolerant scalar reader only earns
  // new values of its existing JSON types, not new nullability/value types.
  if (direction === "output" && oldValues !== undefined && tolerantEnum) {
    const oldTypes = new Set(oldValues.map(literalType));
    const newTypes = newValues?.map(literalType) ?? list(after.type);
    if (
      (newValues === undefined && after.type === undefined && after.anyOf === undefined) ||
      newTypes.some((type) => !oldTypes.has(type === "integer" ? "number" : type))
    ) {
      fail(`${path}/type`, "output enum value type widened");
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
  // oneOf is closed by default: additions may make an old value match TWO
  // branches. Only explicitly tolerant output unions get a disjointness proof.
  if (!same(before.oneOf, after.oneOf)) {
    const discriminator = before[openUnionMarker];
    const open =
      direction === "output" &&
      ["kind", "status", "op"].includes(discriminator) &&
      after[openUnionMarker] === discriminator;
    const oldVariants = open && unionVariants(before.oneOf, discriminator, state, 0);
    const newVariants = open && unionVariants(after.oneOf, discriminator, state, 1);
    if (!oldVariants || !newVariants) {
      fail(`${path}/oneOf`, "exclusive union changed (requires explicit review)");
    } else {
      for (const [index, variant] of oldVariants.entries()) {
        // Preserve every old discriminator value, including grouped enum
        // branches (attention). A grouped branch may gain new values, provided
        // the whole union remains disjoint and its old field contracts hold.
        const next = newVariants.find(({ values }) =>
          variant.values.every((value) => values.includes(value)),
        );
        const at = `${path}/oneOf/${index}`;
        if (!next) fail(at, "open union variant removed or discriminator changed");
        else
          changes.push(
            ...schemaChanges(variant.branch, next.branch, at, direction, {
              ...nested,
              // The disjointness proof permits growth of THIS discriminator,
              // not other enums nested inside a tolerant union's known branch.
              tolerantEnumPaths: [
                ...(state.tolerantEnumPaths ?? []),
                `${at}/properties/${escape(discriminator)}`,
              ],
            }),
          );
      }
    }
  }
  if (before.anyOf !== undefined || after.anyOf !== undefined) {
    const oldBranches = before.anyOf ?? [
      Object.fromEntries(Object.entries(before).filter(([key]) => key !== "anyOf")),
    ];
    const newBranches = after.anyOf ?? [
      Object.fromEntries(Object.entries(after).filter(([key]) => key !== "anyOf")),
    ];
    for (const [index, branch] of oldBranches.entries()) {
      const match = compatibleChanges(newBranches, (next) => compare(branch, next, path));
      if (!match) fail(`${path}/anyOf/${index}`, "union alternative removed or narrowed");
      else changes.push(...match);
    }
    if (direction === "output") {
      // Unlike the marked/disjoint oneOf exception, anyOf has no open-union
      // policy. Do not let an extra broad branch reuse an existing match and
      // silently expand output acceptance (even within the same JSON type).
      if (newBranches.length > oldBranches.length) {
        fail(`${path}/anyOf`, "output union alternative added or widened");
      }
      for (const [index, branch] of newBranches.entries()) {
        const match = compatibleChanges(oldBranches, (old) => compare(old, branch, path));
        if (!match) fail(`${path}/anyOf/${index}`, "output union alternative added or widened");
        else changes.push(...match);
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
    if (handled.has(key) || annotations.has(key) || same(before[key], after[key])) continue;
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

function compatibleChanges(candidates, compare) {
  for (const candidate of candidates) {
    const changes = compare(candidate);
    if (changes.length === 0) return changes;
  }
  return undefined;
}

function literalType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Intersect enum and const if both assertions are present. Literal objects
 * are wire values, so membership uses deep equality, not schema comparison. */
function literalValues(schema) {
  if (schema.const === undefined) return schema.enum;
  return schema.enum === undefined ||
    schema.enum.some((value) => isDeepStrictEqual(value, schema.const))
    ? [schema.const]
    : [];
}

/** Prove disjointness using a required string discriminator in every object
 * branch. Unknown/unbounded discriminators cannot justify an open union. */
function unionVariants(branches, discriminator, state, side) {
  if (!Array.isArray(branches) || !branches.length) return null;
  const seen = new Set();
  const variants = [];
  for (let branch of branches) {
    branch = resolveLocalRef(branch, state.roots[side], state.caches[side]);
    if (
      !object(branch) ||
      branch.type !== "object" ||
      !list(branch.required).includes(discriminator)
    )
      return null;
    const tag = resolveLocalRef(
      branch.properties?.[discriminator],
      state.roots[side],
      state.caches[side],
    );
    if (!object(tag)) return null;
    const values = tag.const !== undefined ? [tag.const] : tag.enum;
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((value) => typeof value !== "string" || seen.has(value))
    )
      return null;
    // Duplicate values inside a branch are harmless, but never across branches.
    const unique = [...new Set(values)];
    for (const value of unique) seen.add(value);
    variants.push({ branch, values: unique });
  }
  return variants;
}

/** Deep equality after resolving local references in each document; $defs
 * containers themselves are compared only through the references that use them. */
function resolvedEqual(old, next, state, seen = [], kind = "schema") {
  // Enum/const objects are wire data, not schemas; property-map keys are field
  // names, not annotations. Do not erase literal data or fields named title.
  if (kind === "literal") return isDeepStrictEqual(old, next);
  if (kind === "schema") {
    old = resolveLocalRef(old, state.roots[0], state.caches[0]);
    next = resolveLocalRef(next, state.roots[1], state.caches[1]);
  }
  if (Array.isArray(old) || Array.isArray(next))
    return (
      Array.isArray(old) &&
      Array.isArray(next) &&
      old.length === next.length &&
      old.every((value, index) => resolvedEqual(value, next[index], state, seen, kind))
    );
  if (!object(old) || !object(next)) return isDeepStrictEqual(old, next);
  if (seen.some(([a, b]) => a === old && b === next)) return true;
  const visited = [...seen, [old, next]];
  const oldKeys = assertionKeys(old, kind);
  return (
    isDeepStrictEqual(oldKeys, assertionKeys(next, kind)) &&
    oldKeys.every((key) =>
      resolvedEqual(
        old[key],
        next[key],
        state,
        visited,
        kind === "map"
          ? "schema"
          : key === "enum" || key === "const"
            ? "literal"
            : schemaMaps.has(key)
              ? "map"
              : "schema",
      ),
    )
  );
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
  // Zod may attach scalar metadata beside a shared schema's $ref. Preserve
  // its site-local opt-in without marking other uses of the same definition.
  const annotated =
    object(resolved) && Object.hasOwn(siblings, openEnumMarker)
      ? { ...resolved, [openEnumMarker]: siblings[openEnumMarker] }
      : resolved;
  cache.set(schema, annotated);
  return annotated;
}

// Baselines before VC-725 have no classification. Only these client families
// were bundled with their caller; every other unclassified entry stays frozen.
// Explicit metadata takes precedence, so reclassifying a frozen host command
// cannot use this migration fallback to bypass its old contract.
const desktopClass = (key, entry) =>
  entry.compatibility ??
  (/^(hosts|hostAdd|hostSignIns|hostLink)\./u.test(key) ? "client-local" : "host-command");

/** Public entries and desktop host commands are additive-only. Client-local
 * entries are reported, including additions and compatible schema edits: their
 * renderer and main ship together, with no N−1 promise. Host commands may leave
 * the desktop tier only by compatible same-key promotion to public.
 */
export function protocolChanges(before, after) {
  const changes = [];
  for (const [tier, entries] of Object.entries(before.tiers)) {
    for (const [key, entry] of Object.entries(entries)) {
      const path = `/tiers/${escape(tier)}/${escape(key)}`;
      const local = tier === "desktop" && desktopClass(key, entry) === "client-local";
      const desktopNext = after.tiers[tier]?.[key];
      if (
        tier === "desktop" &&
        desktopNext &&
        desktopClass(key, entry) !== desktopClass(key, desktopNext)
      )
        changes.push({
          path: `${path}/compatibility`,
          reason: "desktop compatibility class changed",
        });
      if (local) {
        if (!desktopNext || !isDeepStrictEqual(entry, desktopNext))
          changes.push({
            path,
            reason: desktopNext ? "client-local entry changed" : "client-local entry removed",
            severity: "warning",
          });
        continue;
      }
      const promoted = tier === "desktop" ? after.tiers.public?.[key] : undefined;
      const next = desktopNext ?? promoted;
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
  for (const [key, entry] of Object.entries(after.tiers.desktop ?? {})) {
    if (
      !Object.hasOwn(before.tiers.desktop ?? {}, key) &&
      desktopClass(key, entry) === "client-local"
    )
      changes.push({
        path: `/tiers/desktop/${escape(key)}`,
        reason: "client-local entry added",
        severity: "warning",
      });
  }
  // Public operation membership is frozen, even when widening it seems additive.
  if (
    before.baseOperations !== undefined &&
    !isDeepStrictEqual(
      list(before.baseOperations).toSorted(),
      list(after.baseOperations).toSorted(),
    )
  ) {
    changes.push({ path: "/baseOperations", reason: "frozen bootstrap membership changed" });
  }
  // Envelope fields beside a frame's id (VC-699) are read by a host like an
  // input: one may be added, never removed or narrowed.
  for (const [field, schema] of Object.entries(before.envelope ?? {})) {
    const path = `/envelope/${escape(field)}`;
    const next = after.envelope?.[field];
    if (next === undefined) changes.push({ path, reason: "envelope field removed" });
    else changes.push(...schemaChanges(schema, next, path, "input"));
  }
  for (const [feature, operations] of Object.entries(before.features ?? {})) {
    if (!isDeepStrictEqual(list(operations).toSorted(), list(after.features?.[feature]).toSorted()))
      changes.push({
        path: `/features/${escape(feature)}`,
        reason: "frozen feature membership changed",
      });
  }
  return changes;
}

/** Lines printed by the gate even when there are no compatibility failures. */
export function protocolReportLines(changes) {
  return changes
    .filter(({ severity }) => severity === "warning")
    .map(
      ({ path, reason }) =>
        `Report (client-local, not a cross-version promise): ${path}: ${reason}`,
    );
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
    (change) =>
      change.severity !== "warning" &&
      !allowlist.some((exception) => exception.path === change.path),
  );
}
