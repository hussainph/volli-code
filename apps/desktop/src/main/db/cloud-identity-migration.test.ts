import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { SessionExecutionVenue } from "@volli/shared";
import { insertSession } from "../session-control/test-support";
import { getProjectById, insertProject } from "./projects-repo";
import { getTicket, insertTicket, nextTicketNumberForProject } from "./tickets-repo";
import { openRawDb, testProject, testSession, testTicket } from "./test-helpers";
import { openVolliDb } from "./index";
import { CLOUD_IDENTITY_MIGRATION } from "./cloud-identity-migration";
import * as migrations from "./migrations";
import { migrate } from "./migrations";

const WORKSPACE = "6f0e8f7c-2b7c-4f43-9a55-0c8f3c1d2a01";
const OTHER_WORKSPACE = "1d3a9a52-7a0e-4a4b-8a38-5f1b2c9e7d02";
const TICKET = "a8b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c04";
const HOST_A = "0b6d2c0e-3f4a-4b5c-9d6e-7f8a9b0c1d05";
const HOST_B = "c4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c06";
const WORKER_1 = "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a07";
const WORKER_2 = "f7e6d5c4-b3a2-4918-8a7b-6c5d4e3f2a08";

/** Every object migration 58 creates, by type and name — nothing else may appear. */
const IDENTITY_OBJECTS = [
  { type: "table", name: "checkout_leases" },
  { type: "table", name: "devices" },
  { type: "table", name: "host_identity" },
  { type: "table", name: "workers" },
  { type: "table", name: "workspace_epochs" },
  { type: "trigger", name: "checkout_leases_fence" },
  { type: "trigger", name: "workspace_epochs_append_only" },
  { type: "trigger", name: "workspace_epochs_monotonic" },
];
const IDENTITY_TABLES = IDENTITY_OBJECTS.filter(({ type }) => type === "table").map(
  ({ name }) => name,
);

/**
 * A worker's kind is the `SessionExecutionVenue` kind its attachments record.
 * Adding a venue kind fails to compile here until someone decides whether a
 * worker can have it, because the column's CHECK cannot be altered in place.
 */
const WORKER_KINDS = {
  local: true,
  remote: true,
  cloud: true,
} as const satisfies Record<Exclude<SessionExecutionVenue["kind"], "unknown">, true>;

let directory: string | undefined;
let db: Database.Database | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  db = undefined;
  directory = undefined;
});

function freshPath(): string {
  directory = mkdtempSync(join(tmpdir(), "volli-cloud-identity-"));
  return join(directory, "volli.db");
}

/** A populated database at the version before this migration. */
function version57() {
  const path = freshPath();
  db = openRawDb(path);
  db.pragma("foreign_keys = ON");
  migrate(db, path, { toVersion: 57 });
  insertProject(db, testProject({ id: WORKSPACE, path: "/repo/one" }));
  insertProject(db, testProject({ id: OTHER_WORKSPACE, path: "/repo/two" }));
  insertTicket(db, testTicket(WORKSPACE, { id: TICKET }));
  insertSession(db, testSession(WORKSPACE, TICKET, { id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d10" }));
  return { db, path };
}

function schemaObjects(handle: Database.Database) {
  return handle
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

function tableRows(handle: Database.Database): Record<string, string[]> {
  const rows: Record<string, string[]> = {};
  for (const { name } of handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>) {
    rows[name] = (handle.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
      .map((row) => JSON.stringify(row))
      .toSorted();
  }
  return rows;
}

function seedIdentityRows(handle: Database.Database): void {
  handle
    .prepare("INSERT INTO host_identity (id, host_id, created_at) VALUES (1, ?, 10)")
    .run(HOST_A);
  handle
    .prepare(
      "INSERT INTO workspace_epochs (workspace_id, epoch, host_id, created_at) VALUES (?, 1, ?, 20)",
    )
    .run(WORKSPACE, HOST_A);
  handle
    .prepare(
      "INSERT INTO workers (id, name, kind, capabilities, created_at) VALUES (?, 'hetzner-2', 'remote', '{\"os\":\"linux\"}', 30)",
    )
    .run(WORKER_1);
  insertLease(handle, { worker: WORKER_1, epoch: 1, workspaceEpoch: 1, grantedAt: 40 });
  handle
    .prepare("INSERT INTO devices (id, name, created_at) VALUES (?, 'Phone', 50)")
    .run("9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c09");
}

function insertLease(
  handle: Database.Database,
  lease: { worker: string; epoch: number; workspaceEpoch: number; grantedAt: number },
): void {
  handle
    .prepare(
      `INSERT INTO checkout_leases
         (ticket_id, worker_id, epoch, workspace_epoch, granted_at, renewed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TICKET,
      lease.worker,
      lease.epoch,
      lease.workspaceEpoch,
      lease.grantedAt,
      lease.grantedAt,
      lease.grantedAt + 30,
    );
}

describe("cloud identity migration (058)", () => {
  it("adds five empty tables to a populated v57 database and changes nothing that was there", () => {
    const f = version57();
    const rowsBefore = tableRows(f.db);
    const schemaBefore = schemaObjects(f.db);

    expect(migrate(f.db, f.path)).toBe(true);

    expect(f.db.pragma("user_version", { simple: true })).toBe(58);
    const schemaAfter = schemaObjects(f.db);
    // Purely additive: every object that existed is byte-identical, and the
    // only new ones are the identity tables and their fence triggers.
    expect(schemaAfter.filter((object) => !IDENTITY_TABLES.includes(object.tbl_name))).toEqual(
      schemaBefore,
    );
    expect(
      schemaAfter
        .filter((object) => IDENTITY_TABLES.includes(object.tbl_name))
        .map(({ type, name }) => ({ type, name })),
    ).toEqual(IDENTITY_OBJECTS);
    // No row is written: not a host id, not an epoch, not a backfill.
    const rowsAfter = tableRows(f.db);
    for (const table of IDENTITY_TABLES) expect(rowsAfter[table], table).toEqual([]);
    for (const [table, rows] of Object.entries(rowsBefore)) {
      expect(rowsAfter[table], table).toEqual(rows);
    }
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(f.db, f.path)).toBe(false);
  });

  it("gives a fresh install the same identity schema as an upgrade", () => {
    const upgraded = version57();
    migrate(upgraded.db, upgraded.path);
    const upgradedSchema = schemaObjects(upgraded.db).filter((object) =>
      IDENTITY_TABLES.includes(object.tbl_name),
    );
    upgraded.db.close();
    rmSync(directory!, { recursive: true, force: true });

    const path = freshPath();
    db = openRawDb(path);
    expect(migrate(db, path)).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(58);
    expect(schemaObjects(db).filter((object) => IDENTITY_TABLES.includes(object.tbl_name))).toEqual(
      upgradedSchema,
    );
  });

  it("converges when version 58 is offered again, keeping every identity row", () => {
    const f = version57();
    migrate(f.db, f.path);
    seedIdentityRows(f.db);
    const rows = tableRows(f.db);
    const schema = schemaObjects(f.db);

    f.db.pragma("user_version = 57");
    expect(migrate(f.db, f.path, { toVersion: 58 })).toBe(true);

    expect(f.db.pragma("user_version", { simple: true })).toBe(58);
    expect(tableRows(f.db)).toEqual(rows);
    expect(schemaObjects(f.db)).toEqual(schema);
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("re-running the SQL directly is a no-op, including all three populated-table triggers", () => {
    const f = version57();
    migrate(f.db, f.path);
    seedIdentityRows(f.db);
    const rows = tableRows(f.db);
    const schema = schemaObjects(f.db);
    const changes = f.db.prepare("SELECT total_changes() AS n").get();

    f.db.exec(CLOUD_IDENTITY_MIGRATION);
    f.db.exec(CLOUD_IDENTITY_MIGRATION);

    expect(f.db.pragma("user_version", { simple: true })).toBe(58);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(tableRows(f.db)).toEqual(rows);
    expect(schemaObjects(f.db)).toEqual(schema);
    expect(schema.filter(({ type }) => type === "trigger").map(({ name }) => name)).toEqual(
      expect.arrayContaining(
        IDENTITY_OBJECTS.filter(({ type }) => type === "trigger").map(({ name }) => name),
      ),
    );
    // The original fence remains active, not replaced or silently lost.
    expect(() => f.db.prepare("UPDATE workspace_epochs SET epoch = 2").run()).toThrow(
      "workspace epochs are append-only",
    );
  });

  it("opens a v58 database through the v57 migration ceiling and keeps old read/write paths working", () => {
    const f = version57();
    migrate(f.db, f.path);
    seedIdentityRows(f.db);
    const schema = schemaObjects(f.db);
    const rows = tableRows(f.db);
    const project = getProjectById(f.db, WORKSPACE);
    const ticket = getTicket(f.db, TICKET);
    f.db.close();
    db = undefined;

    // The shipped open path and runner are unchanged by 058. Limit its known
    // migrations to 057 to model stable reopening a canary-expanded profile;
    // do not rewind user_version, which would test a different situation.
    const shippedMigrate = migrate;
    const stableMigration = vi
      .spyOn(migrations, "migrate")
      .mockImplementation((handle, path) => shippedMigrate(handle, path, { toVersion: 57 }));
    db = openVolliDb(f.path);

    expect(stableMigration).toHaveBeenCalledOnce();
    expect(stableMigration).toHaveReturnedWith(false);
    expect(db.pragma("user_version", { simple: true })).toBe(58);
    expect(schemaObjects(db)).toEqual(schema);
    expect(tableRows(db)).toEqual(rows);
    expect(existsSync(`${f.path}.backup-v58`)).toBe(false);
    expect(getProjectById(db, WORKSPACE)).toEqual(project);
    expect(getTicket(db, TICKET)).toEqual(ticket);
    const number = nextTicketNumberForProject(db, WORKSPACE);
    const added = testTicket(WORKSPACE, {
      id: "78ebc7e6-0357-444b-a62a-3ca028c35ae1",
      ticketNumber: number,
    });
    insertTicket(db, added);
    expect(getTicket(db, added.id)).toEqual(added);
    for (const table of IDENTITY_TABLES) expect(tableRows(db)[table], table).toEqual(rows[table]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("holds at most one host identity", () => {
    const f = version57();
    migrate(f.db, f.path);
    const insert = f.db.prepare(
      "INSERT INTO host_identity (id, host_id, created_at) VALUES (?, ?, 1)",
    );

    insert.run(1, HOST_A);
    expect(() => insert.run(1, HOST_B)).toThrow("UNIQUE constraint failed");
    expect(() => insert.run(2, HOST_B)).toThrow("CHECK constraint failed");
    expect(f.db.prepare("SELECT host_id FROM host_identity").all()).toEqual([{ host_id: HOST_A }]);
  });

  it("only ever raises a workspace's epoch, never rewrites one, and drops them with the workspace", () => {
    const f = version57();
    migrate(f.db, f.path);
    const insert = f.db.prepare(
      "INSERT INTO workspace_epochs (workspace_id, epoch, host_id, created_at) VALUES (?, ?, ?, 1)",
    );

    insert.run(WORKSPACE, 1, HOST_A);
    insert.run(WORKSPACE, 2, HOST_B);
    // One holder per epoch, and no promotion below the last one.
    expect(() => insert.run(WORKSPACE, 2, HOST_A)).toThrow();
    expect(() => insert.run(WORKSPACE, 1, HOST_B)).toThrow("workspace epoch must increase");
    // Epochs are per workspace, and start at 1: no row at all is epoch 0.
    expect(() => insert.run(OTHER_WORKSPACE, 0, HOST_B)).toThrow("CHECK constraint failed");
    insert.run(OTHER_WORKSPACE, 1, HOST_A);
    expect(() =>
      f.db.prepare("UPDATE workspace_epochs SET host_id = ? WHERE epoch = 2").run(HOST_A),
    ).toThrow("workspace epochs are append-only");
    expect(() => insert.run("not-a-project", 1, HOST_A)).toThrow("FOREIGN KEY constraint failed");

    expect(
      f.db
        .prepare(
          "SELECT epoch, host_id FROM workspace_epochs WHERE workspace_id = ? ORDER BY epoch DESC LIMIT 1",
        )
        .get(WORKSPACE),
    ).toEqual({ epoch: 2, host_id: HOST_B });
    f.db.prepare("DELETE FROM projects WHERE id = ?").run(WORKSPACE);
    expect(f.db.prepare("SELECT workspace_id FROM workspace_epochs").all()).toEqual([
      { workspace_id: OTHER_WORKSPACE },
    ]);
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("lets one lease epoch name exactly one grant", () => {
    const f = version57();
    migrate(f.db, f.path);
    insertLease(f.db, { worker: WORKER_1, epoch: 1, workspaceEpoch: 1, grantedAt: 100 });
    const update = (set: string, ...values: unknown[]) =>
      f.db.prepare(`UPDATE checkout_leases SET ${set} WHERE ticket_id = ?`).run(...values, TICKET);
    const fence = "checkout lease: a new grant must raise the epoch";

    // A renewal moves only the clock; a release ends the grant in place.
    update("renewed_at = ?, expires_at = ?", 110, 140);
    update("released_at = ?", 120);
    // The same epoch cannot be handed to another worker, re-dated, or revived.
    expect(() => update("worker_id = ?", WORKER_2)).toThrow(fence);
    expect(() => update("granted_at = ?", 150)).toThrow(fence);
    expect(() => update("released_at = NULL")).toThrow(fence);
    expect(() => update("released_at = ?", 130)).toThrow(fence);
    expect(() => update("workspace_epoch = ?", 2)).toThrow(fence);

    // A new grant raises the epoch, to any worker.
    update(
      "worker_id = ?, epoch = 2, granted_at = 150, renewed_at = 150, expires_at = 180, released_at = NULL",
      WORKER_2,
    );
    expect(() => update("epoch = 1")).toThrow(fence);
    // A promotion raises the workspace epoch too; it may never fall back.
    update("epoch = 3, workspace_epoch = 2, granted_at = 200, renewed_at = 200, expires_at = 230");
    expect(() =>
      update("epoch = 4, workspace_epoch = 1, granted_at = 250, renewed_at = 250"),
    ).toThrow(fence);
    expect(() => update("ticket_id = ?", "other-ticket")).toThrow(fence);

    expect(
      f.db
        .prepare("SELECT worker_id, epoch, workspace_epoch, released_at FROM checkout_leases")
        .all(),
    ).toEqual([{ worker_id: WORKER_2, epoch: 3, workspace_epoch: 2, released_at: null }]);
  });

  it("leases only real tickets, one row each, and drops the lease with its ticket", () => {
    const f = version57();
    migrate(f.db, f.path);
    insertLease(f.db, { worker: WORKER_1, epoch: 1, workspaceEpoch: 1, grantedAt: 100 });

    expect(() =>
      insertLease(f.db, { worker: WORKER_2, epoch: 2, workspaceEpoch: 1, grantedAt: 100 }),
    ).toThrow("UNIQUE constraint failed");
    expect(() =>
      f.db
        .prepare(
          "INSERT INTO checkout_leases (ticket_id, worker_id, epoch, workspace_epoch, granted_at, renewed_at, expires_at) VALUES ('missing', ?, 1, 1, 1, 1, 2)",
        )
        .run(WORKER_1),
    ).toThrow("FOREIGN KEY constraint failed");
    // `worker_id` deliberately has no foreign key: workers are host-level and
    // leases travel with the workspace (VC-588 splits the two files).
    expect(f.db.prepare("SELECT * FROM pragma_foreign_key_list('checkout_leases')").all()).toEqual([
      expect.objectContaining({ table: "tickets", from: "ticket_id" }),
    ]);

    f.db.prepare("DELETE FROM tickets WHERE id = ?").run(TICKET);
    expect(f.db.prepare("SELECT * FROM checkout_leases").all()).toEqual([]);
  });

  it("records workers with a venue kind and JSON capabilities, and devices by name", () => {
    const f = version57();
    migrate(f.db, f.path);
    const worker = f.db.prepare(
      "INSERT INTO workers (id, name, kind, created_at) VALUES (?, ?, ?, 1)",
    );

    for (const [index, kind] of Object.keys(WORKER_KINDS).entries()) {
      worker.run(`worker-${index}`, `Worker ${index}`, kind);
    }
    expect(() => worker.run("unknown-kind", "Nowhere", "unknown")).toThrow(
      "CHECK constraint failed",
    );
    expect(() =>
      f.db
        .prepare(
          "INSERT INTO workers (id, name, kind, capabilities, created_at) VALUES ('bad', 'Bad', 'remote', 'not json', 1)",
        )
        .run(),
    ).toThrow("CHECK constraint failed");
    expect(f.db.prepare("SELECT DISTINCT capabilities FROM workers").all()).toEqual([
      { capabilities: "{}" },
    ]);

    const device = f.db.prepare("INSERT INTO devices (id, name, created_at) VALUES (?, ?, 1)");
    device.run("device-1", "Phone");
    expect(() => device.run("device-1", "Laptop")).toThrow("UNIQUE constraint failed");
    expect(() => device.run("device-2", null)).toThrow("NOT NULL constraint failed");
    f.db.prepare("UPDATE devices SET revoked_at = 5 WHERE id = 'device-1'").run();
    expect(f.db.prepare("SELECT id, revoked_at FROM devices").all()).toEqual([
      { id: "device-1", revoked_at: 5 },
    ]);
  });
});
