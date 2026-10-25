/** Internal queue execution. The event ledger still owns delivered messages. */
import {
  QueueRevisionConflictError,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionProjection,
  type SessionEventProvenance,
  type RunnerIdentity,
} from "@volli/shared";
import {
  projectSessionFollowUps,
  sessionFollowUpDeliveryCommandId,
  sessionFollowUpDeliveryEvidence,
  type SessionFollowUpCommand,
  type StoredSessionFollowUp,
} from "../session-follow-ups";
import { canonicalJson } from "../transcript-artifacts";
import { NativeAttachmentError, type NativeHarnessAdapter } from "../native-adapter";
import {
  SessionRuntimeConflictError,
  SessionRuntimeCommandConflictError,
} from "../session-runtime-errors";
import type {
  SessionClientCommand,
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
  SessionRuntimePorts,
  SessionRuntimeProjectionSnapshot,
  SessionStreamQueue,
  SessionLocation,
  SessionMessageDeliveryFailure,
  SessionRuntimeIds,
} from "../session-runtime";

type ExistingSessionCommandRequest = Extract<SessionRuntimeCommandRequest, { sessionId: string }>;
type MessageCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<SessionClientCommand, { kind: "message.submit" }>;
};
type FollowUpCommandRequest = ExistingSessionCommandRequest & {
  command: Extract<
    SessionClientCommand,
    { kind: "message.submit" | "message.edit" | "message.cancel" }
  >;
};

interface FollowUpHost {
  assertOpen(): void;
  closed(): boolean;
  turnStartsHeld(): boolean;
  inFlight(commandId: string): boolean;
  requireSession(sessionId: string): Promise<SessionProjection>;
  latestSequence(sessionId: string): Promise<number>;
  acknowledgeBootInterruption(projection: SessionProjection): Promise<SessionProjection>;
  executorStartPending(projection: SessionProjection): boolean;
  executorStartInFlight(projection: SessionProjection): boolean;
  executorFor(projection: SessionProjection): NativeHarnessAdapter;
  admitCommand(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult>;
  submitMessage(
    request: MessageCommandRequest,
    projection: SessionProjection,
    location: SessionLocation,
    existed: boolean,
    targetTurnId?: string,
  ): Promise<SessionRuntimeCommandResult>;
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
  listEventsPaged(input: { sessionId: string }): Promise<readonly SessionEvent[]>;
  id(kind: Parameters<SessionRuntimeIds["next"]>[0]): string;
  publishEvents(events: readonly SessionEvent[]): Promise<void>;
  publishQueue(emission: SessionStreamQueue): Promise<void>;
  reportFailure(input: SessionMessageDeliveryFailure): Promise<void>;
}

export class FollowUpQueue {
  #followUpDrains = new Map<string, Promise<void>>();
  #followUpDrainAgain = new Set<string>();
  #followUpDeliveryBoundaries = new Map<string, string>();
  /**
   * Delivery command ids a drain in this process holds from claim to outcome.
   * Taken inside the claim transaction, so a cancel can never remove a row a
   * drain is about to send. A `releasing` row held by nobody (and not in
   * `#inFlight`) is a claim whose sender is gone.
   */
  readonly #followUpOwned = new Set<string>();
  readonly #followUpRetries = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >();

  readonly #heldFollowUpDrains = new Set<string>();

  constructor(
    private readonly ports: SessionRuntimePorts,
    private readonly host: FollowUpHost,
  ) {}

  pendingSessionIds(): Iterable<string> {
    return this.#followUpDrains.keys();
  }

  deliveryBoundary(commandId: string): string | undefined {
    return this.#followUpDeliveryBoundaries.get(commandId);
  }

  releaseHeld(): void {
    const held = [...this.#heldFollowUpDrains];
    this.#heldFollowUpDrains.clear();
    for (const sessionId of held) this.schedule(sessionId);
  }

  close(): void {
    for (const { timer } of this.#followUpRetries.values()) clearTimeout(timer);
    this.#followUpRetries.clear();
  }

  async command(request: FollowUpCommandRequest): Promise<SessionRuntimeCommandResult> {
    const ledger = this.ports.followUps;
    if (!ledger) throw new SessionRuntimeConflictError("Host follow-up storage is unavailable");
    const projection = await this.host.requireSession(request.sessionId);
    if (projection.commands.some(({ id }) => id === request.commandId)) {
      throw new SessionRuntimeCommandConflictError(
        `Command ${request.commandId} already belongs to the event ledger`,
      );
    }
    const { origin: _origin, ...intentRequest } = request;
    const signature = canonicalJson(intentRequest);
    const command = request.command;
    const throughSequence = await this.host.latestSequence(request.sessionId);
    const now = this.ports.clock.now();
    let withdrewClaim = false;
    const result = await ledger.transaction(request.sessionId, (state, deliveryProof) => {
      const prior = Object.hasOwn(state.commands, request.commandId)
        ? state.commands[request.commandId]
        : undefined;
      if (prior) {
        if (prior.signature !== signature)
          throw new SessionRuntimeCommandConflictError(
            `Command ${request.commandId} has different intent`,
          );
        return prior.result;
      }
      // After the replay check: an accepted command answers the same forever,
      // even once the revision it acted on has moved.
      if (
        command.kind !== "message.submit" &&
        command.expectedRevision !== undefined &&
        command.expectedRevision !== state.revision
      )
        throw new QueueRevisionConflictError(command.expectedRevision, state.revision);
      const queuedCommand: SessionFollowUpCommand = {
        id: request.commandId,
        sessionId: request.sessionId,
        createdAt: now,
        route: null,
        intent:
          command.kind === "message.submit"
            ? { kind: "message.queue", message: command.message }
            : command,
      };
      let rejection: { code: string; detail: string } | null = null;
      if (command.kind === "message.submit") {
        if (projection.status !== "open")
          rejection = {
            code: "session_archived",
            detail: "An archived Session cannot queue messages",
          };
        else if (command.message.role !== "user")
          rejection = { code: "invalid_message", detail: "Only user messages can be queued" };
        else if (state.entries.some(({ id }) => id === command.message.id))
          rejection = { code: "message_exists", detail: "This message is already queued" };
        else
          state.entries.push({
            id: command.message.id,
            message: command.message,
            commandId: request.commandId,
            state: "queued",
            deliveryCommandId: sessionFollowUpDeliveryCommandId(
              request.sessionId,
              request.commandId,
            ),
            ...(request.origin === undefined ? {} : { origin: request.origin }),
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.agent === undefined ? {} : { agent: command.agent }),
            ...(command.variant === undefined ? {} : { variant: command.variant }),
          });
      } else {
        const index = state.entries.findIndex(({ id }) => id === command.messageId);
        const entry = state.entries[index];
        if (!entry)
          rejection = { code: "message_not_queued", detail: "This message is no longer queued" };
        else if (entry.state !== "queued") {
          // Both the claim and its proof are read in the queue transaction.
          // An async projection read before it can miss a late receipt/turn.
          const delivered =
            command.kind === "message.cancel"
              ? deliveryProof?.(entry.deliveryCommandId)
              : undefined;
          if (
            command.kind === "message.cancel" &&
            delivered === false &&
            !this.#busy(entry.deliveryCommandId)
          ) {
            // Nothing proves it ran: hand it back. It may still have run, which
            // the Attention says; a resend is the person's call, never ours.
            state.entries.splice(index, 1);
            state.releasedBoundary = null;
            withdrewClaim = true;
          } else
            rejection = {
              code: "message_releasing",
              detail: delivered
                ? "This message was already delivered"
                : "This message is already being delivered",
            };
        } else if (command.kind === "message.cancel") {
          state.entries.splice(index, 1);
          if (entry.refusedDetail) withdrewClaim = true;
          if (entry.refused) state.releasedBoundary = null;
        } else if (command.message.id !== command.messageId || command.message.role !== "user")
          rejection = {
            code: "invalid_message",
            detail: "An edit must retain the user message identity",
          };
        else {
          entry.message = command.message;
          entry.deliveryCommandId = sessionFollowUpDeliveryCommandId(
            request.sessionId,
            request.commandId,
          );
          if (entry.refused) state.releasedBoundary = null;
          delete entry.refused;
          delete entry.refusedDetail;
          delete entry.steer;
        }
      }
      const receipt: CommandReceipt = {
        id: `${sessionFollowUpDeliveryCommandId(request.sessionId, request.commandId)}:receipt`,
        commandId: request.commandId,
        recordedAt: now,
        sequence: throughSequence,
        ...(rejection
          ? { status: "rejected" as const, ...rejection }
          : {
              status: "accepted" as const,
              acceptedAt: now,
              result: { kind: "message.submitted" as const, sessionId: request.sessionId },
            }),
      };
      const reply: SessionRuntimeCommandResult = {
        sessionId: request.sessionId,
        command: queuedCommand,
        receipt,
        throughSequence,
        refusal: null,
      };
      Object.defineProperty(state.commands, request.commandId, {
        value: { signature, result: reply },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      state.revision += 1;
      return reply;
    });
    if (withdrewClaim) await this.#clearFailure(request.sessionId);
    // Acceptance depends on storage alone, never a running turn or Client.
    this.#notify(request.sessionId);
    // A person acting on the queue earns it a fresh retry budget.
    this.#resetRetry(request.sessionId);
    this.schedule(request.sessionId);
    return result;
  }

  #busy(deliveryCommandId: string): boolean {
    return this.host.inFlight(deliveryCommandId) || this.#followUpOwned.has(deliveryCommandId);
  }

  async withProjection(
    projection: SessionProjection,
  ): Promise<SessionRuntimeProjectionSnapshot["projection"]> {
    if (!this.ports.followUps) return projection;
    const queued = await this.ports.followUps.transaction(
      projection.session.id,
      (state) => ({
        queue: projectSessionFollowUps(state),
        queueRevision: state.revision,
      }),
      { mode: "read" },
    );
    return { ...projection, ...queued };
  }

  async emission(sessionId: string): Promise<SessionStreamQueue> {
    const queued = await this.ports.followUps!.transaction(
      sessionId,
      (state) => ({
        queue: projectSessionFollowUps(state),
        revision: state.revision,
      }),
      { mode: "read" },
    );
    return {
      kind: "queue",
      sessionId,
      throughSequence: await this.host.latestSequence(sessionId),
      ...queued,
    };
  }

  async #publish(sessionId: string): Promise<void> {
    const emission = await this.emission(sessionId);
    await this.host.publishQueue(emission);
  }

  #notify(sessionId: string): void {
    void this.#publish(sessionId).catch((error: unknown) => this.failure(error));
  }

  async failure(error: unknown): Promise<void> {
    try {
      await this.ports.onFollowUpFailure?.(error);
    } catch {
      /* Diagnostics cannot erase durable queue state. */
    }
  }

  schedule(sessionId: string): void {
    if (this.host.closed() || !this.ports.followUps) return;
    // The idle-exit latch (VC-577): the row stays queued and durable; the
    // next launch's recovery sweep (or the latch lifting) releases it.
    if (this.host.turnStartsHeld()) {
      this.#heldFollowUpDrains.add(sessionId);
      return;
    }
    if (this.#followUpDrains.has(sessionId)) {
      this.#followUpDrainAgain.add(sessionId);
      return;
    }
    const operation = Promise.resolve()
      .then(() => this.#drain(sessionId))
      .catch(async (error: unknown) => {
        try {
          await this.host.reportFailure({
            sessionId,
            commandId: `follow-up:${sessionId}`,
            detail: followUpFailureDetail(error),
          });
        } catch (attentionError) {
          await this.failure(attentionError);
        }
        await this.failure(error);
      })
      .finally(() => {
        this.#followUpDrains.delete(sessionId);
        if (this.#followUpDrainAgain.delete(sessionId)) this.schedule(sessionId);
      });
    this.#followUpDrains.set(sessionId, operation);
  }

  /**
   * Bounded backoff for a release that failed before its intent was recorded.
   * Only that failure is retried: nothing reached the executor, so a retry
   * cannot run the prompt twice. One timer per Session; a spent budget waits
   * for the next ordinary wake (turn end, Attention cleared, queue command).
   */
  #scheduleRetry(sessionId: string): void {
    const retry = this.#followUpRetries.get(sessionId) ?? { attempt: 0, timer: undefined };
    const delay = (this.ports.followUpRetryDelaysMs ?? FOLLOW_UP_RETRY_DELAYS_MS)[retry.attempt];
    if (this.host.closed() || retry.timer !== undefined || delay === undefined) return;
    retry.attempt += 1;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      this.schedule(sessionId);
    }, delay);
    this.#followUpRetries.set(sessionId, retry);
  }

  #resetRetry(sessionId: string): void {
    clearTimeout(this.#followUpRetries.get(sessionId)?.timer);
    this.#followUpRetries.delete(sessionId);
  }

  async recover(): Promise<void> {
    this.host.assertOpen();
    for (const sessionId of (await this.ports.followUps?.pendingSessionIds()) ?? []) {
      this.schedule(sessionId);
    }
    // Drains can request one more pass when reconciliation observes a turn end.
    while (this.#followUpDrains.size > 0) await Promise.all(this.#followUpDrains.values());
  }

  #failureAttentionId(projection: SessionProjection): string {
    const sessionId = projection.session.id;
    return messageDeliveryFailureAttentionId(
      sessionId,
      this.host.executorFor(projection).id,
      `follow-up:${sessionId}`,
    );
  }

  async admissionWait<T>(
    commandId: string,
    operation: Promise<T>,
    stage: string,
    onTimeout?: () => void,
  ): Promise<T> {
    if (!commandId.startsWith("follow-up:")) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(
          new NativeAttachmentError(
            `queue_admission_timeout: ${stage} did not finish. Check the transcript before retrying.`,
            "queue_admission_timeout",
            "adapter_unrecoverable",
          ),
        );
      }, this.ports.followUpAdmissionTimeoutMs ?? 30_000);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #drain(sessionId: string): Promise<void> {
    const ledger = this.ports.followUps!;
    let projection = await this.host.requireSession(sessionId);
    const pending = await ledger.transaction(sessionId, (state) => state.entries.length > 0, {
      mode: "read",
    });
    if (!pending) return;
    projection = await this.host.acknowledgeBootInterruption(projection);
    const startPending = this.host.executorStartPending(projection);
    const ownFailureId = this.#failureAttentionId(projection);
    const blockers = projection.attention.active.filter(({ id }) => id !== ownFailureId);
    // Only an in-flight start is normal progress: its completion wakes the
    // queue. A durable orphan has no wake and still needs actionable Attention.
    const blockedDetail =
      projection.status !== "open"
        ? "Queued message is waiting: session_archived. Reopen the Session to retry."
        : projection.stopped !== null
          ? "Queued message is waiting: session_stopped. Reattach the Session to retry."
          : blockers.length > 0
            ? `Queued message is waiting: ${blockers.map(({ kind, detail }) => `${kind}: ${detail}`).join("; ")}`
            : startPending && !this.host.executorStartInFlight(projection)
              ? "Queued message is waiting: executor_start_pending. Finish or retry the attachment."
              : undefined;
    // Set inside the claim transaction, so no cancel can interleave.
    const hold: { deliveryCommandId: string | null } = { deliveryCommandId: null };
    let heldDetail: string | undefined;
    try {
      const entry = await ledger.transaction(sessionId, (state) => {
        heldDetail = state.entries.find((candidate) => candidate.refused)?.refusedDetail;
        const releasing = state.entries.filter((candidate) => candidate.state === "releasing");
        // Recovery assumes one delivery per Session. Two claims is a corrupt
        // ledger, and guessing which one is real could send a prompt twice.
        if (releasing.length > 1)
          throw new SessionRuntimeConflictError(
            "More than one queued message is being delivered; refusing to guess",
          );
        const recovering = releasing[0];
        if (recovering) {
          // An explicit steer owns its claim through dispatch and settlement.
          if (this.#busy(recovering.deliveryCommandId)) return null;
          // A claim whose intent is recorded is only ever reconciled and
          // settled here, never sent again, so a person may withdraw it
          // meanwhile; only a claim this drain may still send is held.
          if (!projection.commands.some(({ id }) => id === recovering.deliveryCommandId)) {
            hold.deliveryCommandId = recovering.deliveryCommandId;
            this.#followUpOwned.add(recovering.deliveryCommandId);
          }
          return recovering;
        }
        if (
          projection.turnActive ||
          projection.status !== "open" ||
          projection.stopped !== null ||
          // A Client's start in flight would refuse this drain's own attach.
          startPending ||
          projection.attention.active.some(({ id }) => id !== ownFailureId)
        )
          return null;
        const boundary = `idle:${projection.latestTurnId ?? "birth"}`;
        if (state.releasedBoundary === boundary) return null;
        const head = state.entries[0];
        if (!head || head.refused) return null;
        head.state = "releasing";
        state.releasedBoundary = boundary;
        state.revision += 1;
        hold.deliveryCommandId = head.deliveryCommandId;
        this.#followUpOwned.add(head.deliveryCommandId);
        return head;
      });
      if (this.host.closed()) return;
      if (!entry) {
        if (heldDetail ?? blockedDetail)
          await this.host.reportFailure({
            sessionId,
            commandId: `follow-up:${sessionId}`,
            detail: (heldDetail ?? blockedDetail)!,
          });
        return;
      }
      // Publish on a separate chain: an unresponsive Client cannot delay release.
      this.#notify(sessionId);
      await this.#release(sessionId, entry, projection);
    } finally {
      if (hold.deliveryCommandId !== null) this.#followUpOwned.delete(hold.deliveryCommandId);
    }
  }

  async #release(
    sessionId: string,
    entry: StoredSessionFollowUp,
    projection: SessionProjection,
  ): Promise<void> {
    const ledger = this.ports.followUps!;
    let current = projection;
    const prior = current.commands.find(({ id }) => id === entry.deliveryCommandId);
    if (prior) {
      await this.#recoverDelivery(sessionId, entry, prior, current);
      return;
    }
    if (entry.steer) {
      // A crash before recording intent cannot turn a steer into a fresh prompt.
      // Recover through the same targeted-turn preflight; never auto-convert it.
      await this.#deliverSteer(sessionId, entry, current);
      return;
    }
    if (current.turnActive || current.status !== "open" || current.stopped !== null) return;
    let result: SessionRuntimeCommandResult;
    try {
      if (!current.liveExecutor) {
        if (this.host.executorStartPending(current)) {
          // Someone else's start: give the row back; that start wakes the queue.
          await this.#returnClaim(sessionId, entry);
          return;
        }
        // One id per attempt. A crash after an accepted attach must not replay
        // that attach under a different continuity — the engine refuses the
        // reused id, which used to strand the row for good.
        const attachPrefix = `${entry.deliveryCommandId}:attach`;
        const attempt = current.commands.filter(
          ({ id }) => id === attachPrefix || id.startsWith(`${attachPrefix}:`),
        ).length;
        const attached = await this.host.admitCommand({
          commandId: `${attachPrefix}:${attempt}`,
          sessionId,
          origin: entry.origin,
          command: {
            kind: "adapter.attach",
            continuity: current.attachments.length === 0 ? "fresh" : "context_replay",
          },
        });
        if (attached.receipt?.status !== "accepted" && attached.receipt?.status !== "completed") {
          // A fresh attempt id always answers terminally, so this is a refusal.
          const { code, detail } = attached.receipt as Extract<
            CommandReceipt,
            { status: "rejected" }
          >;
          const failure = new SessionRuntimeConflictError(
            `Could not attach an executor for the queued message (${code}): ${detail}`,
          );
          if (code === "executor_start_pending") {
            // Nothing was sent, and the other start's completion is the wake.
            await this.#returnClaim(sessionId, entry);
            await this.failure(failure);
            return;
          }
          // The pre-intent catch returns the claim and schedules backoff. The
          // queue's own Attention cannot block that retry, unlike configuration
          // Attention raised by the attach itself.
          throw failure;
        }
      }
      current = await this.host.requireSession(sessionId);
      const boundary = `idle:${current.latestTurnId ?? "birth"}`;
      this.#followUpDeliveryBoundaries.set(entry.deliveryCommandId, boundary);
      await ledger.transaction(sessionId, (state) => {
        state.releasedBoundary = boundary;
      });
      result = await this.host.admitCommand({
        commandId: entry.deliveryCommandId,
        sessionId,
        origin: entry.origin,
        command: {
          kind: "message.submit",
          message: entry.message,
          settle: "opened",
          model: entry.model,
          agent: entry.agent,
          variant: entry.variant,
        },
      });
    } catch (error) {
      if (error instanceof FollowUpBoundaryMovedError) {
        await this.#returnClaim(sessionId, entry);
        return;
      }
      // Nothing was sent unless this delivery's intent reached the event
      // ledger. Then a retry is safe; otherwise only evidence may settle it.
      const after = await this.host.requireSession(sessionId);
      const intent = after.commands.find(({ id }) => id === entry.deliveryCommandId);
      if (!intent) {
        await this.#returnClaim(sessionId, entry);
        this.#scheduleRetry(sessionId);
        throw error;
      }
      await this.failure(error);
      await this.#settleFromEvidence(sessionId, entry, intent, after);
      return;
    } finally {
      this.#followUpDeliveryBoundaries.delete(entry.deliveryCommandId);
    }
    if (!result.receipt || result.receipt.status === "unreconciled") {
      await this.#settleFromEvidence(
        sessionId,
        entry,
        result.command as SessionCommand,
        await this.host.requireSession(sessionId),
      );
      return;
    }
    await this.#settle(
      sessionId,
      entry.commandId,
      result.command as SessionCommand,
      result.receipt,
    );
  }

  /** A claim whose intent is already in the event ledger: settle it, never resend it. */
  async #recoverDelivery(
    sessionId: string,
    entry: StoredSessionFollowUp,
    prior: SessionCommand,
    projection: SessionProjection,
  ): Promise<void> {
    // Recovery must prove the receipt belongs to this exact payload, not
    // merely to a matching id in an older or corrupt event ledger.
    if (
      prior.intent.kind !== "message.submit" ||
      canonicalJson((await this.ports.artifacts.read(prior.intent.reference)).message) !==
        canonicalJson(entry.message)
    )
      throw new SessionRuntimeCommandConflictError(
        "Queued delivery intent does not match its retained payload",
      );
    let current = projection;
    let receipt = current.receipts.findLast(({ commandId }) => commandId === prior.id);
    if (!receipt || receipt.status === "unreconciled") {
      /* v8 ignore next 2 -- an unrouted message is atomically saved with a terminal rejection by the engine. */
      if (!prior.route?.attachmentId)
        throw new SessionRuntimeConflictError("Queued delivery has no recoverable route");
      const recovery = this.host.reconcile({ sessionId, attachmentId: prior.route.attachmentId });
      try {
        await this.admissionWait(
          entry.deliveryCommandId,
          recovery,
          "delivery reconciliation",
          () => {
            void recovery.then(
              () => this.schedule(sessionId),
              (error) => this.failure(error),
            );
          },
        );
      } catch (error) {
        // An executor that cannot answer is no evidence either way.
        await this.failure(error);
        if (error instanceof NativeAttachmentError && error.code === "queue_admission_timeout") {
          current = await this.host.requireSession(sessionId);
          await this.#settleFromEvidence(sessionId, entry, prior, current, error.message);
          return;
        }
      }
      current = await this.host.requireSession(sessionId);
      receipt = current.receipts.findLast(({ commandId }) => commandId === prior.id);
    }
    if (!receipt || receipt.status === "unreconciled") {
      await this.#settleFromEvidence(sessionId, entry, prior, current);
      return;
    }
    await this.#settle(sessionId, entry.commandId, prior, receipt);
  }

  /**
   * Settle as delivered on proof, or retain it: no evidence is NOT evidence of
   * no delivery, and redispatch here could run the same prompt twice. The row
   * stays visible and cancellable, with Attention saying so.
   */
  async #settleFromEvidence(
    sessionId: string,
    entry: StoredSessionFollowUp,
    command: SessionCommand,
    projection: SessionProjection,
    timeoutDetail?: string,
  ): Promise<void> {
    const evidence = await this.#deliveryEvidence(sessionId, command, projection);
    if (evidence === null) {
      const receipt = projection.receipts.findLast(({ commandId }) => commandId === command.id);
      const detail =
        timeoutDetail ??
        (receipt?.status === "unreconciled" && receipt.detail?.includes("queue_admission_timeout")
          ? receipt.detail
          : undefined);
      throw new FollowUpAmbiguousError(
        detail ? `${detail} ${FOLLOW_UP_AMBIGUOUS_DETAIL}` : undefined,
      );
    }
    await this.#settle(sessionId, entry.commandId, command, evidence);
  }

  /**
   * Proof that a recorded delivery reached the executor: its own accepted
   * receipt, or the turn it opened. The turn must match the delivery command
   * explicitly, or carry the derived turn id written with its message intent.
   * Ordering alone cannot prove acceptance: a previously ambiguous command
   * may open a late turn on that same attachment. A turn ENDING first means
   * the message joined running work (a steer), so it proves nothing.
   * The synthetic receipt is release evidence only; the event ledger
   * keeps its own (unreconciled) account.
   */
  async #deliveryEvidence(
    sessionId: string,
    command: SessionCommand,
    projection: SessionProjection,
  ): Promise<CommandReceipt | null> {
    return sessionFollowUpDeliveryEvidence(
      sessionId,
      command,
      projection.receipts,
      await this.host.listEventsPaged({ sessionId }),
    );
  }

  /** Give an owned claim back, unsent; it releases again at the next idle boundary. */
  async #returnClaim(sessionId: string, entry: StoredSessionFollowUp): Promise<void> {
    await this.ports.followUps!.transaction(sessionId, (state) => {
      // Held by this drain since the claim, so nothing else can have moved it.
      const pending = state.entries.find(({ commandId }) => commandId === entry.commandId)!;
      pending.state = "queued";
      state.releasedBoundary = null;
      state.revision += 1;
    });
    this.#notify(sessionId);
  }

  async #clearFailure(sessionId: string): Promise<void> {
    const heldDetail = await this.ports.followUps!.transaction(
      sessionId,
      (state) => state.entries.find((entry) => entry.refused)?.refusedDetail,
      { mode: "read" },
    );
    if (heldDetail) {
      await this.host.reportFailure({
        sessionId,
        commandId: `follow-up:${sessionId}`,
        detail: heldDetail,
      });
      return;
    }
    const projection = await this.host.requireSession(sessionId);
    const failureId = this.#failureAttentionId(projection);
    if (!projection.attention.active.some(({ id }) => id === failureId)) return;
    const cleared = await this.ports.engine.observe({
      id: this.host.id("event"),
      sessionId,
      occurredAt: this.ports.clock.now(),
      provenance: adapterProvenance(
        this.host.executorFor(projection),
        projection.liveExecutor?.venue ?? null,
      ),
      kind: "attention.cleared",
      attentionId: failureId,
    });
    await this.host.publishEvents([cleared]);
  }

  /** Matching a queued identity is an atomic claim, not cancel-then-send. */
  async steer(request: MessageCommandRequest): Promise<SessionRuntimeCommandResult | null> {
    const ledger = this.ports.followUps;
    if (!ledger) return null;
    const projection = await this.host.requireSession(request.sessionId);
    const { origin: _origin, ...intentRequest } = request;
    const signature = canonicalJson(intentRequest);
    const claim = await ledger.transaction<
      { result: SessionRuntimeCommandResult } | { entry: StoredSessionFollowUp } | null
    >(request.sessionId, (state) => {
      const prior = Object.hasOwn(state.commands, request.commandId)
        ? state.commands[request.commandId]
        : undefined;
      if (prior) {
        if (prior.signature !== signature)
          throw new SessionRuntimeCommandConflictError(
            `Command ${request.commandId} has different intent`,
          );
        return { result: prior.result };
      }
      const entry = state.entries.find(({ id }) => id === request.command.message.id);
      if (!entry) {
        // A turn-end release that already won must not be followed by a second send.
        if (
          Object.values(state.commands).some(
            ({ result }) =>
              result.command.intent.kind === "message.queue" &&
              result.command.intent.message.id === request.command.message.id,
          )
        )
          throw new SessionRuntimeConflictError(
            "This queued message has already been delivered or removed",
          );
        return null;
      }
      if (entry.state !== "queued")
        throw new SessionRuntimeConflictError("This queued message is already being delivered");
      if (entry.refused)
        throw new SessionRuntimeConflictError("Edit the refused queued message before retrying");
      // Identity selects the host's canonical payload, including parts/metadata
      // a Client cannot faithfully reconstruct. Steering is never an edit.
      if (
        !projection.turnActive ||
        !projection.latestTurnId ||
        projection.stopped !== null ||
        projection.status !== "open"
      )
        throw new SessionRuntimeConflictError("The targeted turn has ended");
      if (projection.commands.some(({ id }) => id === request.commandId))
        throw new SessionRuntimeCommandConflictError(
          `Command ${request.commandId} already belongs to the event ledger`,
        );
      entry.state = "releasing";
      entry.deliveryCommandId = request.commandId;
      entry.steer = { signature, targetTurnId: projection.latestTurnId };
      state.revision += 1;
      return { entry };
    });
    if (!claim) {
      // Queue reply retention is bounded. The event ledger is not: an old
      // delivered identity must still refuse a new steer after pruning (and
      // after restart). Artifact ids are digests, not message ids, so consult
      // the immutable message.submit payloads rather than the queue's cache.
      for (const command of projection.commands) {
        if (command.intent.kind !== "message.submit" || command.id === request.commandId) continue;
        const { message } = await this.ports.artifacts.read(command.intent.reference);
        if (message.id === request.command.message.id)
          throw new SessionRuntimeConflictError("This message has already been submitted");
      }
      return null;
    }
    if ("result" in claim) return claim.result;
    this.#notify(request.sessionId);
    return this.#deliverSteer(request.sessionId, claim.entry, projection);
  }

  async #deliverSteer(
    sessionId: string,
    entry: StoredSessionFollowUp,
    projection: SessionProjection,
  ): Promise<SessionRuntimeCommandResult> {
    try {
      const location = await this.ports.locations.resolve(projection.session);
      const result = await this.host.submitMessage(
        {
          commandId: entry.deliveryCommandId,
          sessionId,
          origin: entry.origin,
          command: {
            kind: "message.submit",
            delivery: "steer",
            message: entry.message,
            settle: "opened",
            model: entry.model,
            agent: entry.agent,
            variant: entry.variant,
          },
        },
        projection,
        location,
        false,
        entry.steer!.targetTurnId,
      );
      // A steer joins running work, so no turn it opened can prove it arrived.
      if (!result.receipt || result.receipt.status === "unreconciled")
        throw new FollowUpAmbiguousError();
      await this.#settle(
        sessionId,
        entry.commandId,
        result.command as SessionCommand,
        result.receipt,
        true,
      );
      return result;
    } catch (error) {
      // Once its intent is recorded the steer may have arrived; never invite a
      // resend by calling that a plain failure.
      const maybeDelivered =
        error instanceof FollowUpAmbiguousError ||
        (await this.host.requireSession(sessionId)).commands.some(
          ({ id }) => id === entry.deliveryCommandId,
        );
      await this.host.reportFailure({
        sessionId,
        commandId: `follow-up:${sessionId}`,
        detail: maybeDelivered ? FOLLOW_UP_AMBIGUOUS_DETAIL : followUpFailureDetail(error),
      });
      throw error;
    }
  }

  async #settle(
    sessionId: string,
    commandId: string,
    command: SessionCommand,
    receipt: CommandReceipt,
    returnRefusal = false,
  ): Promise<void> {
    if (receipt.status === "rejected") {
      // Definitive non-acceptance is safe to edit/cancel. Keep the payload, but
      // never retry a terminally refused command id with different content.
      const retained = await this.ports.followUps!.transaction(sessionId, (state) => {
        // A person may have withdrawn an unproven claim while this was read.
        const entry = state.entries.find((candidate) => candidate.commandId === commandId);
        if (!entry) return false;
        entry.state = "queued";
        entry.refused = true;
        entry.refusedDetail = `Queued delivery refused: ${receipt.code}${receipt.detail ? `: ${receipt.detail}` : ""}`;
        if (entry.steer)
          Object.defineProperty(state.commands, command.id, {
            value: {
              signature: entry.steer.signature,
              result: {
                sessionId,
                command,
                receipt,
                throughSequence: receipt.sequence,
                refusal: null,
              },
            },
            enumerable: true,
            configurable: true,
            writable: true,
          });
        state.revision += 1;
        return true;
      });
      if (!retained) return;
      this.#notify(sessionId);
      if (!returnRefusal)
        throw new SessionRuntimeConflictError(
          `Queued delivery refused: ${receipt.code}${receipt.detail ? `: ${receipt.detail}` : ""}`,
        );
      return;
    }
    await this.ports.followUps!.transaction(sessionId, (state) => {
      // Absent when a person withdrew the unproven claim meanwhile; the
      // evidence is still recorded, and nothing is left to remove.
      const entry = state.entries.find((candidate) => candidate.commandId === commandId);
      if (entry?.steer)
        Object.defineProperty(state.commands, command.id, {
          value: {
            signature: entry.steer.signature,
            result: {
              sessionId,
              command,
              receipt,
              throughSequence: receipt.sequence,
              refusal: null,
            },
          },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      state.entries = state.entries.filter((candidate) => candidate.commandId !== commandId);
      // Delivery proof lives in the event ledger, not a second unbounded map.
      state.revision += 1;
    });
    this.#resetRetry(sessionId);
    await this.#clearFailure(sessionId);
    this.#notify(sessionId);
    // Recovery may settle a completed prior turn with no live observation left
    // to wake the next row. The durable boundary still admits only one release.
    this.schedule(sessionId);
  }
}

export class FollowUpBoundaryMovedError extends Error {
  constructor() {
    super("The queued message's idle boundary moved before admission");
  }
}

/**
 * What a person reads when a release has no proof either way (VC-675). It must
 * not say "failed": the prompt may have run, and a resend would run it twice.
 */
const FOLLOW_UP_AMBIGUOUS_DETAIL =
  "This follow-up may have been delivered. Check the transcript before resending.";

/** Delivery may have happened; the row is retained, cancellable, never resent. */
class FollowUpAmbiguousError extends SessionRuntimeConflictError {
  constructor(detail = FOLLOW_UP_AMBIGUOUS_DETAIL) {
    super(detail);
  }
}

function followUpFailureDetail(error: unknown): string {
  return error instanceof FollowUpAmbiguousError
    ? error.message
    : `Queued message delivery failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Pre-intent release retries: quick for a blip, then sparse, then visible and waiting. */
const FOLLOW_UP_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000];

/** Frozen derivation shared with the runtime's delivery-failure reporter. */
export function messageDeliveryFailureAttentionId(
  sessionId: string,
  adapterId: string,
  commandId: string,
): string {
  return ["message-delivery", sessionId, adapterId, commandId].map(encodeURIComponent).join(":");
}

function adapterProvenance(
  adapter: NativeHarnessAdapter,
  venue: RunnerIdentity | null,
): SessionEventProvenance {
  return {
    source: { kind: "adapter", id: adapter.id, detail: { adapterVersion: adapter.adapterVersion } },
    venue,
  };
}
