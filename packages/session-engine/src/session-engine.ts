import {
  advanceSessionProjection,
  createSessionProjectionCheckpoint,
  observationPayload,
  reportSessionUsage,
  sameCommandReceipt,
  sameSessionCommand,
  sameCommandReceiptOutcome,
  sameSessionCommandRequest,
  sameSessionEventPayload,
  sameSessionEventProvenance,
} from "@volli/shared";
import type {
  CommandReceipt,
  CommandReceiptResult,
  GetSessionQuery,
  ListSessionsQuery,
  ListSessionStartsQuery,
  ListLatestTicketSignalsQuery,
  ListSessionEventsQuery,
  ListSessionUsageQuery,
  Session,
  SessionAttachment,
  SessionCommand,
  SessionCommandIntent,
  SessionRole,
  SessionCommandRequest,
  SessionCommandRoute,
  SessionEvent,
  SessionEventPayload,
  SessionEventProvenance,
  SessionInput,
  SessionLedger,
  SessionLedgerClock,
  SessionLedgerIds,
  SessionLedgerTransaction,
  SessionObservation,
  SessionProjection,
  SessionProjectionCheckpoint,
  SessionUsageReport,
  SessionUsageReportQuery,
  LatestSessionSignal,
  UnstampedCommandReceipt,
} from "@volli/shared";

export interface CreateSessionRequest {
  commandId: string;
  projectId: string;
  ticketId: string | null;
  /** The Role the Session is created under; stated by the caller, never derived from `ticketId` (VC-9). */
  role: SessionRole;
  /** The delegating Session for a `subagent`, null otherwise — ledger data, never a host table's. */
  parentSessionId: string | null;
  title: string | null;
  /**
   * The Session id a client already minted (VC-358), honored when present so a
   * provisional chat can be promoted under the id it carried all along. Absent
   * — every existing caller — keeps the ledger's own `ids.next("session")`
   * derivation, untouched. The requested id is not stored beside the Session:
   * it simply IS the Session id, so replay can compare a later request against
   * the durable row and refuse a command that arrives naming another id.
   */
  requestedSessionId?: string | null;
  /** Trusted host-supplied audit provenance; renderers never call this module directly. */
  provenance: SessionEventProvenance;
}

export interface SubmitSessionCommandRequest {
  commandId: string;
  sessionId: string;
  intent: Exclude<SessionCommandIntent, { kind: "session.create" }>;
  /** Trusted host-supplied audit provenance; renderers never call this module directly. */
  provenance: SessionEventProvenance;
}

export interface CreateSessionResult {
  session: Session;
  command: SessionCommand;
  commandEvent: SessionEvent;
  event: SessionEvent;
  receipt: CommandReceipt;
  receiptEvent: SessionEvent;
}

export interface SubmitSessionCommandResult {
  command: SessionCommand;
  commandEvent: SessionEvent;
  receipt: CommandReceipt | null;
  receiptEvent: SessionEvent | null;
}

export interface CompleteModelSelectionRequest {
  sessionId: string;
  commandId: string;
  attachmentId: string;
  occurredAt: number;
  provenance: SessionEventProvenance;
}

export interface CompleteModelSelectionResult {
  event: SessionEvent;
  receipt: CommandReceipt;
  receiptEvent: SessionEvent;
}

export interface SessionEngine {
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  getOrRecordSessionInput(request: {
    sessionId: string;
    input: SessionInput;
    provenance: SessionEventProvenance;
  }): Promise<SessionInput>;
  observe(observation: SessionObservation): Promise<SessionEvent>;
  submit(request: SubmitSessionCommandRequest): Promise<SubmitSessionCommandResult>;
  /** Atomically commits an adapter-applied idle model policy and its terminal receipt. */
  completeModelSelection(
    request: CompleteModelSelectionRequest,
  ): Promise<CompleteModelSelectionResult>;
  getSession(query: GetSessionQuery): Promise<SessionProjection | null>;
  /**
   * The stored Session row alone, without folding its history.
   *
   * `getSession` answers with a projection, which costs a read and a fold of
   * every event the Session has. A caller that is about to fold the history
   * itself needs neither — only the immutable row the fold starts from — and
   * asking `getSession` for it makes that caller fold the same log twice.
   */
  getBaseSession(query: GetSessionQuery): Promise<Session | null>;
  /**
   * Every Session in scope, projected.
   *
   * Each row is folded atomically, but the listing as a whole is not one
   * snapshot across Sessions: rows are members as of one instant, and their
   * histories are folded at or after it (VC-388). The implementation states
   * why that is sound; callers only need to know not to read a cross-Session
   * invariant out of two rows of one listing.
   */
  listSessions(query: ListSessionsQuery): Promise<readonly SessionProjection[]>;
  countSessions(query: ListSessionsQuery): Promise<number>;
  /**
   * When Sessions were started, across every project — the practice chart's
   * whole input. Stamps rather than Sessions, so a 26-week window costs one
   * indexed read and no folds.
   */
  listSessionStarts(query: ListSessionStartsQuery): Promise<readonly number[]>;
  listLatestTicketSignals(
    query: ListLatestTicketSignalsQuery,
  ): Promise<readonly LatestSessionSignal[]>;
  listEvents(query: ListSessionEventsQuery): Promise<readonly SessionEvent[]>;
  /**
   * Metadata-only event head, without payload/provenance decoding.
   *
   * `0` means "this Session has no committed events", and that is a total
   * answer rather than an ambiguous one: sequences are 1-based, and a Session
   * that does not exist has no committed events either, so both cases are the
   * same true statement about history. It is deliberately NOT an error channel
   * — a caller that additionally needs the Session to exist has already asked
   * for it, and the one caller for which `0` is impossible
   * (`SessionRuntime`'s post-commit result) raises its own error rather than
   * pushing that concern into every reader of this head.
   */
  latestEventSequence(query: GetSessionQuery): Promise<number>;
  /** A derived projection cache row; null means the immutable log must be folded. */
  getProjectionCheckpoint(query: GetSessionQuery): Promise<SessionProjectionCheckpoint | null>;
  /** Persists only a rebuildable read model, never a Session fact. */
  saveProjectionCheckpoint(checkpoint: SessionProjectionCheckpoint): Promise<void>;
  /**
   * What a scope consumed, over a window, optionally broken down.
   *
   * One indexed read plus one pass of arithmetic — no Session histories folded
   * and no transcript artifacts opened, which is the difference between a cost
   * question that is cheap to ask and one nobody asks twice.
   */
  reportUsage(query: ReportSessionUsageQuery): Promise<SessionUsageReport>;
}

export type ReportSessionUsageQuery = ListSessionUsageQuery & SessionUsageReportQuery;

export interface SessionEnginePorts {
  ledger: SessionLedger;
  clock: SessionLedgerClock;
  ids: SessionLedgerIds;
  /**
   * Host diagnostics seam for a projection checkpoint that could not be used.
   *
   * A checkpoint is a rebuildable cache, so a failure here is always recovered
   * by refolding the immutable log — but a cache that fails on EVERY read is
   * indistinguishable from one that is merely absent, and the symptom is only
   * that reads are quietly slow forever. Reporting the miss is what makes that
   * condition observable. Seam failures are isolated, exactly as the runtime's
   * {@link SessionRuntimePorts.onSubscriberFailure} is.
   */
  onProjectionCheckpointFailure?: (error: unknown) => void;
  /**
   * Hands the host back a turn of its event loop, part-way through a read that
   * spans many Sessions (VC-388).
   *
   * It must resolve on a MACROTASK. An implementation built from resolved
   * promises, `queueMicrotask` or `await` alone satisfies the type and does
   * nothing this exists for: the microtask queue drains to exhaustion before
   * the loop advances, so a listing built that way still blocks timers, IPC
   * and input for its whole length. The default is a zero-delay timer, which
   * is the one spelling available in every host this package runs in; a Node
   * host should inject `setImmediate`, which lands in the check phase rather
   * than behind the timer list.
   */
  yieldToHost?: () => Promise<void>;
}

export class SessionEngineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEngineConflictError";
  }
}

export class SessionEngineNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was not found`);
    this.name = "SessionEngineNotFoundError";
  }
}

/** The storage-agnostic Session Engine; its host supplies one transactional ledger writer. */
export function createSessionEngine(ports: SessionEnginePorts): SessionEngine {
  // Isolated here rather than at each call site: a diagnostics seam that could
  // itself throw would turn a recovered cache miss into a failed read.
  const reportCheckpointFailure = (error: unknown): void => {
    try {
      ports.onProjectionCheckpointFailure?.(error);
    } catch {
      // Observing a miss must not change the read it observes.
    }
  };
  const yieldToHost = ports.yieldToHost ?? defaultYieldToHost;
  /** Insertion-ordered, so the first key is the least recently listed Session. */
  const listingFolds = new Map<string, ListingFold>();

  /**
   * One listing row, from the cache when the Session has not moved.
   *
   * The head read and the fold happen in the SAME transaction as each other,
   * so the cursor stored here is exactly the log the projection was built
   * from — read in two transactions, an append between them would be recorded
   * as already folded and stay invisible until the next one.
   *
   * A log rewritten out of band, beneath the ledger's insert-only contract,
   * is not seen here; it is not seen by the durable checkpoint rows either,
   * and a host that does that must build a new engine.
   */
  const listingProjection = (
    transaction: SessionLedgerTransaction,
    session: Session,
  ): SessionProjection => {
    // Metadata only: no payload decoded, no provenance joined, no checkpoint
    // JSON parsed. That is what makes asking cheaper than answering.
    const head = transaction.latestEventSequence(session.id);
    const cached = listingFolds.get(session.id);
    if (cached && cached.throughSequence === head && sameSession(cached.session, session)) {
      listingFolds.delete(session.id);
      listingFolds.set(session.id, cached);
      return cached.projection;
    }
    const projection = projectStoredSession(transaction, session, reportCheckpointFailure);
    listingFolds.delete(session.id);
    listingFolds.set(session.id, { session, throughSequence: head, projection });
    for (const oldest of listingFolds.keys()) {
      if (listingFolds.size <= SESSION_LISTING_CACHE_LIMIT) break;
      listingFolds.delete(oldest);
    }
    return projection;
  };
  return {
    async createSession(request) {
      return ports.ledger.transaction((transaction) => {
        const createdAt = ports.clock.now();
        const existing = transaction.getCommand(request.commandId);
        if (existing) return replayCreate(transaction, request);

        const session: Session = {
          id: request.requestedSessionId ?? ports.ids.next("session"),
          projectId: request.projectId,
          ticketId: request.ticketId,
          role: request.role,
          parentSessionId: request.parentSessionId,
          title: request.title,
          createdAt,
        };
        const command: SessionCommand = {
          id: request.commandId,
          sessionId: session.id,
          createdAt,
          intent: {
            kind: "session.create",
            projectId: request.projectId,
            ticketId: request.ticketId,
            role: request.role,
            parentSessionId: request.parentSessionId,
            title: request.title,
          },
          route: null,
        };
        const commandEvent = commandRecordedEvent(
          ports.ids.next("event"),
          session.id,
          1,
          createdAt,
          request.provenance,
          command,
        );
        const sessionEvent: SessionEvent = {
          id: ports.ids.next("event"),
          sessionId: session.id,
          sequence: 2,
          occurredAt: createdAt,
          recordedAt: ports.clock.now(),
          provenance: request.provenance,
          commandId: command.id,
          payload: { kind: "session.created", session },
        };
        const receiptEvent = receiptRecordedEvent(
          ports.ids.next("event"),
          session.id,
          3,
          createdAt,
          request.provenance,
          completedReceipt(ports.ids.next("receipt"), command.id, 3, ports.clock.now(), {
            kind: "session.created",
            sessionId: session.id,
          }),
        );

        transaction.insertSession(session);
        transaction.saveCommand(command);
        transaction.appendEvent(commandEvent);
        transaction.appendEvent(sessionEvent);
        transaction.appendReceipt(receiptEvent.payload.receipt);
        transaction.appendEvent(receiptEvent);
        return {
          session,
          command,
          commandEvent,
          event: sessionEvent,
          receipt: receiptEvent.payload.receipt,
          receiptEvent,
        };
      });
    },

    async getOrRecordSessionInput(request) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(request.sessionId);
        if (!session) throw new SessionEngineNotFoundError(request.sessionId);
        const events = transaction.listEvents({ sessionId: request.sessionId });
        const existing = events.find(
          (event) =>
            event.payload.kind === "session.input.recorded" &&
            event.payload.input.kind === request.input.kind,
        );
        if (existing?.payload.kind === "session.input.recorded") {
          return { ...existing.payload.input };
        }
        const occurredAt = ports.clock.now();
        const event: SessionEvent = {
          id: ports.ids.next("event"),
          sessionId: request.sessionId,
          sequence: transaction.latestEventSequence(request.sessionId) + 1,
          occurredAt,
          recordedAt: ports.clock.now(),
          provenance: request.provenance,
          payload: { kind: "session.input.recorded", input: { ...request.input } },
        };
        transaction.appendEvent(event);
        return { ...request.input };
      });
    },

    async observe(observation) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(observation.sessionId);
        if (!session) throw new SessionEngineNotFoundError(observation.sessionId);
        // No whole-log read here (VC-356). Recording one fact used to list every
        // event of the Session first, which made a turn's durable cost a
        // function of how long the Session had been alive rather than of what
        // the turn reported — quadratic across a Session, on the path a person
        // waits on. The three things that read wanted are each answerable
        // without it: the projection resumes from its checkpoint, the next
        // sequence is an index lookup, and the one question neither can answer
        // asks for the audit read where it is actually needed.
        //
        // SQLite persists omitted optional envelope ids as NULL. Canonicalize
        // before either receipt or fact handling so every durable event uses
        // the same replay identity.
        const attachmentId = observationAttachmentId(observation) ?? null;

        if (observation.kind === "command.receipt") {
          const command = assertReceiptCommandOwnership(transaction, session, observation);
          const existingReceipt = transaction.getReceipt(observation.receipt.id);
          if (existingReceipt) {
            assertAdapterReceiptRoute(command, observation);
            if (!sameCommandReceiptOutcome(existingReceipt, observation.receipt)) {
              throw new SessionEngineConflictError(
                `Receipt ${observation.receipt.id} was already recorded differently`,
              );
            }
            // The replay path, and the only read here that still walks the
            // log: no index answers "which event carries this receipt", and a
            // re-delivered receipt is rare. Kept exact rather than narrowed to
            // this observation's own id, because a receipt re-delivered under a
            // new envelope id must still resolve to the event that recorded it.
            const event = receiptEventFor(
              transaction.listEvents({ sessionId: session.id }),
              existingReceipt.id,
            );
            if (!event || event.sessionId !== session.id) {
              throw new SessionEngineConflictError(
                `Receipt ${existingReceipt.id} has no Session event`,
              );
            }
            return event;
          }
          const priorReceipts = transaction.listReceipts(observation.receipt.commandId);
          const hasTerminalReceipt = priorReceipts.some(
            (receipt) => receipt.status === "rejected" || receipt.status === "completed",
          );
          const wouldRegressAcceptedDelivery =
            observation.receipt.status !== "completed" &&
            priorReceipts.some((receipt) => receipt.status === "accepted");
          if (hasTerminalReceipt || wouldRegressAcceptedDelivery) {
            throw new SessionEngineConflictError(
              `Command ${observation.receipt.commandId} already has a terminal receipt`,
            );
          }

          const stored = storedSessionProjection(transaction, session, reportCheckpointFailure);
          assertReceiptObservation(transaction, session, stored.checkpoint.projection, observation);
          const sequence = transaction.latestEventSequence(session.id) + 1;
          const event = receiptRecordedEvent(
            observation.id,
            session.id,
            sequence,
            observation.occurredAt,
            observation.provenance,
            stampReceipt(observation.receipt, sequence, ports.clock.now()),
            attachmentId,
          );
          transaction.appendReceipt(event.payload.receipt);
          transaction.appendEvent(event);
          refreshProjectionCheckpoint(transaction, session, stored, event, reportCheckpointFailure);
          return event;
        }

        // Attribution is stamped from the Session row this event is being
        // appended against, inside the same transaction, and becomes part of
        // the immutable fact. Read at rebuild time instead, it would be
        // whatever `sessions.ticket_id` had become by then — null, after a
        // Ticket delete — and the rebuilt projection would disagree with the
        // one the live path wrote. A read model that cannot be derived again
        // to the same answer is not rebuildable.
        const payload = observationPayload(observation, {
          projectId: session.projectId,
          ticketId: session.ticketId,
        });
        const commandId = observation.commandId ?? null;
        assertObservationCausation(transaction, session, observation);
        assertAttachmentStartRoute(transaction, observation);
        const existingEvent = transaction.getEvent(observation.id);
        if (existingEvent) {
          if (
            existingEvent.sessionId !== observation.sessionId ||
            existingEvent.occurredAt !== observation.occurredAt ||
            (existingEvent.attachmentId ?? null) !== attachmentId ||
            (existingEvent.commandId ?? null) !== commandId ||
            !sameSessionEventProvenance(existingEvent.provenance, observation.provenance) ||
            !sameSessionEventPayload(existingEvent.payload, payload)
          ) {
            throw new SessionEngineConflictError(
              `Observation ${observation.id} was already recorded with different evidence`,
            );
          }
          return existingEvent;
        }

        const stored = storedSessionProjection(transaction, session, reportCheckpointFailure);
        assertObservableFact(stored.checkpoint.projection, observation);
        assertPendingStartReservation(stored.checkpoint.projection, observation);
        const event: SessionEvent = {
          id: observation.id,
          sessionId: session.id,
          sequence: transaction.latestEventSequence(session.id) + 1,
          occurredAt: observation.occurredAt,
          recordedAt: ports.clock.now(),
          provenance: observation.provenance,
          attachmentId,
          commandId,
          payload,
        };
        transaction.appendEvent(event);
        refreshProjectionCheckpoint(transaction, session, stored, event, reportCheckpointFailure);
        return event;
      });
    },

    async submit(request) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(request.sessionId);
        if (!session) throw new SessionEngineNotFoundError(request.sessionId);
        const commandRequest: SessionCommandRequest = {
          id: request.commandId,
          sessionId: session.id,
          intent: request.intent,
        };
        const existing = transaction.getCommand(commandRequest.id);
        if (existing) return replaySubmit(transaction, session, commandRequest);

        // Accepting a Command is the other half of a turn's durable cost, and
        // it reached for the same whole-log read `observe` did (VC-356). The
        // replay branch above already returned, so nothing here needs the log
        // itself — only the folded state and the next sequence.
        const projection = projectStoredSession(transaction, session, reportCheckpointFailure);
        const routeResolution = resolveCommandRoute(projection, request.intent);
        const command: SessionCommand = {
          ...commandRequest,
          createdAt: ports.clock.now(),
          route: routeResolution.route,
        };
        const commandEvent = commandRecordedEvent(
          ports.ids.next("event"),
          session.id,
          transaction.latestEventSequence(session.id) + 1,
          command.createdAt,
          request.provenance,
          command,
        );
        transaction.saveCommand(command);
        transaction.appendEvent(commandEvent);

        const rejection = rejectionFor(projection, command, routeResolution.rejection);
        if (rejection) {
          const receiptEvent = receiptRecordedEvent(
            ports.ids.next("event"),
            session.id,
            commandEvent.sequence + 1,
            command.createdAt,
            request.provenance,
            stampReceipt(rejection, commandEvent.sequence + 1, ports.clock.now()),
          );
          transaction.appendReceipt(receiptEvent.payload.receipt);
          transaction.appendEvent(receiptEvent);
          return { command, commandEvent, receipt: receiptEvent.payload.receipt, receiptEvent };
        }

        if (
          command.intent.kind !== "session.archive" &&
          command.intent.kind !== "session.retitle" &&
          command.intent.kind !== "session.signal" &&
          command.intent.kind !== "session.stop" &&
          (command.intent.kind !== "model.select" || command.route !== null)
        ) {
          return { command, commandEvent, receipt: null, receiptEvent: null };
        }

        const sessionEvent: SessionEvent = {
          id: ports.ids.next("event"),
          sessionId: session.id,
          sequence: commandEvent.sequence + 1,
          occurredAt: command.createdAt,
          recordedAt: ports.clock.now(),
          provenance: request.provenance,
          commandId: command.id,
          payload:
            command.intent.kind === "session.archive"
              ? { kind: "session.archived" }
              : command.intent.kind === "session.retitle"
                ? { kind: "session.retitled", title: command.intent.title }
                : command.intent.kind === "model.select"
                  ? modelSelectedPayload(command.intent)
                  : command.intent.kind === "session.stop"
                    ? {
                        kind: "session.stopped",
                        reason: command.intent.reason,
                        by: command.intent.by,
                      }
                    : {
                        kind: "session.signaled",
                        signal: command.intent.signal,
                        reason: command.intent.reason,
                      },
        };
        transaction.appendEvent(sessionEvent);
        const receiptEvent = receiptRecordedEvent(
          ports.ids.next("event"),
          session.id,
          commandEvent.sequence + 2,
          command.createdAt,
          request.provenance,
          completedReceipt(
            ports.ids.next("receipt"),
            command.id,
            commandEvent.sequence + 2,
            ports.clock.now(),
            command.intent.kind === "session.archive"
              ? { kind: "session.archived", sessionId: session.id }
              : command.intent.kind === "session.retitle"
                ? { kind: "session.retitled", sessionId: session.id }
                : command.intent.kind === "model.select"
                  ? { kind: "model.selected", sessionId: session.id }
                  : command.intent.kind === "session.stop"
                    ? { kind: "session.stopped", sessionId: session.id }
                    : { kind: "session.signaled", sessionId: session.id },
          ),
        );
        transaction.appendReceipt(receiptEvent.payload.receipt);
        transaction.appendEvent(receiptEvent);
        return { command, commandEvent, receipt: receiptEvent.payload.receipt, receiptEvent };
      });
    },

    async completeModelSelection(request) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(request.sessionId);
        if (!session) throw new SessionEngineNotFoundError(request.sessionId);
        const command = transaction.getCommand(request.commandId);
        if (
          !command ||
          command.sessionId !== session.id ||
          command.intent.kind !== "model.select" ||
          command.route?.attachmentId !== request.attachmentId
        ) {
          throw new SessionEngineConflictError(
            `Command ${request.commandId} is not a routed model selection for attachment ${request.attachmentId}`,
          );
        }
        if (
          request.provenance.source.kind !== "adapter" ||
          request.provenance.source.id !== command.route.adapterId
        ) {
          throw new SessionEngineConflictError(
            `Command ${command.id} was not completed by adapter ${command.route.adapterId}`,
          );
        }
        const events = transaction.listEvents({ sessionId: session.id });
        const priorReceipt =
          transaction
            .listReceipts(command.id)
            .findLast((receipt) => receipt.status !== "unreconciled") ?? null;
        if (priorReceipt) {
          const event = events.find(
            (candidate) =>
              candidate.commandId === command.id && candidate.payload.kind === "model.selected",
          );
          const receiptEvent = receiptEventFor(events, priorReceipt.id);
          const commandEvent = commandEventFor(events, command.id);
          if (
            priorReceipt.status !== "completed" ||
            priorReceipt.result.kind !== "model.selected" ||
            priorReceipt.result.sessionId !== session.id ||
            !event ||
            event.attachmentId !== command.route.attachmentId ||
            event.payload.kind !== "model.selected" ||
            event.payload.selection.providerId !== command.intent.selection.providerId ||
            event.payload.selection.modelId !== command.intent.selection.modelId ||
            event.payload.selection.reasoningLevel !== command.intent.selection.reasoningLevel ||
            event.provenance.source.kind !== "adapter" ||
            event.provenance.source.id !== command.route.adapterId ||
            !receiptEvent ||
            receiptEvent.payload.kind !== "command.receipt.recorded" ||
            !sameCommandReceipt(receiptEvent.payload.receipt, priorReceipt) ||
            !sameSessionEventProvenance(receiptEvent.provenance, event.provenance) ||
            !commandEvent ||
            !(commandEvent.sequence < event.sequence && event.sequence < receiptEvent.sequence)
          ) {
            throw new SessionEngineConflictError(
              `Command ${command.id} has invalid completed model-selection history`,
            );
          }
          return { event, receipt: priorReceipt, receiptEvent };
        }

        const sequence = transaction.latestEventSequence(session.id) + 1;
        const event: SessionEvent = {
          id: ports.ids.next("event"),
          sessionId: session.id,
          sequence,
          occurredAt: request.occurredAt,
          recordedAt: ports.clock.now(),
          provenance: request.provenance,
          attachmentId: request.attachmentId,
          commandId: command.id,
          payload: modelSelectedPayload(command.intent),
        };
        const receiptEvent = receiptRecordedEvent(
          ports.ids.next("event"),
          session.id,
          sequence + 1,
          request.occurredAt,
          request.provenance,
          completedReceipt(ports.ids.next("receipt"), command.id, sequence + 1, ports.clock.now(), {
            kind: "model.selected",
            sessionId: session.id,
          }),
        );
        transaction.appendEvent(event);
        transaction.appendReceipt(receiptEvent.payload.receipt);
        transaction.appendEvent(receiptEvent);
        return { event, receipt: receiptEvent.payload.receipt, receiptEvent };
      });
    },

    async getSession(query) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(query.sessionId);
        return session ? projectStoredSession(transaction, session, reportCheckpointFailure) : null;
      });
    },

    async getBaseSession(query) {
      return ports.ledger.transaction((transaction) => transaction.getSession(query.sessionId));
    },

    /**
     * Every Session in scope, folded — in chunks, releasing the ledger and the
     * host's event loop between them (VC-388).
     *
     * ── WHAT THIS DELIBERATELY GIVES UP ───────────────────────────────────
     * A listing is NO LONGER a single point-in-time snapshot across Sessions.
     * It is membership and every base row as of ONE instant, and each
     * Session's EVENTS folded at or after that instant. Two rows in one
     * listing may therefore reflect logs read microseconds apart.
     *
     * That is a real weakening of what a single transaction promised, so it
     * is stated rather than left to be discovered. What makes it sound:
     *
     *  - Sessions are independent aggregates. No Session's projection reads
     *    another's log, so there is no cross-Session invariant for the skew
     *    to break. A caller that ever needs two Sessions to agree about one
     *    fact needs a different read, and needed one before this too.
     *  - Each Session's own fold is still atomic: it happens inside one
     *    transaction, so no projection is ever half-applied.
     *  - Base rows are carried from the membership transaction, not re-read
     *    per chunk. The one field that moves under the insert-only contract
     *    (`ticketId`, cleared by a Ticket delete) is therefore uniform across
     *    the listing — MORE consistent than re-reading would be, not less.
     *  - A row cannot disappear mid-listing except by project delete, which
     *    takes the entire project with it.
     *
     * What it buys: the main process and every writer get a turn in between,
     * instead of waiting out a fold whose length is the project's roster.
     */
    async listSessions(query) {
      // Membership is decided once, in its own transaction, and the rows it
      // returns are carried to the folds below rather than re-read there.
      const rows = await ports.ledger.transaction((transaction) => transaction.listSessions(query));
      const projections: SessionProjection[] = [];
      for (let from = 0; from < rows.length; from += SESSION_LISTING_FOLD_CHUNK) {
        // Between chunks, never after the last one: a turn nobody needs is
        // still a turn the caller waits for.
        if (from > 0) await yieldToHost();
        const chunk = rows.slice(from, from + SESSION_LISTING_FOLD_CHUNK);
        projections.push(
          ...(await ports.ledger.transaction((transaction) =>
            chunk.map((session) => listingProjection(transaction, session)),
          )),
        );
      }
      return projections;
    },

    async countSessions(query) {
      return ports.ledger.transaction((transaction) => transaction.countSessions(query));
    },

    async listSessionStarts(query) {
      return ports.ledger.transaction((transaction) => transaction.listSessionStarts(query));
    },

    async listLatestTicketSignals(query) {
      return ports.ledger.transaction((transaction) => transaction.listLatestTicketSignals(query));
    },

    async listEvents(query) {
      return ports.ledger.transaction((transaction) => transaction.listEvents(query));
    },

    async latestEventSequence(query) {
      return ports.ledger.transaction((transaction) =>
        transaction.latestEventSequence(query.sessionId),
      );
    },

    async getProjectionCheckpoint(query) {
      return ports.ledger.transaction((transaction) =>
        transaction.getProjectionCheckpoint(query.sessionId),
      );
    },

    async saveProjectionCheckpoint(checkpoint) {
      return ports.ledger.transaction((transaction) =>
        transaction.saveProjectionCheckpoint(checkpoint),
      );
    },

    async reportUsage(query) {
      return ports.ledger.transaction((transaction) =>
        // The floor is read in the SAME transaction as the rows. Two reads
        // would let an upgrade land between them and produce a report that
        // claimed complete coverage of rows it had not seen.
        reportSessionUsage(transaction.listUsage(query), {
          ...query,
          meteredFrom: transaction.usageMeteredFrom(),
        }),
      );
    },
  };
}

/**
 * How far the persisted checkpoint may fall behind the log before a write path
 * refreshes it.
 *
 * A checkpoint that is only ever written when an attachment closes does not
 * bound anything for the Session that is currently running: the tail grows for
 * the whole attachment, which is exactly the span a long chat spends appending
 * facts. Refreshing it costs one derived row; NOT refreshing it costs a fold
 * over that row's worth of events on every durable fact, forever. So the
 * cadence is a bound on both: at most this many events are ever re-folded, and
 * at most one cache row is written per this many appends.
 */
export const CHECKPOINT_REFRESH_EVENTS = 64;

/**
 * How many Sessions one listing transaction folds before the ledger is handed
 * back and the host gets a turn (VC-388).
 *
 * This is the unit of two separate costs, which is why one number sets both:
 * the span the ledger is held against other writers, and the span the host
 * process cannot run a timer or answer IPC. Each Session inside the chunk is
 * bounded to a {@link CHECKPOINT_REFRESH_EVENTS}-event tail by its checkpoint,
 * so the worst case per chunk is this many folds of that tail — not a function
 * of how many Sessions the project has.
 *
 * Eight is measured, not guessed, and the measurement is in
 * `docs/research/perf/session-listing-vc388.md`. Two results shaped it. Total
 * time is nearly FLAT across chunk sizes — a 60-Session roster costs about the
 * same whether it is folded in one transaction or sixty — so a fine chunk buys
 * its shorter block almost for free. But the yield primitive is not free: a
 * host that falls back to `setTimeout` pays that clamp once per chunk, which
 * takes a per-Session chunk from 14ms to 84ms. Eight is the size whose longest
 * block stays inside a frame on BOTH primitives (3.6ms with `setImmediate`,
 * 9.8ms without), so a host with a coarse timer degrades instead of falling
 * off a cliff.
 */
export const SESSION_LISTING_FOLD_CHUNK = 8;

/**
 * A macrotask turn, on the best primitive the host actually has.
 *
 * `setImmediate` runs in the check phase with no floor. `setTimeout(0)` is
 * clamped to a millisecond by Node and to four by browsers after nesting, and
 * that clamp is the single largest term in a chunked listing's wall time — it
 * is paid once per chunk and has nothing to do with the work. Feature-detected
 * rather than injected because every host benefits and none of them should
 * have to know this; a host whose only macrotask has a floor (a browser, where
 * `MessageChannel` is the no-clamp spelling) can still pass
 * {@link SessionEnginePorts.yieldToHost}.
 */
const hostSetImmediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
  .setImmediate;

const defaultYieldToHost: () => Promise<void> =
  typeof hostSetImmediate === "function"
    ? () =>
        new Promise<void>((resolve) => {
          hostSetImmediate(() => {
            resolve();
          });
        })
    : () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

/**
 * How many Sessions keep a folded listing row in memory (VC-388).
 *
 * The cache's whole job is to let a repeat listing skip the Sessions that did
 * not move, so a limit below a project's roster would be worse than no cache
 * at all: each listing would evict its own earliest entries before reaching
 * its last row, and every visit would pay a full fold AND the bookkeeping.
 * The number is therefore sized to clear plausible ROSTERS rather than to a
 * memory budget — and it has to clear several at once, because the listing
 * callers are not all one project's UI (`pty/manager.ts` lists every project's
 * Sessions to compute a concurrency budget).
 *
 * A held row measured 5.6 KB for an ordinary Session and 79.8 KB for a
 * deliberately extreme one — 450 events carrying 150 commands and their
 * receipts — so this ceiling is about 1.4 MB in the shape a real roster has
 * and about 20 MB in a shape that would need 256 such Sessions to reach. See
 * `docs/research/perf/session-listing-vc388.md`.
 */
export const SESSION_LISTING_CACHE_LIMIT = 256;

/**
 * One Session's folded listing row, and everything needed to prove it current.
 *
 * The cursor alone is not a key. A Session's projection is a function of its
 * event log AND of the immutable row the fold starts from, and one field of
 * that row does move underneath the ledger's insert-only contract:
 * `ticketId` is cleared when a Ticket is deleted. Keying on the sequence only
 * would serve a listing that still named a Ticket that no longer exists, with
 * no event having been appended to say otherwise. So the row is kept beside
 * the cursor and compared, which also costs nothing to be right about if some
 * future store lets another field move.
 */
interface ListingFold {
  session: Session;
  /** Log head at the moment of the fold, from the metadata-only read. */
  throughSequence: number;
  projection: SessionProjection;
}

interface StoredSessionProjection {
  checkpoint: SessionProjectionCheckpoint;
  /**
   * Cursor of the checkpoint as PERSISTED, or null when none was usable.
   * `checkpoint` has already been advanced past this, so only this value can
   * say how stale the durable cache is.
   */
  persistedThrough: number | null;
}

function storedSessionProjection(
  transaction: SessionLedgerTransaction,
  session: Session,
  onCheckpointFailure: (error: unknown) => void,
): StoredSessionProjection {
  try {
    const checkpoint = transaction.getProjectionCheckpoint(session.id);
    if (checkpoint) {
      // The fold read, not the audit read: a listing over every Session would
      // otherwise JSON-decode one provenance per event to produce state that
      // never looks at it (VC-355).
      const tail = transaction.listProjectionEvents({
        sessionId: session.id,
        afterSequence: checkpoint.throughSequence,
      });
      return {
        checkpoint: advanceSessionProjection(checkpoint, tail, session),
        persistedThrough: checkpoint.throughSequence,
      };
    }
  } catch (error) {
    // A projection checkpoint is a rebuildable cache. Any unsupported,
    // malformed, or stale value falls through to the immutable event log —
    // reported, so a cache that never succeeds is visible as more than slowness.
    onCheckpointFailure(error);
  }

  return {
    checkpoint: createSessionProjectionCheckpoint(
      session,
      transaction.listProjectionEvents({ sessionId: session.id }),
    ),
    persistedThrough: null,
  };
}

function projectStoredSession(
  transaction: SessionLedgerTransaction,
  session: Session,
  onCheckpointFailure: (error: unknown) => void,
): SessionProjection {
  return storedSessionProjection(transaction, session, onCheckpointFailure).checkpoint.projection;
}

/**
 * Folds one just-appended fact into the derived cache when it has drifted far
 * enough to be worth a write. Never throws: the checkpoint is rebuildable, so
 * a failed refresh is slower, not wrong.
 */
function refreshProjectionCheckpoint(
  transaction: SessionLedgerTransaction,
  session: Session,
  stored: StoredSessionProjection,
  appended: SessionEvent,
  onCheckpointFailure: (error: unknown) => void,
): void {
  if (appended.sequence - (stored.persistedThrough ?? 0) < CHECKPOINT_REFRESH_EVENTS) return;
  try {
    transaction.saveProjectionCheckpoint(
      advanceSessionProjection(stored.checkpoint, [appended], session),
    );
  } catch (error) {
    onCheckpointFailure(error);
  }
}

/**
 * The `model.selected` fact for a `model.select` intent. The tier rides along
 * only when the intent named one (VC-259), so an exact-id pick writes the
 * same bytes it always did.
 */
function modelSelectedPayload(
  intent: Extract<SessionCommandIntent, { kind: "model.select" }>,
): Extract<SessionEventPayload, { kind: "model.selected" }> {
  return {
    kind: "model.selected",
    selection: intent.selection,
    ...(intent.tier === undefined ? {} : { tier: intent.tier }),
  };
}

function replayCreate(
  transaction: SessionLedgerTransaction,
  request: CreateSessionRequest,
): CreateSessionResult {
  const stored = transaction.getCommand(request.commandId);
  if (!stored || !sameCreateSessionRequest(stored, request)) {
    throw new SessionEngineConflictError(
      `Command ${request.commandId} was already accepted with different intent`,
    );
  }
  // VC-358: the requested id, when the replaying request carries one, must be
  // the id the command was first accepted under — a promote that replays with
  // a different client-minted id is a different intent, not the same one.
  if (request.requestedSessionId && stored.sessionId !== request.requestedSessionId) {
    throw new SessionEngineConflictError(
      `Command ${stored.id} was accepted for Session ${stored.sessionId}, not ${request.requestedSessionId}`,
    );
  }
  const receipt = transaction.listReceipts(stored.id).find(isCreateReceipt);
  if (!receipt) throw new SessionEngineConflictError(`Command ${stored.id} has no create receipt`);
  const session = transaction.getSession(stored.sessionId);
  if (!session) throw new SessionEngineConflictError(`Command ${stored.id} has no Session`);
  if (receipt.result.sessionId !== session.id) {
    throw new SessionEngineConflictError(
      `Command ${stored.id} has a create receipt for another Session`,
    );
  }
  const events = transaction.listEvents({ sessionId: session.id });
  const commandEvent = commandEventFor(events, stored.id);
  const event = events.find(
    (candidate) =>
      candidate.payload.kind === "session.created" && candidate.commandId === stored.id,
  );
  const receiptEvent = receiptEventFor(events, receipt.id);
  if (
    !commandEvent ||
    commandEvent.sessionId !== session.id ||
    !event ||
    event.sessionId !== session.id ||
    !receiptEvent ||
    receiptEvent.sessionId !== session.id
  ) {
    throw new SessionEngineConflictError(`Command ${stored.id} has incomplete durable history`);
  }
  if (
    commandEvent.payload.kind !== "command.recorded" ||
    !sameSessionCommand(commandEvent.payload.command, stored) ||
    event.payload.kind !== "session.created" ||
    !sameSession(event.payload.session, session) ||
    receiptEvent.payload.kind !== "command.receipt.recorded" ||
    !sameCommandReceipt(receiptEvent.payload.receipt, receipt)
  ) {
    throw new SessionEngineConflictError(
      `Command ${stored.id} has history that does not match Session`,
    );
  }
  return { session, command: stored, commandEvent, event, receipt, receiptEvent };
}

function sameCreateSessionRequest(command: SessionCommand, request: CreateSessionRequest): boolean {
  return (
    command.id === request.commandId &&
    command.intent.kind === "session.create" &&
    command.intent.projectId === request.projectId &&
    command.intent.ticketId === request.ticketId &&
    command.intent.role === request.role &&
    command.intent.parentSessionId === request.parentSessionId &&
    command.intent.title === request.title
  );
}

function sameSession(left: Session, right: Session): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.ticketId === right.ticketId &&
    left.role === right.role &&
    left.parentSessionId === right.parentSessionId &&
    left.title === right.title &&
    left.createdAt === right.createdAt
  );
}

function replaySubmit(
  transaction: SessionLedgerTransaction,
  session: Session,
  command: SessionCommandRequest,
): SubmitSessionCommandResult {
  const stored = transaction.getCommand(command.id);
  if (!stored || !sameSessionCommandRequest(stored, command)) {
    throw new SessionEngineConflictError(
      `Command ${command.id} was already accepted with different intent`,
    );
  }
  const events = transaction.listEvents({ sessionId: session.id });
  const commandEvent = commandEventFor(events, command.id);
  if (!commandEvent || commandEvent.sessionId !== session.id) {
    throw new SessionEngineConflictError(`Command ${command.id} has no recorded event`);
  }
  const receipt = transaction.listReceipts(command.id).at(-1) ?? null;
  const receiptEvent = receipt ? receiptEventFor(events, receipt.id) : null;
  if (receipt && (!receiptEvent || receiptEvent.sessionId !== session.id)) {
    throw new SessionEngineConflictError(`Receipt ${receipt.id} has no Session event`);
  }
  if (
    stored.intent.kind === "model.select" &&
    receipt?.status === "completed" &&
    receipt.result.kind === "model.selected"
  ) {
    const selectedEvent = events.find(
      (event) => event.commandId === stored.id && event.payload.kind === "model.selected",
    );
    if (
      !selectedEvent ||
      !receiptEvent ||
      !(
        commandEvent.sequence < selectedEvent.sequence &&
        selectedEvent.sequence < receiptEvent.sequence
      )
    ) {
      throw new SessionEngineConflictError(
        `Command ${stored.id} has incomplete model selection history`,
      );
    }
    if (
      selectedEvent.payload.kind !== "model.selected" ||
      selectedEvent.payload.selection.providerId !== stored.intent.selection.providerId ||
      selectedEvent.payload.selection.modelId !== stored.intent.selection.modelId ||
      selectedEvent.payload.selection.reasoningLevel !== stored.intent.selection.reasoningLevel ||
      receipt.result.sessionId !== session.id
    ) {
      throw new SessionEngineConflictError(
        `Command ${stored.id} has model selection history that does not match intent`,
      );
    }
  }
  return {
    command: stored,
    commandEvent,
    receipt,
    receiptEvent,
  };
}

function commandRecordedEvent(
  id: string,
  sessionId: string,
  sequence: number,
  occurredAt: number,
  provenance: SessionEventProvenance,
  command: SessionCommand,
): SessionEvent {
  return {
    id,
    sessionId,
    sequence,
    occurredAt,
    recordedAt: occurredAt,
    provenance,
    commandId: command.id,
    payload: { kind: "command.recorded", command },
  };
}

function receiptRecordedEvent(
  id: string,
  sessionId: string,
  sequence: number,
  occurredAt: number,
  provenance: SessionEventProvenance,
  receipt: CommandReceipt,
  attachmentId?: string | null,
): ReceiptRecordedSessionEvent {
  return {
    id,
    sessionId,
    sequence,
    occurredAt,
    recordedAt: receipt.recordedAt,
    provenance,
    attachmentId,
    commandId: receipt.commandId,
    payload: { kind: "command.receipt.recorded", receipt },
  };
}

type ReceiptRecordedSessionEvent = SessionEvent & {
  payload: Extract<SessionEventPayload, { kind: "command.receipt.recorded" }>;
};

function completedReceipt(
  id: string,
  commandId: string,
  sequence: number,
  recordedAt: number,
  result: CommandReceiptResult,
): CommandReceipt {
  return { id, commandId, status: "completed", recordedAt, sequence, result };
}

function stampReceipt(
  observed: UnstampedCommandReceipt,
  sequence: number,
  recordedAt: number,
): CommandReceipt {
  return { ...observed, sequence, recordedAt };
}

function rejectionFor(
  projection: SessionProjection,
  command: SessionCommand,
  routeRejection: CommandRouteRejection | null,
): UnstampedCommandReceipt | null {
  if (projection.status === "archived") {
    return {
      id: `rejected:${command.id}`,
      commandId: command.id,
      status: "rejected",
      code:
        command.intent.kind === "session.archive" ? "session_already_archived" : "session_archived",
      detail: `Session ${projection.session.id} is archived`,
    };
  }
  if (command.intent.kind === "model.select" && projection.turnActive) {
    return {
      id: `rejected:${command.id}`,
      commandId: command.id,
      status: "rejected",
      code: "turn_active",
      detail: "The model cannot change while a turn is active",
    };
  }
  if (!routeRejection) return null;
  return {
    id: `rejected:${command.id}`,
    commandId: command.id,
    status: "rejected",
    code: routeRejection.code,
    detail: routeRejection.detail,
  };
}

interface CommandRouteRejection {
  code:
    | "no_live_executor"
    | "interaction_unavailable"
    | "attachment_unavailable"
    | "live_executor_exists"
    | "executor_start_pending";
  detail: string;
}

interface CommandRouteResolution {
  route: SessionCommandRoute | null;
  rejection: CommandRouteRejection | null;
}

function resolveCommandRoute(
  projection: SessionProjection,
  intent: Exclude<SessionCommandIntent, { kind: "session.create" }>,
): CommandRouteResolution {
  switch (intent.kind) {
    case "executor.start":
      return projection.liveExecutor
        ? {
            route: null,
            rejection: {
              code: "live_executor_exists",
              detail: `Session ${projection.session.id} already has a live executor`,
            },
          }
        : projection.pendingExecutorStart
          ? {
              route: null,
              rejection: {
                code: "executor_start_pending",
                detail: `Executor start ${projection.pendingExecutorStart.id} is still pending`,
              },
            }
          : { route: { adapterId: intent.adapterId, attachmentId: null }, rejection: null };
    case "message.submit": {
      const attachment = projection.liveExecutor;
      return attachment
        ? {
            route: { adapterId: attachment.adapterId, attachmentId: attachment.id },
            rejection: null,
          }
        : {
            route: null,
            rejection: {
              code: "no_live_executor",
              detail: "No live executor can receive this message",
            },
          };
    }
    case "interaction.resolve": {
      const interaction = projection.interactions.active.find(
        (candidate) => candidate.id === intent.interactionId,
      );
      if (!interaction || interaction.attachmentId !== intent.attachmentId) {
        return {
          route: null,
          rejection: {
            code: "interaction_unavailable",
            detail: `Interaction ${intent.interactionId} is not open on attachment ${intent.attachmentId}`,
          },
        };
      }
      const attachment = projection.attachments.find(
        (candidate) => candidate.id === intent.attachmentId,
      );
      return attachment?.status === "open"
        ? {
            route: { adapterId: attachment.adapterId, attachmentId: attachment.id },
            rejection: null,
          }
        : {
            route: null,
            rejection: {
              code: "attachment_unavailable",
              detail: `Attachment ${intent.attachmentId} is not open`,
            },
          };
    }
    case "executor.stop":
    case "executor.interrupt":
    case "executor.retry":
    case "context.compact": {
      const attachment = projection.attachments.find(
        (candidate) => candidate.id === intent.attachmentId,
      );
      return attachment?.status === "open"
        ? {
            route: { adapterId: attachment.adapterId, attachmentId: attachment.id },
            rejection: null,
          }
        : {
            route: null,
            rejection: {
              code: "attachment_unavailable",
              detail: `Attachment ${intent.attachmentId} is not open`,
            },
          };
    }
    case "model.select": {
      const attachment = projection.liveExecutor;
      return attachment
        ? {
            route: { adapterId: attachment.adapterId, attachmentId: attachment.id },
            rejection: null,
          }
        : { route: null, rejection: null };
    }
    case "session.archive":
    case "session.retitle":
    case "session.signal":
    case "session.stop":
      return { route: null, rejection: null };
  }
}

function assertObservableFact(
  projection: SessionProjection,
  observation: Exclude<SessionObservation, { kind: "command.receipt" }>,
): void {
  if (observation.kind === "attachment.opened") {
    if (projection.status === "archived") {
      throw new SessionEngineConflictError(`Session ${projection.session.id} is archived`);
    }
    assertNewAttachment(projection, observation.attachment);
    if (projection.liveExecutor) {
      throw new SessionEngineConflictError(
        `Session ${projection.session.id} already has live executor ${projection.liveExecutor.id}`,
      );
    }
    return;
  }
  if (observation.kind === "attachment.failed") {
    assertNewAttachment(projection, observation.attachment);
    return;
  }

  const attachmentId = observationAttachmentId(observation);
  if (!attachmentId) return;
  const attachment = projection.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) throw new SessionEngineConflictError(`Attachment ${attachmentId} is unknown`);
  // Every other observation asserts something a live binding did, and a closed
  // binding does nothing — so requiring an open attachment is what keeps them
  // honest. A cancellation asserts the opposite: that the ask ended with nobody
  // deciding it. Closing the attachment does not clear the interactions it
  // opened, so refusing this one is what strands them — the card stays in
  // `active` with nothing left alive that could ever answer it.
  if (attachment.status !== "open" && observation.kind !== "interaction.cancelled") {
    throw new SessionEngineConflictError(`Attachment ${attachmentId} is already closed`);
  }
  if (
    observation.kind === "attachment.native_referenced" &&
    (observation.provenance.source.kind !== "adapter" ||
      observation.provenance.source.id !== attachment.adapterId)
  ) {
    throw new SessionEngineConflictError(
      `Native reference for attachment ${attachmentId} must be produced by adapter ${attachment.adapterId}`,
    );
  }
  if (
    (observation.kind === "interaction.opened" || observation.kind === "interaction.resolved") &&
    (observation.provenance.source.kind !== "adapter" ||
      observation.provenance.source.id !== attachment.adapterId)
  ) {
    throw new SessionEngineConflictError(
      `${observation.kind} for attachment ${attachmentId} must be produced by adapter ${attachment.adapterId}`,
    );
  }
  // Both verbs end an interaction, so both owe the same proof that it is theirs
  // to end. Cancelling needs it more, not less: it is the one observation a
  // closed attachment may still make, and without this an attachment could
  // reach across and delete an interaction another one is still waiting on.
  if (observation.kind === "interaction.resolved" || observation.kind === "interaction.cancelled") {
    const interaction = projection.interactions.active.find(
      (candidate) => candidate.id === observation.interactionId,
    );
    if (!interaction || interaction.attachmentId !== attachment.id) {
      throw new SessionEngineConflictError(
        `Interaction ${observation.interactionId} is not open on attachment ${attachment.id}`,
      );
    }
  }
}

function assertPendingStartReservation(
  projection: SessionProjection,
  observation: Exclude<SessionObservation, { kind: "command.receipt" }>,
): void {
  if (
    observation.kind === "attachment.opened" &&
    projection.pendingExecutorStart &&
    observation.commandId !== projection.pendingExecutorStart.id
  ) {
    throw new SessionEngineConflictError(
      `Session ${projection.session.id} has pending executor start ${projection.pendingExecutorStart.id}`,
    );
  }
}

function assertNewAttachment(projection: SessionProjection, attachment: SessionAttachment): void {
  if (attachment.sessionId !== projection.session.id) {
    throw new SessionEngineConflictError(`Attachment ${attachment.id} belongs to another Session`);
  }
  if (projection.attachments.some((candidate) => candidate.id === attachment.id)) {
    throw new SessionEngineConflictError(`Attachment ${attachment.id} already exists`);
  }
}

function assertReceiptObservation(
  transaction: SessionLedgerTransaction,
  session: Session,
  projection: SessionProjection,
  observation: Extract<SessionObservation, { kind: "command.receipt" }>,
): void {
  const command = assertReceiptCommandOwnership(transaction, session, observation);
  assertReceiptMatchesCommand(command, session, observation.receipt);
  assertAdapterReceiptRoute(command, observation);

  const attachmentId = observationAttachmentId(observation);
  if (!attachmentId) return;
  const attachment = projection.attachments.find((candidate) => candidate.id === attachmentId);
  if (
    !attachment ||
    observation.provenance.source.kind !== "adapter" ||
    observation.provenance.source.id !== attachment.adapterId
  ) {
    throw new SessionEngineConflictError(
      `Receipt ${observation.receipt.id} has invalid attachment evidence`,
    );
  }
}

function assertReceiptCommandOwnership(
  transaction: SessionLedgerTransaction,
  session: Session,
  observation: Extract<SessionObservation, { kind: "command.receipt" }>,
): SessionCommand {
  const command = transaction.getCommand(observation.receipt.commandId);
  if (!command || !commandBelongsToSession(command, session)) {
    throw new SessionEngineConflictError(
      `Receipt ${observation.receipt.id} does not belong to Session ${session.id}`,
    );
  }
  if (
    command.intent.kind === "session.create" ||
    command.intent.kind === "session.archive" ||
    command.intent.kind === "session.retitle" ||
    command.intent.kind === "session.signal"
  ) {
    throw new SessionEngineConflictError(
      `Receipt ${observation.receipt.id} cannot be externally observed`,
    );
  }
  return command;
}

function assertAttachmentStartRoute(
  transaction: SessionLedgerTransaction,
  observation: Exclude<SessionObservation, { kind: "command.receipt" }>,
): void {
  if (
    (observation.kind !== "attachment.opened" && observation.kind !== "attachment.failed") ||
    !observation.commandId
  ) {
    return;
  }
  const command = transaction.getCommand(observation.commandId);
  if (
    command?.intent.kind === "executor.start" &&
    command.route?.adapterId !== observation.attachment.adapterId
  ) {
    throw new SessionEngineConflictError(
      `Attachment ${observation.attachment.id} does not match command ${command.id} route`,
    );
  }
}

function assertObservationCausation(
  transaction: SessionLedgerTransaction,
  session: Session,
  observation: Exclude<SessionObservation, { kind: "command.receipt" }>,
): void {
  if (!observation.commandId) return;
  const command = transaction.getCommand(observation.commandId);
  if (!command || !commandBelongsToSession(command, session)) {
    throw new SessionEngineConflictError(
      `Command ${observation.commandId} does not belong to Session ${session.id}`,
    );
  }
}

function commandBelongsToSession(command: SessionCommand, session: Session): boolean {
  return command.sessionId === session.id;
}

function assertReceiptMatchesCommand(
  command: SessionCommand,
  session: Session,
  receipt: UnstampedCommandReceipt,
): void {
  if (receipt.status === "accepted" || receipt.status === "completed") {
    if (
      receipt.result.kind !== expectedResultKind(command.intent.kind) ||
      receipt.result.sessionId !== session.id
    ) {
      throw new SessionEngineConflictError(
        `Receipt ${receipt.id} does not match command ${command.id}`,
      );
    }
  }
}

function assertAdapterReceiptRoute(
  command: SessionCommand,
  observation: Extract<SessionObservation, { kind: "command.receipt" }>,
): void {
  const route = command.route;
  if (!route) {
    throw new SessionEngineConflictError(`Command ${command.id} has no adapter delivery route`);
  }
  if (
    observation.provenance.source.kind !== "adapter" ||
    observation.provenance.source.id !== route.adapterId
  ) {
    throw new SessionEngineConflictError(
      `Receipt ${observation.receipt.id} was not produced by adapter ${route.adapterId}`,
    );
  }
  if (
    (command.intent.kind === "message.submit" ||
      command.intent.kind === "model.select" ||
      command.intent.kind === "interaction.resolve" ||
      command.intent.kind === "executor.stop" ||
      command.intent.kind === "executor.interrupt" ||
      command.intent.kind === "executor.retry" ||
      command.intent.kind === "context.compact") &&
    observationAttachmentId(observation) !== route.attachmentId
  ) {
    throw new SessionEngineConflictError(
      `Receipt ${observation.receipt.id} does not match routed attachment`,
    );
  }
}

function expectedResultKind(intent: SessionCommandIntent["kind"]): CommandReceiptResult["kind"] {
  const resultKinds: Record<SessionCommandIntent["kind"], CommandReceiptResult["kind"]> = {
    "session.create": "session.created",
    "session.archive": "session.archived",
    "session.retitle": "session.retitled",
    "session.signal": "session.signaled",
    "session.stop": "session.stopped",
    "model.select": "model.selected",
    "executor.start": "executor.start.requested",
    "executor.stop": "executor.stop.requested",
    "executor.interrupt": "executor.interrupted",
    "executor.retry": "executor.retried",
    "context.compact": "context.compacted",
    "message.submit": "message.submitted",
    "interaction.resolve": "interaction.resolved",
  };
  return resultKinds[intent];
}

function observationAttachmentId(observation: SessionObservation): string | null | undefined {
  switch (observation.kind) {
    case "attachment.opened":
    case "attachment.failed":
      return observation.attachment.id;
    case "attention.raised":
      return observation.attention.attachmentId;
    case "interaction.opened":
      return observation.interaction.attachmentId;
    default:
      return observation.attachmentId;
  }
}

function commandEventFor(events: readonly SessionEvent[], commandId: string): SessionEvent | null {
  return (
    events.find(
      (event) =>
        event.payload.kind === "command.recorded" && event.payload.command.id === commandId,
    ) ?? null
  );
}

function receiptEventFor(events: readonly SessionEvent[], receiptId: string): SessionEvent | null {
  return (
    events.find(
      (event) =>
        event.payload.kind === "command.receipt.recorded" && event.payload.receipt.id === receiptId,
    ) ?? null
  );
}

function isCreateReceipt(
  receipt: CommandReceipt,
): receipt is CommandReceipt & { result: CommandReceiptResult } {
  return (
    (receipt.status === "accepted" || receipt.status === "completed") &&
    receipt.result.kind === "session.created"
  );
}
