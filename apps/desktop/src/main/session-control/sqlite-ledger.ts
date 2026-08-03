import type Database from "better-sqlite3";
import type {
  CommandReceipt,
  CommandReceiptResult,
  ListSessionEventsQuery,
  ListLatestTicketSignalsQuery,
  ListSessionsQuery,
  LatestSessionSignal,
  Session,
  SessionAttachment,
  SessionAttachmentFailure,
  SessionCommand,
  SessionCommandIntent,
  SessionCommandRoute,
  SessionEvent,
  SessionEventPayload,
  SessionEventProvenance,
  SessionLedger,
  SessionLedgerTransaction,
  SessionNativeDetail,
} from "@volli/shared";
import { isSessionAttachmentContinuity, sameCommandReceipt } from "@volli/shared";

type SqlRow = Record<string, unknown>;

/**
 * The desktop's sole durable Session writer.  Although better-sqlite3 is
 * synchronous, a Session Engine transaction may await host work, so this queue
 * holds BEGIN IMMEDIATE ownership across that await and never lets a second
 * ledger operation observe a partial fact set.
 */
export class SqliteSessionLedger implements SessionLedger {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: (transaction: SessionLedgerTransaction) => Promise<T> | T): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec("BEGIN IMMEDIATE");
      let open = true;
      const transaction = new SqliteSessionLedgerTransaction(this.db, () => open);
      try {
        const value = await work(transaction);
        transaction.assertReceiptEventPairs();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The original failure carries the useful error. A failed rollback
          // only happens after SQLite already abandoned the transaction.
        }
        throw error;
      } finally {
        open = false;
      }
    };
    const queued = this.#tail.then(run, run);
    this.#tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

export function createSqliteSessionLedger(db: Database.Database): SessionLedger {
  return new SqliteSessionLedger(db);
}

class SqliteSessionLedgerTransaction implements SessionLedgerTransaction {
  readonly #touchedSessionIds = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly isOpen: () => boolean,
  ) {}

  getSession(sessionId: string): Session | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, project_id, ticket_id, title, created_at FROM sessions WHERE id = ?")
      .get(sessionId) as unknown;
    return row === undefined ? null : decodeSession(row, "sessions row");
  }

  listSessions(query: ListSessionsQuery): readonly Session[] {
    this.assertOpen();
    const scope =
      query.scope === "ticket"
        ? " AND ticket_id = @ticketId"
        : query.scope === "scratch"
          ? " AND ticket_id IS NULL"
          : "";
    const rows = this.db
      .prepare(
        `SELECT id, project_id, ticket_id, title, created_at
           FROM sessions
          WHERE project_id = @projectId${scope}
          ORDER BY created_at DESC, id COLLATE BINARY DESC`,
      )
      .all(query.scope === "ticket" ? query : { projectId: query.projectId }) as unknown[];
    return rows.map((row) => decodeSession(row, "sessions row"));
  }

  countSessions(query: ListSessionsQuery): number {
    this.assertOpen();
    const scope =
      query.scope === "ticket"
        ? " AND ticket_id = @ticketId"
        : query.scope === "scratch"
          ? " AND ticket_id IS NULL"
          : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sessions
          WHERE project_id = @projectId${scope}`,
      )
      .get(query.scope === "ticket" ? query : { projectId: query.projectId }) as unknown;
    return readInteger(rowValue(row, "count", "session count"), "session count");
  }

  listLatestTicketSignals(query: ListLatestTicketSignalsQuery): readonly LatestSessionSignal[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `WITH latest_session_signals AS (
           SELECT s.ticket_id AS ticket_id,
                  s.id AS session_id,
                  json_extract(e.payload, '$.signal') AS signal,
                  json_extract(e.payload, '$.reason') AS reason,
                  e.occurred_at AS occurred_at,
                  ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY e.sequence DESC) AS session_rank
             FROM sessions s
             JOIN session_events e ON e.session_id = s.id
            WHERE s.project_id = @projectId
              AND s.ticket_id IS NOT NULL
              AND json_extract(e.payload, '$.kind') = 'session.signaled'
              AND json_extract(e.payload, '$.signal') IN ('done', 'blocked')
         ), latest_ticket_signals AS (
           SELECT ticket_id,
                  session_id,
                  signal,
                  reason,
                  occurred_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY ticket_id
                    ORDER BY occurred_at DESC, session_id COLLATE BINARY DESC
                  ) AS ticket_rank
             FROM latest_session_signals
            WHERE session_rank = 1
         )
         SELECT ticket_id, session_id, signal, reason, occurred_at
           FROM latest_ticket_signals
          WHERE ticket_rank = 1
          ORDER BY ticket_id COLLATE BINARY ASC`,
      )
      .all(query) as unknown[];
    return rows.map((row) => {
      const value = asRecord(row, "latest ticket signal row");
      return {
        ticketId: readString(value.ticket_id, "latest ticket signal row.ticket_id"),
        sessionId: readString(value.session_id, "latest ticket signal row.session_id"),
        signal: enumValue(value.signal, ["done", "blocked"], "latest ticket signal row.signal"),
        reason: readNullableString(value.reason, "latest ticket signal row.reason"),
        createdAt: readInteger(value.occurred_at, "latest ticket signal row.occurred_at"),
      };
    });
  }

  insertSession(session: Session): void {
    this.assertOpen();
    assertSession(session, "Session");
    this.assertGloballyUnusedId(session.id);
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
         VALUES (@id, @projectId, @ticketId, @title, @createdAt)`,
      )
      .run(session);
  }

  getEvent(eventId: string): SessionEvent | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT id, session_id, sequence, occurred_at, recorded_at, provenance,
                attachment_id, command_id, payload
           FROM session_events WHERE id = ?`,
      )
      .get(eventId) as unknown;
    return row === undefined ? null : decodeEvent(row, "session_events row");
  }

  appendEvent(event: SessionEvent): void {
    this.assertOpen();
    assertEvent(event, "Session event");
    this.#touchedSessionIds.add(event.sessionId);
    this.assertGloballyUnusedId(event.id);
    const prior = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
      )
      .get(event.sessionId) as unknown;
    const previousSequence = readInteger(
      rowValue(prior, "sequence", "event sequence"),
      "event sequence",
    );
    if (event.sequence !== previousSequence + 1) {
      throw new Error(`Session ${event.sessionId} event sequence must be monotonic`);
    }
    this.insertAttachmentEvidence(event);
    this.assertEventForeignKeys(event);
    this.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
         VALUES
           (@id, @sessionId, @sequence, @occurredAt, @recordedAt, @provenance, @attachmentId, @commandId, @payload)`,
      )
      .run({
        id: event.id,
        sessionId: event.sessionId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        provenance: encodeJson(event.provenance),
        attachmentId: event.attachmentId ?? null,
        commandId: event.commandId ?? null,
        payload: encodeJson(event.payload),
      });
    if (event.payload.kind === "command.receipt.recorded") {
      const receipt = this.getReceipt(event.payload.receipt.id);
      if (!receipt || !sameCommandReceipt(receipt, event.payload.receipt)) {
        throw new Error(`Receipt ${event.payload.receipt.id} does not match its event`);
      }
      const linked = this.db
        .prepare(
          `UPDATE session_command_receipts
              SET receipt_event_id = @eventId
            WHERE id = @receiptId
              AND session_id = @sessionId
              AND command_id = @commandId
              AND sequence = @sequence
              AND recorded_at = @recordedAt`,
        )
        .run({
          eventId: event.id,
          receiptId: receipt.id,
          sessionId: event.sessionId,
          commandId: receipt.commandId,
          sequence: event.sequence,
          recordedAt: event.recordedAt,
        });
      if (linked.changes !== 1) {
        throw new Error(`Receipt ${receipt.id} cannot be linked to event ${event.id}`);
      }
    }
  }

  listEvents(query: ListSessionEventsQuery): readonly SessionEvent[] {
    this.assertOpen();
    const afterSequence = query.afterSequence ?? 0;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event pagination cursor must be a non-negative integer");
    }
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      throw new Error("Event pagination limit must be a non-negative integer");
    }
    const limit = query.limit === undefined ? "" : " LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, sequence, occurred_at, recorded_at, provenance,
                attachment_id, command_id, payload
           FROM session_events
          WHERE session_id = @sessionId AND sequence > @afterSequence
          ORDER BY sequence ASC${limit}`,
      )
      .all({ sessionId: query.sessionId, afterSequence, limit: query.limit }) as unknown[];
    return rows.map((row) => decodeEvent(row, "session_events row"));
  }

  getCommand(commandId: string): SessionCommand | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT id, session_id, created_at, intent, route FROM session_commands WHERE id = ?",
      )
      .get(commandId) as unknown;
    return row === undefined ? null : decodeCommand(row, "session_commands row");
  }

  saveCommand(command: SessionCommand): void {
    this.assertOpen();
    assertCommand(command, "Session command");
    this.assertGloballyUnusedId(command.id);
    this.db
      .prepare(
        `INSERT INTO session_commands (id, session_id, created_at, intent, route)
         VALUES (@id, @sessionId, @createdAt, @intent, @route)`,
      )
      .run({
        id: command.id,
        sessionId: command.sessionId,
        createdAt: command.createdAt,
        intent: encodeJson(command.intent),
        route: command.route === null ? null : encodeJson(command.route),
      });
  }

  getReceipt(receiptId: string): CommandReceipt | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT id, session_id, command_id, sequence, recorded_at, receipt
           FROM session_command_receipts WHERE id = ?`,
      )
      .get(receiptId) as unknown;
    return row === undefined ? null : decodeReceiptRow(row, "session_command_receipts row");
  }

  listReceipts(commandId: string): readonly CommandReceipt[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `SELECT id, session_id, command_id, sequence, recorded_at, receipt
           FROM session_command_receipts
          WHERE command_id = ?
          ORDER BY sequence ASC, id COLLATE BINARY ASC`,
      )
      .all(commandId) as unknown[];
    return rows.map((row) => decodeReceiptRow(row, "session_command_receipts row"));
  }

  appendReceipt(receipt: CommandReceipt): void {
    this.assertOpen();
    assertReceipt(receipt, "Command receipt");
    this.assertGloballyUnusedId(receipt.id);
    const command = this.getCommand(receipt.commandId);
    if (!command) throw new Error(`Command ${receipt.commandId} was not found`);
    this.#touchedSessionIds.add(command.sessionId);
    this.db
      .prepare(
        `INSERT INTO session_command_receipts
           (id, session_id, command_id, sequence, recorded_at, receipt)
         VALUES (@id, @sessionId, @commandId, @sequence, @recordedAt, @receipt)`,
      )
      .run({
        id: receipt.id,
        sessionId: command.sessionId,
        commandId: receipt.commandId,
        sequence: receipt.sequence,
        recordedAt: receipt.recordedAt,
        receipt: encodeJson(receipt),
      });
  }

  /** Called at the transaction boundary, after every append has happened. */
  assertReceiptEventPairs(): void {
    this.assertOpen();
    for (const sessionId of this.#touchedSessionIds) {
      const unpaired = this.db
        .prepare(
          `SELECT r.id
             FROM session_command_receipts r
             JOIN session_commands c ON c.id = r.command_id
             LEFT JOIN session_events e ON e.id = r.receipt_event_id
            WHERE r.session_id = @sessionId
              AND (r.receipt_event_id IS NULL
                   OR e.id IS NULL
                   OR e.session_id <> r.session_id
                   OR c.session_id <> r.session_id
                   OR e.command_id <> r.command_id
                   OR e.sequence <> r.sequence
                   OR e.recorded_at <> r.recorded_at)
            LIMIT 1`,
        )
        .get({ sessionId }) as unknown;
      if (unpaired !== undefined) {
        throw new Error(
          `Receipt ${readString(rowValue(unpaired, "id", "receipt"), "receipt id")} has no matching event`,
        );
      }
      const orphanEvent = this.db
        .prepare(
          `SELECT e.id
             FROM session_events e
             LEFT JOIN session_command_receipts r
               ON r.id = json_extract(e.payload, '$.receipt.id')
            WHERE e.session_id = @sessionId
              AND json_extract(e.payload, '$.kind') = 'command.receipt.recorded'
              AND (r.id IS NULL OR r.session_id <> e.session_id OR r.command_id <> e.command_id)
            LIMIT 1`,
        )
        .get({ sessionId }) as unknown;
      if (orphanEvent !== undefined) {
        throw new Error(
          `Receipt event ${readString(rowValue(orphanEvent, "id", "receipt event"), "receipt event id")} has no matching receipt`,
        );
      }
    }
  }

  private insertAttachmentEvidence(event: SessionEvent): void {
    const payload = event.payload;
    if (payload.kind !== "attachment.opened" && payload.kind !== "attachment.failed") return;
    const attachment = payload.attachment;
    if (attachment.sessionId !== event.sessionId) {
      throw new Error(`Attachment ${attachment.id} belongs to another Session`);
    }
    const existing = this.db
      .prepare("SELECT id FROM session_attachments WHERE id = ?")
      .get(attachment.id) as unknown;
    if (existing !== undefined) throw new Error(`Attachment ${attachment.id} already exists`);
    this.db
      .prepare(
        `INSERT INTO session_attachments
           (id, session_id, adapter_id, venue_id, venue_kind, continuity, native_id,
            native_detail, observed_kind, failure, created_sequence)
         VALUES
           (@id, @sessionId, @adapterId, @venueId, @venueKind, @continuity, @nativeId,
            @nativeDetail, @observedKind, @failure, @createdSequence)`,
      )
      .run({
        id: attachment.id,
        sessionId: attachment.sessionId,
        adapterId: attachment.adapterId,
        venueId: attachment.venue.id,
        venueKind: attachment.venue.kind,
        continuity: attachment.continuity,
        nativeId: attachment.native?.id ?? null,
        nativeDetail: attachment.native === null ? null : encodeJson(attachment.native.detail),
        observedKind: payload.kind === "attachment.opened" ? "opened" : "failed",
        failure: payload.kind === "attachment.failed" ? encodeJson(payload.failure) : null,
        createdSequence: event.sequence,
      });
  }

  private assertEventForeignKeys(event: SessionEvent): void {
    if (event.attachmentId !== null && event.attachmentId !== undefined) {
      const attachment = this.db
        .prepare("SELECT session_id FROM session_attachments WHERE id = ?")
        .get(event.attachmentId) as unknown;
      if (attachment === undefined)
        throw new Error(`Attachment ${event.attachmentId} was not found`);
      if (rowValue(attachment, "session_id", "attachment") !== event.sessionId) {
        throw new Error(`Attachment ${event.attachmentId} belongs to another Session`);
      }
    }
    if (event.commandId !== null && event.commandId !== undefined) {
      const command = this.getCommand(event.commandId);
      if (!command) throw new Error(`Command ${event.commandId} was not found`);
      if (command.sessionId !== event.sessionId) {
        throw new Error(`Command ${event.commandId} belongs to another Session`);
      }
    }
  }

  private assertGloballyUnusedId(id: string): void {
    const row = this.db
      .prepare(
        `SELECT id FROM sessions WHERE id = @id
         UNION ALL SELECT id FROM session_attachments WHERE id = @id
         UNION ALL SELECT id FROM session_commands WHERE id = @id
         UNION ALL SELECT id FROM session_events WHERE id = @id
         UNION ALL SELECT id FROM session_command_receipts WHERE id = @id
         LIMIT 1`,
      )
      .get({ id }) as unknown;
    if (row !== undefined) throw new Error(`Ledger id ${id} already exists`);
  }

  private assertOpen(): void {
    if (!this.isOpen()) throw new Error("Session ledger transaction is closed");
  }
}

function decodeSession(row: unknown, context: string): Session {
  const value = asRecord(row, context);
  const session: Session = {
    id: readString(value.id, `${context}.id`),
    projectId: readString(value.project_id, `${context}.project_id`),
    ticketId: readNullableString(value.ticket_id, `${context}.ticket_id`),
    title: readNullableString(value.title, `${context}.title`),
    createdAt: readInteger(value.created_at, `${context}.created_at`),
  };
  assertSession(session, context);
  return session;
}

function decodeCommand(row: unknown, context: string): SessionCommand {
  const value = asRecord(row, context);
  const command: SessionCommand = {
    id: readString(value.id, `${context}.id`),
    sessionId: readString(value.session_id, `${context}.session_id`),
    createdAt: readInteger(value.created_at, `${context}.created_at`),
    intent: decodeIntent(parseJson(value.intent, `${context}.intent`), `${context}.intent`),
    route:
      value.route === null
        ? null
        : decodeRoute(parseJson(value.route, `${context}.route`), `${context}.route`),
  };
  assertCommand(command, context);
  return command;
}

function decodeReceiptRow(row: unknown, context: string): CommandReceipt {
  const value = asRecord(row, context);
  const receipt = decodeReceipt(
    parseJson(value.receipt, `${context}.receipt`),
    `${context}.receipt`,
  );
  const id = readString(value.id, `${context}.id`);
  const commandId = readString(value.command_id, `${context}.command_id`);
  const sequence = readInteger(value.sequence, `${context}.sequence`);
  const recordedAt = readInteger(value.recorded_at, `${context}.recorded_at`);
  if (
    receipt.id !== id ||
    receipt.commandId !== commandId ||
    receipt.sequence !== sequence ||
    receipt.recordedAt !== recordedAt
  ) {
    throw new Error(`${context} columns do not match receipt JSON`);
  }
  return receipt;
}

function decodeEvent(row: unknown, context: string): SessionEvent {
  const value = asRecord(row, context);
  const attachmentId = readNullableString(value.attachment_id, `${context}.attachment_id`);
  const commandId = readNullableString(value.command_id, `${context}.command_id`);
  const event: SessionEvent = {
    id: readString(value.id, `${context}.id`),
    sessionId: readString(value.session_id, `${context}.session_id`),
    sequence: readInteger(value.sequence, `${context}.sequence`),
    occurredAt: readInteger(value.occurred_at, `${context}.occurred_at`),
    recordedAt: readInteger(value.recorded_at, `${context}.recorded_at`),
    provenance: decodeProvenance(
      parseJson(value.provenance, `${context}.provenance`),
      `${context}.provenance`,
    ),
    payload: decodePayload(parseJson(value.payload, `${context}.payload`), `${context}.payload`),
  };
  if (attachmentId !== null) event.attachmentId = attachmentId;
  if (commandId !== null) event.commandId = commandId;
  assertEvent(event, context);
  return event;
}

function decodePayload(value: unknown, context: string): SessionEventPayload {
  const record = asRecord(value, context);
  const kind = readString(record.kind, `${context}.kind`);
  switch (kind) {
    case "command.recorded":
      return { kind, command: decodeCommandValue(record.command, `${context}.command`) };
    case "session.created":
      return { kind, session: decodeSessionValue(record.session, `${context}.session`) };
    case "session.archived":
      return { kind };
    case "session.retitled":
      return { kind, title: readNullableString(record.title, `${context}.title`) };
    case "session.signaled":
      return {
        kind,
        signal: enumValue(record.signal, ["done", "blocked"], `${context}.signal`),
        reason: readNullableString(record.reason, `${context}.reason`),
      };
    case "attachment.opened":
      return { kind, attachment: decodeAttachment(record.attachment, `${context}.attachment`) };
    case "attachment.native_referenced":
      return {
        kind,
        attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
        native: decodeNative(record.native, `${context}.native`),
      };
    case "attachment.failed":
      return {
        kind,
        attachment: decodeAttachment(record.attachment, `${context}.attachment`),
        failure: decodeFailure(record.failure, `${context}.failure`),
      };
    case "attachment.closed":
      return {
        kind,
        attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
        outcome: enumValue(
          record.outcome,
          ["completed", "failed", "interrupted"],
          `${context}.outcome`,
        ),
      };
    case "run.started":
    case "run.completed":
      return {
        kind,
        attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
        runId: readString(record.runId, `${context}.runId`),
      };
    case "turn.started":
    case "turn.completed":
      return {
        kind,
        attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
        turnId: readString(record.turnId, `${context}.turnId`),
      };
    case "transcript.referenced":
      return {
        kind,
        attachmentId: readNullableString(record.attachmentId, `${context}.attachmentId`),
        turnId: readNullableString(record.turnId, `${context}.turnId`),
        reference: decodeTranscript(record.reference, `${context}.reference`),
      };
    case "attention.raised":
      return { kind, attention: decodeAttention(record.attention, `${context}.attention`) };
    case "attention.cleared":
      return { kind, attentionId: readString(record.attentionId, `${context}.attentionId`) };
    case "capabilities.updated":
      return {
        kind,
        snapshot: decodeCapabilitySnapshot(record.snapshot, `${context}.snapshot`),
      };
    case "interaction.opened":
      return {
        kind,
        interaction: decodeInteraction(record.interaction, `${context}.interaction`),
      };
    case "interaction.resolved":
      return {
        kind,
        attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
        interactionId: readString(record.interactionId, `${context}.interactionId`),
        resolution: decodeInteractionResolution(record.resolution, `${context}.resolution`),
      };
    case "command.receipt.recorded":
      return { kind, receipt: decodeReceipt(record.receipt, `${context}.receipt`) };
    case "adapter.observed":
      return {
        kind,
        attachmentId: readNullableString(record.attachmentId, `${context}.attachmentId`),
        name: readString(record.name, `${context}.name`),
        native: decodeNativeDetail(record.native, `${context}.native`),
      };
    default:
      throw new Error(`${context}.kind is not a known Session event payload`);
  }
}

function decodeSessionValue(value: unknown, context: string): Session {
  const row = asRecord(value, context);
  const session: Session = {
    id: readString(row.id, `${context}.id`),
    projectId: readString(row.projectId, `${context}.projectId`),
    ticketId: readNullableString(row.ticketId, `${context}.ticketId`),
    title: readNullableString(row.title, `${context}.title`),
    createdAt: readInteger(row.createdAt, `${context}.createdAt`),
  };
  assertSession(session, context);
  return session;
}

function decodeCommandValue(value: unknown, context: string): SessionCommand {
  const row = asRecord(value, context);
  const command: SessionCommand = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    createdAt: readInteger(row.createdAt, `${context}.createdAt`),
    intent: decodeIntent(row.intent, `${context}.intent`),
    route: row.route === null ? null : decodeRoute(row.route, `${context}.route`),
  };
  assertCommand(command, context);
  return command;
}

function decodeIntent(value: unknown, context: string): SessionCommandIntent {
  const row = asRecord(value, context);
  const kind = readString(row.kind, `${context}.kind`);
  switch (kind) {
    case "session.create":
      return {
        kind,
        projectId: readString(row.projectId, `${context}.projectId`),
        ticketId: readNullableString(row.ticketId, `${context}.ticketId`),
        title: readNullableString(row.title, `${context}.title`),
      };
    case "session.archive":
      return { kind };
    case "session.retitle":
      return { kind, title: readNullableString(row.title, `${context}.title`) };
    case "session.signal":
      return {
        kind,
        signal: enumValue(row.signal, ["done", "blocked"], `${context}.signal`),
        reason: readNullableString(row.reason, `${context}.reason`),
      };
    case "executor.start":
      return {
        kind,
        adapterId: readString(row.adapterId, `${context}.adapterId`),
        continuity: enumValue(
          row.continuity,
          ["fresh", "native_resume", "context_replay", "recreate"],
          `${context}.continuity`,
        ),
      };
    case "executor.stop":
    case "executor.interrupt":
      return { kind, attachmentId: readString(row.attachmentId, `${context}.attachmentId`) };
    case "message.submit":
      return { kind, reference: decodeTranscript(row.reference, `${context}.reference`) };
    case "interaction.resolve":
      return {
        kind,
        attachmentId: readString(row.attachmentId, `${context}.attachmentId`),
        interactionId: readString(row.interactionId, `${context}.interactionId`),
        resolution: decodeInteractionResolution(row.resolution, `${context}.resolution`),
        reference: decodeTranscript(row.reference, `${context}.reference`),
      };
    default:
      throw new Error(`${context}.kind is not a known Session command`);
  }
}

function decodeRoute(value: unknown, context: string): SessionCommandRoute {
  const row = asRecord(value, context);
  return {
    adapterId: readString(row.adapterId, `${context}.adapterId`),
    attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`),
  };
}

function decodeReceipt(value: unknown, context: string): CommandReceipt {
  const row = asRecord(value, context);
  const base = {
    id: readString(row.id, `${context}.id`),
    commandId: readString(row.commandId, `${context}.commandId`),
    sequence: readInteger(row.sequence, `${context}.sequence`),
    recordedAt: readInteger(row.recordedAt, `${context}.recordedAt`),
  };
  const status = readString(row.status, `${context}.status`);
  if (status === "accepted") {
    return {
      ...base,
      status,
      acceptedAt: readInteger(row.acceptedAt, `${context}.acceptedAt`),
      result: decodeReceiptResult(row.result, `${context}.result`),
    };
  }
  if (status === "rejected") {
    return {
      ...base,
      status,
      code: readString(row.code, `${context}.code`),
      detail: readNullableString(row.detail, `${context}.detail`),
    };
  }
  if (status === "completed") {
    return { ...base, status, result: decodeReceiptResult(row.result, `${context}.result`) };
  }
  if (status === "unreconciled") {
    return { ...base, status, detail: readNullableString(row.detail, `${context}.detail`) };
  }
  throw new Error(`${context}.status is not a known receipt status`);
}

function decodeReceiptResult(value: unknown, context: string): CommandReceiptResult {
  const row = asRecord(value, context);
  const kind = enumValue(
    row.kind,
    [
      "session.created",
      "session.archived",
      "session.retitled",
      "session.signaled",
      "executor.start.requested",
      "executor.stop.requested",
      "executor.interrupted",
      "message.submitted",
      "interaction.resolved",
    ],
    `${context}.kind`,
  );
  return { kind, sessionId: readString(row.sessionId, `${context}.sessionId`) };
}

function decodeAttachment(value: unknown, context: string): SessionAttachment {
  const row = asRecord(value, context);
  const venue = asRecord(row.venue, `${context}.venue`);
  const attachment: SessionAttachment = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    adapterId: readString(row.adapterId, `${context}.adapterId`),
    venue: {
      id: readString(venue.id, `${context}.venue.id`),
      kind: enumValue(venue.kind, ["local", "cloud", "remote", "unknown"], `${context}.venue.kind`),
    },
    continuity: enumValue(
      row.continuity,
      ["fresh", "native_resume", "context_replay", "recreate"],
      `${context}.continuity`,
    ),
    native: row.native === null ? null : decodeNative(row.native, `${context}.native`),
  };
  assertAttachment(attachment, context);
  return attachment;
}

function decodeNative(
  value: unknown,
  context: string,
): { id: string | null; detail: SessionNativeDetail | null } {
  const row = asRecord(value, context);
  return {
    id: readNullableString(row.id, `${context}.id`),
    detail: decodeNativeDetail(row.detail, `${context}.detail`),
  };
}

function decodeFailure(value: unknown, context: string): SessionAttachmentFailure {
  const row = asRecord(value, context);
  return {
    code: readString(row.code, `${context}.code`),
    detail: readNullableString(row.detail, `${context}.detail`),
    diagnostic: decodeNativeDetail(row.diagnostic, `${context}.diagnostic`),
  };
}

function decodeTranscript(
  value: unknown,
  context: string,
): { id: string; mediaType: string | null; digest: string | null } {
  const row = asRecord(value, context);
  return {
    id: readString(row.id, `${context}.id`),
    mediaType: readNullableString(row.mediaType, `${context}.mediaType`),
    digest: readNullableString(row.digest, `${context}.digest`),
  };
}

function decodeAttention(
  value: unknown,
  context: string,
): Extract<SessionEventPayload, { kind: "attention.raised" }>["attention"] {
  const row = asRecord(value, context);
  const kind = enumValue(
    row.kind,
    [
      "input_required",
      "permission_required",
      "auth_required",
      "configuration_invalid",
      "rate_limited",
      "quota_exhausted",
      "context_limit_reached",
      "transport_retrying",
      "partial_turn_interrupted",
      "adapter_disconnected",
      "adapter_unrecoverable",
    ],
    `${context}.kind`,
  );
  const base = {
    id: readString(row.id, `${context}.id`),
    attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`),
    detail: readNullableString(row.detail, `${context}.detail`),
    diagnostic: decodeNativeDetail(row.diagnostic, `${context}.diagnostic`),
  };
  if (kind === "rate_limited") {
    return { ...base, kind, retryAt: readNullableInteger(row.retryAt, `${context}.retryAt`) };
  }
  if (kind === "quota_exhausted") {
    return { ...base, kind, resetAt: readNullableInteger(row.resetAt, `${context}.resetAt`) };
  }
  return { ...base, kind };
}

function decodeCapabilitySnapshot(
  value: unknown,
  context: string,
): Extract<SessionEventPayload, { kind: "capabilities.updated" }>["snapshot"] {
  const row = asRecord(value, context);
  if (!Array.isArray(row.features)) throw new Error(`${context}.features must be an array`);
  if (!Array.isArray(row.catalog)) throw new Error(`${context}.catalog must be an array`);
  return {
    id: readString(row.id, `${context}.id`),
    adapterId: readString(row.adapterId, `${context}.adapterId`),
    attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`),
    profileId: readString(row.profileId, `${context}.profileId`),
    revision: readInteger(row.revision, `${context}.revision`),
    observedAt: readInteger(row.observedAt, `${context}.observedAt`),
    expiresAt: readNullableInteger(row.expiresAt, `${context}.expiresAt`),
    features: row.features.map((item, index) => {
      const feature = asRecord(item, `${context}.features[${index}]`);
      return {
        id: readString(feature.id, `${context}.features[${index}].id`),
        state: enumValue(
          feature.state,
          ["available", "unavailable", "unknown"],
          `${context}.features[${index}].state`,
        ),
        evidence: enumValue(
          feature.evidence,
          ["declared", "reported", "observed", "verified"],
          `${context}.features[${index}].evidence`,
        ),
        detail: readNullableString(feature.detail, `${context}.features[${index}].detail`),
      };
    }),
    catalog: row.catalog.map((item, index) => {
      const entry = asRecord(item, `${context}.catalog[${index}]`);
      return {
        kind: enumValue(
          entry.kind,
          ["model", "agent", "command", "mcp", "skill", "tool"],
          `${context}.catalog[${index}].kind`,
        ),
        id: readString(entry.id, `${context}.catalog[${index}].id`),
        label: readString(entry.label, `${context}.catalog[${index}].label`),
        state: enumValue(
          entry.state,
          ["available", "unavailable", "unknown"],
          `${context}.catalog[${index}].state`,
        ),
        evidence: enumValue(
          entry.evidence,
          ["declared", "reported", "observed", "verified"],
          `${context}.catalog[${index}].evidence`,
        ),
        detail: decodeNativeDetail(entry.detail, `${context}.catalog[${index}].detail`),
      };
    }),
  };
}

function decodeInteraction(
  value: unknown,
  context: string,
): Extract<SessionEventPayload, { kind: "interaction.opened" }>["interaction"] {
  const row = asRecord(value, context);
  if (!Array.isArray(row.options)) throw new Error(`${context}.options must be an array`);
  return {
    id: readString(row.id, `${context}.id`),
    attachmentId: readString(row.attachmentId, `${context}.attachmentId`),
    kind: enumValue(row.kind, ["permission", "question"], `${context}.kind`),
    title: readString(row.title, `${context}.title`),
    detail: readNullableString(row.detail, `${context}.detail`),
    options: row.options.map((item, index) => {
      const option = asRecord(item, `${context}.options[${index}]`);
      // Both absences, because both occur. `SessionInteractionOption.description`
      // is `string | null` and every adapter writes the explicit `null` — while
      // events persisted before that contract simply omit the key. Reading only
      // `undefined` as absent threw on the null, which killed the whole
      // `interaction.opened` event at the persistence boundary: no durable
      // interaction, an always-empty `projection.interactions`, and an approval
      // nothing could ever resolve. The throw surfaced nowhere, so the gate
      // still drew its buttons from the adapter's in-memory state and simply
      // did not respond.
      const description = readAbsentableString(
        option.description,
        `${context}.options[${index}].description`,
      );
      return {
        id: readString(option.id, `${context}.options[${index}].id`),
        label: readString(option.label, `${context}.options[${index}].label`),
        description,
      };
    }),
    multiple: readBoolean(row.multiple, `${context}.multiple`),
    native: decodeNative(row.native, `${context}.native`),
  };
}

function decodeInteractionResolution(
  value: unknown,
  context: string,
): Extract<SessionEventPayload, { kind: "interaction.resolved" }>["resolution"] {
  const row = asRecord(value, context);
  if (!Array.isArray(row.optionIds)) throw new Error(`${context}.optionIds must be an array`);
  return {
    optionIds: row.optionIds.map((item, index) =>
      readString(item, `${context}.optionIds[${index}]`),
    ),
    response: readNullableString(row.response, `${context}.response`),
  };
}

function decodeProvenance(value: unknown, context: string): SessionEventProvenance {
  const row = asRecord(value, context);
  const source = asRecord(row.source, `${context}.source`);
  const venue = row.venue === null ? null : asRecord(row.venue, `${context}.venue`);
  return {
    source: {
      kind: enumValue(source.kind, ["user", "adapter", "system"], `${context}.source.kind`),
      id: readString(source.id, `${context}.source.id`),
      detail: decodeNativeDetail(source.detail, `${context}.source.detail`),
    },
    venue:
      venue === null
        ? null
        : {
            id: readString(venue.id, `${context}.venue.id`),
            kind: enumValue(
              venue.kind,
              ["local", "cloud", "remote", "unknown"],
              `${context}.venue.kind`,
            ),
          },
  };
}

function assertSession(value: Session, context: string): void {
  if (!value.id || !value.projectId || !Number.isInteger(value.createdAt)) {
    throw new Error(`${context} is not a valid Session`);
  }
}

function assertCommand(value: SessionCommand, context: string): void {
  if (!value.id || !value.sessionId || !Number.isInteger(value.createdAt)) {
    throw new Error(`${context} is not a valid Session command`);
  }
  decodeIntent(value.intent, `${context}.intent`);
  if (value.route !== null) decodeRoute(value.route, `${context}.route`);
}

function assertAttachment(value: SessionAttachment, context: string): void {
  if (
    !value.id ||
    !value.sessionId ||
    !value.adapterId ||
    !value.venue.id ||
    !isSessionAttachmentContinuity(value.continuity)
  ) {
    throw new Error(`${context} is not a valid Session attachment`);
  }
  if (value.native !== null) decodeNative(value.native, `${context}.native`);
}

function assertReceipt(value: CommandReceipt, context: string): void {
  decodeReceipt(value, context);
}

function assertEvent(value: SessionEvent, context: string): void {
  if (
    !value.id ||
    !value.sessionId ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isInteger(value.occurredAt) ||
    !Number.isInteger(value.recordedAt)
  ) {
    throw new Error(`${context} has an invalid envelope`);
  }
  decodeProvenance(value.provenance, `${context}.provenance`);
  decodePayload(value.payload, `${context}.payload`);
  if (value.payload.kind === "command.receipt.recorded") {
    if (
      value.commandId !== value.payload.receipt.commandId ||
      value.sequence !== value.payload.receipt.sequence ||
      value.recordedAt !== value.payload.receipt.recordedAt
    ) {
      throw new Error(`${context} receipt envelope does not match receipt`);
    }
  }
}

function parseJson(value: unknown, context: string): unknown {
  if (typeof value !== "string") throw new Error(`${context} must be JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${context} contains invalid JSON`);
  }
}

function encodeJson(value: unknown): string {
  assertJsonValue(value, "JSON value");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSON value cannot be undefined");
  return encoded;
}

function decodeNativeDetail(value: unknown, context: string): SessionNativeDetail | null {
  assertJsonValue(value, context);
  return value as SessionNativeDetail;
}

function assertJsonValue(value: unknown, context: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${context} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${context}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${context}.${key}`);
    return;
  }
  throw new Error(`${context} is not JSON-compatible`);
}

function asRecord(value: unknown, context: string): SqlRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as SqlRow;
}

function rowValue(row: unknown, key: string, context: string): unknown {
  return asRecord(row, context)[key];
}

function readString(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  return value;
}

function readNullableString(value: unknown, context: string): string | null {
  return value === null ? null : readString(value, context);
}

/** Absent either way — an explicit `null` or a key an older event never wrote. */
function readAbsentableString(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : readString(value, context);
}

function readBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function readInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context} must be an integer`);
  }
  return value;
}

function readNullableInteger(value: unknown, context: string): number | null {
  return value === null ? null : readInteger(value, context);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  context: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${context} has an unsupported value`);
  }
  return value as T[number];
}
