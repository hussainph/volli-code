/**
 * The profile step's door: a person's own settings, carried once, under their
 * own sign-in, never anyone else's and never a project's.
 */
import { MIGRATION_PLACEHOLDERS } from "@volli/shared/cloud";
import { describe, expect, test } from "vite-plus/test";

import { fixtureUuid as U } from "../../packages/shared/src/cloud/migration-import.fixture";
import { api } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import { setup, signIn } from "./board-helpers";

const PERSON = { kind: "person", userId: MIGRATION_PLACEHOLDERS.userId };

function setting(name: string, definition: unknown, id = U(40 + name.length)) {
  return {
    id,
    level: "personal",
    userId: MIGRATION_PLACEHOLDERS.userId,
    workspaceId: null,
    projectId: null,
    kind: "app_setting",
    name,
    state: "on",
    definition,
    revision: 1,
    updatedBy: PERSON,
    updatedAt: 1,
  };
}

async function world() {
  const t = setup();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, { ownerUserId: alice.userId, memberUserIds: [bob.userId], runners: 1 }),
  );
  return { t, alice, bob, workspaceId: seeded.workspaceId, runnerId: seeded.runnerIds[0]! };
}

describe("profileImports.importPersonalSettings", () => {
  test("stores the person's settings once; a re-send is unchanged, a changed one keeps the stored", async () => {
    const { t, alice, workspaceId, runnerId } = await world();
    const args = { workspaceId, runnerId, rows: [setting("model", { a: 1 })] };
    expect(await alice.as.mutation(api.profileImports.importPersonalSettings, args)).toMatchObject({
      inserted: 1,
      unchanged: 0,
    });
    expect(await alice.as.mutation(api.profileImports.importPersonalSettings, args)).toMatchObject({
      inserted: 0,
      unchanged: 1,
    });
    const changed = await alice.as.mutation(api.profileImports.importPersonalSettings, {
      ...args,
      rows: [setting("model", { a: 2 })],
    });
    expect(changed).toMatchObject({ inserted: 0, conflicts: [{ code: "conflict" }] });
    const stored = await t.run((ctx) =>
      ctx.db
        .query("configEntries")
        .withIndex("by_scope_kind_name", (q) => q.eq("scopeKey", `u:${alice.userId}`))
        .collect(),
    );
    expect(stored.map((entry) => [entry.userId, entry.definition])).toEqual([
      [alice.userId, { a: 1 }],
    ]);
  });

  test("refuses a project's entry, and never touches another person's", async () => {
    const { alice, bob, workspaceId, runnerId } = await world();
    const project = { ...setting("skills", {}), level: "project", projectId: U(1) };
    const refused = await alice.as.mutation(api.profileImports.importPersonalSettings, {
      workspaceId,
      runnerId,
      rows: [project],
    });
    expect(refused).toMatchObject({ inserted: 0, rejected: [{ code: "not_personal" }] });
    const id = U(60);
    await alice.as.mutation(api.profileImports.importPersonalSettings, {
      workspaceId,
      runnerId,
      rows: [setting("theme", { dark: true }, id)],
    });
    // Bob's own runner is not his, and his copy of the same id is Alice's row.
    await expect(
      bob.as.mutation(api.profileImports.importPersonalSettings, {
        workspaceId,
        runnerId,
        rows: [setting("theme", { dark: true }, id)],
      }),
    ).rejects.toMatchObject({ data: { code: "runner_unavailable" } });
  });

  test("needs a Workspace the person belongs to", async () => {
    const { t, runnerId } = await world();
    const carol = await signIn(t, "carol");
    const other = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: carol.userId }));
    const { alice } = { alice: await signIn(t, "alice") };
    await expect(
      alice.as.mutation(api.profileImports.importPersonalSettings, {
        workspaceId: other.workspaceId,
        runnerId,
        rows: [],
      }),
    ).rejects.toMatchObject({ data: { code: "not_a_member" } });
  });
});
