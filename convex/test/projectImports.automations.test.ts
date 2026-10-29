import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  migrationRowDigest,
  newId,
} from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { code } from "./board-helpers";
import {
  MOVED,
  U,
  MANIFEST_SHA,
  beginArgs,
  expectedFor,
  importAll,
  importWorld,
} from "./projectImport-fixtures";

const NOW = Date.parse("2026-03-07T12:00:00Z");
beforeEach(() => vi.stubEnv("VOLLI_TEST_JWKS", "data:test"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const w = await importWorld();
  w.records.automations[0]!.triggerSpec = {
    kind: "schedule",
    schedule: { preset: "hourly", minute: 15, timeZone: "UTC" },
  };
  w.records.automations.push({
    ...w.records.automations[0],
    id: U(30),
    name: "Arrival",
    triggerSpec: { kind: "columns", columns: ["todo"] },
  });
  w.records.automationArmings[0]!.automationId = U(30);
  w.expected = expectedFor(w.records, w.target);
  await w.t.run(async (ctx) => {
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", w.runnerId))
      .unique();
    await ctx.db.patch(runner!._id, { capabilities: { tools: ["automation.run"] } });
  });
  await w.alice.as.mutation(api.projectImports.begin, beginArgs(w));
  const results = await importAll(w.alice.as, w.moveId, w.records);
  for (const stream of MIGRATION_IMPORT_STREAMS)
    expect(results[stream], stream).toMatchObject({ conflicts: [], rejected: [] });
  return w;
}

async function commit(w: Awaited<ReturnType<typeof world>>) {
  await w.alice.as.mutation(api.projectImports.commit, {
    moveId: w.moveId,
    manifestSha256: MANIFEST_SHA,
  });
}

describe("moved Automation safety", () => {
  test("armings and schedules land paused, replay identically, and read back to the promised digest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const w = await world();
    for (const stream of ["automationArmings", "automationSchedules"] as const) {
      const read = await w.alice.as.query(api.projectImports.readRows, {
        moveId: w.moveId,
        stream,
        cursor: null,
        numItems: 2,
      });
      expect(read.rows).toHaveLength(1);
      expect(read.rows[0]).toMatchObject({ pausedAt: expect.any(Number), pausedReason: "moved" });
      expect(read.rows[0]!.pausedAt).toBeGreaterThanOrEqual(NOW);
      const digest = new MigrationDigest();
      for (const row of read.rows) digest.add(migrationRowDigest(stream, row));
      expect(digest.value).toBe(w.expected.find((e) => e.stream === stream)!.digest);
      vi.setSystemTime(NOW + 60_000);
      expect(
        await w.alice.as.mutation(api.projectImports.importRows, {
          moveId: w.moveId,
          stream,
          rows: w.records[stream],
        }),
      ).toMatchObject({ inserted: 0, unchanged: 1, conflicts: [], rejected: [] });
    }
    const stored = await w.t.run((ctx) => ctx.db.query("automationSchedules").collect());
    expect(stored[0]).toMatchObject({
      nextFireAt: 0,
      lastFiredAt: null,
      pendingJobId: null,
      pendingRunId: null,
      gapRunId: null,
    });
    await expect(
      w.alice.as.query(api.projectImports.rearmList, { moveId: w.moveId }),
    ).rejects.toThrow(code("import_closed"));
    await commit(w);
    await w.t.mutation(internal.testAutomations.fireDueAt, { now: NOW + 86_400_000 });
    expect(await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
    expect(await w.alice.as.query(api.projectImports.rearmList, { moveId: w.moveId })).toEqual({
      projectId: MOVED.projectId,
      columns: [{ automationId: U(30), name: "Arrival", status: "todo" }],
      schedules: [{ automationId: U(10), name: "Nightly" }],
      inertGlobals: [],
    });
    await expect(
      w.bob.as.query(api.projectImports.rearmList, { moveId: w.moveId }),
    ).rejects.toThrow(code("not_found"));
  });

  test("explicit re-arm on this Mac clears the list and computes a strictly-future cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const w = await world();
    await commit(w);
    const arm = {
      commandId: newId("command"),
      projectId: MOVED.projectId,
      status: "todo" as const,
      automationId: U(30),
      runnerId: w.runnerId,
    };
    await w.alice.as.mutation(api.automations.arm, arm);
    await w.alice.as.mutation(api.automations.arm, arm);
    const schedule = { commandId: newId("command"), automationId: U(10), runnerId: w.runnerId };
    await w.alice.as.mutation(api.automations.armSchedule, schedule);
    expect(await w.alice.as.query(api.projectImports.rearmList, { moveId: w.moveId })).toEqual({
      projectId: MOVED.projectId,
      columns: [],
      schedules: [],
      inertGlobals: [],
    });
    const rows = await w.t.run((ctx) => ctx.db.query("automationSchedules").collect());
    expect(rows[0]).toMatchObject({
      pausedAt: null,
      pausedReason: null,
      runnerId: w.runnerId,
      armedByUserId: w.alice.userId,
    });
    expect(rows[0]!.nextFireAt).toBeGreaterThan(NOW);
    expect(await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
  });

  test("lists only the current person's inert globals, without executable definitions", async () => {
    const w = await world();
    await commit(w);
    const entry = {
      id: U(91),
      level: "personal",
      userId: "$local-user",
      workspaceId: null,
      projectId: null,
      kind: "automation",
      name: "Global sweep",
      state: "on",
      definition: { instructions: "private Instructions" },
      revision: 1,
      updatedBy: { kind: "person", userId: "$local-user" },
      updatedAt: 1,
    };
    await w.alice.as.mutation(api.profileImports.importPersonalSettings, {
      workspaceId: w.workspaceId,
      runnerId: w.runnerId,
      rows: [entry],
    });
    await w.t.run(async (ctx) => {
      const own = await ctx.db
        .query("configEntries")
        .withIndex("by_uuid", (q) => q.eq("id", U(91)))
        .unique();
      const { _id, _creationTime, ...fields } = own!;
      await ctx.db.insert("configEntries", {
        ...fields,
        id: U(92),
        userId: w.bob.userId,
        scopeKey: `u:${w.bob.userId}`,
        name: "Other person's global",
      });
    });
    const result = await w.alice.as.query(api.projectImports.rearmList, { moveId: w.moveId });
    expect(result.inertGlobals).toEqual([{ id: U(91), name: "Global sweep" }]);
    expect(JSON.stringify(result)).not.toContain("private Instructions");
  });

  test("schedule read-back never includes another project's schedule on the same armer", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("automationSchedules").collect())[0]!;
      const { _id, _creationTime, ...fields } = row;
      await ctx.db.insert("automations", {
        ...w.records.automations[0],
        id: U(90),
        projectId: w.visible.projectId,
        createdBy: { kind: "person", userId: w.alice.userId },
      } as never);
      await ctx.db.insert("automationSchedules", { ...fields, automationId: U(90) });
    });
    const read = await w.alice.as.query(api.projectImports.readRows, {
      moveId: w.moveId,
      stream: "automationSchedules",
      cursor: null,
      numItems: 10,
    });
    expect(read.rows.map((row) => row.automationId)).toEqual([U(10)]);
  });

  test.each([false, true])(
    "previous clients may omit the new zero schedule promise (already in-flight: %s)",
    async (inFlight) => {
      const w = await importWorld();
      const expected = w.expected.filter((e) => e.stream !== "automationSchedules");
      await w.alice.as.mutation(api.projectImports.begin, beginArgs(w, { expected }));
      if (inFlight)
        await w.t.run(async (ctx) => {
          const accumulator = await ctx.db
            .query("projectImportStreams")
            .withIndex("by_move_stream", (q) =>
              q.eq("moveId", w.moveId).eq("stream", "automationSchedules"),
            )
            .unique();
          await ctx.db.delete(accumulator!._id);
        });
      await w.alice.as.mutation(api.projectImports.begin, beginArgs(w, { expected }));
      for (const stream of MIGRATION_IMPORT_STREAMS) {
        if (stream === "automationSchedules") continue;
        await w.alice.as.mutation(api.projectImports.importRows, {
          moveId: w.moveId,
          stream,
          rows: w.records[stream],
        });
      }
      await w.alice.as.mutation(api.projectImports.commit, {
        moveId: w.moveId,
        manifestSha256: MANIFEST_SHA,
      });
    },
  );
});
