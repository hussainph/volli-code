/**
 * Every public function the deployment registers, enumerated the way the
 * anonymous sweep does (`anonymous.test.ts`), with arguments generated from
 * each function's own validator. Shared by the sweeps over the generated api.
 *
 * `_generated/api.js` is the `anyApi` proxy, which names nothing at runtime,
 * so this enumerates what is actually registered: every export of every
 * function module (the same glob `convex-test` runs) that is a public query,
 * mutation or action.
 */

import type { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference, type FunctionType } from "convex/server";
import { jsonToConvex, type ObjectFieldType, type ValidatorJSON, type Value } from "convex/values";

import type { api } from "../functions/_generated/api";

export const modules = import.meta.glob("../functions/**/*.ts");

/** `"module:export"` for every public function the generated `api` declares. */
type PathsIn<Node, Prefix extends string> = {
  [Key in keyof Node & string]: Node[Key] extends FunctionReference<FunctionType, "public">
    ? `${Prefix}:${Key}`
    : PathsIn<Node[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
}[keyof Node & string];
export type PublicPath = PathsIn<typeof api, "">;

type Tester = ReturnType<typeof convexTest>;
type Args = Record<string, Value>;

// ── enumeration ──────────────────────────────────────────────────────────────

interface Registered {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  exportArgs?: () => string;
}

export interface PublicFunction {
  path: string;
  kind: FunctionType;
  args: ValidatorJSON;
}

/**
 * A glob key's Convex module path, or `null` for what codegen skips: its own
 * output, the schema, and config files such as `auth.config.ts`.
 */
function modulePathOf(key: string): string | null {
  const path = key.replace(/^\.\.\/functions\//u, "").replace(/\.ts$/u, "");
  if (path.startsWith("_generated/") || path === "schema") return null;
  if (path.split("/").pop()!.includes(".")) return null;
  return path;
}

function kindOf(fn: Registered): FunctionType | null {
  if (fn.isQuery === true) return "query";
  if (fn.isMutation === true) return "mutation";
  if (fn.isAction === true) return "action";
  return null;
}

export const loaded: Array<{ modulePath: string; exports: Record<string, unknown> }> = [];
for (const [key, load] of Object.entries(modules)) {
  const modulePath = modulePathOf(key);
  if (modulePath === null) continue;
  loaded.push({ modulePath, exports: (await load()) as Record<string, unknown> });
}
loaded.sort((a, b) => a.modulePath.localeCompare(b.modulePath));

export const registered: Array<{ path: string; fn: Registered }> = loaded.flatMap(
  ({ modulePath, exports }) =>
    Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name, value]) => ({ path: `${modulePath}:${name}`, fn: value as Registered })),
);

export const PUBLIC: PublicFunction[] = registered.flatMap(({ path, fn }) => {
  const kind = kindOf(fn);
  if (kind === null || fn.isPublic !== true) return [];
  return [{ path, kind, args: JSON.parse(fn.exportArgs!()) as ValidatorJSON }];
});

// ── arguments ────────────────────────────────────────────────────────────────

/** A string every id check accepts: canonical, lowercase, version 4. */
export const SAMPLE_STRING = "00000000-0000-4000-8000-000000000000";

/**
 * Fills a named argument instead of the generated sample, or `undefined` to
 * leave it to the sample (and leave an optional one out).
 */
export type ArgumentFill = (name: string, validator: ValidatorJSON) => Value | undefined;

function sample(validator: ValidatorJSON, at: string, fill?: ArgumentFill): Value {
  switch (validator.type) {
    case "null":
      return null;
    case "number":
      return 1;
    case "bigint":
      return 1n;
    case "boolean":
      return false;
    case "string":
      return SAMPLE_STRING;
    case "bytes":
      return new ArrayBuffer(0);
    case "any":
      return {};
    case "literal":
      return jsonToConvex(validator.value);
    case "array":
      return [];
    case "record":
      return {};
    case "union":
      return sample(validator.value[0]!, at, fill);
    case "object":
      return sampleFields(validator.value, at, fill);
    case "id":
    case "commitTs":
      throw new Error(`${at}: no generated sample for a \`${validator.type}\` argument yet.`);
  }
}

function sampleFields(
  fields: Record<string, ObjectFieldType>,
  at: string,
  fill?: ArgumentFill,
): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [name, field] of Object.entries(fields)) {
    const filled = fill?.(name, field.fieldType);
    if (filled !== undefined) out[name] = filled;
    else if (!field.optional) out[name] = sample(field.fieldType, `${at}.${name}`, fill);
  }
  return out;
}

/**
 * Arguments that pass `fn`'s own validator: the first member of a union,
 * required fields only, a lowercase UUID for every string; `fill` names
 * values for arguments it recognises (optional ones included).
 */
export function sampleArgs(
  { path, args }: PublicFunction,
  fill?: ArgumentFill,
): Record<string, Value> {
  if (args.type === "any") return {};
  if (args.type !== "object") throw new Error(`${path}: arguments are not an object validator.`);
  return sampleFields(args.value, path, fill);
}

// ── calls ────────────────────────────────────────────────────────────────────

export function call(
  t: Pick<Tester, "query" | "mutation" | "action">,
  fn: PublicFunction,
  args: Args,
): Promise<unknown> {
  switch (fn.kind) {
    case "query":
      return t.query(makeFunctionReference<"query", Args>(fn.path), args);
    case "mutation":
      return t.mutation(makeFunctionReference<"mutation", Args>(fn.path), args);
    case "action":
      return t.action(makeFunctionReference<"action", Args>(fn.path), args);
  }
}

/** A refusal's typed `code` (a `ConvexError`'s `data.code`), or `null` for any other outcome. */
export function refusalCode(error: unknown): string | null {
  const data = typeof error === "object" && error !== null ? Reflect.get(error, "data") : null;
  const code = typeof data === "object" && data !== null ? Reflect.get(data, "code") : null;
  return typeof code === "string" ? code : null;
}
