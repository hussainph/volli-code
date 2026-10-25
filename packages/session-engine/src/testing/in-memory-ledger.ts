import { readSessionOrigin } from "@volli/shared";
import {
  assertSessionEvent,
  assertSessionProjectionCheckpoint,
  sameCommandReceipt,
} from "@volli/shared";
import type {
  CommandReceipt,
  ListLatestTicketSignalsQuery,
  ListSessionStartsQuery,
  ListSessionsQuery,
  ListSessionUsageQuery,
  LatestSessionSignal,
  ListSessionEventsQuery,
  Session,
  SessionCommand,
  SessionEvent,
  SessionLedger,
  SessionLedgerTransaction,
  SessionProjectionCheckpoint,
  Synchronous,
  SessionUsageAttribution,
  SessionUsageEntry,
  SessionUsageScope,
} from "@volli/shared";

/**
 * Scope is decided by the ATTRIBUTION on the fact, never by the Session row.
 *
 * Same rule the SQLite projection follows, and the shared ledger contract
 * (`session-ledger-contract.ts`) holds both to it: a Ticket that has since
 * been deleted still owns the spend recorded against it, and a scope resolved
 * off `sessions.ticket_id` would answer `{ kind: "ticket" }` with nothing while
 * the projection still answered with the bill.
 */
function inUsageScope(
  scope: SessionUsageScope,
  entry: { sessionId: string; attribution: SessionUsageAttribution },
): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "project":
      return entry.attribution.projectId === scope.projectId;
    case "ticket":
      return entry.attribution.ticketId === scope.ticketId;
    case "session":
      return entry.sessionId === scope.sessionId;
  }
}

type ConcreteLatestSessionSignal = Omit<LatestSessionSignal, "sessionId"> & { sessionId: string };

/**
 * A transactional test adapter. Production composition supplies SQLite (and,
 * later, another durable writer) behind the exact same port, and every one of
 * them — this included — must pass `describeSessionLedgerContract`. A behaviour
 * this twin needs that the contract does not pin is a contract case missing.
 */
class InMemorySessionLedger implements SessionLedger {
  readonly #checkReferences: boolean;
  #sessions = new Map<string, Session>();
  #events = new Map<string, SessionEvent>();
  #commands = new Map<string, SessionCommand>();
  #receipts = new Map<string, CommandReceipt>();
  #projectionCheckpoints = new Map<string, SessionProjectionCheckpoint>();
  /** Attachment id to its Session, recorded by `attachment.opened` / `attachment.failed`. */
  #attachments = new Map<string, string>();
  /** Receipt id to the `command.receipt.recorded` event that carries it. */
  #receiptEvents = new Map<string, string>();
  /** Receipts the open transaction appended; each must have its event by commit. */
  #appendedReceipts: string[] = [];
  #tail: Promise<void> = Promise.resolve();

  constructor(checkReferences: boolean) {
    this.#checkReferences = checkReferences;
  }

  async transaction<T>(
    work: (transaction: SessionLedgerTransaction) => Synchronous<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const checkpoint = this.#checkpoint();
    let open = true;
    const transaction = this.#scopedTransaction(() => open);
    this.#appendedReceipts = [];

    try {
      const value = work(transaction) as T;
      if (this.#checkReferences) this.#assertReceiptEventPairs();
      return value;
    } catch (error) {
      this.#restore(checkpoint);
      throw error;
    } finally {
      open = false;
      release?.();
    }
  }

  #scopedTransaction(isOpen: () => boolean): SessionLedgerTransaction {
    const assertOpen = () => {
      if (!isOpen()) throw new Error("Session ledger transaction is closed");
    };
    return {
      getSession: (sessionId) => {
        assertOpen();
        return this.#getSession(sessionId);
      },
      listSessions: (query) => {
        assertOpen();
        return this.#listSessions(query);
      },
      countSessions: (query) => {
        assertOpen();
        return this.#countSessions(query);
      },
      listAttachedSessions: () => {
        assertOpen();
        return this.#listAttachedSessions();
      },
      listSessionStarts: (query) => {
        assertOpen();
        return this.#listSessionStarts(query);
      },
      listLatestTicketSignals: (query) => {
        assertOpen();
        return this.#listLatestTicketSignals(query);
      },
      insertSession: (session) => {
        assertOpen();
        this.#insertSession(session);
      },
      getEvent: (eventId) => {
        assertOpen();
        return this.#getEvent(eventId);
      },
      appendEvent: (event) => {
        assertOpen();
        this.#appendEvent(event);
      },
      listEvents: (query) => {
        assertOpen();
        return this.#listEvents(query);
      },
      listProjectionEvents: (query) => {
        assertOpen();
        // This adapter holds decoded objects, so there is no provenance decode
        // to skip and no cheaper read to offer. Dropping the field anyway keeps
        // it honest about what a fold is allowed to see, so a reducer that
        // started reading provenance would fail here and not only in SQLite.
        return this.#listEvents(query).map(({ provenance, ...event }) => {
          const detail = provenance.source.detail;
          // Assigned rather than spread (oxc(no-map-spread)): the rest
          // destructure above already made `event` this call's own copy.
          return event.payload.kind === "command.recorded"
            ? Object.assign(event, {
                commandOrigin: readSessionOrigin(
                  typeof detail === "object" && detail !== null && !Array.isArray(detail)
                    ? (detail as Record<string, unknown>).sessionOrigin
                    : null,
                ),
              })
            : event;
        });
      },
      latestEventSequence: (sessionId) => {
        assertOpen();
        return this.#latestEventSequence(sessionId);
      },
      getProjectionCheckpoint: (sessionId) => {
        assertOpen();
        return this.#getProjectionCheckpoint(sessionId);
      },
      saveProjectionCheckpoint: (checkpoint) => {
        assertOpen();
        this.#saveProjectionCheckpoint(checkpoint);
      },
      getCommand: (commandId) => {
        assertOpen();
        return this.#getCommand(commandId);
      },
      saveCommand: (command) => {
        assertOpen();
        this.#saveCommand(command);
      },
      getReceipt: (receiptId) => {
        assertOpen();
        return this.#getReceipt(receiptId);
      },
      listReceipts: (commandId) => {
        assertOpen();
        return this.#listReceipts(commandId);
      },
      appendReceipt: (receipt) => {
        assertOpen();
        this.#appendReceipt(receipt);
      },
      listUsage: (query) => {
        assertOpen();
        return this.#listUsage(query);
      },
      // Always complete. This adapter derives usage from the events it holds,
      // and it holds every event it was ever given — there is no era of its
      // history that predates metering, because there is no history it did not
      // build in this process.
      usageMeteredFrom: () => {
        assertOpen();
        return 0;
      },
      // The in-memory adapter derives usage on every read, so there is no
      // stored projection to discard. Keeping the verb rather than throwing is
      // deliberate: rebuild is part of the port every adapter must honour, and
      // an adapter that refused it would make the port a lie about SQLite.
      rebuildUsageProjection: () => {
        assertOpen();
      },
    };
  }

  /**
   * Derived from the events, not from a table. This adapter exists for tests,
   * where correctness is the whole point and a scan costs nothing: its answers
   * are the facts' by construction, and the contract's usage cases hold the
   * SQLite projection to the same answers.
   */
  #listUsage(query: ListSessionUsageQuery): readonly SessionUsageEntry[] {
    const entries: SessionUsageEntry[] = [];
    for (const event of this.#events.values()) {
      if (event.payload.kind !== "usage.recorded") continue;
      if (query.since !== undefined && event.occurredAt < query.since) continue;
      if (query.until !== undefined && event.occurredAt >= query.until) continue;
      const { attribution } = event.payload;
      if (!inUsageScope(query.scope, { sessionId: event.sessionId, attribution })) continue;
      entries.push({
        ...event.payload.usage,
        sessionId: event.sessionId,
        projectId: attribution.projectId,
        ticketId: attribution.ticketId,
        occurredAt: event.occurredAt,
      });
    }
    // Newest first, and no tie-break. The port promises an order, not a total
    // order: a report is a sum over the whole set, so two operations sharing a
    // millisecond cannot change any answer derived from it.
    return entries.toSorted((left, right) => right.occurredAt - left.occurredAt);
  }

  #getSession(sessionId: string): Session | null {
    const session = this.#sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  #listSessions(query: ListSessionsQuery): readonly Session[] {
    return [...this.#sessions.values()]
      .filter((session) => {
        if (session.projectId !== query.projectId) return false;
        switch (query.scope) {
          case "all":
            return true;
          case "ticket":
            return session.ticketId === query.ticketId;
          case "project":
            return session.ticketId === null;
        }
      })
      .toSorted(
        (left, right) =>
          right.createdAt - left.createdAt || compareSqliteBinaryText(right.id, left.id),
      )
      .map(clone);
  }

  /**
   * Every Session holding at least one open attachment, across every project.
   *
   * Derived straight from the events rather than from an index: this store is
   * a test double whose whole content fits in memory, so the cheap answer and
   * the true answer are the same walk. The SQLite ledger keeps a projected
   * closure mark instead — same meaning, different cost — and the shared
   * ledger contract holds the two to the same answers.
   */
  #listAttachedSessions(): readonly Session[] {
    const attached: Session[] = [];
    for (const session of this.#sessions.values()) {
      const open = new Set<string>();
      for (const event of this.#eventsFor(session.id)) {
        // `attachment.failed` never opens one, so only these two move the set.
        if (event.payload.kind === "attachment.opened") open.add(event.payload.attachment.id);
        if (event.payload.kind === "attachment.closed") open.delete(event.payload.attachmentId);
      }
      if (open.size > 0) attached.push(clone(session));
    }
    return attached.toSorted(
      (left, right) =>
        right.createdAt - left.createdAt || compareSqliteBinaryText(right.id, left.id),
    );
  }

  #countSessions(query: ListSessionsQuery): number {
    return [...this.#sessions.values()].filter((session) => {
      if (session.projectId !== query.projectId) return false;
      switch (query.scope) {
        case "all":
          return true;
        case "ticket":
          return session.ticketId === query.ticketId;
        case "project":
          return session.ticketId === null;
      }
    }).length;
  }

  #listSessionStarts(query: ListSessionStartsQuery): readonly number[] {
    return [...this.#sessions.values()]
      .map((session) => session.createdAt)
      .filter((createdAt) => createdAt >= query.sinceMs)
      .toSorted((left, right) => left - right);
  }

  #listLatestTicketSignals(query: ListLatestTicketSignalsQuery): readonly LatestSessionSignal[] {
    // Ledger ACCEPTANCE order, matching the SQLite adapter's
    // `session_event_sequence` read: the last signal appended for a ticket
    // wins, whatever `occurredAt` claims and whatever the Session ids are
    // (VC-512). The Map's insertion order is this adapter's ledger order, and
    // `#appendEvent` is its only writer, so it is the same provisional local
    // order the SQLite side stores. A future relay must supply final order or
    // explicit supersession (docs/BOUNDARIES.md standing rule 2).
    const byTicket = new Map<string, ConcreteLatestSessionSignal>();
    for (const event of this.#events.values()) {
      if (!isSessionSignalEvent(event)) continue;
      const session = this.#sessions.get(event.sessionId);
      if (
        session === undefined ||
        session.projectId !== query.projectId ||
        session.ticketId === null
      ) {
        continue;
      }
      byTicket.set(session.ticketId, {
        ticketId: session.ticketId,
        sessionId: session.id,
        signal: event.payload.signal,
        reason: event.payload.reason,
        createdAt: event.occurredAt,
      });
    }
    return [...byTicket.values()].toSorted((left, right) =>
      compareSqliteBinaryText(left.ticketId, right.ticketId),
    );
  }

  #insertSession(session: Session): void {
    this.#assertUnusedId(session.id);
    this.#sessions.set(session.id, clone(session));
  }

  #getEvent(eventId: string): SessionEvent | null {
    const event = this.#events.get(eventId);
    return event ? clone(event) : null;
  }

  #appendEvent(event: SessionEvent): void {
    // Write parity with the SQLite ledger: the codec's write-side assertion is
    // the same decode every durable read runs, so lab and test writes reject
    // exactly what SQLite would instead of persisting an event this build
    // could never read back.
    assertSessionEvent(event, "Session event");
    this.#assertUnusedId(event.id);
    if (!this.#sessions.has(event.sessionId)) {
      throw new Error(`Session ${event.sessionId} was not found`);
    }
    const latestSequence = this.#eventsFor(event.sessionId).at(-1)?.sequence ?? 0;
    if (event.sequence !== latestSequence + 1) {
      throw new Error(`Session ${event.sessionId} event sequence must be monotonic`);
    }
    // The same references the SQLite ledger enforces with its foreign keys and
    // attachment table: an attachment belongs to one Session and opens once,
    // and a fact names only an attachment and a command its own Session holds.
    if (this.#checkReferences) this.#assertEventReferences(event);
    this.#events.set(event.id, clone(event));
  }

  #assertEventReferences(event: SessionEvent): void {
    const { payload } = event;
    if (payload.kind === "attachment.opened" || payload.kind === "attachment.failed") {
      const { attachment } = payload;
      if (attachment.sessionId !== event.sessionId) {
        throw new Error(`Attachment ${attachment.id} belongs to another Session`);
      }
      if (this.#attachments.has(attachment.id)) {
        throw new Error(`Attachment ${attachment.id} already exists`);
      }
      this.#attachments.set(attachment.id, event.sessionId);
    }
    if (event.attachmentId !== null && event.attachmentId !== undefined) {
      const owner = this.#attachments.get(event.attachmentId);
      if (owner === undefined) throw new Error(`Attachment ${event.attachmentId} was not found`);
      if (owner !== event.sessionId) {
        throw new Error(`Attachment ${event.attachmentId} belongs to another Session`);
      }
    }
    if (event.commandId !== null && event.commandId !== undefined) {
      const command = this.#commands.get(event.commandId);
      if (!command) throw new Error(`Command ${event.commandId} was not found`);
      if (command.sessionId !== event.sessionId) {
        throw new Error(`Command ${event.commandId} belongs to another Session`);
      }
    }
    if (payload.kind === "command.receipt.recorded") {
      const receipt = this.#receipts.get(payload.receipt.id);
      if (!receipt || !sameCommandReceipt(receipt, payload.receipt)) {
        throw new Error(`Receipt ${payload.receipt.id} does not match its event`);
      }
      // The codec already holds the envelope to the receipt's command, sequence
      // and stamp, and the command check above holds that command to this
      // Session, so the event is the receipt's own.
      this.#receiptEvents.set(receipt.id, event.id);
    }
  }

  /**
   * At the transaction boundary, as the SQLite ledger checks it: every receipt
   * this transaction appended is carried by a receipt event, and receipts
   * from earlier transactions passed this when they committed.
   */
  #assertReceiptEventPairs(): void {
    for (const receiptId of this.#appendedReceipts) {
      if (!this.#receiptEvents.has(receiptId)) {
        throw new Error(`Receipt ${receiptId} has no matching event`);
      }
    }
  }

  #listEvents(query: ListSessionEventsQuery): readonly SessionEvent[] {
    const afterSequence = query.afterSequence ?? 0;
    // The same refusals as the SQLite ledger: a cursor or limit that is not a
    // non-negative integer is a caller bug, not an empty page.
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event pagination cursor must be a non-negative integer");
    }
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      throw new Error("Event pagination limit must be a non-negative integer");
    }
    return this.#eventsFor(query.sessionId)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, query.limit)
      .map(clone);
  }

  #latestEventSequence(sessionId: string): number {
    return this.#eventsFor(sessionId).at(-1)?.sequence ?? 0;
  }

  #getProjectionCheckpoint(sessionId: string): SessionProjectionCheckpoint | null {
    const checkpoint = this.#projectionCheckpoints.get(sessionId);
    return checkpoint ? clone(checkpoint) : null;
  }

  #saveProjectionCheckpoint(checkpoint: SessionProjectionCheckpoint): void {
    if (!this.#sessions.has(checkpoint.sessionId)) {
      throw new Error("Session projection checkpoint is invalid");
    }
    assertSessionProjectionCheckpoint(checkpoint, {
      latestSequence: this.#latestEventSequence(checkpoint.sessionId),
      invalidMessage: "Session projection checkpoint is invalid",
    });
    const existing = this.#projectionCheckpoints.get(checkpoint.sessionId);
    if (existing && existing.throughSequence > checkpoint.throughSequence) return;
    this.#projectionCheckpoints.set(checkpoint.sessionId, clone(checkpoint));
  }

  #getCommand(commandId: string): SessionCommand | null {
    const command = this.#commands.get(commandId);
    return command ? clone(command) : null;
  }

  #saveCommand(command: SessionCommand): void {
    this.#assertUnusedId(command.id);
    if (this.#checkReferences && !this.#sessions.has(command.sessionId)) {
      throw new Error(`Session ${command.sessionId} was not found`);
    }
    this.#commands.set(command.id, clone(command));
  }

  #getReceipt(receiptId: string): CommandReceipt | null {
    const receipt = this.#receipts.get(receiptId);
    return receipt ? clone(receipt) : null;
  }

  #listReceipts(commandId: string): readonly CommandReceipt[] {
    return [...this.#receipts.values()]
      .filter((receipt) => receipt.commandId === commandId)
      .toSorted((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  #appendReceipt(receipt: CommandReceipt): void {
    if (!this.#commands.has(receipt.commandId)) {
      throw new Error(`Command ${receipt.commandId} was not found`);
    }
    this.#assertUnusedId(receipt.id);
    this.#appendedReceipts.push(receipt.id);
    this.#receipts.set(receipt.id, clone(receipt));
  }

  #eventsFor(sessionId: string): SessionEvent[] {
    return [...this.#events.values()]
      .filter((event) => event.sessionId === sessionId)
      .toSorted((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  #assertUnusedId(id: string): void {
    if (
      this.#sessions.has(id) ||
      this.#events.has(id) ||
      this.#commands.has(id) ||
      this.#receipts.has(id) ||
      this.#attachments.has(id)
    ) {
      throw new Error(`Ledger id ${id} already exists`);
    }
  }

  #checkpoint(): LedgerCheckpoint {
    return {
      sessions: cloneMap(this.#sessions),
      events: cloneMap(this.#events),
      commands: cloneMap(this.#commands),
      receipts: cloneMap(this.#receipts),
      projectionCheckpoints: cloneMap(this.#projectionCheckpoints),
      attachments: new Map(this.#attachments),
      receiptEvents: new Map(this.#receiptEvents),
    };
  }

  #restore(checkpoint: LedgerCheckpoint): void {
    this.#sessions = checkpoint.sessions;
    this.#events = checkpoint.events;
    this.#commands = checkpoint.commands;
    this.#receipts = checkpoint.receipts;
    this.#projectionCheckpoints = checkpoint.projectionCheckpoints;
    this.#attachments = checkpoint.attachments;
    this.#receiptEvents = checkpoint.receiptEvents;
  }
}

function isSessionSignalEvent(event: SessionEvent): event is SessionEvent & {
  payload: Extract<SessionEvent["payload"], { kind: "session.signaled" }>;
} {
  return event.payload.kind === "session.signaled";
}

interface LedgerCheckpoint {
  sessions: Map<string, Session>;
  events: Map<string, SessionEvent>;
  commands: Map<string, SessionCommand>;
  receipts: Map<string, CommandReceipt>;
  projectionCheckpoints: Map<string, SessionProjectionCheckpoint>;
  attachments: Map<string, string>;
  receiptEvents: Map<string, string>;
}

export interface InMemorySessionLedgerOptions {
  /**
   * `false` stores what the SQLite ledger's foreign keys and receipt pairing
   * would refuse — a receipt with no receipt event, a fact naming a command or
   * attachment nobody stored, a command for no Session. Only for tests of how a
   * reader copes with a store that already holds such history; the contract
   * runs the checked default.
   */
  checkReferences?: boolean;
}

export function createInMemorySessionLedger(
  options: InMemorySessionLedgerOptions = {},
): SessionLedger {
  return new InMemorySessionLedger(options.checkReferences ?? true);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** SQLite's default BINARY collation compares the UTF-8 bytes of TEXT values. */
function compareSqliteBinaryText(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function cloneMap<T>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
}
