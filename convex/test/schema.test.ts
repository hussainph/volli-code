import { convexTest } from "convex-test";
import type { Infer } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import { newId, type Actor, type Id, type IdKind } from "@volli/shared/cloud";

import { actor } from "../functions/lib/validators";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

/** The shared type as stored: branded ids are plain strings in the schema. */
type Stored<T> =
  T extends Id<IdKind> ? string : T extends object ? { [K in keyof T]: Stored<T[K]> } : T;

describe("schema conventions", () => {
  const tables = Object.entries(schema.tables);

  test("every table with an `id` field has a `by_uuid` index on it, and nothing uses the reserved name", () => {
    const missing: string[] = [];
    for (const [name, table] of tables) {
      const indexes = table[" indexes"]();
      expect(indexes.map((index) => index.indexDescriptor)).not.toContain("by_id");
      const fields = (table.validator as { fields?: Record<string, unknown> }).fields ?? {};
      if (!("id" in fields)) continue;
      const byUuid = indexes.find((index) => index.indexDescriptor === "by_uuid");
      if (byUuid?.fields.join() !== "id") missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test("no table stores a machine path", () => {
    for (const [name, table] of tables) {
      const fields = Object.keys((table.validator as { fields: Record<string, unknown> }).fields);
      expect(
        fields.filter((field) => /path/i.test(field)),
        name,
      ).toEqual([]);
    }
  });
});

function boardEvent(eventActor: unknown, kind = "created") {
  return {
    id: newId("boardEvent"),
    projectId: newId("project"),
    ticketId: null,
    seq: 1,
    kind,
    actor: eventActor,
    occurredAt: 0,
    payload: { kind },
  };
}

describe("the Actor validator mirrors the shared Actor", () => {
  test("types agree (ids as plain strings)", () => {
    expectTypeOf<Infer<typeof actor>>().toEqualTypeOf<Stored<Actor>>();
  });

  const user = newId("user");
  const session = newId("session");
  const valid: Actor[] = [
    { kind: "person", userId: user, via: "desktop" },
    { kind: "agent", userId: user, sessionId: session, ticketId: null },
    { kind: "automation", userId: user, automationId: "a", runId: "r", sessionId: session },
    { kind: "volli", reason: "migration", onBehalfOf: user, runnerId: newId("runner") },
    { kind: "legacy", was: "unauthenticated", sessionId: "local-1" },
  ];

  test("every arm is storable", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const arm of valid) {
        await ctx.db.insert("boardEvents", boardEvent(arm) as never);
      }
    });
    const stored = await t.run((ctx) => ctx.db.query("boardEvents").collect());
    expect(stored.map((row) => row.actor)).toEqual(valid);
  });

  test.each([
    ["an unknown arm", { kind: "robot", userId: "x" }],
    ["an unknown Volli reason", { kind: "volli", reason: "whim" }],
    ["an unknown client", { kind: "person", userId: "x", via: "watch" }],
  ])("closed on write: %s is refused", async (_label, bad) => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) => ctx.db.insert("boardEvents", boardEvent(bad) as never)),
    ).rejects.toThrow(/Validator error/);
  });

  test("closed on write: an unknown board event kind is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) => ctx.db.insert("boardEvents", boardEvent(valid[0], "teleported") as never)),
    ).rejects.toThrow(/Validator error/);
  });
});
