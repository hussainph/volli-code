import { assertSessionEvent } from "@volli/shared";
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
  SessionUsageAttribution,
  SessionUsageEntry,
  SessionUsageScope,
} from "@volli/shared";

/**
 * Scope is decided by the ATTRIBUTION on the fact, never by the Session row.
 *
 * Same rule the SQLite projection follows, and it has to be, because this
 * adapter is the reference that one is checked against: a Ticket that has since
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
 * later, another durable writer) behind the exact same port.
 */
class InMemorySessionLedger implements SessionLedger {
  #sessions = new Map<string, Session>();
  #events = new Map<string, SessionEvent>();
  #commands = new Map<string, SessionCommand>();
  #receipts = new Map<string, CommandReceipt>();
  #tail: Promise<void> = Promise.resolve();

  async transaction<T>(
    work: (transaction: SessionLedgerTransaction) => Promise<T> | T,
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

    try {
      return await work(transaction);
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
   * where correctness is the whole point and a scan costs nothing — and
   * deriving it here is what makes it the reference the SQLite projection is
   * checked against.
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
    const byTicket = new Map<string, ConcreteLatestSessionSignal>();
    for (const session of this.#sessions.values()) {
      if (session.projectId !== query.projectId || session.ticketId === null) continue;
      const event = this.#eventsFor(session.id).findLast(isSessionSignalEvent);
      if (event === undefined) continue;
      const candidate: ConcreteLatestSessionSignal = {
        ticketId: session.ticketId,
        sessionId: session.id,
        signal: event.payload.signal,
        reason: event.payload.reason,
        createdAt: event.occurredAt,
      };
      const prior = byTicket.get(candidate.ticketId);
      if (
        prior === undefined ||
        candidate.createdAt > prior.createdAt ||
        (candidate.createdAt === prior.createdAt &&
          compareSqliteBinaryText(candidate.sessionId, prior.sessionId) > 0)
      ) {
        byTicket.set(candidate.ticketId, candidate);
      }
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
    this.#events.set(event.id, clone(event));
  }

  #listEvents(query: ListSessionEventsQuery): readonly SessionEvent[] {
    const afterSequence = query.afterSequence ?? 0;
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    return this.#eventsFor(query.sessionId)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  #getCommand(commandId: string): SessionCommand | null {
    const command = this.#commands.get(commandId);
    return command ? clone(command) : null;
  }

  #saveCommand(command: SessionCommand): void {
    this.#assertUnusedId(command.id);
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
      this.#receipts.has(id)
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
    };
  }

  #restore(checkpoint: LedgerCheckpoint): void {
    this.#sessions = checkpoint.sessions;
    this.#events = checkpoint.events;
    this.#commands = checkpoint.commands;
    this.#receipts = checkpoint.receipts;
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
}

export function createInMemorySessionLedger(): SessionLedger {
  return new InMemorySessionLedger();
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
