/**
 * A representative profile on disk: a migrated database, attachment bytes
 * under `blobs/`, and transcript artifacts under `session-transcripts/`.
 *
 * Not a `*.test.ts`, so the main test project never treats it as a suite — it
 * is imported BY the backup suites, the same arrangement `db/test-helpers.ts`
 * uses. It exists because the acceptance criteria are about a WHOLE profile:
 * a round trip that only proved tickets survive would say nothing about the
 * ordering, the artifacts, or the automation queue, which are exactly the
 * things a hand-written per-table fixture forgets.
 *
 * Rows are written as SQL rather than through the repos on purpose. What is
 * under test is whether a backup carries every persisted fact, so the fixture
 * has to be able to write facts the product's own write paths do not offer
 * today (a retained ticket with a PR url, a queued armed run with a failed
 * attempt behind it) and to write machine-local rows — credentials, harness
 * trust — that must be shown to be ABSENT from a bundle.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { blobsRoot, writeBlob } from "../blob-store";
import { migrate } from "../db/migrations";
import { openRawDb } from "../db/test-helpers";
import { sessionTranscriptsRoot } from "../session-runtime/transcript-artifacts";

export interface FixtureProfile {
  /** The profile root — an Electron `userData` stand-in. */
  root: string;
  dbPath: string;
  db: Database.Database;
  blobsRoot: string;
  transcriptsRoot: string;
  /** Content hashes of the two attachment blobs, ticket-linked and session-linked. */
  blobHashes: { ticket: string; session: string };
  /** `sha256:…` ids of the transcripts referenced from the ledger. */
  transcriptIds: { prompt: string; reply: string };
  cleanup: () => void;
}

/** Canonical JSON for a transcript artifact — key order fixed, as the store writes it. */
function transcriptBytes(messageId: string, text: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      threadId: "thread-1",
      branchId: "branch-1",
      attemptId: "attempt-1",
      turnId: "turn-1",
      message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
    }),
    "utf8",
  );
}

function writeTranscript(root: string, bytes: Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, `${digest}.json`), bytes);
  return `sha256:${digest}`;
}

/**
 * Builds the fixture profile.
 *
 * `schemaVersion` stops the migration walk early, which is how the
 * app-upgrade-window suite produces a bundle from an OLDER profile than the
 * app that will restore it.
 */
export function createFixtureProfile(options: { schemaVersion?: number } = {}): FixtureProfile {
  const root = mkdtempSync(join(tmpdir(), "volli-backup-profile-"));
  const dbPath = join(root, "volli.db");
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    dbPath,
    options.schemaVersion === undefined ? {} : { toVersion: options.schemaVersion },
  );

  const blobs = blobsRoot(root);
  const transcripts = sessionTranscriptsRoot(root);
  const ticketBlob = writeBlob(blobs, Buffer.from("ticket attachment bytes", "utf8"));
  const sessionBlob = writeBlob(
    blobs,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const promptId = writeTranscript(transcripts, transcriptBytes("message-1", "restore me"));
  const replyId = writeTranscript(transcripts, transcriptBytes("message-2", "restored"));

  seed(db, { ticketBlob, sessionBlob, promptId, replyId });

  return {
    root,
    dbPath,
    db,
    blobsRoot: blobs,
    transcriptsRoot: transcripts,
    blobHashes: { ticket: ticketBlob, session: sessionBlob },
    transcriptIds: { prompt: promptId, reply: replyId },
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Artifacts {
  ticketBlob: string;
  sessionBlob: string;
  promptId: string;
  replyId: string;
}

function reference(id: string): unknown {
  return { id, mediaType: "application/vnd.volli.transcript+json", digest: id };
}

/**
 * One row, written only as far as this schema reaches.
 *
 * Columns the current `user_version` does not have yet are dropped, and a
 * table that does not exist yet is skipped entirely. That is what lets ONE
 * fixture describe a v39, v40 and v41 profile — which is the shape the
 * app-upgrade-window suite needs, since a bundle written at an older schema
 * has to be a real older profile rather than a newer one with fields deleted.
 */
function inserter(db: Database.Database) {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const table of tables) {
    columnsByTable.set(
      table,
      new Set(
        (
          db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>
        ).map(({ name }) => name),
      ),
    );
  }
  return (table: string, record: Record<string, unknown>): void => {
    if (!tables.has(table)) return;
    const live = columnsByTable.get(table) ?? new Set<string>();
    const columns = Object.keys(record).filter((column) => live.has(column));
    db.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...(columns.map((column) => record[column]) as never[]));
  };
}

/* eslint-disable max-lines-per-function -- one fixture, read top to bottom */
function seed(db: Database.Database, artifacts: Artifacts): void {
  const insert = inserter(db);

  // ---- projects, labels, tickets ------------------------------------------
  insert("projects", {
    id: "proj-alpha",
    name: "Alpha",
    path: "/Users/source/code/alpha",
    ticket_prefix: "AL",
    color_index: 2,
    sort_order: 0,
    row_version: 3,
    created_at: 100,
    updated_at: 400,
    next_ticket_number: 42,
    base_branch: "main",
    setup_command: "pnpm install",
    theme_appearance: "auto",
  });
  insert("projects", {
    id: "proj-beta",
    name: "Beta",
    path: "/Users/source/code/beta",
    ticket_prefix: "BE",
    color_index: 5,
    sort_order: 1,
    row_version: 1,
    created_at: 110,
    updated_at: 110,
    next_ticket_number: 7,
  });
  insert("labels", {
    id: "label-bug",
    project_id: "proj-alpha",
    name: "bug",
    color: "#ff0000",
    row_version: 1,
    created_at: 120,
    updated_at: 120,
  });
  insert("tickets", {
    id: "ticket-live",
    project_id: "proj-alpha",
    ticket_number: 12,
    title: "Live ticket",
    body: "Body of the live ticket",
    status: "doing",
    priority: "high",
    uses_worktree: 1,
    position: 1000,
    row_version: 4,
    created_at: 200,
    updated_at: 300,
    archived_at: null,
    worktree_path: "/Users/source/.volli/worktrees/alpha/AL-12",
    branch: "volli/AL-12-live",
    base_branch: "main",
    preferred_harness_id: "claude-code",
    pr_url: null,
    retention_keep: 0,
  });
  insert("tickets", {
    id: "ticket-archived",
    project_id: "proj-alpha",
    ticket_number: 9,
    title: "Archived ticket",
    body: "Shipped",
    status: "done",
    priority: "medium",
    uses_worktree: 1,
    position: 2000,
    row_version: 9,
    created_at: 150,
    updated_at: 900,
    archived_at: 950,
    worktree_path: "/Users/source/.volli/worktrees/alpha/AL-9",
    branch: "volli/AL-9-done",
    base_branch: "main",
    preferred_harness_id: "claude-code",
    pr_url: "https://github.com/example/alpha/pull/9",
    retention_keep: 1,
  });
  insert("ticket_labels", { ticket_id: "ticket-live", label_id: "label-bug" });
  // The last two share a millisecond: the pair that proves ticket-event order
  // comes from the sequence sidecar rather than from `created_at`.
  for (const [id, kind, payload, at] of [
    ["tevent-1", "created", { kind: "created", status: "backlog" }, 200],
    ["tevent-2", "status_changed", { kind: "status_changed", to: "doing" }, 210],
    ["tevent-3", "commented", { kind: "commented" }, 210],
  ] as const) {
    insert("ticket_events", {
      id,
      ticket_id: "ticket-live",
      kind,
      actor: "user",
      payload: JSON.stringify(payload),
      created_at: at,
    });
  }
  insert("ticket_comments", {
    id: "comment-1",
    ticket_id: "ticket-live",
    session_id: null,
    actor: "user",
    body: "A comment body",
    created_at: 220,
    updated_at: 220,
  });

  // ---- sessions and their ordered ledger -----------------------------------
  insert("sessions", {
    id: "session-root",
    project_id: "proj-alpha",
    ticket_id: "ticket-live",
    title: "Root session",
    created_at: 230,
    role: "ticket",
    parent_session_id: null,
  });
  insert("sessions", {
    id: "session-child",
    project_id: "proj-alpha",
    ticket_id: "ticket-live",
    title: "Child session",
    created_at: 240,
    role: "ticket",
    parent_session_id: "session-root",
  });
  insert("session_delegations", {
    session_id: "session-root",
    ticket_id: "ticket-live",
    parent_session_id: null,
    depth: 0,
  });
  insert("session_delegations", {
    session_id: "session-child",
    ticket_id: "ticket-live",
    parent_session_id: "session-root",
    depth: 1,
  });
  insert("session_verb_grants", {
    session_id: "session-root",
    verb: "session.start",
    scope: "own-ticket",
    max_depth: 1,
    max_children: 3,
  });
  insert("session_delegation_claims", {
    parent_session_id: "session-root",
    tool_call_id: "tool-call-1",
    ticket_id: "ticket-live",
    create_command_id: "session-root:tool-call-1:create",
    child_session_id: "session-child",
    created_at: 245,
  });
  insert("session_delegation_extensions", {
    parent_session_id: "session-root",
    tool_call_id: "tool-call-2",
    created_at: 246,
  });
  insert("session_attachments", {
    id: "attach-1",
    session_id: "session-root",
    adapter_id: "terminal",
    venue_id: "local",
    venue_kind: "local",
    continuity: "fresh",
    native_id: "pty-4711",
    native_detail: JSON.stringify({
      kind: "volli.terminal.v1",
      cwd: "/Users/source/.volli/worktrees/alpha/AL-12",
      harnessId: "claude-code",
    }),
    observed_kind: "opened",
    failure: null,
    created_sequence: 1,
  });
  const provenance = JSON.stringify({
    source: { kind: "adapter", id: "terminal", detail: { cwd: "/Users/source/code/alpha" } },
    venue: { id: "local", kind: "local" },
  });
  insert("session_commands", {
    id: "command-1",
    session_id: "session-root",
    created_at: 250,
    intent: JSON.stringify({ kind: "message.submit", reference: reference(artifacts.promptId) }),
    route: JSON.stringify({ adapterId: "terminal", attachmentId: "attach-1" }),
  });
  const events: Array<[string, number, string | null, unknown]> = [
    ["event-1", 1, "command-1", { kind: "command.accepted", commandId: "command-1" }],
    [
      "event-2",
      2,
      "command-1",
      {
        kind: "transcript.referenced",
        attachmentId: "attach-1",
        turnId: "turn-1",
        reference: reference(artifacts.promptId),
      },
    ],
    [
      "event-3",
      3,
      null,
      {
        kind: "transcript.referenced",
        attachmentId: "attach-1",
        turnId: "turn-1",
        reference: reference(artifacts.replyId),
      },
    ],
    [
      "event-4",
      4,
      null,
      {
        kind: "usage.recorded",
        attachmentId: "attach-1",
        turnId: "turn-1",
        attribution: { projectId: "proj-alpha", ticketId: "ticket-live" },
        usage: {
          cause: "assistant",
          providerId: "anthropic",
          modelId: "claude-opus-4-1",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
          costUsd: 0.25,
          costBasis: "catalog-estimate",
        },
      },
    ],
  ];
  for (const [id, sequence, commandId, payload] of events) {
    insert("session_events", {
      id,
      session_id: "session-root",
      sequence,
      occurred_at: 250 + sequence,
      recorded_at: 250 + sequence,
      provenance,
      attachment_id: "attach-1",
      command_id: commandId,
      payload: JSON.stringify(payload),
    });
  }
  insert("session_events", {
    id: "event-child-1",
    session_id: "session-child",
    sequence: 1,
    occurred_at: 260,
    recorded_at: 260,
    provenance,
    attachment_id: null,
    command_id: null,
    payload: JSON.stringify({ kind: "session.signaled", signal: "done", reason: null }),
  });
  insert("session_command_receipts", {
    id: "receipt-1",
    session_id: "session-root",
    command_id: "command-1",
    sequence: 1,
    recorded_at: 251,
    receipt: JSON.stringify({
      id: "receipt-1",
      commandId: "command-1",
      status: "completed",
      result: { kind: "message.submitted", sessionId: "session-root" },
      recordedAt: 251,
      sequence: 1,
    }),
    receipt_event_id: "event-1",
  });
  insert("ticket_signals", {
    id: "signal-1",
    ticket_id: "ticket-live",
    session_id: "session-root",
    actor: "session",
    kind: "implement",
    verdict: "pass",
    detail: "Landed",
    created_at: 270,
  });
  insert("ticket_signals", {
    id: "signal-2",
    ticket_id: "ticket-live",
    session_id: "session-root",
    actor: "session",
    kind: "review",
    verdict: "blocked",
    detail: null,
    created_at: 271,
  });

  // ---- attachments ---------------------------------------------------------
  insert("blobs", {
    hash: artifacts.ticketBlob,
    mime: "text/plain",
    size_bytes: 23,
    original_name: "notes.txt",
    width: null,
    height: null,
    created_at: 280,
  });
  insert("blobs", {
    hash: artifacts.sessionBlob,
    mime: "image/png",
    size_bytes: 8,
    original_name: "shot.png",
    width: 16,
    height: 16,
    created_at: 281,
  });
  insert("blob_links", {
    id: "link-ticket",
    blob_hash: artifacts.ticketBlob,
    ticket_id: "ticket-live",
    session_id: null,
    label: "notes.txt",
    created_at: 282,
  });
  insert("blob_links", {
    id: "link-session",
    blob_hash: artifacts.sessionBlob,
    ticket_id: null,
    session_id: "session-root",
    label: "shot.png",
    created_at: 283,
  });

  // ---- settings ------------------------------------------------------------
  insert("app_state", { key: "volli:retention", value: '{"doneTtlDays":21}', updated_at: 290 });
  insert("app_state", { key: "volli:theme", value: '{"appearance":"dark"}', updated_at: 291 });

  // ---- automations ---------------------------------------------------------
  insert("automations", {
    id: "automation-1",
    project_id: "proj-alpha",
    name: "Review",
    instructions: "/review go",
    runtime: JSON.stringify({
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningLevel: "high",
    }),
    row_version: 2,
    created_at: 300,
    updated_at: 310,
    trigger_spec: JSON.stringify({ kind: "column", statuses: ["needs_review"] }),
  });
  insert("automation_commands", {
    id: "acommand-1",
    intent: JSON.stringify({
      kind: "automation.run",
      plan: { sessionOperationId: "session-mint" },
    }),
    created_at: 320,
  });
  insert("automation_events", {
    id: "aevent-1",
    command_id: "acommand-1",
    kind: "automation.run.accepted",
    payload: "{}",
    created_at: 321,
  });
  insert("automation_command_receipts", {
    id: "areceipt-1",
    command_id: "acommand-1",
    status: "completed",
    result: '{"kind":"automation.ran"}',
    recorded_at: 322,
  });
  insert("automation_runs", {
    id: "arun-1",
    automation_id: "automation-1",
    automation_name: "Review",
    ticket_id: "ticket-live",
    session_id: "session-root",
    provider_id: "anthropic",
    model_id: "claude-opus",
    reasoning_level: "high",
    created_at: 323,
    attendance: "unattended",
  });
  insert("automation_run_deliveries", {
    run_id: "arun-1",
    session_id: "session-root",
    automation_command_id: "acommand-1",
    message_command_id: "mcommand-1",
    message_id: "message-1",
    text: "/review go",
    resources: "[]",
    created_at: 324,
    delivered_at: 325,
  });
  insert("automation_session_mint_intents", {
    session_create_command_id: "session-mint:create",
    automation_command_id: "acommand-1",
    recorded_at: 326,
  });
  insert("automation_column_arming", {
    project_id: "proj-alpha",
    status: "needs_review",
    automation_id: "automation-1",
    armed_at: 330,
  });
  insert("automation_column_order", {
    project_id: "proj-alpha",
    status: "needs_review",
    ranked_ids: '["automation-1"]',
    ordered_at: 331,
  });
  insert("automation_skipped_occurrences", {
    id: "skip-1",
    automation_id: "automation-1",
    automation_name: "Review",
    project_id: "proj-alpha",
    due_at: 340,
    missed_count: 2,
    reason: '{"kind":"app_asleep"}',
    recorded_at: 341,
  });
  insert("automation_pending_armed_runs", {
    ticket_id: "ticket-live",
    id: "pending-1",
    project_id: "proj-alpha",
    ticket_display_id: "AL-12",
    automation_id: "automation-1",
    automation_name: "Review",
    status: "needs_review",
    origin: "armed",
    opened_at: 350,
    start_at: 360,
  });
  insert("automation_pending_armed_run_attempts", {
    id: "attempt-1",
    command_id: "acommand-retry",
    ticket_id: "ticket-live",
    project_id: "proj-alpha",
    ticket_display_id: "AL-12",
    automation_id: "automation-1",
    automation_name: "Review",
    status: "needs_review",
    origin: "armed",
    opened_at: 350,
    start_at: 360,
    error: "runtime unavailable",
  });

  // ---- what must NEVER travel ---------------------------------------------
  insert("secrets", { name: "anthropic:api-key", value: "sk-secret-value", updated_at: 400 });
  insert("registered_harnesses", {
    slug: "claude-code",
    manifest_path: "/Users/source/.volli/harnesses/claude.json",
    manifest_sha256: "abc123",
    decision: "trusted",
    declared_events: "[]",
    verified_events: "[]",
    decided_at: 410,
    created_at: 410,
    updated_at: 410,
  });
  insert("harness_channel", { harness_id: "claude-code", last_launch_at: 420, last_event_at: 421 });
  db.prepare(
    `INSERT INTO web_access_settings (id, provider, searxng_url, updated_at)
     VALUES (1, 'searxng', 'http://127.0.0.1:8888', 430)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, searxng_url = excluded.searxng_url`,
  ).run();
}
/* eslint-enable max-lines-per-function */
