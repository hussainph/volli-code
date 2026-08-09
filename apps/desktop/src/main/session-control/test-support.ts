/**
 * Test-only ledger fixture helpers.
 *
 * Runtime code reaches Sessions through SessionEngine projections.  A few
 * long-lived main-process tests need synchronous fixture setup/assertion, so
 * these helpers write and read the *ledger tables* directly rather than
 * reviving a terminal-shaped `sessions` repository.  They intentionally live
 * beside the ledger and must never be imported by production modules.
 */
import type Database from "better-sqlite3";
import type { SessionNativeReference, SessionRecord } from "@volli/shared";
import {
  terminalNativeReference,
  terminalSessionRecord,
  type TerminalAttachmentDetail,
} from "./terminal-attachment";

const TEST_PROVENANCE = JSON.stringify({
  source: { kind: "system", id: "test-fixture", detail: null },
  venue: { id: "local", kind: "local" },
});

function attachmentIdFor(sessionId: string): string {
  return `test-terminal:${sessionId}`;
}

function detailFor(record: SessionRecord): TerminalAttachmentDetail {
  return {
    kind: "volli.terminal.v1",
    cwd: record.cwd,
    harnessId: record.harnessId,
    activeHarnessId: record.activeHarnessId,
    harnessSessionId: record.harnessSessionId,
    launchKind: record.launchKind,
    placement: record.placement,
    exitCode: record.exitCode,
  };
}

function nextSequence(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
    )
    .get(sessionId) as { sequence: number };
  return row.sequence + 1;
}

function appendEvent(
  db: Database.Database,
  input: {
    id: string;
    sessionId: string;
    occurredAt: number;
    attachmentId: string;
    payload: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO session_events
       (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
     VALUES
       (@id, @sessionId, @sequence, @occurredAt, @recordedAt, @provenance, @attachmentId, NULL, @payload)`,
  ).run({
    ...input,
    sequence: nextSequence(db, input.sessionId),
    recordedAt: input.occurredAt,
    provenance: TEST_PROVENANCE,
    payload: JSON.stringify(input.payload),
  });
}

/** Seeds a terminal attachment as immutable ledger facts for a synchronous legacy test. */
export function insertSession(db: Database.Database, record: SessionRecord): void {
  const attachmentId = attachmentIdFor(record.id);
  const detail = detailFor(record);
  const attachment = {
    id: attachmentId,
    sessionId: record.id,
    adapterId: "terminal",
    venue: { id: "local", kind: "local" as const },
    continuity: "fresh" as const,
    native: terminalNativeReference(detail),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
       VALUES (@id, @projectId, @ticketId, @title, @createdAt)`,
    ).run(record);
    db.prepare(
      `INSERT INTO session_attachments
         (id, session_id, adapter_id, venue_id, venue_kind, continuity, native_id,
          native_detail, observed_kind, failure, created_sequence)
       VALUES
         (@id, @sessionId, 'terminal', 'local', 'local', 'fresh', @nativeId,
          @nativeDetail, 'opened', NULL, 1)`,
    ).run({
      id: attachmentId,
      sessionId: record.id,
      nativeId: detail.harnessSessionId,
      nativeDetail: JSON.stringify(detail),
    });
    appendEvent(db, {
      id: `test-opened:${record.id}`,
      sessionId: record.id,
      occurredAt: record.createdAt,
      attachmentId,
      payload: { kind: "attachment.opened", attachment },
    });
    if (record.endedAt !== null) {
      appendEvent(db, {
        id: `test-closed:${record.id}`,
        sessionId: record.id,
        occurredAt: record.endedAt,
        attachmentId,
        payload: { kind: "attachment.closed", attachmentId, outcome: "completed" },
      });
    }
  })();
}

interface SessionRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  title: string | null;
  created_at: number;
}

interface AttachmentRow {
  id: string;
  native_id: string | null;
  native_detail: string | null;
  observed_kind: "opened" | "failed";
  failure: string | null;
}

function latestNativeReference(
  db: Database.Database,
  sessionId: string,
  attachment: AttachmentRow,
): SessionNativeReference | null {
  const event = db
    .prepare(
      `SELECT payload FROM session_events
        WHERE session_id = ? AND attachment_id = ?
          AND json_extract(payload, '$.kind') = 'attachment.native_referenced'
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(sessionId, attachment.id) as { payload: string } | undefined;
  if (event) {
    const payload = JSON.parse(event.payload) as { native?: SessionNativeReference };
    return payload.native ?? null;
  }
  return attachment.native_detail === null
    ? null
    : {
        id: attachment.native_id,
        detail: JSON.parse(attachment.native_detail) as TerminalAttachmentDetail,
      };
}

/** Reads a terminal compatibility DTO by projecting the persisted ledger facts. */
export function getSession(db: Database.Database, sessionId: string): SessionRecord | undefined {
  const session = db
    .prepare("SELECT id, project_id, ticket_id, title, created_at FROM sessions WHERE id = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!session) return undefined;
  const attachment = db
    .prepare(
      `SELECT id, native_id, native_detail, observed_kind, failure
         FROM session_attachments
        WHERE session_id = ? AND adapter_id = 'terminal'
        ORDER BY created_sequence DESC, id DESC LIMIT 1`,
    )
    .get(sessionId) as AttachmentRow | undefined;
  // No terminal attachment means no honest `SessionRecord`, which is exactly
  // what `terminalSessionRecord` now returns null for.
  if (!attachment) return undefined;
  const closed = db
    .prepare(
      `SELECT occurred_at, payload FROM session_events
        WHERE session_id = ? AND attachment_id = ?
          AND json_extract(payload, '$.kind') = 'attachment.closed'
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(sessionId, attachment.id) as { occurred_at: number; payload: string } | undefined;
  const closedPayload = closed
    ? (JSON.parse(closed.payload) as { outcome: "completed" | "failed" | "interrupted" })
    : null;
  const native = latestNativeReference(db, sessionId, attachment);
  const record = terminalSessionRecord({
    session: {
      id: session.id,
      projectId: session.project_id,
      ticketId: session.ticket_id,
      title: session.title,
      createdAt: session.created_at,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [
      {
        id: attachment.id,
        sessionId,
        adapterId: "terminal",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native,
        status: closed ? "closed" : attachment.observed_kind === "failed" ? "failed" : "open",
        openedAt: attachment.observed_kind === "opened" ? session.created_at : null,
        closedAt: closed?.occurred_at ?? null,
        outcome:
          closedPayload?.outcome ?? (attachment.observed_kind === "failed" ? "failed" : null),
        failure: attachment.failure === null ? null : (JSON.parse(attachment.failure) as never),
      },
    ],
    liveExecutor: null,
    attention: { active: [], primary: null },
    capabilities: [],
    interactions: { active: [], resolved: [] },
    signal: null,
    modelSelection: null,
    turnActive: false,
    lastActivityAt: session.created_at,
    // This helper reads the ledger tables directly rather than replaying
    // `session.created` (see the module doc comment) — the live `ticket_id`
    // is the best available stand-in for the immutable birth fact here, same
    // simplification `lastActivityAt` above already makes.
    bornTicketless: session.ticket_id === null,
  });
  return record ?? undefined;
}

export function listSessions(db: Database.Database, projectId: string): SessionRecord[] {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY created_at DESC, id DESC")
    .all(projectId) as Array<{ id: string }>;
  return rows.flatMap((row) => {
    const session = getSession(db, row.id);
    return session ? [session] : [];
  });
}

export function listTicketSessions(db: Database.Database, ticketId: string): SessionRecord[] {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE ticket_id = ? ORDER BY created_at DESC, id DESC")
    .all(ticketId) as Array<{ id: string }>;
  return rows.flatMap((row) => {
    const session = getSession(db, row.id);
    return session ? [session] : [];
  });
}

function updateNative(
  db: Database.Database,
  sessionId: string,
  update: (detail: TerminalAttachmentDetail) => TerminalAttachmentDetail,
  occurredAt: number,
): void {
  const current = getSession(db, sessionId);
  if (!current) return;
  const attachmentId = attachmentIdFor(sessionId);
  const detail = update(detailFor(current));
  appendEvent(db, {
    id: `test-native:${sessionId}:${nextSequence(db, sessionId)}`,
    sessionId,
    occurredAt,
    attachmentId,
    payload: {
      kind: "attachment.native_referenced",
      attachmentId,
      native: terminalNativeReference(detail),
    },
  });
}

export function setActiveHarnessId(
  db: Database.Database,
  sessionId: string,
  harnessId: string,
): void {
  updateNative(db, sessionId, (detail) => ({ ...detail, activeHarnessId: harnessId as never }), 0);
}

export function endSession(
  db: Database.Database,
  sessionId: string,
  endedAt: number,
  exitCode: number | null,
): void {
  const current = getSession(db, sessionId);
  if (!current) return;
  const attachmentId = attachmentIdFor(sessionId);
  updateNative(db, sessionId, (detail) => ({ ...detail, exitCode }), endedAt);
  const closed = db
    .prepare(
      `SELECT 1 FROM session_events
        WHERE session_id = ? AND attachment_id = ?
          AND json_extract(payload, '$.kind') = 'attachment.closed' LIMIT 1`,
    )
    .get(sessionId, attachmentId);
  if (!closed) {
    appendEvent(db, {
      id: `test-closed:${sessionId}`,
      sessionId,
      occurredAt: endedAt,
      attachmentId,
      payload: { kind: "attachment.closed", attachmentId, outcome: "completed" },
    });
  }
}
