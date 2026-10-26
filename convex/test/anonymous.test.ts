/**
 * The anonymous-call sweep: every public query, mutation and action, called
 * with no identity, refuses with a typed `unauthenticated` (a `ConvexError`
 * whose `data.code` is `"unauthenticated"`) and leaves no trace behind.
 *
 * A local backend reflects any CORS origin, so a public function that answers
 * an anonymous caller answers any page that can reach it (convex/README.md:
 * "Every public function requires an identity").
 *
 * `_generated/api.js` is the `anyApi` proxy, which names nothing at runtime,
 * so the sweep enumerates what is actually registered: every export of every
 * function module (the same glob `convex-test` runs) that is a public query,
 * mutation or action. It then checks that this glob sees exactly the modules
 * codegen put in `_generated/api.d.ts`, so a module the glob misses fails
 * here rather than slipping past the sweep.
 *
 * Arguments are generated from each function's own validator: the first
 * member of a union, required fields only, a lowercase UUID for every string.
 * They pass the validator, so what answers is the handler, not the validator.
 */

import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type FunctionReference,
  type FunctionType,
  type GenericDatabaseReader,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import { jsonToConvex, type ObjectFieldType, type ValidatorJSON, type Value } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type { api } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

// ── the allowlists ───────────────────────────────────────────────────────────

/** `"module:export"` for every public function the generated `api` declares. */
type PathsIn<Node, Prefix extends string> = {
  [Key in keyof Node & string]: Node[Key] extends FunctionReference<FunctionType, "public">
    ? `${Prefix}:${Key}`
    : PathsIn<Node[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
}[keyof Node & string];
type PublicPath = PathsIn<typeof api, "">;

/**
 * Public functions that deliberately answer an anonymous caller, each with
 * the reason it is safe. Empty: every public query, mutation and action
 * requires an identity. An entry is a design decision recorded here, never a
 * way to quiet a row whose guard was forgotten or runs too late.
 */
const ANONYMOUS_FUNCTIONS: Partial<Record<PublicPath, string>> = {};

/**
 * The HTTP routes, which are anonymous by design: a box calls `/runner/*`
 * before it has an identity, and GitHub calls `/github/*`. Each proves itself
 * with a one-time secret or a signature instead (convex/README.md). A new
 * route fails the sweep until it is added here with how it proves itself.
 */
const ANONYMOUS_HTTP_ROUTES: Record<string, string> = {
  // Spends a one-time install token; only then mints the runner's first credential.
  "POST /runner/link": "install token",
  // Opens a device-code link that grants nothing until a signed-in person approves its code.
  "POST /runner/link/start": "device code, approved by a signed-in person",
  // Answers the credential once, to the holder of the start's poll secret, after approval.
  "POST /runner/link/poll": "poll secret",
  // Exchanges the rotated refresh credential (with reuse detection) for a runner token.
  "POST /runner/token": "refresh credential",
  // GitHub's OAuth return: a confirm page only for a live connect flow's one-time state.
  "GET /github/oauth/callback": "connect flow state",
  // The confirm form: the live connect flow's one-time state plus GitHub's code.
  "POST /github/oauth/callback": "connect flow state",
  // GitHub's Setup URL: a live install flow's state; the installation is checked
  // against the flow owner's own GitHub installations.
  "GET /github/setup": "install flow state",
  // Deliveries signed with the webhook secret (HMAC over the body), then the App id.
  "POST /github/webhook": "webhook signature",
};

/**
 * A few functions the enumeration must find, one per kind. Typed against the
 * generated `api`, so a rename breaks the build rather than the sweep.
 */
const MUST_FIND = {
  "accounts:viewer": "query",
  "accounts:ensureViewer": "mutation",
  "secrets:set": "action",
} as const satisfies Partial<Record<PublicPath, FunctionType>>;

/** Internal functions the enumeration must leave out. */
const MUST_SKIP = ["testSeed:seedWorld", "testJobs:enqueue", "previewAccess:set"];

// ── enumeration ──────────────────────────────────────────────────────────────

interface Registered {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  exportArgs?: () => string;
}

interface PublicFunction {
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

const loaded: Array<{ modulePath: string; exports: Record<string, unknown> }> = [];
for (const [key, load] of Object.entries(modules)) {
  const modulePath = modulePathOf(key);
  if (modulePath === null) continue;
  loaded.push({ modulePath, exports: (await load()) as Record<string, unknown> });
}
loaded.sort((a, b) => a.modulePath.localeCompare(b.modulePath));

const registered: Array<{ path: string; fn: Registered }> = loaded.flatMap(
  ({ modulePath, exports }) =>
    Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name, value]) => ({ path: `${modulePath}:${name}`, fn: value as Registered })),
);

const PUBLIC: PublicFunction[] = registered.flatMap(({ path, fn }) => {
  const kind = kindOf(fn);
  if (kind === null || fn.isPublic !== true) return [];
  return [{ path, kind, args: JSON.parse(fn.exportArgs!()) as ValidatorJSON }];
});

const SWEPT = PUBLIC.filter(({ path }) => !(path in ANONYMOUS_FUNCTIONS));

// ── arguments ────────────────────────────────────────────────────────────────

/** A string every id check accepts: canonical, lowercase, version 4. */
const SAMPLE_STRING = "00000000-0000-4000-8000-000000000000";

function sample(validator: ValidatorJSON, at: string): Value {
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
      return sample(validator.value[0]!, at);
    case "object":
      return sampleFields(validator.value, at);
    case "id":
    case "commitTs":
      throw new Error(`${at}: no generated sample for a \`${validator.type}\` argument yet.`);
  }
}

function sampleFields(fields: Record<string, ObjectFieldType>, at: string): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, field]) => !field.optional)
      .map(([name, field]) => [name, sample(field.fieldType, `${at}.${name}`)]),
  );
}

function sampleArgs({ path, args }: PublicFunction): Record<string, Value> {
  if (args.type === "any") return {};
  if (args.type !== "object") throw new Error(`${path}: arguments are not an object validator.`);
  return sampleFields(args.value, path);
}

// ── calls ────────────────────────────────────────────────────────────────────

function setup() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof setup>;
type Args = Record<string, Value>;

function call(t: Tester, fn: PublicFunction, args: Args): Promise<unknown> {
  switch (fn.kind) {
    case "query":
      return t.query(makeFunctionReference<"query", Args>(fn.path), args);
    case "mutation":
      return t.mutation(makeFunctionReference<"mutation", Args>(fn.path), args);
    case "action":
      return t.action(makeFunctionReference<"action", Args>(fn.path), args);
  }
}

/** How a call ended, as one comparable line: the refusal's code, or what went wrong. */
async function outcome(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "answered an anonymous caller";
  } catch (error) {
    const data = typeof error === "object" && error !== null ? Reflect.get(error, "data") : null;
    const code = typeof data === "object" && data !== null ? Reflect.get(data, "code") : null;
    if (typeof code === "string") return `refused: ${code}`;
    return `threw an untyped error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Every document an anonymous call left behind, by table, scheduled functions included. */
async function traces(t: Tester): Promise<Record<string, number>> {
  return t.run(async (ctx) => {
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const left: Record<string, number> = {};
    for (const table of Object.keys(schema.tables)) {
      const rows = await db.query(table).take(1);
      if (rows.length > 0) left[table] = rows.length;
    }
    const scheduled = await ctx.db.system.query("_scheduled_functions").take(1);
    if (scheduled.length > 0) left["_scheduled_functions"] = scheduled.length;
    return left;
  });
}

// ── the sweep ────────────────────────────────────────────────────────────────

describe("the enumeration", () => {
  test("loads exactly the modules codegen put in the generated api", () => {
    const source = readFileSync(
      new URL("../functions/_generated/api.d.ts", import.meta.url),
      "utf8",
    );
    const block = /declare const fullApi: ApiFromModules<\{([\s\S]*?)\}>;/u.exec(source);
    expect(block, "api.d.ts declares fullApi").not.toBeNull();
    const generated = [
      ...block![1]!.matchAll(/^\s*(?:"([^"]+)"|([\w$]+)):\s*typeof\s+[\w$]+;\s*$/gmu),
    ].map(([, quoted, bare]) => quoted ?? bare!);
    expect(generated.length).toBeGreaterThan(0);
    expect(loaded.map(({ modulePath }) => modulePath).toSorted()).toEqual(generated.toSorted());
  });

  test("finds public functions of every kind and no internal ones", () => {
    const found = Object.fromEntries(PUBLIC.map(({ path, kind }) => [path, kind]));
    for (const [path, kind] of Object.entries(MUST_FIND)) expect(found[path], path).toBe(kind);
    for (const path of MUST_SKIP) {
      expect(
        registered.some((entry) => entry.path === path),
        `${path} is registered`,
      ).toBe(true);
      expect(found[path], path).toBeUndefined();
    }
  });

  test("every allowlisted function is still public and says why", () => {
    const paths = new Set(PUBLIC.map(({ path }) => path));
    for (const [path, reason] of Object.entries(ANONYMOUS_FUNCTIONS)) {
      expect(paths.has(path), `${path} is a public function`).toBe(true);
      expect(reason?.trim(), `${path} has a reason`).toBeTruthy();
    }
  });
});

describe("an anonymous caller", () => {
  test.each(SWEPT)("is refused by $path ($kind)", async (fn) => {
    const t = setup();
    await expect(outcome(call(t, fn, sampleArgs(fn)))).resolves.toBe("refused: unauthenticated");
    await expect(traces(t), "documents left behind").resolves.toEqual({});
  });
});

describe("the HTTP routes", () => {
  test("are exactly the allowlisted anonymous doors", () => {
    const http = loaded.find(({ modulePath }) => modulePath === "http")?.exports["default"] as
      | HttpRouter
      | undefined;
    expect(http, "http.ts exports its router").toBeDefined();
    const routes = http!.getRoutes().map(([path, method]) => `${method} ${path}`);
    expect(routes.toSorted()).toEqual(Object.keys(ANONYMOUS_HTTP_ROUTES).toSorted());
  });
});
