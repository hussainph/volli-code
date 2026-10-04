import type { PendingArmedRun } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  beginPendingArmedRunAttempt,
  deletePendingArmedRun,
  deletePendingArmedRunAttempt,
  deletePendingArmedRunForTicket,
  getPendingArmedRun,
  getPendingArmedRunAttempt,
  listPendingArmedRunAttempts,
  listPendingArmedRuns,
  putPendingArmedRun,
  updatePendingArmedRunAttemptError,
} from "./pending-armed-runs-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

function pending(overrides: Partial<PendingArmedRun> = {}): PendingArmedRun {
  return {
    id: "arrival-1",
    ticketId: "ticket-1",
    projectId: "project-1",
    ticketDisplayId: "VC-12",
    automationId: "automation-1",
    automationName: "Review sweep",
    status: "doing",
    origin: "armed",
    openedAt: 1_000,
    startAt: 4_500,
    ...overrides,
  };
}

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "project-1" }));
  insertTicket(
    ctx.db,
    testTicket("project-1", {
      id: "ticket-1",
      ticketNumber: 12,
      status: "doing",
    }),
  );
});

afterEach(() => ctx.cleanup());

describe("pending armed Run projection", () => {
  it("round-trips the durable countdown snapshot", () => {
    const row = pending();
    putPendingArmedRun(ctx.db, row);

    expect(getPendingArmedRun(ctx.db, row.id)).toEqual(row);
    expect(listPendingArmedRuns(ctx.db)).toEqual([row]);
  });

  it("atomically replaces the earlier arrival for one Ticket", () => {
    putPendingArmedRun(ctx.db, pending());
    const replacement = pending({ id: "arrival-2", openedAt: 2_000, startAt: 5_500 });
    putPendingArmedRun(ctx.db, replacement);

    expect(listPendingArmedRuns(ctx.db)).toEqual([replacement]);
    expect(deletePendingArmedRun(ctx.db, "arrival-1")).toBe(false);
    expect(getPendingArmedRun(ctx.db, "arrival-2")).toEqual(replacement);
  });

  it("atomically retains one expiry command while closing its countdown", () => {
    const row = pending();
    putPendingArmedRun(ctx.db, row);

    expect(beginPendingArmedRunAttempt(ctx.db, row.id, "command-1", "Reply interrupted")).toEqual({
      pending: row,
      commandId: "command-1",
      error: "Reply interrupted",
    });
    expect(getPendingArmedRun(ctx.db, row.id)).toBeUndefined();
    expect(getPendingArmedRunAttempt(ctx.db, row.id)).toEqual({
      pending: row,
      commandId: "command-1",
      error: "Reply interrupted",
    });
    expect(beginPendingArmedRunAttempt(ctx.db, row.id, "command-2", "Duplicate")).toBeUndefined();

    expect(updatePendingArmedRunAttemptError(ctx.db, row.id, "IPC reply lost")).toBe(true);
    expect(listPendingArmedRunAttempts(ctx.db)).toEqual([
      { pending: row, commandId: "command-1", error: "IPC reply lost" },
    ]);
    expect(deletePendingArmedRunAttempt(ctx.db, row.id)).toBe(true);
    expect(listPendingArmedRunAttempts(ctx.db)).toEqual([]);
  });

  it("keeps a retained attempt when the Ticket gets another countdown", () => {
    const first = pending();
    putPendingArmedRun(ctx.db, first);
    beginPendingArmedRunAttempt(ctx.db, first.id, "command-1", "Reply interrupted");

    const replacement = pending({ id: "arrival-2", openedAt: 2_000, startAt: 5_500 });
    putPendingArmedRun(ctx.db, replacement);

    expect(listPendingArmedRuns(ctx.db)).toEqual([replacement]);
    expect(listPendingArmedRunAttempts(ctx.db)).toEqual([
      { pending: first, commandId: "command-1", error: "Reply interrupted" },
    ]);
  });

  it("deletes by exact arrival or by the Ticket replacement key", () => {
    putPendingArmedRun(ctx.db, pending());
    expect(deletePendingArmedRun(ctx.db, "arrival-1")).toBe(true);
    expect(deletePendingArmedRun(ctx.db, "arrival-1")).toBe(false);

    putPendingArmedRun(ctx.db, pending({ id: "arrival-2" }));
    expect(deletePendingArmedRunForTicket(ctx.db, "ticket-1")).toBe(true);
    expect(listPendingArmedRuns(ctx.db)).toEqual([]);
  });

  it("cascades away when its Ticket is deleted", () => {
    putPendingArmedRun(ctx.db, pending());
    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("ticket-1");
    expect(listPendingArmedRuns(ctx.db)).toEqual([]);
  });
});
