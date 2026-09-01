/**
 * The two control-tier supervision operations (VC-86): stop another Session's
 * work, and steer a message into one. The application half behind the
 * `session_stop` / `session_send` tools, the way `start-session.ts` is the
 * half behind `session_start` — the door validates and words the answer, this
 * module owns the semantics.
 *
 * ## The authority bound
 *
 * Both operations resolve their target inside the CALLER'S project, before any
 * handle is parsed — the same scoping the start operation pins. A Session
 * cannot stop or steer outside the project its attachment belongs to, because
 * no other project's Sessions are ever candidates.
 *
 * ## What a stop is
 *
 * Three acts in one operation, ordered so the durable truth leads:
 *
 * 1. The stop fact — `session.stop` through the Session Engine, carrying the
 *    calling Session as its actor. Durable whatever happens next; this is
 *    what listings read as "stopped" and history reads as who-and-why.
 * 2. An interrupt of the active turn, when one is open.
 * 3. A release of the live attachment, so the executor lets go.
 *
 * The runtime acts are best-effort and their failures are REPORTED, never
 * hidden: a stop whose release failed says so in the answer, because "stopped"
 * with a still-streaming executor is the one lie a supervisor must not be
 * told. The Session identity stays openable throughout — stop ends work,
 * never identity (Session durability doctrine).
 *
 * ## What a send is
 *
 * One `message.submit` into the target's live attachment, delivery `steer`, so
 * a mid-turn model reads the direction now rather than after it finishes. The
 * message text carries an explicit supervision marker naming the sending
 * Session — the receiving model must never mistake steering for its own user.
 * The command is awaited through its delivery receipt: an operation may not
 * tell a supervisor that steering landed until the target runtime accepted it.
 */

import { shortSessionId } from "@volli/shared";
import type { CommandReceipt, SessionProjection } from "@volli/shared";
import type { SessionEngine, SessionRuntime } from "@volli/session-engine";

import { latestStructuredAttachment, terminalSessionRecord } from "../session-control";

/** What the operations need. Narrow on purpose; everything is per-call. */
export interface SuperviseSessionPorts {
  sessionEngine: Pick<SessionEngine, "listSessions" | "submit">;
  runtime: Pick<SessionRuntime, "command">;
}

/** A refusal the door words for the model. `text` is a complete sentence. */
export class SuperviseSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuperviseSessionError";
  }
}

export interface SuperviseTargetInput {
  /** The caller's own durable Session id — the actor, and the self-guard. */
  callerSessionId: string;
  /** The caller's project — the bound targets are resolved inside. */
  projectId: string;
  /** The short public handle, as `session list` prints it. */
  handle: string;
}

/**
 * The target a supervision operation acts on: a structured (chat) Session in
 * the caller's project, addressed by its short public handle.
 *
 * Terminal sessions are excluded the way every session verb excludes them
 * from the chat half: a PTY has no turn to interrupt and no steer channel, so
 * a handle that names one is answered with what it is rather than with a
 * generic miss.
 */
async function resolveTarget(
  ports: SuperviseSessionPorts,
  input: SuperviseTargetInput,
): Promise<SessionProjection> {
  const handle = input.handle.trim();
  if (handle.length === 0) {
    throw new SuperviseSessionError(
      "`session` must be a short session id, as `volli session list` prints it.",
    );
  }
  const projections = await ports.sessionEngine.listSessions({
    projectId: input.projectId,
    scope: "all",
  });
  const matches = projections.filter(
    (projection) => shortSessionId(projection.session.id) === handle,
  );
  if (matches.length === 0) {
    throw new SuperviseSessionError(
      `No session ${handle} in this project. \`volli session list\` prints the handles.`,
    );
  }
  if (matches.length > 1) {
    throw new SuperviseSessionError(
      `Session id ${handle} is ambiguous in this project; nothing was touched.`,
    );
  }
  const target = matches[0]!;
  if (target.session.id === input.callerSessionId) {
    throw new SuperviseSessionError(
      "That handle is this Session. Finish your turn, or signal done or blocked instead.",
    );
  }
  if (terminalSessionRecord(target) !== null) {
    throw new SuperviseSessionError(
      `Session ${handle} is a terminal session; stop and send address structured chat Sessions only.`,
    );
  }
  return target;
}

export interface StopSessionInput extends SuperviseTargetInput {
  /** Idempotency key: every durable write derives from it. */
  operationId: string;
  reason?: string;
}

export interface StopSessionOutcome {
  sessionId: string;
  handle: string;
  title: string | null;
  /** The durable stop already existed; this call retried only its live executor. */
  previouslyStopped: boolean;
  /** Whether an open turn was interrupted. */
  interrupted: boolean;
  /** Whether a live attachment was released. */
  released: boolean;
  /** Runtime acts that failed, as complete sentences. Empty on a clean stop. */
  failures: readonly string[];
}

/** Stop another Session's work, durably and attributably. */
export async function stopSessionOperation(
  ports: SuperviseSessionPorts,
  input: StopSessionInput,
): Promise<StopSessionOutcome> {
  const target = await resolveTarget(ports, input);
  const previouslyStopped = target.stopped !== null;
  let liveTarget = target;

  if (!previouslyStopped) {
    // The durable fact first: whatever the runtime does next, the stop and its
    // actor exist. A failed durable write is not a stop and must not be hidden.
    const submitted = await ports.sessionEngine.submit({
      commandId: input.operationId,
      sessionId: target.session.id,
      intent: {
        kind: "session.stop",
        reason: input.reason ?? null,
        by: { kind: "session", sessionId: input.callerSessionId },
      },
      provenance: {
        source: { kind: "system", id: "session-supervision", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    if (submitted.receipt?.status !== "completed") {
      throw new SuperviseSessionError(
        `Session ${input.handle} could not be durably recorded as stopped.`,
      );
    }
    // A turn can be admitted while the stop fact commits. Re-read before
    // interrupting so the release acts on the attachment and turn that exist
    // now, rather than the snapshot we resolved before the stop.
    liveTarget = await resolveTarget(ports, input);
  }

  const failures: string[] = [];
  let interrupted = false;
  let released = false;
  const attachment = latestStructuredAttachment(liveTarget.attachments);
  if (attachment?.status === "open") {
    if (liveTarget.turnActive) {
      try {
        const result = await ports.runtime.command({
          commandId: `${input.operationId}:interrupt`,
          sessionId: target.session.id,
          command: { kind: "executor.interrupt", attachmentId: attachment.id },
        });
        if (receiptAccepted(result.receipt)) interrupted = true;
        else failures.push(`The active turn did not interrupt: ${receiptFailure(result.receipt)}.`);
      } catch (error) {
        failures.push(`The active turn did not interrupt: ${errorText(error)}.`);
      }
    }
    try {
      const result = await ports.runtime.command({
        commandId: `${input.operationId}:release`,
        sessionId: target.session.id,
        command: { kind: "adapter.release", attachmentId: attachment.id },
      });
      if (receiptAccepted(result.receipt)) released = true;
      else failures.push(`The executor did not release: ${receiptFailure(result.receipt)}.`);
    } catch (error) {
      failures.push(`The executor did not release: ${errorText(error)}.`);
    }
  }

  return {
    sessionId: target.session.id,
    handle: shortSessionId(target.session.id),
    title: target.session.title,
    previouslyStopped,
    interrupted,
    released,
    failures,
  };
}

export interface SendSessionInput extends SuperviseTargetInput {
  /** Idempotency key: the message command id derives from it. */
  operationId: string;
  message: string;
}

export interface SendSessionOutcome {
  sessionId: string;
  handle: string;
  title: string | null;
  /** Whether the target had a turn open when the steer was submitted. */
  midTurn: boolean;
}

/**
 * The supervision marker the receiving model reads. In-band on purpose: the
 * transcript is the one channel a model is guaranteed to read, and provenance
 * metadata never reaches it. Owner direction relayed this way is exactly the
 * channel the rc-0.1.0 pass lacked.
 */
export function supervisionMarker(callerSessionId: string): string {
  return `[Steering from supervising Session ${shortSessionId(callerSessionId)} — owner direction, not your user's own message]`;
}

/** Steer a message into another Session's live attachment. */
export async function sendSessionMessageOperation(
  ports: SuperviseSessionPorts,
  input: SendSessionInput,
): Promise<SendSessionOutcome> {
  const message = input.message.trim();
  if (message.length === 0) {
    throw new SuperviseSessionError("`message` must be non-empty text.");
  }
  const target = await resolveTarget(ports, input);
  if (target.stopped !== null) {
    throw new SuperviseSessionError(
      `Session ${input.handle} is stopped; a stopped Session reads nothing. A person can reattach it, or start a new Session.`,
    );
  }
  const attachment = latestStructuredAttachment(target.attachments);
  if (attachment?.status !== "open") {
    throw new SuperviseSessionError(
      `Session ${input.handle} has no live executor to read a message; a person can reattach it from the app.`,
    );
  }

  const text = `${supervisionMarker(input.callerSessionId)}\n\n${message}`;
  const delivered = await ports.runtime.command({
    commandId: input.operationId,
    sessionId: target.session.id,
    command: {
      kind: "message.submit",
      delivery: "steer",
      message: {
        id: `${input.operationId}:message`,
        role: "user",
        parts: [{ type: "text", text }],
      },
    },
  });
  if (!receiptAccepted(delivered.receipt)) {
    throw new SuperviseSessionError(
      `Volli could not confirm steering into Session ${shortSessionId(target.session.id)}: ${receiptFailure(delivered.receipt)}.`,
    );
  }

  return {
    sessionId: target.session.id,
    handle: shortSessionId(target.session.id),
    title: target.session.title,
    midTurn: target.turnActive,
  };
}

function receiptAccepted(receipt: CommandReceipt | null): boolean {
  return receipt?.status === "accepted" || receipt?.status === "completed";
}

function receiptFailure(receipt: CommandReceipt | null): string {
  if (receipt === null) return "the runtime returned no delivery receipt";
  switch (receipt.status) {
    case "rejected":
      return receipt.detail === null
        ? `the runtime rejected it (${receipt.code})`
        : `the runtime rejected it (${receipt.code}): ${receipt.detail}`;
    case "unreconciled":
      return receipt.detail === null
        ? "delivery is unreconciled"
        : `delivery is unreconciled: ${receipt.detail}`;
    case "accepted":
    case "completed":
      return "delivery was not accepted";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
