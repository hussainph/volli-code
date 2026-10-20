import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type Database from "better-sqlite3";
import type { SessionEventProvenance, SessionExecutionVenue } from "@volli/shared";
import { openVolliDb, insertProject, throwTransactionViolation } from "@volli/host-core/db";
import {
  openTestDb,
  testProject,
  type TestDb,
  createSqliteSessionLedger,
} from "@volli/host-core/testing";
import { closeStaleAttachments } from "@volli/host-core/session-runtime";
// hostd does not depend on the engine package; host-core's own copy is the one it runs.
import {
  createSessionEngine,
  type SessionEngine,
} from "../../../packages/session-engine/src/index";
import {
  ensureHostId,
  HOSTD_VENUE_KIND,
  hostdVenue,
  ownsLegacyHostdVenue,
  readHostId,
} from "./venue";

const HOST_ID = "6f1c2b8e-4d3a-4f6b-9c2d-1e0f3a4b5c6d";
const dbs: TestDb[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function migrated(): Database.Database {
  const fixture = openTestDb();
  dbs.push(fixture);
  return fixture.db;
}
function identityRows(db: Database.Database) {
  return db.prepare("SELECT id, host_id, created_at FROM host_identity").all();
}

describe("hostd's host id", () => {
  it("owns legacy remote socket paths, never UUID workers or desktop venues", () => {
    expect(ownsLegacyHostdVenue({ id: "/run/old/volli.sock", kind: "remote" })).toBe(true);
    expect(ownsLegacyHostdVenue({ id: HOST_ID, kind: "remote" })).toBe(false);
    expect(ownsLegacyHostdVenue({ id: "future-worker", kind: "remote" })).toBe(false);
    expect(ownsLegacyHostdVenue({ id: "/run/old/volli.sock", kind: "local" })).toBe(false);
    expect(ownsLegacyHostdVenue({ id: "local", kind: "local" })).toBe(false);
  });

  it("mints a UUID v4 once on first use and never rewrites it", () => {
    const db = migrated();
    expect(readHostId(db)).toBeNull();
    const newId = vi.fn(() => HOST_ID);
    expect(ensureHostId(db, { newId, now: () => 42 })).toBe(HOST_ID);
    expect(ensureHostId(db, { newId: () => "unused", now: () => 99 })).toBe(HOST_ID);
    expect(newId).toHaveBeenCalledTimes(1);
    expect(identityRows(db)).toEqual([{ id: 1, host_id: HOST_ID, created_at: 42 }]);
    expect(readHostId(db)).toBe(HOST_ID);
  });

  it("defaults to randomUUID and the wall clock", () => {
    const db = migrated();
    const before = Date.now();
    const hostId = ensureHostId(db);
    expect(hostId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [row] = identityRows(db) as Array<{ created_at: number }>;
    expect(row!.created_at).toBeGreaterThanOrEqual(before);
    expect(hostdVenue(db)).toEqual({ id: hostId, kind: "remote" });
  });

  it("fails closed on a stored id that is not a UUID v4, without replacing it", () => {
    const db = migrated();
    db.prepare("INSERT INTO host_identity (id, host_id, created_at) VALUES (1, ?, 0)").run(
      "/run/volli/volli.sock",
    );
    expect(() => readHostId(db)).toThrow("not a UUID v4");
    expect(() => hostdVenue(db, { newId: () => HOST_ID })).toThrow("not a UUID v4");
    expect(identityRows(db)).toEqual([{ id: 1, host_id: "/run/volli/volli.sock", created_at: 0 }]);
  });

  it("refuses to mint an id that is not a UUID v4, writing nothing", () => {
    const db = migrated();
    expect(() => ensureHostId(db, { newId: () => "/run/volli/volli.sock" })).toThrow(
      "must be a UUID v4",
    );
    expect(identityRows(db)).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it("names the venue by the host id, never by an address, with hostd's kind", () => {
    const db = migrated();
    expect(HOSTD_VENUE_KIND).toBe("remote");
    expect(hostdVenue(db, { newId: () => HOST_ID })).toEqual({ id: HOST_ID, kind: "remote" });
  });
});

interface Booted {
  db: Database.Database;
  engine: SessionEngine;
}
function boot(dbPath: string): Booted {
  const db = openVolliDb(dbPath, { onTransactionViolation: throwTransactionViolation });
  let n = 0;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now: () => 1_000 },
    ids: { next: () => `engine-${++n}` },
  });
  return { db, engine };
}
function stop({ db }: Booted): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}
async function sweep({ engine }: Booted, venue: SessionExecutionVenue, projectId: string) {
  const onError = vi.fn();
  let n = 0;
  const closed = await closeStaleAttachments({
    engine,
    venue,
    reconcile: () => Promise.reject(new Error("no structured turn is open")),
    projectIds: [projectId],
    newId: () => `recovery-${++n}`,
    now: () => 5_000,
    onError,
  });
  expect(onError).not.toHaveBeenCalled();
  return closed;
}
async function attachments({ engine }: Booted, projectId: string) {
  const [projection] = await engine.listSessions({ projectId, scope: "all" });
  return projection!.attachments.map(({ id, status, venue }) => ({ id, status, venue }));
}

/**
 * Two boots over one data directory with the agent socket moved between
 * them: the real database file and migrations, the real SQLite Session ledger
 * and engine, and host-core's shared boot recovery sweep. The venue never
 * reads the socket path, so the second boot still owns the first boot's
 * attachment and closes it.
 */
describe("boot recovery across a socket move", () => {
  it("recovers the earlier boot's open attachment after --socket moves", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostd-venue-"));
    roots.push(root);
    const dbPath = join(root, "volli.db");
    const project = testProject({ id: "project-venue" });

    // Boot 1, serving /run/a/volli.sock: a terminal companion attaches, and
    // the process dies without closing it.
    const first = boot(dbPath);
    let firstVenue: SessionExecutionVenue;
    try {
      insertProject(first.db, project);
      firstVenue = hostdVenue(first.db);
      const provenance: SessionEventProvenance = {
        source: { kind: "system", id: "hostd", detail: null },
        venue: firstVenue,
      };
      const created = await first.engine.createSession({
        commandId: "create",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Across a socket move",
        provenance,
      });
      await first.engine.observe({
        id: "attach",
        kind: "attachment.opened",
        sessionId: created.session.id,
        occurredAt: 1_000,
        provenance,
        attachment: {
          id: "attachment-1",
          sessionId: created.session.id,
          adapterId: "terminal",
          venue: firstVenue,
          continuity: "fresh",
          native: null,
          authority: null,
        },
      });
    } finally {
      stop(first);
    }

    // Boot 2, serving /run/b/volli.sock.
    const second = boot(dbPath);
    try {
      const secondVenue = hostdVenue(second.db);
      expect(secondVenue).toEqual(firstVenue);
      // The pre-VC-627 derivation is the mutation this proof kills: a venue
      // named by the moved socket owns nothing, and the attachment stays open.
      expect(await sweep(second, { id: "/run/b/volli.sock", kind: "remote" }, project.id)).toBe(0);
      expect(await attachments(second, project.id)).toEqual([
        { id: "attachment-1", status: "open", venue: firstVenue },
      ]);
      expect(await sweep(second, secondVenue, project.id)).toBe(1);
      expect(await attachments(second, project.id)).toEqual([
        { id: "attachment-1", status: "closed", venue: firstVenue },
      ]);
    } finally {
      stop(second);
    }
  });
});
