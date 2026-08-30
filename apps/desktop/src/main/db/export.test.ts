import { NO_AUTOMATION_TRIGGER, USER_ACTOR } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createAutomation, recordAutomationRun, setColumnArming } from "./automations-repo";
import { createComment } from "./comments-repo";
import { recordTicketEvent } from "./events-repo";
import {
  buildExportDocument,
  defaultExportFilename,
  EXPORT_FORMAT,
  REBUILDABLE_PROJECTIONS,
  serializeExportDocument,
} from "./export";
import { addTicketLabel, getOrCreateLabel } from "./labels-repo";
import { MIGRATIONS } from "./migrations";
import {
  insertProject,
  updateProjectAppearance,
  updateProjectCanvas,
  updateProjectThemeOverride,
} from "./projects-repo";
import { createDesktopSessionEngine } from "../session-control";
import { insertSession } from "../session-control/test-support";
import { createTicketSessionDelegationStore } from "../session-runtime/delegation-store";
import { openTestDb, testProject, testSession, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { archiveTicket, insertTicket } from "./tickets-repo";
import type { Canvas } from "@volli/shared";

/**
 * Field order matters here and only here: the export carries the canvas as its
 * stored string, so the expectation below stringifies this literal and the
 * repo's own field-by-field rebuild has to agree with it key for key.
 */
const exportedCanvas: Canvas = {
  stops: [{ hex: "#e8652a", x: 0.2, y: 0.15 }],
  primaryIndex: 0,
  vibrancy: 0.6,
  grain: 0.15,
};

let ctx: TestDb;

/** `snake_case` column → the `camelCase` key the export document uses for it. */
function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

afterEach(() => {
  ctx.cleanup();
});

describe("buildExportDocument — empty db", () => {
  it("builds synchronously because every database read is synchronous", () => {
    ctx = openTestDb();

    const document = buildExportDocument(ctx.db, { appVersion: "1.2.3", now: 0 });

    expect(document).not.toBeInstanceOf(Promise);
    expect(document.format).toBe(EXPORT_FORMAT);
  });

  it("emits the metadata envelope and an empty array for every table", async () => {
    ctx = openTestDb();

    const document = await buildExportDocument(ctx.db, {
      appVersion: "1.2.3",
      now: 1_700_000_000_000,
    });

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
    expect(document.sessionAttachments).toEqual([]);
    expect(document.sessionEvents).toEqual([]);
    expect(document.sessionCommands).toEqual([]);
    expect(document.sessionCommandReceipts).toEqual([]);
    expect(document.sessionDelegations).toEqual([]);
    expect(document.sessionVerbGrants).toEqual([]);
    expect(document.sessionDelegationClaims).toEqual([]);
    expect(document.ticketComments).toEqual([]);
    expect(document.appState).toEqual([]);
    expect(document.automations).toEqual([]);
    expect(document.automationRuns).toEqual([]);
    expect(document.automationColumnArmings).toEqual([]);
  });

  it("schemaVersion tracks the db's own PRAGMA user_version, not a hardcoded constant", async () => {
    ctx = openTestDb();
    ctx.db.pragma("user_version = 7");

    const document = await buildExportDocument(ctx.db, { appVersion: "0.0.1", now: 0 });

    expect(document.schemaVersion).toBe(7);
  });
});

describe("buildExportDocument — populated db", () => {
  it("dumps every table, camelCased, with the ticket displayId reused from displayTicketId", async () => {
    ctx = openTestDb();
    const project = testProject({
      id: "proj-1",
      ticketPrefix: "VC",
      baseBranch: "main",
      setupCommand: "pnpm install",
    });
    insertProject(ctx.db, project);
    // Migration 013's four columns. The GLOBAL theme rides `app_state` and so
    // survives an export for free; the per-project override lives only here.
    // `theme_app_slug`/`theme_seed`/`theme_editor_id` are the three dead
    // columns — no longer reachable through `ProjectThemeOverride`, so this
    // write always lands `null` in all of them; the export below still has to
    // carry a field for each (see "carries every projects column" below).
    updateProjectThemeOverride(ctx.db, project.id, { terminalThemeName: "Nord" }, 60);
    // Migration 014's two. Carried as the STORED strings, like the global
    // canvas riding `app_state` — one hand-edited row must not be able to throw
    // an export that a user is running to rescue their data.
    updateProjectCanvas(ctx.db, project.id, exportedCanvas, 61);
    updateProjectAppearance(ctx.db, project.id, "auto", 62);
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

    // Ahead of every surviving ticket — the state a hard-delete leaves behind,
    // and the reason the counter cannot be rebuilt from the exported tickets.
    ctx.db.prepare("UPDATE projects SET next_ticket_number = 14 WHERE id = ?").run(project.id);

    const label = getOrCreateLabel(ctx.db, project.id, "bug", 5);
    addTicketLabel(ctx.db, liveTicket.id, label.id);

    recordTicketEvent(
      ctx.db,
      liveTicket.id,
      { kind: "created", status: "backlog", title: liveTicket.title },
      15,
    );

    const earlierSession = testSession(project.id, liveTicket.id, {
      id: "session-0",
      createdAt: 29,
    });
    insertSession(ctx.db, earlierSession);
    const session = testSession(project.id, liveTicket.id, { id: "session-1", createdAt: 30 });
    insertSession(ctx.db, session);
    const generatedIds = [
      "signal-command-event",
      "signal-fact-event",
      "signal-receipt-event",
      "signal-receipt",
    ];
    const sessionEngine = createDesktopSessionEngine(ctx.db, {
      now: () => 35,
      nextId: () => {
        const id = generatedIds.shift();
        if (id === undefined) throw new Error("unexpected generated id");
        return id;
      },
    });
    await sessionEngine.submit({
      commandId: "signal-command",
      sessionId: session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Needs approval" },
      provenance: {
        source: { kind: "adapter", id: "terminal", detail: { hook: "blocked" } },
        venue: { id: "local", kind: "local" },
      },
    });

    createComment(
      ctx.db,
      { ticketId: liveTicket.id, body: "hello", actor: USER_ACTOR, sessionId: session.id },
      40,
    );

    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
      .run("ui:zoom", '{"level":0}', 50);

    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Review",
        instructions: "/review go",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
      70,
    );
    recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        ticketId: liveTicket.id,
        sessionId: session.id,
        model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
      71,
    );
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: automation.id },
      72,
    );

    const document = await buildExportDocument(ctx.db, {
      appVersion: "9.9.9",
      now: 1_700_000_000_000,
    });

    // projects
    expect(document.projects).toEqual([
      {
        id: project.id,
        name: project.name,
        path: project.path,
        ticketPrefix: "VC",
        baseBranch: "main",
        nextTicketNumber: 14,
        setupCommand: "pnpm install",
        themeAppSlug: null,
        themeTerminalName: "Nord",
        themeEditorId: null,
        themeSeed: null,
        themeCanvas: JSON.stringify(exportedCanvas),
        themeAppearance: "auto",
        skillModes: null,
        sessionHarness: null,
        sessionModel: null,
        // No recorded departure, so this project inherits every authority
        // default (migration 025).
        authorityPolicy: null,
        colorIndex: project.colorIndex,
        sortOrder: project.sortOrder,
        // Bumped by the three theme writes above.
        rowVersion: 4,
        createdAt: project.createdAt,
        updatedAt: 62,
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

    // Canonical Session ledger tables — identity is separate from terminal
    // attachment metadata, and every stored JSON field is decoded.
    expect(document.sessions).toEqual([
      {
        id: earlierSession.id,
        projectId: project.id,
        ticketId: liveTicket.id,
        title: earlierSession.title,
        createdAt: 29,
      },
      {
        id: session.id,
        projectId: project.id,
        ticketId: liveTicket.id,
        title: session.title,
        createdAt: 30,
      },
    ]);
    expect(document.sessionAttachments.map(({ id }) => id)).toEqual([
      `test-terminal:${earlierSession.id}`,
      `test-terminal:${session.id}`,
    ]);
    expect(document.sessionAttachments[1]).toMatchObject({
      sessionId: session.id,
      adapterId: "terminal",
      venueId: "local",
      venueKind: "local",
      continuity: "fresh",
      nativeId: null,
      nativeDetail: {
        kind: "volli.terminal.v1",
        cwd: session.cwd,
        harnessId: session.harnessId,
      },
      observedKind: "opened",
      failure: null,
      createdSequence: 1,
    });
    expect(document.sessionEvents.map(({ sessionId, sequence }) => [sessionId, sequence])).toEqual([
      [earlierSession.id, 1],
      [session.id, 1],
      [session.id, 2],
      [session.id, 3],
      [session.id, 4],
    ]);
    expect(document.sessionEvents[3]).toMatchObject({
      id: "signal-fact-event",
      sessionId: session.id,
      sequence: 3,
      provenance: {
        source: { kind: "adapter", id: "terminal", detail: { hook: "blocked" } },
      },
      commandId: "signal-command",
      payload: { kind: "session.signaled", signal: "blocked", reason: "Needs approval" },
    });
    expect(document.sessionCommands).toEqual([
      {
        id: "signal-command",
        sessionId: session.id,
        createdAt: 35,
        intent: { kind: "session.signal", signal: "blocked", reason: "Needs approval" },
        route: null,
      },
    ]);
    expect(document.sessionCommandReceipts).toEqual([
      {
        id: "signal-receipt",
        sessionId: session.id,
        commandId: "signal-command",
        sequence: 4,
        recordedAt: 35,
        receipt: {
          id: "signal-receipt",
          commandId: "signal-command",
          status: "completed",
          result: { kind: "session.signaled", sessionId: session.id },
          recordedAt: 35,
          sequence: 4,
        },
        receiptEventId: "signal-receipt-event",
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

    // automations — the runtime pin rides as its STORED JSON string, and the
    // run carries the RESOLVED model as flat fields beside its references.
    expect(document.automations).toEqual([
      {
        id: automation.id,
        projectId: project.id,
        name: "Review",
        instructions: "/review go",
        triggerSpec: null,
        runtime: JSON.stringify({
          providerId: "anthropic",
          modelId: "claude-opus",
          reasoningLevel: "high",
        }),
        rowVersion: 1,
        createdAt: 70,
        updatedAt: 70,
      },
    ]);
    expect(document.automationRuns).toMatchObject([
      {
        automationId: automation.id,
        automationName: "Review",
        ticketId: liveTicket.id,
        sessionId: session.id,
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
        createdAt: 71,
      },
    ]);
    // Column arming rides along even though it never travels with a PROJECT:
    // this document is one machine's backup of its own database, and leaving
    // the rows out would silently lose state somebody set by hand.
    expect(document.automationColumnArmings).toEqual([
      {
        projectId: project.id,
        status: "doing",
        automationId: automation.id,
        armedAt: 72,
      },
    ]);
  });

  it("falls back to the raw project id as displayId prefix for a ticket with no matching project row", async () => {
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

    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    expect(document.tickets).toHaveLength(1);
    expect(document.tickets[0]?.displayId).toBe(`${project.id}-1`);
  });

  /**
   * The gap this guards is invisible from above: `setup_command` (008) and the
   * four theme columns (013) were both added to `projects` without reaching
   * `exportProjects`, so an export silently dropped them. Derived from
   * `PRAGMA table_info` rather than a hand-written list, so the NEXT migration
   * that forgets the export fails here instead of shipping.
   *
   * `runtime_preferences` is named rather than derived, and it is the only
   * name allowed here: migration 019 added it for the Runtime Catalog, which
   * went with the singular Pi runtime, so no build can restore what it holds.
   * A column is exempt because it is dead, never because someone forgot it.
   */
  const UNEXPORTED_DEAD_COLUMNS: ReadonlySet<string> = new Set(["runtime_preferences"]);

  it("carries every live projects column, so a migration cannot silently drop one", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1" }));

    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    const columns = ctx.db
      .prepare("SELECT name FROM pragma_table_info('projects')")
      .all() as Array<{ name: string }>;
    const exported = document.projects[0];
    expect(exported).toBeDefined();
    expect(columns.length).toBeGreaterThan(0);
    for (const { name } of columns) {
      expect(Object.hasOwn(exported as object, camelCase(name))).toBe(
        !UNEXPORTED_DEAD_COLUMNS.has(name),
      );
    }
  });

  it("carries every column from each canonical Session ledger table", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1" });
    insertProject(ctx.db, project);
    const session = testSession(project.id, null, { id: "session-1" });
    insertSession(ctx.db, session);
    const ids = [
      "failure-session",
      "failure-command-event",
      "failure-created-event",
      "failure-receipt-event",
      "failure-receipt",
      "command-event",
      "signal-event",
      "receipt-event",
      "receipt",
      "message-event",
    ];
    const sessionEngine = createDesktopSessionEngine(ctx.db, {
      now: () => 1,
      nextId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("unexpected generated id");
        return id;
      },
    });
    const failedSession = await sessionEngine.createSession({
      commandId: "failure-create-command",
      projectId: project.id,
      ticketId: null,
      title: "Failed attachment",
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    await sessionEngine.observe({
      id: "attachment-failed-event",
      kind: "attachment.failed",
      sessionId: failedSession.session.id,
      occurredAt: 1,
      provenance: {
        source: { kind: "adapter", id: "terminal", detail: null },
        venue: { id: "local", kind: "local" },
      },
      attachment: {
        id: "failed-attachment",
        sessionId: failedSession.session.id,
        adapterId: "terminal",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: null,
        authority: null,
      },
      failure: { code: "spawn_failed", detail: "shell missing", diagnostic: null },
    });
    await sessionEngine.submit({
      commandId: "command",
      sessionId: session.id,
      intent: { kind: "session.signal", signal: "done", reason: null },
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    await sessionEngine.submit({
      commandId: "message-command",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "prompt-1", mediaType: "text/plain", digest: "sha256:1" },
      },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });
    const tables = [
      ["sessions", document.sessions],
      ["session_attachments", document.sessionAttachments],
      ["session_events", document.sessionEvents],
      ["session_commands", document.sessionCommands],
      ["session_command_receipts", document.sessionCommandReceipts],
    ] as const;
    for (const [table, rows] of tables) {
      const columns = ctx.db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all() as Array<{
        name: string;
      }>;
      const exported = rows[0];
      expect(exported).toBeDefined();
      for (const { name } of columns) {
        expect(Object.hasOwn(exported as object, camelCase(name))).toBe(true);
      }
    }
    expect(document.sessionAttachments.find(({ id }) => id === "failed-attachment")).toMatchObject({
      nativeDetail: null,
      failure: { code: "spawn_failed", detail: "shell missing", diagnostic: null },
    });
    expect(document.sessionCommands.find(({ id }) => id === "message-command")?.route).toEqual({
      adapterId: "terminal",
      attachmentId: `test-terminal:${session.id}`,
    });
  });

  it("exports durable Ticket Session grants, ancestry, and their fan-out claim", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "delegation-project" });
    const ticket = testTicket(project.id, { id: "delegation-ticket" });
    const root = testSession(project.id, ticket.id, { id: "delegation-root" });
    const child = testSession(project.id, ticket.id, { id: "delegation-child" });
    insertProject(ctx.db, project);
    insertTicket(ctx.db, ticket);
    insertSession(ctx.db, root);
    const store = createTicketSessionDelegationStore(ctx.db);
    store.recordBirth(root.id, store.resolveBirth({ role: "ticket", ticketId: ticket.id }));
    const claim = store.claimStart({
      parentSessionId: root.id,
      ticketId: ticket.id,
      toolCallId: "tool-call-1",
      createCommandId: `${root.id}:tool-call-1:create`,
    });
    if (!claim.ok) throw new Error("Expected the root Session to claim one child");
    insertSession(ctx.db, child);
    store.recordBirth(
      child.id,
      store.resolveBirth({ role: "ticket", ticketId: ticket.id, delegation: claim.delegation }),
    );

    const document = buildExportDocument(ctx.db, { appVersion: "1.2.3", now: 0 });

    expect(document).toMatchObject({
      sessionDelegations: [
        { sessionId: child.id, ticketId: ticket.id, parentSessionId: root.id, depth: 1 },
        { sessionId: root.id, ticketId: ticket.id, parentSessionId: null, depth: 0 },
      ],
      sessionVerbGrants: [
        {
          sessionId: root.id,
          verb: "session.start",
          scope: "own-ticket",
          maxDepth: 1,
          maxChildren: 3,
        },
      ],
      sessionDelegationClaims: [
        {
          parentSessionId: root.id,
          toolCallId: "tool-call-1",
          ticketId: ticket.id,
          createCommandId: `${root.id}:tool-call-1:create`,
          childSessionId: child.id,
        },
      ],
    });
  });

  /**
   * The exclusion has to be a declaration rather than an oversight, and this is
   * what makes it one: every name in the list is held against the live schema,
   * so an exemption cannot outlive the table it exempts, and a projection
   * silently renamed by a migration fails here rather than in a user's rescue
   * document.
   */
  it("declares each omitted projection against a table that really exists", async () => {
    ctx = openTestDb();
    const tables = (
      ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);

    expect(REBUILDABLE_PROJECTIONS).toEqual(["session_usage", "session_usage_coverage"]);
    for (const projection of REBUILDABLE_PROJECTIONS) {
      expect(tables, `${projection} is declared rebuildable but is not in the schema`).toContain(
        projection,
      );
    }
    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });
    expect(document).not.toHaveProperty("sessionUsage");
    expect(document).not.toHaveProperty("sessionUsageCoverage");
  });

  /**
   * The projection is excluded because it is DERIVED, and this is the claim
   * that makes the exclusion honest: the events the export does carry are
   * enough to put every row back, attribution included.
   */
  it("carries the events a dropped usage projection can be rebuilt from", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1" });
    insertProject(ctx.db, project);
    insertTicket(ctx.db, testTicket(project.id, { id: "ticket-1", usesWorktree: false }));
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 1 });
    const created = await sessionEngine.createSession({
      commandId: "usage-session",
      projectId: project.id,
      ticketId: "ticket-1",
      title: "Metered",
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    await sessionEngine.observe({
      id: "usage-1",
      kind: "usage.recorded",
      sessionId: created.session.id,
      occurredAt: 2,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
      attachmentId: null,
      turnId: null,
      usage: {
        cause: "assistant",
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        costUsd: 0.25,
        costBasis: "catalog-estimate",
      },
    });

    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    expect(document).not.toHaveProperty("sessionUsage");
    const usageEvent = document.sessionEvents.find((event) => event.id === "usage-1");
    expect(usageEvent?.payload).toMatchObject({
      kind: "usage.recorded",
      // Attribution rides in the fact, which is exactly why the derived table
      // does not need to be carried beside it.
      attribution: { projectId: project.id, ticketId: "ticket-1" },
      usage: { costUsd: 0.25, cacheReadTokens: 400 },
    });
  });

  it("orders every table by a stable, data-derived key rather than insertion order", async () => {
    ctx = openTestDb();
    const projectB = testProject({ id: "proj-b", ticketPrefix: "PB" });
    const projectA = testProject({ id: "proj-a", ticketPrefix: "PA" });
    // Inserted out of id order — export should still come back id-ascending.
    insertProject(ctx.db, projectB);
    insertProject(ctx.db, projectA);

    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

    expect(document.projects.map((p) => p.id)).toEqual(["proj-a", "proj-b"]);
  });
});

describe("buildExportDocument — determinism", () => {
  it("two calls with the same now/appVersion against an unchanged db are deep-equal", async () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    insertTicket(ctx.db, ticket);

    const first = await buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 500 });
    const second = await buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 500 });

    expect(first).toEqual(second);
  });

  it("only exportedAt differs when now differs between two calls", async () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);

    const first = await buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 100 });
    const second = await buildExportDocument(ctx.db, { appVersion: "2.0.0", now: 200 });

    expect({ ...first, exportedAt: "" }).toEqual({ ...second, exportedAt: "" });
    expect(first.exportedAt).not.toBe(second.exportedAt);
  });
});

describe("serializeExportDocument", () => {
  it("2-space indents and ends with a single trailing newline", async () => {
    ctx = openTestDb();
    const document = await buildExportDocument(ctx.db, { appVersion: "1.0.0", now: 0 });

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
