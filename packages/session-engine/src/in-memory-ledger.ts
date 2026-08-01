import type {
  CommandReceipt,
  ListLatestTicketSignalsQuery,
  ListSessionsQuery,
  LatestSessionSignal,
  ListSessionEventsQuery,
  Session,
  SessionCommand,
  SessionEvent,
  SessionLedger,
  SessionLedgerTransaction,
} from "@volli/shared";

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
    };
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
          case "scratch":
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
        case "scratch":
          return session.ticketId === null;
      }
    }).length;
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
