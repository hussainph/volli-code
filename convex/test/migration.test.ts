import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { MIGRATION_IMPORT_STREAMS, MIGRATION_PLACEHOLDERS, newId } from "@volli/shared/cloud";

// The shared mapping's own fixture: one export record per stream.
import {
  MIGRATION_FIXTURE_RECORDS,
  fixtureUuid,
} from "../../packages/shared/src/cloud/migration-import.fixture";

import { internal } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

// `begin` creates a dry-run target only on a deployment that trusts the test issuer.
beforeAll(() => vi.stubEnv("VOLLI_TEST_JWKS", "data:test"));
afterAll(() => vi.unstubAllEnvs());

const USER = MIGRATION_PLACEHOLDERS.userId;
const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;
const WORKSPACE = MIGRATION_PLACEHOLDERS.workspaceId;
const person = { kind: "person", userId: USER };

function freshTarget() {
  return { userId: newId("user"), workspaceId: newId("workspace"), runnerId: newId("runner") };
}

async function setup() {
  const t = convexTest(schema, modules);
  const target = freshTarget();
  await t.mutation(internal.migration.begin, {
    target,
    createMissing: true,
    displayName: "Migrating person",
    runnerName: "This Mac",
  });
  return { t, target };
}

function project(id: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    name: "Alpha",
    colorIndex: 1,
    ticketPrefix: "AL",
    origin: "migrated",
    countsTowardCap: false,
    createdByUserId: USER,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    removedAt: null,
  };
}

function ticket(id: string, projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId,
    number: 1,
    title: "First",
    status: "todo",
    priority: "low",
    position: "a0",
    labelIds: [],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "pi",
    branch: null,
    baseBranch: null,
    pullRequests: [],
    retentionKeep: false,
    placeRunnerId: RUNNER,
    createdBy: person,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function session(id: string, projectId: string) {
  return {
    id,
    projectId,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    ownerUserId: USER,
    title: null,
    visibility: "private",
    visibilityReason: "adhoc",
    placeRunnerId: RUNNER,
    createdAt: 1,
    lastActivityAt: 1,
    lastSequence: 1,
    eventCount: 1,
  };
}

function event(sessionId: string, sequence: number, id = `event-${sequence}`) {
  return {
    id,
    sessionId,
    sequence,
    occurredAt: 1,
    recordedAt: 1,
    provenance: { source: "runtime" },
    attachmentId: null,
    commandId: null,
    payload: { kind: "session.created" },
    kindKnown: true,
    quarantine: null,
    bytes: 10,
  };
}

describe("migration.begin", () => {
  test("creates the dry-run target once, then only checks it", async () => {
    const t = convexTest(schema, modules);
    const target = freshTarget();
    const args = { target, createMissing: true, displayName: "P", runnerName: "Mac" };
    expect(await t.mutation(internal.migration.begin, args)).toEqual({
      created: ["user", "workspace", "runner"],
    });
    expect(await t.mutation(internal.migration.begin, args)).toEqual({ created: [] });
    expect(await t.mutation(internal.migration.begin, { ...args, createMissing: false })).toEqual({
      created: [],
    });
  });

  test("creates nothing on a deployment that is not a test deployment", async () => {
    vi.stubEnv("VOLLI_TEST_JWKS", "");
    try {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(internal.migration.begin, {
          target: freshTarget(),
          createMissing: true,
          displayName: "P",
          runnerName: "Mac",
        }),
      ).rejects.toThrow(/test deployments only/);
    } finally {
      vi.stubEnv("VOLLI_TEST_JWKS", "data:test");
    }
  });

  test("refuses a target that does not exist or is not the person's", async () => {
    const t = convexTest(schema, modules);
    const args = {
      target: freshTarget(),
      createMissing: false,
      displayName: "P",
      runnerName: "Mac",
    };
    await expect(t.mutation(internal.migration.begin, args)).rejects.toThrow(/active account/);
    await expect(
      t.mutation(internal.migration.begin, { ...args, target: { ...args.target, userId: "u" } }),
    ).rejects.toThrow(/canonical UUID/);
    await expect(
      t.mutation(internal.migration.begin, {
        ...args,
        createMissing: true,
        target: { ...args.target, runnerId: "r" },
      }),
    ).rejects.toThrow(/canonical UUID/);

    const { t: other, target } = await setup();
    const stranger = { ...target, runnerId: newId("runner") };
    await expect(
      other.mutation(internal.migration.begin, { ...args, target: stranger }),
    ).rejects.toThrow(/runner/);
    await expect(
      other.mutation(internal.migration.begin, {
        ...args,
        target: { ...target, workspaceId: newId("workspace") },
      }),
    ).rejects.toThrow(/Workspace does not exist/);
  });
});

describe("record ↔ schema parity", () => {
  test("one export record of every stream maps onto a document the schema accepts", async () => {
    const { t, target } = await setup();
    const results: Record<string, unknown> = {};
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const rows = [MIGRATION_FIXTURE_RECORDS[stream]];
      // The delegation's child is a second Session of the same project.
      if (stream === "sessions") rows.push({ ...rows[0], id: fixtureUuid(22) });
      results[stream] = await t.mutation(internal.migration.importRows, { target, stream, rows });
    }
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      expect(results[stream], stream).toMatchObject({ conflicts: [], rejected: [] });
    }
  });
});

describe("migration.importRows", () => {
  test("inserts, then a re-run leaves identical rows alone and reports changed ones", async () => {
    const { t, target } = await setup();
    const projectId = newId("project");
    const first = await t.mutation(internal.migration.importRows, {
      target,
      stream: "projects",
      rows: [project(projectId)],
    });
    expect(first).toEqual({ inserted: 1, unchanged: 0, conflicts: [], rejected: [] });

    const ticketId = newId("ticket");
    const rows = [ticket(ticketId, projectId)];
    expect(
      await t.mutation(internal.migration.importRows, { target, stream: "tickets", rows }),
    ).toMatchObject({
      inserted: 1,
    });
    expect(
      await t.mutation(internal.migration.importRows, { target, stream: "tickets", rows }),
    ).toEqual({
      inserted: 0,
      unchanged: 1,
      conflicts: [],
      rejected: [],
    });
    const changed = await t.mutation(internal.migration.importRows, {
      target,
      stream: "tickets",
      rows: [ticket(ticketId, projectId, { title: "Renamed" })],
    });
    const renumbered = await t.mutation(internal.migration.importRows, {
      target,
      stream: "tickets",
      rows: [ticket(newId("ticket"), projectId)],
    });
    expect(renumbered.rejected).toEqual([
      { index: 0, code: "duplicate_key", detail: "another row has this projectId and number" },
    ]);
    expect(changed.conflicts).toEqual([
      { index: 0, code: "conflict", detail: "a different row has this key" },
    ]);

    const stored = await t.run((ctx) =>
      ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", ticketId))
        .unique(),
    );
    expect(stored).toMatchObject({ title: "First", placeRunnerId: target.runnerId });
    expect(JSON.stringify(stored)).not.toContain("$local");
  });

  test("refuses rows row by row: bad ids, other Workspaces, schema mismatches", async () => {
    const { t, target } = await setup();
    const projectId = newId("project");
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "projects",
      rows: [project(projectId)],
    });
    const result = await t.mutation(internal.migration.importRows, {
      target,
      stream: "tickets",
      rows: [
        ticket("ticket-1", projectId),
        ticket(newId("ticket"), newId("project")),
        ticket(newId("ticket"), projectId, { status: "someday" }),
        ticket(newId("ticket"), projectId, { number: 2 }),
      ],
    });
    expect(result.inserted).toBe(1);
    expect(result.rejected).toEqual([
      { index: 0, code: "invalid_id", detail: "id: is not a canonical UUID" },
      { index: 1, code: "outside_target", detail: "its project is not in the target Workspace" },
      { index: 2, code: "schema", detail: expect.stringMatching(/^the schema refused/) },
    ]);
    expect(JSON.stringify(result)).not.toContain("someday");
  });

  test("a project already migrated into another Workspace is a conflict, not a takeover", async () => {
    const { t, target } = await setup();
    const projectId = newId("project");
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "projects",
      rows: [project(projectId)],
    });
    const second = freshTarget();
    await t.mutation(internal.migration.begin, {
      target: second,
      createMissing: true,
      displayName: "Second Mac",
      runnerName: "Other",
    });
    const again = await t.mutation(internal.migration.importRows, {
      target: second,
      stream: "projects",
      rows: [project(projectId)],
    });
    expect(again.conflicts).toEqual([
      { index: 0, code: "already_migrated", detail: "another Workspace holds this row" },
    ]);
    const forged = await t.mutation(internal.migration.importRows, {
      target: second,
      stream: "projects",
      rows: [{ ...project(newId("project")), workspaceId: target.workspaceId }],
    });
    expect(forged.rejected).toMatchObject([{ code: "outside_target" }]);
  });

  test("Session events are keyed by sequence and their ids stay unique within the Session", async () => {
    const { t, target } = await setup();
    const projectId = newId("project");
    const sessionId = newId("session");
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "projects",
      rows: [project(projectId)],
    });
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "sessions",
      rows: [session(sessionId, projectId)],
    });
    const result = await t.mutation(internal.migration.importRows, {
      target,
      stream: "sessionEvents",
      rows: [event(sessionId, 1), event(sessionId, 2, "event-1"), event(newId("session"), 1)],
    });
    expect(result).toMatchObject({
      inserted: 1,
      conflicts: [{ index: 1, code: "conflict" }],
      rejected: [{ index: 2, code: "outside_target" }],
    });
    // The stamped `acceptedAt` differs on a re-run; the row is still unchanged.
    const again = await t.mutation(internal.migration.importRows, {
      target,
      stream: "sessionEvents",
      rows: [event(sessionId, 1)],
    });
    expect(again.unchanged).toBe(1);

    const events = await t.query(internal.migration.readSessionEvents, {
      target,
      sessionId,
      afterSequence: 0,
      limit: 10,
    });
    expect(events.rows.map((row) => row.eventId)).toEqual(["event-1"]);
    expect(events.rows[0]).not.toHaveProperty("_id");
    const elsewhere = await t.query(internal.migration.readSessionEvents, {
      target: freshTarget(),
      sessionId,
      afterSequence: 0,
      limit: 10,
    });
    expect(elsewhere.rows).toEqual([]);

    const intake = await t.mutation(internal.migration.importRows, {
      target,
      stream: "sessionIntake",
      rows: [{ sessionId, acceptedThrough: 1, lastEventId: "event-1" }],
    });
    expect(intake.inserted).toBe(1);
  });

  test("audit rows belong to the target Workspace", async () => {
    const { t, target } = await setup();
    const audit = (workspaceId: string) => ({
      id: newId("job"),
      workspaceId,
      actor: person,
      kind: "mcp_install",
      targetKind: "mcp_server",
      targetId: "x",
      at: 1,
      detail: {},
    });
    const result = await t.mutation(internal.migration.importRows, {
      target,
      stream: "auditLog",
      rows: [audit(WORKSPACE), audit(newId("workspace"))],
    });
    expect(result).toMatchObject({ inserted: 1, rejected: [{ index: 1, code: "outside_target" }] });
  });
});

describe("personal settings", () => {
  test("belong to the migrating person, not to a project", async () => {
    const { t, target } = await setup();
    const entry = (userId: string) => ({
      id: newId("job"),
      level: "personal",
      userId,
      workspaceId: null,
      projectId: null,
      kind: "decision_model",
      name: "default",
      state: "on",
      definition: { modelId: "m" },
      revision: 1,
      updatedBy: person,
      updatedAt: 1,
    });
    const result = await t.mutation(internal.migration.importRows, {
      target,
      stream: "configEntries",
      rows: [entry(USER), entry(newId("user"))],
    });
    expect(result).toMatchObject({ inserted: 1, rejected: [{ index: 1, code: "outside_target" }] });
    const page = await t.query(internal.migration.readPage, {
      target,
      stream: "configEntries",
      cursor: null,
      numItems: 10,
    });
    expect(page.rows).toMatchObject([{ scopeKey: `u:${target.userId}` }]);
  });
});

describe("migration.readPage", () => {
  test("pages a table back without Convex fields, only the target's rows", async () => {
    const { t, target } = await setup();
    const mine = newId("project");
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "projects",
      rows: [project(mine)],
    });
    const other = freshTarget();
    await t.mutation(internal.migration.begin, {
      target: other,
      createMissing: true,
      displayName: "O",
      runnerName: "O",
    });
    await t.mutation(internal.migration.importRows, {
      target: other,
      stream: "projects",
      rows: [project(newId("project"))],
    });
    const ticketIds = [newId("ticket"), newId("ticket"), newId("ticket")];
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "tickets",
      rows: ticketIds.map((id, index) => ticket(id, mine, { number: index + 1 })),
    });
    const sessionId = newId("session");
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "sessions",
      rows: [session(sessionId, mine)],
    });
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "ticketBodies",
      rows: [{ ticketId: ticketIds[0], body: "b", revision: 1, updatedBy: person, updatedAt: 1 }],
    });
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "delegations",
      rows: [
        {
          childSessionId: sessionId,
          parentSessionId: newId("session"),
          ticketId: null,
          depth: 1,
          toolCallId: null,
          createCommandId: null,
          createdAt: null,
        },
      ],
    });
    await t.mutation(internal.migration.importRows, {
      target,
      stream: "delegationExtensions",
      rows: [{ parentSessionId: sessionId, toolCallId: "c", approvedByUserId: USER, createdAt: 1 }],
    });

    const projects = await t.query(internal.migration.readPage, {
      target,
      stream: "projects",
      cursor: null,
      numItems: 10,
    });
    expect(projects.rows.map((row) => row.id)).toEqual([mine]);
    expect(projects.rows[0]).not.toHaveProperty("_id");

    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page: { rows: Record<string, unknown>[]; continueCursor: string; isDone: boolean } =
        await t.query(internal.migration.readPage, {
          target,
          stream: "tickets",
          cursor,
          numItems: 2,
          maximumBytesRead: 1_000_000,
        });
      seen.push(...page.rows.map((row) => row.id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen.toSorted()).toEqual(ticketIds.toSorted());

    for (const stream of ["ticketBodies", "delegations", "delegationExtensions"] as const) {
      const page = await t.query(internal.migration.readPage, {
        target,
        stream,
        cursor: null,
        numItems: 10,
      });
      expect(page.rows, stream).toHaveLength(1);
    }
  });
});
