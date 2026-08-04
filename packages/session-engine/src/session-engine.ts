import {
  observationPayload,
  projectSession,
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
  ListLatestTicketSignalsQuery,
  ListSessionEventsQuery,
  Session,
  SessionAttachment,
  SessionCommand,
  SessionCommandIntent,
  SessionCommandRequest,
  SessionCommandRoute,
  SessionEvent,
  SessionEventPayload,
  SessionEventProvenance,
  SessionLedger,
  SessionLedgerClock,
  SessionLedgerIds,
  SessionLedgerTransaction,
  SessionObservation,
  SessionProjection,
  LatestSessionSignal,
  UnstampedCommandReceipt,
} from "@volli/shared";

export interface CreateSessionRequest {
  commandId: string;
  projectId: string;
  ticketId: string | null;
  title: string | null;
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

export interface SessionEngine {
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  observe(observation: SessionObservation): Promise<SessionEvent>;
  submit(request: SubmitSessionCommandRequest): Promise<SubmitSessionCommandResult>;
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
  listSessions(query: ListSessionsQuery): Promise<readonly SessionProjection[]>;
  countSessions(query: ListSessionsQuery): Promise<number>;
  listLatestTicketSignals(
    query: ListLatestTicketSignalsQuery,
  ): Promise<readonly LatestSessionSignal[]>;
  listEvents(query: ListSessionEventsQuery): Promise<readonly SessionEvent[]>;
}

export interface SessionEnginePorts {
  ledger: SessionLedger;
  clock: SessionLedgerClock;
  ids: SessionLedgerIds;
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
  return {
    async createSession(request) {
      return ports.ledger.transaction((transaction) => {
        const createdAt = ports.clock.now();
        const existing = transaction.getCommand(request.commandId);
        if (existing) return replayCreate(transaction, request);

        const session: Session = {
          id: ports.ids.next("session"),
          projectId: request.projectId,
          ticketId: request.ticketId,
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

    async observe(observation) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(observation.sessionId);
        if (!session) throw new SessionEngineNotFoundError(observation.sessionId);
        const events = transaction.listEvents({ sessionId: session.id });
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
            const event = receiptEventFor(events, existingReceipt.id);
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

          const projection = projectSession(session, events, ports.clock.now());
          assertReceiptObservation(transaction, session, projection, observation);
          const sequence = nextSequence(events);
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
          return event;
        }

        const payload = observationPayload(observation);
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

        const projection = projectSession(session, events, ports.clock.now());
        assertObservableFact(projection, observation);
        assertPendingStartReservation(projection, observation);
        const event: SessionEvent = {
          id: observation.id,
          sessionId: session.id,
          sequence: nextSequence(events),
          occurredAt: observation.occurredAt,
          recordedAt: ports.clock.now(),
          provenance: observation.provenance,
          attachmentId,
          commandId,
          payload,
        };
        transaction.appendEvent(event);
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

        const events = transaction.listEvents({ sessionId: session.id });
        const projection = projectSession(session, events, ports.clock.now());
        const routeResolution = resolveCommandRoute(projection, request.intent);
        const command: SessionCommand = {
          ...commandRequest,
          createdAt: ports.clock.now(),
          route: routeResolution.route,
        };
        const commandEvent = commandRecordedEvent(
          ports.ids.next("event"),
          session.id,
          nextSequence(events),
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
          command.intent.kind !== "session.signal"
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
                : { kind: "session.signaled", sessionId: session.id },
          ),
        );
        transaction.appendReceipt(receiptEvent.payload.receipt);
        transaction.appendEvent(receiptEvent);
        return { command, commandEvent, receipt: receiptEvent.payload.receipt, receiptEvent };
      });
    },

    async getSession(query) {
      return ports.ledger.transaction((transaction) => {
        const session = transaction.getSession(query.sessionId);
        return session
          ? projectSession(
              session,
              transaction.listEvents({ sessionId: session.id }),
              ports.clock.now(),
            )
          : null;
      });
    },

    async getBaseSession(query) {
      return ports.ledger.transaction((transaction) => transaction.getSession(query.sessionId));
    },

    async listSessions(query) {
      return ports.ledger.transaction((transaction) =>
        transaction
          .listSessions(query)
          .map((session) =>
            projectSession(
              session,
              transaction.listEvents({ sessionId: session.id }),
              ports.clock.now(),
            ),
          ),
      );
    },

    async countSessions(query) {
      return ports.ledger.transaction((transaction) => transaction.countSessions(query));
    },

    async listLatestTicketSignals(query) {
      return ports.ledger.transaction((transaction) => transaction.listLatestTicketSignals(query));
    },

    async listEvents(query) {
      return ports.ledger.transaction((transaction) => transaction.listEvents(query));
    },
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
    command.intent.title === request.title
  );
}

function sameSession(left: Session, right: Session): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.ticketId === right.ticketId &&
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
    case "executor.interrupt": {
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
    case "session.archive":
    case "session.retitle":
    case "session.signal":
      return { route: null, rejection: null };
  }
}

function nextSequence(events: readonly SessionEvent[]): number {
  return (events.at(-1)?.sequence ?? 0) + 1;
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
  if (!attachmentId) {
    if (
      observation.kind === "capabilities.updated" &&
      (observation.provenance.source.kind !== "adapter" ||
        observation.provenance.source.id !== observation.snapshot.adapterId)
    ) {
      throw new SessionEngineConflictError(
        `Capability snapshot ${observation.snapshot.id} must be produced by adapter ${observation.snapshot.adapterId}`,
      );
    }
    return;
  }
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
    (observation.kind === "capabilities.updated" ||
      observation.kind === "interaction.opened" ||
      observation.kind === "interaction.resolved") &&
    (observation.provenance.source.kind !== "adapter" ||
      observation.provenance.source.id !== attachment.adapterId)
  ) {
    throw new SessionEngineConflictError(
      `${observation.kind} for attachment ${attachmentId} must be produced by adapter ${attachment.adapterId}`,
    );
  }
  if (
    observation.kind === "capabilities.updated" &&
    (observation.snapshot.attachmentId !== attachment.id ||
      observation.snapshot.adapterId !== attachment.adapterId)
  ) {
    throw new SessionEngineConflictError(
      `Capability snapshot ${observation.snapshot.id} does not match attachment ${attachment.id}`,
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
      command.intent.kind === "interaction.resolve" ||
      command.intent.kind === "executor.stop" ||
      command.intent.kind === "executor.interrupt") &&
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
    "executor.start": "executor.start.requested",
    "executor.stop": "executor.stop.requested",
    "executor.interrupt": "executor.interrupted",
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
    case "capabilities.updated":
      return observation.snapshot.attachmentId;
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
