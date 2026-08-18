import type Database from "better-sqlite3";
import type {
  CommandReceipt,
  ListSessionEventsQuery,
  ListLatestTicketSignalsQuery,
  ListSessionsQuery,
  LatestSessionSignal,
  Session,
  SessionCommand,
  SessionEvent,
  SessionLedger,
  SessionLedgerTransaction,
} from "@volli/shared";
import {
  assertSession,
  assertSessionEvent,
  decodeCommandReceipt,
  decodeSessionCommandIntent,
  decodeSessionCommandRoute,
  decodeSessionEventPayload,
  decodeSessionEventProvenance,
  encodeSessionJson,
  sameCommandReceipt,
  UnknownSessionEventKindError,
} from "@volli/shared";

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
        : query.scope === "project"
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
        : query.scope === "project"
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
    if (row === undefined) return null;
    try {
      return decodeEvent(row, "session_events row");
    } catch (error) {
      if (error instanceof UnknownSessionEventKindError) return null;
      throw error;
    }
  }

  appendEvent(event: SessionEvent): void {
    this.assertOpen();
    assertSessionEvent(event, "Session event");
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
        provenance: encodeSessionJson(event.provenance),
        attachmentId: event.attachmentId ?? null,
        commandId: event.commandId ?? null,
        payload: encodeSessionJson(event.payload),
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
    const statement = this.db.prepare(
      `SELECT id, session_id, sequence, occurred_at, recorded_at, provenance,
              attachment_id, command_id, payload
         FROM session_events
        WHERE session_id = @sessionId AND sequence > @afterSequence
        ORDER BY sequence ASC${query.limit === undefined ? "" : " LIMIT @limit"}`,
    );
    const decoded: SessionEvent[] = [];
    let dropped = 0;
    const retiredKinds = new Set<string>();
    // The limit counts events this build can return, not rows SQLite matched.
    // A page made entirely of retired kinds would otherwise come back empty
    // while later history still existed, and callers advance their cursor from
    // the last event they were handed — so an empty page reads as "the end"
    // and silently truncates the Session. Keep pulling until the page is full
    // or the rows run out.
    const wanted = query.limit;
    let cursor = afterSequence;
    for (;;) {
      const remaining = wanted === undefined ? undefined : wanted - decoded.length;
      if (remaining !== undefined && remaining <= 0) break;
      const rows = statement.all({
        sessionId: query.sessionId,
        afterSequence: cursor,
        limit: remaining,
      }) as unknown[];
      for (const row of rows) {
        // Advanced from the row, not from the decoded event, so a dropped row
        // still moves the cursor past itself.
        const sequence = (row as SqlRow).sequence;
        if (typeof sequence === "number") cursor = Math.max(cursor, sequence);
        try {
          decoded.push(decodeEvent(row, "session_events row"));
        } catch (error) {
          if (!(error instanceof UnknownSessionEventKindError)) throw error;
          dropped += 1;
          retiredKinds.add(error.payloadKind);
        }
      }
      // No limit means the single pass already read every matching row. With a
      // limit, a short page is the only honest signal that nothing is left;
      // a full one means at least one row was consumed, so the cursor moved
      // and the next pass makes progress.
      if (remaining === undefined || rows.length < remaining) break;
    }
    if (dropped > 0) {
      // Named, not just counted: the whole point of dropping is that this build
      // no longer knows the kind, so the kind is the only thing that identifies
      // what a reader is missing.
      const names = [...retiredKinds].toSorted().join(", ");
      console.warn(`[session-ledger] skipped ${dropped} event(s) of retired kind(s): ${names}`);
    }
    return decoded;
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
        intent: encodeSessionJson(command.intent),
        route: command.route === null ? null : encodeSessionJson(command.route),
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
    decodeCommandReceipt(receipt, "Command receipt");
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
        receipt: encodeSessionJson(receipt),
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
        nativeDetail:
          attachment.native === null ? null : encodeSessionJson(attachment.native.detail),
        observedKind: payload.kind === "attachment.opened" ? "opened" : "failed",
        failure: payload.kind === "attachment.failed" ? encodeSessionJson(payload.failure) : null,
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
    intent: decodeSessionCommandIntent(
      parseJson(value.intent, `${context}.intent`),
      `${context}.intent`,
    ),
    route:
      value.route === null
        ? null
        : decodeSessionCommandRoute(parseJson(value.route, `${context}.route`), `${context}.route`),
  };
  assertCommand(command, context);
  return command;
}

function decodeReceiptRow(row: unknown, context: string): CommandReceipt {
  const value = asRecord(row, context);
  const receipt = decodeCommandReceipt(
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
    provenance: decodeSessionEventProvenance(
      parseJson(value.provenance, `${context}.provenance`),
      `${context}.provenance`,
    ),
    payload: decodeSessionEventPayload(
      parseJson(value.payload, `${context}.payload`),
      `${context}.payload`,
    ),
  };
  if (attachmentId !== null) event.attachmentId = attachmentId;
  if (commandId !== null) event.commandId = commandId;
  assertSessionEvent(event, context);
  return event;
}

function assertCommand(value: SessionCommand, context: string): void {
  if (!value.id || !value.sessionId || !Number.isInteger(value.createdAt)) {
    throw new Error(`${context} is not a valid Session command`);
  }
  decodeSessionCommandIntent(value.intent, `${context}.intent`);
  if (value.route !== null) decodeSessionCommandRoute(value.route, `${context}.route`);
}

function parseJson(value: unknown, context: string): unknown {
  if (typeof value !== "string") throw new Error(`${context} must be JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${context} contains invalid JSON`);
  }
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

function readInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context} must be an integer`);
  }
  return value;
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
