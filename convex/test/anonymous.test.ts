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
 * so the sweep enumerates what is actually registered (`public-functions.ts`):
 * every export of every function module (the same glob `convex-test` runs)
 * that is a public query, mutation or action. It then checks that this glob sees exactly the modules
 * codegen put in `_generated/api.d.ts`, so a module the glob misses fails
 * here rather than slipping past the sweep.
 *
 * Arguments are generated from each function's own validator: the first
 * member of a union, required fields only, a lowercase UUID for every string.
 * They pass the validator, so what answers is the handler, not the validator.
 */

import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import type {
  FunctionType,
  GenericDatabaseReader,
  GenericDataModel,
  HttpRouter,
} from "convex/server";
import { describe, expect, test } from "vite-plus/test";

import schema from "../functions/schema";
import {
  PUBLIC,
  call,
  loaded,
  modules,
  refusalCode,
  registered,
  sampleArgs,
  type PublicPath,
} from "./public-functions";

// ── the allowlists ───────────────────────────────────────────────────────────

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
  "automations:list": "query",
  "automations:arm": "mutation",
  "automations:armSchedule": "mutation",
  "automations:runsForTicket": "query",
} as const satisfies Partial<Record<PublicPath, FunctionType>>;

/** Internal functions the enumeration must leave out. */
const MUST_SKIP = ["testSeed:seedWorld", "testJobs:enqueue", "previewAccess:set"];

// ── calls ────────────────────────────────────────────────────────────────────

const SWEPT = PUBLIC.filter(({ path }) => !(path in ANONYMOUS_FUNCTIONS));

function setup() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof setup>;

/** How a call ended, as one comparable line: the refusal's code, or what went wrong. */
async function outcome(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "answered an anonymous caller";
  } catch (error) {
    const code = refusalCode(error);
    if (code !== null) return `refused: ${code}`;
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
