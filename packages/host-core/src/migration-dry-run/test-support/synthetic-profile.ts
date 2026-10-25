/**
 * A synthetic profile for the migration dry run: a head-schema `volli.db`
 * migrated by the real migrations, attachment bytes under `blobs/`, and a
 * worktree directory, with every id a UUID as the app mints them. It holds
 * one of each case the dry run must handle: a live and a removed project,
 * tickets in several columns, a worktree scope flip and a kind with no board
 * event, a Session inside the activity window and one outside it, an unknown
 * event kind, a malformed known one, and payloads too large or unstorable to
 * keep inline.
 *
 * Test data only: not a `*.test.ts`, written as SQL like `backup/test-fixture.ts`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { writeBlob } from "../../blob-store";
import { migrate } from "../../db/migrations";
import { openRawDb } from "../../db/test-helpers";

const DAY = 86_400_000;

/** Fixed UUIDs, so a test can name what it expects. */
export const SYNTHETIC_IDS = {
  project: "7a1f0c2e-0000-4000-8000-000000000001",
  removedProject: "7a1f0c2e-0000-4000-8000-000000000002",
  label: "7a1f0c2e-0000-4000-8000-000000000010",
  tickets: [
    "7a1f0c2e-0000-4000-8000-000000000021",
    "7a1f0c2e-0000-4000-8000-000000000022",
    "7a1f0c2e-0000-4000-8000-000000000023",
    "7a1f0c2e-0000-4000-8000-000000000024",
  ],
  removedTicket: "7a1f0c2e-0000-4000-8000-000000000025",
  hotSession: "7a1f0c2e-0000-4000-8000-000000000031",
  coldSession: "7a1f0c2e-0000-4000-8000-000000000032",
  childSession: "7a1f0c2e-0000-4000-8000-000000000033",
  removedSession: "7a1f0c2e-0000-4000-8000-000000000034",
  automation: "7a1f0c2e-0000-4000-8000-000000000041",
  run: "7a1f0c2e-0000-4000-8000-000000000042",
} as const;

export interface SyntheticProfile {
  dbPath: string;
  blobsDir: string;
  /** The machine paths the profile names (projects, worktrees). */
  paths: string[];
}

function inserter(db: Database.Database) {
  return (table: string, record: Record<string, unknown>): void => {
    const columns = Object.keys(record);
    db.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...(columns.map((column) => record[column]) as never[]));
  };
}

/* eslint-disable max-lines-per-function -- one fixture, read top to bottom */
export function writeSyntheticProfile(root: string, now = Date.now()): SyntheticProfile {
  const ids = SYNTHETIC_IDS;
  const dbPath = join(root, "volli.db");
  const blobsDir = join(root, "blobs");
  const projectPath = join(root, "code", "alpha");
  const worktree = join(root, "worktrees", "AL-1");
  mkdirSync(worktree, { recursive: true });
  const db = openRawDb(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    migrate(db, dbPath);
    const insert = inserter(db);
    const old = now - 90 * DAY;
    const recent = now - DAY;

    // ---- projects and the board ---------------------------------------------
    insert("projects", {
      id: ids.project,
      name: "Alpha",
      path: projectPath,
      ticket_prefix: "AL",
      color_index: 2,
      sort_order: 0,
      created_at: old,
      updated_at: recent,
      next_ticket_number: 3,
      base_branch: "main",
      setup_command: "pnpm install",
      session_harness: "pi",
    });
    insert("projects", {
      id: ids.removedProject,
      name: "Gone",
      path: join(root, "code", "gone"),
      ticket_prefix: "GO",
      color_index: 1,
      sort_order: 1,
      created_at: old,
      updated_at: old,
      removed_at: old + DAY,
    });
    insert("labels", {
      id: ids.label,
      project_id: ids.project,
      name: "Bug",
      color: "#ff0000",
      created_at: old,
      updated_at: old,
    });
    const tickets: Array<[string, number, string, number, Record<string, unknown>]> = [
      // Column order is the reverse of id order, so a migrated column cannot pass by accident.
      [ids.tickets[0], 1, "todo", 2000, { worktree_path: worktree, branch: "volli/AL-1-first" }],
      [ids.tickets[1], 2, "todo", 1000, { uses_worktree: 0 }],
      [ids.tickets[2], 4, "doing", 500, { pr_url: "https://github.com/example/alpha/pull/4" }],
      [ids.tickets[3], 5, "done", 100, { archived_at: recent, retention_keep: 1 }],
    ];
    for (const [id, number, status, position, extra] of tickets) {
      insert("tickets", {
        id,
        project_id: ids.project,
        ticket_number: number,
        title: `Ticket ${number}`,
        body: `Body of ticket ${number}`,
        status,
        priority: "medium",
        uses_worktree: 1,
        position,
        created_at: old,
        updated_at: recent,
        preferred_harness_id: "pi",
        retention_keep: 0,
        ...extra,
      });
    }
    insert("tickets", {
      id: ids.removedTicket,
      project_id: ids.removedProject,
      ticket_number: 1,
      title: "Removed",
      body: "",
      status: "todo",
      priority: "low",
      uses_worktree: 1,
      position: 1,
      created_at: old,
      updated_at: old,
      preferred_harness_id: "pi",
      retention_keep: 0,
    });
    insert("ticket_labels", { ticket_id: ids.tickets[0], label_id: ids.label });
    const ticketEvents: Array<[string, string, string, unknown]> = [
      [ids.tickets[0], "created", "user", { kind: "created", status: "todo" }],
      [
        ids.tickets[1],
        "worktree_scope_changed",
        "user",
        { kind: "worktree_scope_changed", from: true, to: false },
      ],
      [
        ids.tickets[0],
        "worktree_changed",
        "automation",
        {
          kind: "worktree_changed",
          from: { worktreePath: null, branch: null, baseBranch: null },
          to: { worktreePath: worktree, branch: "volli/AL-1-first", baseBranch: "main" },
        },
      ],
      [
        ids.tickets[2],
        "status_changed",
        JSON.stringify({ kind: "session", sessionId: ids.hotSession, ticketId: ids.tickets[2] }),
        { kind: "status_changed", to: "doing" },
      ],
      [ids.tickets[0], "retired_kind", "user", { kind: "retired_kind" }],
      [ids.tickets[0], "commented", "user", { kind: "commented" }],
      [ids.removedTicket, "created", "user", { kind: "created", status: "todo" }],
    ];
    for (const [index, [ticketId, kind, actor, payload]] of ticketEvents.entries()) {
      insert("ticket_events", {
        id: `7a1f0c2e-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
        ticket_id: ticketId,
        kind,
        actor,
        payload: JSON.stringify(payload),
        created_at: old + index,
      });
    }
    insert("ticket_comments", {
      id: "7a1f0c2e-0000-4000-8000-000000000201",
      ticket_id: ids.tickets[0],
      session_id: null,
      actor: "user",
      body: `See ${projectPath}/README.md`,
      created_at: recent,
      updated_at: recent,
    });

    // ---- Sessions and their history -------------------------------------------
    const sessions: Array<[string, string, string | null, string, string | null, number]> = [
      [ids.hotSession, ids.project, ids.tickets[0], "ticket", null, recent],
      [ids.coldSession, ids.project, null, "project", null, old],
      [ids.childSession, ids.project, ids.tickets[0], "subagent", ids.hotSession, recent],
      [ids.removedSession, ids.removedProject, null, "project", null, old],
    ];
    for (const [id, projectId, ticketId, role, parent, createdAt] of sessions) {
      insert("sessions", {
        id,
        project_id: projectId,
        ticket_id: ticketId,
        title: `Session ${role}`,
        created_at: createdAt,
        role,
        parent_session_id: parent,
      });
    }
    insert("session_delegations", {
      session_id: ids.hotSession,
      ticket_id: ids.tickets[0],
      parent_session_id: null,
      depth: 0,
    });
    insert("session_delegations", {
      session_id: ids.childSession,
      ticket_id: ids.tickets[0],
      parent_session_id: ids.hotSession,
      depth: 1,
    });
    insert("session_verb_grants", {
      session_id: ids.hotSession,
      verb: "session.start",
      scope: "own-ticket",
      max_depth: 1,
      max_children: 3,
    });
    insert("session_provenances", {
      id: 1,
      provenance: JSON.stringify({
        source: { kind: "system", id: "synthetic", detail: null },
        venue: { id: "local", kind: "local" },
      }),
    });
    const signaled = { kind: "session.signaled", signal: "done", reason: null };
    const history: Array<[string, number, unknown[]]> = [
      [
        ids.hotSession,
        recent,
        [
          signaled,
          { kind: "retired.kind", note: "an event kind this build no longer knows" },
          { kind: "session.signaled", signal: 5, reason: null },
          {
            kind: "retired.surface",
            schema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
          },
          { kind: "retired.big", text: "x".repeat(300 * 1024) },
        ],
      ],
      [ids.coldSession, old, [signaled, signaled]],
      [ids.childSession, recent, [signaled]],
      [ids.removedSession, old, [signaled]],
    ];
    for (const [sessionId, at, payloads] of history) {
      for (const [index, payload] of payloads.entries()) {
        insert("session_events", {
          id: `event:${sessionId}:${index + 1}`,
          session_id: sessionId,
          sequence: index + 1,
          occurred_at: at + index,
          recorded_at: at + index,
          provenance_id: 1,
          attachment_id: null,
          command_id: null,
          payload: JSON.stringify(payload),
        });
      }
    }
    insert("session_read_receipts", { session_id: ids.hotSession, unread_since: recent });
    insert("ticket_signals", {
      id: "7a1f0c2e-0000-4000-8000-000000000301",
      ticket_id: ids.tickets[0],
      session_id: ids.hotSession,
      actor: "session",
      kind: "implement",
      verdict: "pass",
      detail: null,
      created_at: recent,
    });

    // ---- attachments ------------------------------------------------------------
    const ticketBlob = writeBlob(blobsDir, Buffer.from("synthetic attachment", "utf8"));
    insert("blobs", {
      hash: ticketBlob,
      mime: "text/plain",
      size_bytes: 20,
      original_name: "notes.txt",
      width: null,
      height: null,
      created_at: recent,
    });
    insert("blob_links", {
      id: "7a1f0c2e-0000-4000-8000-000000000401",
      blob_hash: ticketBlob,
      ticket_id: ids.tickets[0],
      session_id: null,
      label: "notes.txt",
      created_at: recent,
    });

    // ---- settings and MCP (local MCP ids are slugs, not UUIDs) ---------------------
    insert("app_state", {
      key: "volli:decision-model",
      value: JSON.stringify({ providerId: "anthropic", modelId: "claude" }),
      updated_at: recent,
    });
    insert("mcp_servers", {
      id: "mcp-docs",
      project_id: ids.project,
      name: "docs",
      enabled: 1,
      // Launched from under the home directory: exported as `~/…`, never the machine path.
      transport: JSON.stringify({ kind: "stdio", command: join(root, "bin", "docs-mcp") }),
      catalog: "[]",
      stale: 0,
      created_at: old,
      updated_at: old,
    });

    // ---- Automations --------------------------------------------------------------
    insert("automations", {
      id: ids.automation,
      project_id: ids.project,
      name: "Review",
      instructions: "/review",
      runtime: null,
      created_at: old,
      updated_at: old,
      trigger_spec: JSON.stringify({ kind: "column", statuses: ["needs_review"] }),
    });
    insert("automation_runs", {
      id: ids.run,
      automation_id: ids.automation,
      automation_name: "Review",
      ticket_id: ids.tickets[0],
      session_id: ids.hotSession,
      provider_id: "anthropic",
      model_id: "claude",
      reasoning_level: "high",
      created_at: recent,
      attendance: "unattended",
    });
    insert("automation_column_order", {
      project_id: ids.project,
      status: "needs_review",
      ranked_ids: JSON.stringify([ids.automation]),
      ordered_at: old,
    });
    insert("automation_column_arming", {
      project_id: ids.project,
      status: "needs_review",
      automation_id: ids.automation,
      armed_at: old,
    });
  } finally {
    db.close();
  }
  return { dbPath, blobsDir, paths: [projectPath, worktree] };
}
/* eslint-enable max-lines-per-function */
