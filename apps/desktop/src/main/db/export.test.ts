import { USER_ACTOR } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createComment } from "./comments-repo";
import { recordTicketEvent } from "./events-repo";
import {
  buildExportDocument,
  defaultExportFilename,
  EXPORT_FORMAT,
  serializeExportDocument,
} from "./export";
import { addTicketLabel, getOrCreateLabel } from "./labels-repo";
import { MIGRATIONS } from "./migrations";
import { insertProject } from "./projects-repo";
import { insertSession } from "./sessions-repo";
import { openTestDb, testProject, testSession, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { archiveTicket, insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("buildExportDocument — empty db", () => {
  it("emits the metadata envelope and an empty array for every table", () => {
    ctx = openTestDb();

    const document = buildExportDocument(ctx.db, { appVersion: "1.2.3", now: 1_700_000_000_000 });

    expect(document.format).toBe(EXPORT_FORMAT);
    expect(document.format).toBe("volli-export");
    expect(document.appVersion).toBe("1.2.3");
    expect(document.exportedAt).toBe(new Date(1_700_000_000_000).toISOString());
    // A fresh test db is fully migrated, so the exported version is the last
    // migration's — derived, not hardcoded, so a new migration can't stale this.
    expect(document.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    expect(document.projects).toEqual([]);
    expect(document.tickets).toEqual([]);
    expect(document.labels).toEqual([]);
    expect(document.ticketLabels).toEqual([]);
    expect(document.ticketEvents).toEqual([]);
    expect(document.sessions).toEqual([]);
    expect(document.ticketComments).toEqual([]);
    expect(document.appState).toEqual([]);
  });

  it("schemaVersion tracks the db's own PRAGMA user_version, not a hardcoded constant", () => {
    ctx = openTestDb();
    ctx.db.pragma("user_version = 7");

    const document = buildExportDocument(ctx.db, { appVersion: "0.0.1", now: 0 });

    expect(document.schemaVersion).toBe(7);
  });
});

describe("buildExportDocument — populated db", () => {
  it("dumps every table, camelCased, with the ticket displayId reused from displayTicketId", () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1", ticketPrefix: "VC", baseBranch: "main" });
    insertProject(ctx.db, project);

    const liveTicket = testTicket(project.id, {
      id: "ticket-live",
      ticketNumber: 12,
      title: "Live ticket",
      preferredHarnessId: "codex",
      createdAt: 10,
    });
    insertTicket(ctx.db, liveTicket);

    const archivedTicket = testTicket(project.id, {
      id: "ticket-archived",
      ticketNumber: 13,
      title: "Archived ticket",
      createdAt: 20,
    });
    insertTicket(ctx.db, archivedTicket);
    archiveTicket(ctx.db, archivedTicket.id, 999);

    const label = getOrCreateLabel(ctx.db, project.id, "bug", 5);
    addTicketLabel(ctx.db, liveTicket.id, label.id);

    recordTicketEvent(
      ctx.db,
      liveTicket.id,
      { kind: "created", status: "backlog", title: liveTicket.title },
      15,
    );

    const session = testSession(project.id, liveTicket.id, { id: "session-1", createdAt: 30 });
    insertSession(ctx.db, session);

    createComment(
      ctx.db,
      { ticketId: liveTicket.id, body: "hello", actor: USER_ACTOR, sessionId: session.id },
      40,
    );

    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
      .run("ui:zoom", '{"level":0}', 50);

    const document = buildExportDocument(ctx.db, { appVersion: "9.9.9", now: 1_700_000_000_000 });

    // projects
    expect(document.projects).toEqual([
      {
        id: project.id,
        name: project.name,
        path: project.path,
        ticketPrefix: "VC",
        baseBranch: "main",
        colorIndex: project.colorIndex,
        sortOrder: project.sortOrder,
        rowVersion: 1,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ]);

    // tickets — includes archived rows, ordered by id, carries displayId
    expect(document.tickets).toHaveLength(2);
    const [archived, live] = document.tickets.toSorted((a, b) => a.id.localeCompare(b.id));
    expect(archived).toMatchObject({
      id: "ticket-archived",
      displayId: "VC-13",
      title: "Archived ticket",
      archivedAt: 999,
    });
    expect(live).toMatchObject({
      id: "ticket-live",
      displayId: "VC-12",
      title: "Live ticket",
      preferredHarnessId: "codex",
      archivedAt: null,
      usesWorktree: true,
    });

    // labels
    expect(document.labels).toEqual([
      {
        id: label.id,
        projectId: project.id,
        name: "bug",
        color: null,
        rowVersion: 1,
        createdAt: 5,
        updatedAt: 5,
      },
    ]);

    // ticket_labels junction
    expect(document.ticketLabels).toEqual([{ ticketId: liveTicket.id, labelId: label.id }]);

    // ticket_events — payload comes back parsed, not a raw JSON string.
    // Two rows: the explicit `created` event above, plus the `commented`
    // event createComment fires automatically below.
    expect(document.ticketEvents).toHaveLength(2);
    const createdEvent = document.ticketEvents.find((e) => e.kind === "created");
    expect(createdEvent).toMatchObject({
      ticketId: liveTicket.id,
      kind: "created",
      actor: "user",
      payload: { kind: "created", status: "backlog", title: liveTicket.title },
      createdAt: 15,
    });

    // sessions
    expect(document.sessions).toEqual([
      {
        id: session.id,
        projectId: project.id,
        ticketId: liveTicket.id,
        harnessId: session.harnessId,
        harnessSessionId: null,
        title: session.title,
        cwd: session.cwd,
        createdAt: 30,
        endedAt: null,
      },
    ]);

    // ticket_comments
    expect(document.ticketComments).toHaveLength(1);
    expect(document.ticketComments[0]).toMatchObject({
      ticketId: liveTicket.id,
      sessionId: session.id,
      actor: USER_ACTOR,
      body: "hello",
      createdAt: 40,
      updatedAt: 40,
    });

    // app_state — value kept as its raw stored JSON string, unparsed
    expect(document.appState).toEqual([{ key: "ui:zoom", value: '{"level":0}', updatedAt: 50 }]);
  });

  it("falls back to the raw project id as displayId prefix for a ticket with no matching project row", () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1", ticketPrefix: "VC" });
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { id: "ticket-1", ticketNumber: 1 });
    insertTicket(ctx.db, ticket);

    // Simulate a ticket row whose project has since vanished (never happens
    // under the live FK, but this guards a hand-built/corrupted db from
    // producing an `undefined-1` displayId).
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);

    const document = buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    expect(document.tickets).toHaveLength(1);
    expect(document.tickets[0]?.displayId).toBe(`${project.id}-1`);
  });

  it("orders every table by a stable, data-derived key rather than insertion order", () => {
    ctx = openTestDb();
    const projectB = testProject({ id: "proj-b", ticketPrefix: "PB" });
    const projectA = testProject({ id: "proj-a", ticketPrefix: "PA" });
    // Inserted out of id order — export should still come back id-ascending.
    insertProject(ctx.db, projectB);
    insertProject(ctx.db, projectA);

    const document = buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    expect(document.projects.map((p) => p.id)).toEqual(["proj-a", "proj-b"]);
  });
});

describe("buildExportDocument — determinism", () => {
  it("two calls with the same now/appVersion against an unchanged db are deep-equal", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    insertTicket(ctx.db, ticket);

    const first = buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 500 });
    const second = buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 500 });

    expect(first).toEqual(second);
  });

  it("only exportedAt differs when now differs between two calls", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);

    const first = buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 100 });
    const second = buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 200 });

    expect({ ...first, exportedAt: "" }).toEqual({ ...second, exportedAt: "" });
    expect(first.exportedAt).not.toBe(second.exportedAt);
  });
});

describe("serializeExportDocument", () => {
  it("2-space indents and ends with a single trailing newline", () => {
    ctx = openTestDb();
    const document = buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    const serialized = serializeExportDocument(document);

    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.endsWith("}\n\n")).toBe(false);
    expect(serialized).toContain('\n  "format": "volli-export"');
    expect(JSON.parse(serialized)).toEqual(document);
  });
});

describe("defaultExportFilename", () => {
  it("formats as volli-export-YYYY-MM-DD.json, zero-padded", () => {
    expect(defaultExportFilename(new Date(2026, 0, 5))).toBe("volli-export-2026-01-05.json");
    expect(defaultExportFilename(new Date(2026, 10, 23))).toBe("volli-export-2026-11-23.json");
  });
});
