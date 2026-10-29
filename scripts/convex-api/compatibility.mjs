/** Compare the declared wire contract, not inferred TypeScript handler results. */
import { serialize } from "./snapshot.mjs";
import { compareVersions, parseVersion } from "../convex-compat/tags.mjs";

export { latestTag as latestAppTag } from "../convex-compat/tags.mjs";

const equal = (a, b) => serialize(a) === serialize(b);

/** Whether every old input remains accepted, including strict object keys. */
export function accepts(previous, next) {
  if (equal(previous, next) || next.type === "any") return true;
  if (previous.type === "any") return false;
  if (previous.type === "union") return previous.value.every((arm) => accepts(arm, next));
  if (next.type === "union") return next.value.some((arm) => accepts(previous, arm));
  if (previous.type === "literal") {
    const type = typeof previous.value;
    if (next.type === "string" && type === "string") return true;
    if (next.type === "boolean" && type === "boolean") return true;
    if (next.type === "float64" && type === "number") return true;
    if (next.type === "int64" && previous.value?.$integer) return true;
    return false;
  }
  if (previous.type !== next.type) return false;
  switch (previous.type) {
    case "array":
      return accepts(previous.value, next.value);
    case "record":
      return (
        accepts(previous.keys, next.keys) &&
        accepts(previous.values.fieldType, next.values.fieldType)
      );
    case "object":
      return (
        Object.entries(previous.value).every(([key, field]) => {
          const to = next.value[key];
          return to && (!field.optional || to.optional) && accepts(field.fieldType, to.fieldType);
        }) &&
        Object.entries(next.value).every(([key, field]) => key in previous.value || field.optional)
      );
    default:
      // id/table changes and unknown validators fail closed; scalar matches
      // were handled by equality above.
      return false;
  }
}

/** Outputs preserve every declared field an older client may read. Extra
 * fields are harmless. Required -> optional and new union arms are not: unlike
 * input widening they can hand an older client a value it cannot understand.
 */
function preservesReturn(previous, next) {
  if (equal(previous, next) || previous.type === "any") return true;
  if (next.type === "any") return false;
  if (next.type === "union") return next.value.every((arm) => preservesReturn(previous, arm));
  if (previous.type === "union") return previous.value.some((arm) => preservesReturn(arm, next));
  if (previous.type === "object" && next.type === "object") {
    return Object.entries(previous.value).every(([key, field]) => {
      const to = next.value[key];
      return (
        to && (field.optional || !to.optional) && preservesReturn(field.fieldType, to.fieldType)
      );
    });
  }
  if (previous.type === "array" && next.type === "array")
    return preservesReturn(previous.value, next.value);
  if (previous.type === "record" && next.type === "record") {
    return (
      accepts(next.keys, previous.keys) &&
      preservesReturn(previous.values.fieldType, next.values.fieldType)
    );
  }
  return accepts(next, previous);
}

export function contractChanges(previous, next) {
  if (previous.format !== 1 || next.format !== 1 || !previous.functions || !next.functions)
    throw new Error("Unsupported Convex API contract format");
  const changes = [];
  const add = (fn, path, code) => changes.push({ function: fn, path, code });
  for (const [name, before] of Object.entries(previous.functions)) {
    const after = next.functions[name];
    if (!after) {
      add(name, "function", "function_removed_or_internal");
      continue;
    }
    if (before.kind !== after.kind) add(name, "kind", "function_kind_changed");
    if (before.args.type === "object" && after.args.type === "object") {
      for (const [key, field] of Object.entries(before.args.value)) {
        const to = after.args.value[key];
        if (!to) add(name, `args.${key}`, "argument_removed");
        else if (field.optional && !to.optional) add(name, `args.${key}`, "argument_made_required");
        else if (!accepts(field.fieldType, to.fieldType))
          add(name, `args.${key}`, "argument_retyped_or_narrowed");
      }
      for (const [key, field] of Object.entries(after.args.value)) {
        if (!(key in before.args.value) && !field.optional)
          add(name, `args.${key}`, "required_argument_added");
      }
    } else if (!accepts(before.args, after.args)) add(name, "args", "arguments_narrowed");
    if (
      before.returns !== null &&
      (after.returns === null || !preservesReturn(before.returns, after.returns))
    )
      add(name, "returns", "return_removed_or_retyped");
  }
  return changes;
}

export function unapprovedChanges(changes, allowlist, releasedTag) {
  if (!Array.isArray(allowlist)) throw new Error("API allowlist must be an array");

  for (const entry of allowlist) {
    if (
      !entry.function ||
      !entry.path ||
      !entry.code ||
      !entry.reason?.trim() ||
      !parseVersion(entry.retiresIn)
    )
      throw new Error(
        "API exceptions require function, path, code, reason and retiresIn release (vX.Y.Z[-canary.N])",
      );
    if (
      releasedTag &&
      compareVersions(parseVersion(releasedTag), parseVersion(entry.retiresIn)) >= 0
    )
      throw new Error(`Expired API exception for ${entry.function}: retired in ${entry.retiresIn}`);
  }
  return changes.filter(
    (change) =>
      !allowlist.some(
        (entry) =>
          entry.function === change.function &&
          entry.path === change.path &&
          entry.code === change.code,
      ),
  );
}
