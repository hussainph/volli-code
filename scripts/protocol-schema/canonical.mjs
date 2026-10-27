/** Object keys are canonical; array order (including enums) is declaration order. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stable(value[key])]),
  );
}

const schemaMaps = ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"];
const schemaLists = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaValues = [
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];

/** Normalize schema syntax only: never rewrite literal/default/example data. */
export function canonicalizeSchema(schema) {
  if (typeof schema !== "object" || schema === null) return schema;
  const result = { ...schema };
  for (const key of schemaMaps) {
    if (result[key])
      result[key] = Object.fromEntries(
        Object.entries(result[key]).map(([name, value]) => [name, canonicalizeSchema(value)]),
      );
  }
  for (const key of schemaLists) {
    if (Array.isArray(result[key])) result[key] = result[key].map(canonicalizeSchema);
  }
  for (const key of schemaValues) {
    if (result[key] !== undefined)
      result[key] = Array.isArray(result[key])
        ? result[key].map(canonicalizeSchema)
        : canonicalizeSchema(result[key]);
  }
  // A type array is exactly the union of its individual types. Preserve all
  // sibling assertions, and never overwrite an existing anyOf constraint.
  if (Array.isArray(result.type) && result.anyOf === undefined) {
    const types = result.type;
    delete result.type;
    result.anyOf = types.map((type) => ({ type }));
  }
  return result;
}

export function canonicalizeProtocol(protocol) {
  return stable({
    ...protocol,
    envelope: Object.fromEntries(
      Object.entries(protocol.envelope).map(([key, schema]) => [key, canonicalizeSchema(schema)]),
    ),
    tiers: Object.fromEntries(
      Object.entries(protocol.tiers).map(([tier, entries]) => [
        tier,
        Object.fromEntries(
          Object.entries(entries).map(([key, entry]) => [
            key,
            {
              ...entry,
              input: canonicalizeSchema(entry.input),
              output: canonicalizeSchema(entry.output),
            },
          ]),
        ),
      ]),
    ),
  });
}
