/**
 * Every mapping rule in `sources.ts`, driven through the real exporter over a
 * fixture profile extended with the rows each rule exists for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { attachmentHashesByName } from "@volli/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "../backup/test-fixture";
import { listMaterializableLinks } from "../db/blobs-repo";
import { exportMigrationSnapshot } from "./exporter";
import { streamRecords as records } from "./test-support/export-files";
import { mcpOperationId, mcpServerEntryId, workingCopyId } from "./transform";
import { EXPORT_SOURCES, buildLookups } from "./sources";

// Each test exports a whole profile through real files; a cold shared CI box is slow.
vi.setConfig({ testTimeout: 30_000 });

let profile: FixtureProfile;
let work: string;

beforeEach(() => {
  profile = createFixtureProfile();
  work = mkdtempSync(join(tmpdir(), "volli-migration-sources-"));
});
afterEach(() => {
  profile.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function run(sql: string, ...params: unknown[]): void {
  profile.db.prepare(sql).run(...(params as never[]));
}

async function exportProfile(name = "export") {
  return exportMigrationSnapshot({
    sourcePath: profile.dbPath,
    outDir: join(work, name),
    appVersion: "test",
    includeRemovedProjects: true,
    now: () => 5,
    homeDir: "/Users/source",
  });
}

const SESSION_ACTOR = JSON.stringify({
  kind: "session",
  sessionId: "session-root",
  ticketId: null,
});

function ticketEvent(id: string, ticketId: string, kind: string, actor: string, payload: string) {
  run(
    `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, ?, ?, 500)`,
    id,
    ticketId,
    kind,
    actor,
    payload,
  );
}

function ticket(id: string, number: number, fields: Record<string, unknown>) {
  const row = {
    id,
    project_id: "proj-beta",
    ticket_number: number,
    title: id,
    body: "",
    status: "todo",
    priority: "low",
    uses_worktree: 1,
    position: number,
    row_version: 1,
    created_at: 1,
    updated_at: 1,
    worktree_path: null,
    branch: null,
    base_branch: null,
    preferred_harness_id: "claude-code",
    pr_url: null,
    retention_keep: 0,
    ...fields,
  };
  const columns = Object.keys(row);
  run(
    `INSERT INTO tickets (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

function session(id: string, role: string, parent: string | null, ticketId: string | null) {
  run(
    `INSERT INTO sessions (id, project_id, ticket_id, title, created_at, role, parent_session_id)
     VALUES (?, 'proj-beta', ?, NULL, 700, ?, ?)`,
    id,
    ticketId,
    role,
    parent,
  );
}

describe("mapping rules", () => {
  it("preserves local filename collision order independently of UUID export order", async () => {
    run("DELETE FROM blob_links");
    run("UPDATE blobs SET original_name = 'shot.png'");
    run(
      `INSERT INTO blob_links (id, blob_hash, ticket_id, session_id, label, created_at)
      VALUES ('z-first', ?, 'ticket-live', NULL, 'first', 10),
             ('a-second', ?, 'ticket-live', NULL, 'second', 10)`,
      profile.blobHashes.ticket,
      profile.blobHashes.session,
    );
    const { outDir, manifest } = await exportProfile();
    const links = records(outDir, manifest, "blobLinks");
    expect(links.map((link) => link.id)).toEqual(["a-second", "z-first"]);
    const ordered = links.toSorted((a, b) => Number(a.sourceOrder) - Number(b.sourceOrder));
    expect(ordered.map((link) => link.id)).toEqual(["z-first", "a-second"]);
    const names = attachmentHashesByName(
      ordered.map((link) => ({
        linkId: link.id,
        blobHash: link.sha256,
        label: link.label,
        originalName: "shot.png",
      })),
    );
    expect(names).toEqual(
      attachmentHashesByName(listMaterializableLinks(profile.db, null, "ticket-live")),
    );
    expect(names.get("shot.png")).toBe(profile.blobHashes.ticket);
    expect(names.get("shot-2.png")).toBe(profile.blobHashes.session);
  });

  it("covers projects, labels, tickets and board events", async () => {
    run("UPDATE projects SET theme_canvas = ? WHERE id = 'proj-beta'", '{"stops":[]}');
    run("UPDATE projects SET theme_canvas = 'not json' WHERE id = 'proj-alpha'");
    run("UPDATE projects SET session_harness = 'claude-code' WHERE id = 'proj-alpha'");
    run(
      `INSERT INTO labels (id, project_id, name, color, row_version, created_at, updated_at,
                           merged_into_id, merged_at, merged_by)
       VALUES ('label-old', 'proj-alpha', 'Bugs', NULL, 2, 1, 2, 'label-bug', 2, ?)`,
      SESSION_ACTOR,
    );
    ticket("ticket-main", 1, {
      uses_worktree: 0,
      base_branch: "release",
      pr_url: "https://github.com/example/beta/pull/3",
    });
    ticket("ticket-dup", 2, {});
    ticketEvent("e-created-1", "ticket-dup", "created", SESSION_ACTOR, '{"kind":"created"}');
    ticketEvent("e-created-2", "ticket-dup", "created", "user", '{"kind":"created"}');
    ticketEvent(
      "e-merged",
      "ticket-main",
      "pr_merged",
      "automation",
      '{"kind":"pr_merged","url":"https://github.com/example/beta/pull/3"}',
    );
    ticketEvent("e-merged-bare", "ticket-archived", "pr_merged", "automation", "[1]");
    ticketEvent("e-scalar", "ticket-live", "retitled", "user", "5");
    ticketEvent("e-odd", "ticket-live", "worktree_changed", "user", '{"kind":"worktree_changed"}');
    ticketEvent(
      "e-by-run",
      "ticket-live",
      "status_changed",
      JSON.stringify({ kind: "automation", sessionId: "session-root", ticketId: "ticket-live" }),
      '{"kind":"status_changed"}',
    );
    ticketEvent(
      "e-failed",
      "ticket-live",
      "worktree_failed",
      "automation",
      JSON.stringify({
        kind: "worktree_failed",
        stage: "create",
        stderr:
          "fatal: '/Users/source/.volli/worktrees/alpha/AL-12' exists; see /Users/source/code/alpha and /Users/source/.gitconfig",
      }),
    );
    ticketEvent(
      "e-committed",
      "ticket-main",
      "worktree_committed",
      "user",
      '{"kind":"worktree_committed"}',
    );
    ticketEvent("e-null", "ticket-main", "worktree_changed", "user", "null");
    ticketEvent(
      "e-main-failed",
      "ticket-main",
      "worktree_failed",
      "automation",
      '{"kind":"worktree_failed","stderr":"no /Users/source/code/beta"}',
    );
    ticketEvent("e-array", "ticket-main", "worktree_failed", "user", "[1]");
    ticketEvent(
      "e-scope",
      "ticket-main",
      "worktree_scope_changed",
      "user",
      '{"kind":"worktree_scope_changed","from":true,"to":false}',
    );
    ticketEvent("e-retired", "ticket-main", "retired_kind", "user", '{"kind":"retired_kind"}');

    const { outDir, manifest } = await exportProfile();
    const prefs = records(outDir, manifest, "memberProjectPrefs");
    expect(prefs.find((entry) => entry.projectId === "proj-beta")!.themeCanvas).toEqual({
      stops: [],
    });
    expect("themeCanvas" in prefs.find((entry) => entry.projectId === "proj-alpha")!).toBe(false);

    const old = records(outDir, manifest, "labels").find((label) => label.id === "label-old")!;
    expect(old).toMatchObject({
      nameKey: "bugs",
      mergedIntoId: "label-bug",
      mergedBy: { kind: "agent", sessionId: "session-root" },
    });

    const tickets = records(outDir, manifest, "tickets");
    const main = tickets.find((entry) => entry.id === "ticket-main")!;
    expect(main).toMatchObject({
      checkoutMode: "main_checkout",
      baseBranch: "release",
      placeRunnerId: null,
      pullRequests: [{ number: 3, state: "merged", mergedAt: 500 }],
    });
    expect(tickets.find((entry) => entry.id === "ticket-dup")!.createdBy).toMatchObject({
      kind: "agent",
      sessionId: "session-root",
    });
    // A merge event that names no url still marks the ticket's PR merged.
    expect(tickets.find((entry) => entry.id === "ticket-archived")!.pullRequests[0]).toMatchObject({
      state: "merged",
      mergedAt: 500,
    });
    expect(
      records(outDir, manifest, "workingCopies")
        .map((copy) => copy.ticketId)
        .toSorted(),
    ).toEqual(["ticket-archived", "ticket-live"]);

    const events = records(outDir, manifest, "boardEvents");
    const byId = new Map(events.map((event) => [event.id, event]));
    expect(byId.get("e-scalar")!.payload).toBe(5);
    expect(byId.get("e-odd")!.payload).toEqual({ kind: "worktree_changed", from: null, to: null });
    expect(byId.get("e-by-run")!.actor).toEqual({
      kind: "automation",
      userId: "$local-user",
      automationId: "automation-1",
      runId: "arun-1",
      sessionId: "session-root",
    });
    expect(byId.get("e-failed")!.payload).toEqual({
      kind: "worktree_failed",
      stage: "create",
      stderr: "fatal: '<worktree>' exists; see <project> and ~/.gitconfig",
      runnerId: "$local-runner",
      workingCopyId: workingCopyId("ticket-live"),
    });
    // No worktree, so no Working copy to name.
    expect(byId.get("e-committed")!.payload).toEqual({
      kind: "worktree_committed",
      runnerId: "$local-runner",
    });
    expect(byId.get("e-null")!.payload).toBeNull();
    expect(byId.get("e-main-failed")!.payload).toEqual({
      kind: "worktree_failed",
      stderr: "no <project>",
      runnerId: "$local-runner",
    });
    expect(
      records(outDir, manifest, "configEntries").find((entry) => entry.kind === "harness")!
        .definition,
    ).toBe("claude-code");
    expect(byId.get("e-array")!.payload).toEqual([1]);
    expect(
      events.filter((event) => event.projectId === "proj-beta").map((event) => event.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // A scope flip is the cloud's checkout mode change; a kind the cloud has no use for is kept.
    expect(byId.get("e-scope")).toMatchObject({
      kind: "checkout_mode_changed",
      payload: { kind: "checkout_mode_changed", from: "worktree", to: "main_checkout" },
    });
    expect(byId.has("e-retired")).toBe(false);
    expect(records(outDir, manifest, "legacyRows")).toContainEqual(
      expect.objectContaining({
        table: "ticket_events",
        projectId: "proj-beta",
        reason: "kind has no board event equivalent",
        row: expect.objectContaining({ id: "e-retired" }),
      }),
    );
    expect(
      records(outDir, manifest, "projectCounters").find((entry) => entry.projectId === "proj-beta")!
        .boardSeq,
    ).toBe(8);
  });

  it("covers comments, Sessions, delegations, runs, MCP and the ledger", async () => {
    run("UPDATE ticket_comments SET updated_at = 999 WHERE id = 'comment-1'");
    session("session-project", "project", null, null);
    session("session-sub", "subagent", "session-project", null);
    run("INSERT INTO session_read_receipts (session_id, unread_since) VALUES ('session-sub', 42)");
    run(
      `INSERT INTO session_delegation_claims (parent_session_id, tool_call_id, ticket_id,
                                              create_command_id, child_session_id, created_at)
       VALUES ('session-root', 'tool-call-9', 'ticket-live', 'cmd-9', NULL, 9)`,
    );
    run(
      `INSERT INTO automation_runs (id, automation_id, automation_name, ticket_id, session_id,
                                    provider_id, model_id, reasoning_level, created_at)
       VALUES ('run-unbound', NULL, NULL, NULL, 'session-sub', 'p', 'm', 'low', 1),
              ('run-schedule', 'automation-1', 'Review', NULL, 'session-project', 'p', 'm', 'low', 2)`,
    );
    run(
      `INSERT INTO automation_commands (id, intent, created_at)
       VALUES ('acommand-2', '{"kind":"automation.run","plan":{"projectId":"proj-alpha"}}', 400)`,
    );
    run(
      `INSERT INTO mcp_servers (id, project_id, name, enabled, transport, catalog, stale,
                                created_at, updated_at)
       VALUES ('mcp-on', 'proj-alpha', 'docs', 1, ?, '[]', 0, 1, 1)`,
      JSON.stringify({
        kind: "stdio",
        command: "/Users/source/bin/docs-mcp",
        args: ["--root", "/Users/source/code"],
        env: { DEPTH: 2, EMPTY: null },
      }),
    );
    run(
      `INSERT INTO mcp_operations (id, project_id, server_id, server_name, operation, outcome,
                                   summary, detail, session_id, ticket_id, created_at)
       VALUES ('op-person', 'proj-alpha', 'mcp-on', 'docs', 'remove', 'applied',
               'removed /Users/source/bin/docs-mcp', 'ran /Users/source/bin/docs-mcp', NULL, NULL, 1),
              ('op-agent', 'proj-alpha', 'mcp-on', 'docs', 'install', 'applied', 's',
               NULL, 'session-root', 'ticket-live', 2)`,
    );
    run("DELETE FROM session_usage_coverage");
    profile.db.pragma("foreign_keys = OFF");
    session("session-loop-a", "subagent", "session-loop-b", null);
    session("session-loop-b", "subagent", "session-loop-a", null);
    session("session-sub-of-ticket", "subagent", "session-root", null);
    session("session-parentless", "subagent", null, null);
    profile.db.pragma("foreign_keys = ON");
    run(
      "INSERT INTO app_state (key, value, updated_at) VALUES ('volli:automation-schedule-cursors', ?, 1)",
      JSON.stringify({ "automation-1": 1234, broken: "soon" }),
    );

    const { outDir, manifest } = await exportProfile();
    expect(records(outDir, manifest, "ticketComments")[0]!.editedAt).toBe(999);

    const sessions = new Map(
      records(outDir, manifest, "sessions").map((entry) => [entry.id, entry]),
    );
    expect(sessions.get("session-project")).toMatchObject({
      visibility: "private",
      visibilityReason: "adhoc",
      lastActivityAt: 700,
      lastSequence: 0,
      eventCount: 0,
    });
    expect(sessions.get("session-sub")).toMatchObject({
      visibility: "private",
      visibilityReason: "inherited",
    });
    expect(sessions.get("session-loop-a")).toMatchObject({
      visibility: "private",
      visibilityReason: "inherited",
    });
    expect(sessions.get("session-parentless")!.visibility).toBe("private");
    expect(sessions.get("session-sub-of-ticket")).toMatchObject({
      visibility: "shared",
      visibilityReason: "inherited",
    });
    expect(records(outDir, manifest, "automationScheduleCursors")).toEqual([]);
    expect(records(outDir, manifest, "legacyRows")).toContainEqual(
      expect.objectContaining({
        table: "automation_schedule_cursors",
        projectId: "proj-alpha",
        row: { automationId: "automation-1", evaluatedThrough: 1234 },
      }),
    );
    expect(records(outDir, manifest, "legacyRows")).toContainEqual(
      expect.objectContaining({
        table: "automation_schedule_cursors",
        projectId: null,
        row: { automationId: "broken", evaluatedThrough: "soon" },
      }),
    );
    expect(
      records(outDir, manifest, "automationRuns").find((entry) => entry.id === "attempt-1")!
        .retryCommandId,
    ).toBe("acommand-retry");
    expect(records(outDir, manifest, "readMarkers")).toEqual([
      {
        userId: "$local-user",
        sessionId: "session-sub",
        unreadSince: 42,
        readThroughSequence: null,
      },
    ]);
    expect(records(outDir, manifest, "legacyRows")).toContainEqual({
      table: "session_delegation_claims",
      projectId: "proj-alpha",
      reason: "claimed fan-out slot whose child Session was never created",
      row: {
        parent_session_id: "session-root",
        tool_call_id: "tool-call-9",
        ticket_id: "ticket-live",
        create_command_id: "cmd-9",
        created_at: 9,
      },
    });
    const runs = new Map(
      records(outDir, manifest, "automationRuns").map((entry) => [entry.id, entry]),
    );
    expect(runs.get("run-unbound")!.trigger).toBe("manual");
    expect(runs.get("run-schedule")!.trigger).toBe("schedule");
    expect(
      records(outDir, manifest, "legacyRows").find((row) => row.row.id === "acommand-2")!.projectId,
    ).toBe("proj-alpha");
    expect(
      records(outDir, manifest, "configEntries").find(
        (entry) => entry.id === mcpServerEntryId("mcp-on"),
      )!.state,
    ).toBe("on");
    const audit = new Map(records(outDir, manifest, "auditLog").map((entry) => [entry.id, entry]));
    // Local MCP ids are slugs: the cloud rows take derived UUIDs and keep the slug.
    // The home directory is `~` in an MCP definition and its audit trail.
    expect(audit.get(mcpOperationId("op-person"))).toMatchObject({
      targetId: mcpServerEntryId("mcp-on"),
      detail: {
        localServerId: "mcp-on",
        summary: "removed ~/bin/docs-mcp",
        detail: "ran ~/bin/docs-mcp",
      },
    });
    expect(audit.get(mcpOperationId("op-agent"))!.detail).toMatchObject({ detail: null });
    expect(
      records(outDir, manifest, "configEntries").find(
        (entry) => entry.id === mcpServerEntryId("mcp-on"),
      )!.definition,
    ).toMatchObject({
      localId: "mcp-on",
      transport: {
        kind: "stdio",
        command: "~/bin/docs-mcp",
        args: ["--root", "~/code"],
        env: { DEPTH: 2, EMPTY: null },
      },
    });
    expect(audit.get(mcpOperationId("op-person"))!.actor).toEqual({
      kind: "person",
      userId: "$local-user",
    });
    expect(audit.get(mcpOperationId("op-agent"))!.actor).toEqual({
      kind: "agent",
      userId: "$local-user",
      sessionId: "session-root",
      ticketId: "ticket-live",
    });
    expect(manifest.source.usageMeteredFrom).toBeNull();
  });
});

describe("corrupt sources stop the export", () => {
  // Also drive each mapper's own guard without the ownership projection.
  // Preflight refuses these FKs earlier in a complete export, but individual
  // source consumers must never map an orphan into an apparently valid row.
  function mapRaw(id: string) {
    const source = EXPORT_SOURCES.find((s) => s.id === id)!;
    const lookups = buildLookups(profile.db, { snapshotAt: 1, profileStep: true });
    const prepared = source.prepare(profile.db, lookups);
    for (const row of profile.db.prepare(source.sql).all())
      source.map(row, prepared, lookups, () => {});
  }
  async function expectCorrupt(message: RegExp) {
    await expect(exportProfile()).rejects.toMatchObject({
      code: "source_corrupt",
      message: expect.stringMatching(message),
    });
  }

  it("a ticket whose project is gone", async () => {
    profile.db.pragma("foreign_keys = OFF");
    ticket("ticket-ghost", 99, { project_id: "proj-ghost" });
    expect(() => mapRaw("tickets")).toThrow(/names missing project/);
    await expectCorrupt(/orphan tickets ticket-ghost: missing projects/);
  });

  it("a comment whose ticket is gone", async () => {
    profile.db.pragma("foreign_keys = OFF");
    run(
      `INSERT INTO ticket_comments (id, ticket_id, session_id, actor, body, created_at, updated_at)
       VALUES ('comment-ghost', 'ticket-ghost', NULL, 'user', 'x', 1, 1)`,
    );
    expect(() => mapRaw("ticketComments")).toThrow(/names a missing ticket/);
    await expectCorrupt(/orphan ticket_comments comment-ghost: missing tickets/);
  });

  it("a blob link with no owner", async () => {
    profile.db.pragma("foreign_keys = OFF");
    run(
      `INSERT INTO blob_links (id, blob_hash, ticket_id, session_id, label, created_at)
       VALUES ('link-ghost', ?, 'ticket-ghost', NULL, 'x', 1)`,
      profile.blobHashes.ticket,
    );
    expect(() => mapRaw("blobLinks")).toThrow(/no owning ticket or Session/);
    await expectCorrupt(/orphan blob_links link-ghost: missing tickets/);
  });

  it("a Run whose Session is gone", async () => {
    profile.db.pragma("foreign_keys = OFF");
    run(
      `INSERT INTO automation_runs (id, automation_id, automation_name, ticket_id, session_id,
                                    provider_id, model_id, reasoning_level, created_at)
       VALUES ('run-ghost', NULL, NULL, NULL, 'session-ghost', 'p', 'm', 'low', 1)`,
    );
    expect(() => mapRaw("automationRuns")).toThrow(/names a missing Session/);
    await expectCorrupt(/orphan automation_runs run-ghost: missing sessions/);
  });

  it.each([null, "ticket-live"])(
    "refuses missing Session ancestry while the raw mapper keeps its legacy fallback (%s)",
    async (ticketId) => {
      profile.db.pragma("foreign_keys = OFF");
      session("orphan-session", "subagent", "missing-parent", ticketId);
      const source = EXPORT_SOURCES.find((s) => s.id === "sessions")!;
      const lookups = buildLookups(profile.db, { snapshotAt: 1, profileStep: true });
      const mapped: unknown[] = [];
      const row = profile.db
        .prepare(`SELECT * FROM (${source.sql}) WHERE id='orphan-session'`)
        .get();
      source.map(row, source.prepare(profile.db, lookups), lookups, (_stream, record) =>
        mapped.push(record),
      );
      expect(mapped[0]).toMatchObject({
        visibility: ticketId === null ? "private" : "shared",
        visibilityReason: "inherited",
      });
      await expectCorrupt(/orphan sessions orphan-session/);
    },
  );

  it("a Session event whose provenance is missing", async () => {
    profile.db.pragma("foreign_keys = OFF");
    run("UPDATE session_events SET provenance_id=999 WHERE id='event-2'");
    expect(() => mapRaw("sessionEvents")).toThrow(/names missing provenance/);
    await expectCorrupt(/orphan session_events event-2/);
  });

  it("an Automation ledger row with an unattributable project", async () => {
    run(
      "INSERT INTO automation_commands (id,intent,created_at) VALUES ('orphan-ledger',?,1)",
      JSON.stringify({ plan: { projectId: "missing-project" } }),
    );
    await expectCorrupt(/Automation ledger orphan-ledger names missing project/);
  });

  it("a worktree scope change whose sides are not booleans", async () => {
    ticketEvent(
      "e-bad-scope",
      "ticket-live",
      "worktree_scope_changed",
      "user",
      '{"kind":"worktree_scope_changed","from":1,"to":false}',
    );
    await expectCorrupt(/scope change of ticket ticket-live has a worktree scope/);
  });

  it("a worktree scope change whose payload is not an object", async () => {
    ticketEvent("e-bare-scope", "ticket-live", "worktree_scope_changed", "user", "[1]");
    await expectCorrupt(/scope change of ticket ticket-live has a worktree scope/);
  });

  it("a provenance that is not JSON", async () => {
    profile.db.pragma("ignore_check_constraints = ON");
    run("INSERT INTO session_provenances (id, provenance) VALUES (50, 'not json')");
    run(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
                                   provenance_id, attachment_id, command_id, payload)
       VALUES ('event-bad-provenance', 'session-child', 2, 1, 1, 50, NULL, NULL,
               '{"kind":"session.archived"}')`,
    );
    await expectCorrupt(/provenance 50 is not valid JSON/);
  });
});

describe("tolerated rows", () => {
  it("skips an unreadable schedule cursor row", async () => {
    run(
      "INSERT INTO app_state (key, value, updated_at) VALUES ('volli:automation-schedule-cursors', '[1]', 1)",
    );
    const { outDir, manifest } = await exportProfile();
    expect(records(outDir, manifest, "automationScheduleCursors")).toEqual([]);
  });

  it("keeps a column order whose ranked ids are not a list of ids", async () => {
    run(
      `INSERT INTO automation_column_order (project_id, status, ranked_ids, ordered_at)
       VALUES ('proj-beta', 'todo', '{"a":1}', 3)`,
    );
    const { outDir, manifest } = await exportProfile();
    expect(
      records(outDir, manifest, "automationColumnOrder").some(
        (row) => row.projectId === "proj-beta",
      ),
    ).toBe(false);
    expect(records(outDir, manifest, "legacyRows")).toContainEqual({
      table: "automation_column_order",
      projectId: "proj-beta",
      reason: "ranked ids are not a list of ids",
      row: { project_id: "proj-beta", status: "todo", ranked_ids: '{"a":1}', ordered_at: 3 },
    });
  });
});
