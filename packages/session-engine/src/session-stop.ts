/** Transport-independent stop semantics shared by the host runtime and supervision tools. */
import { shortSessionId } from "@volli/shared";
import type {
  CommandReceipt,
  SessionEventProvenance,
  SessionProjection,
  SessionStopActor,
  SessionAttachmentProjection,
} from "@volli/shared";
import type { SessionEngine } from "./session-engine";
import type { SessionRuntime } from "./session-runtime";

/** The person's door reads its target by id rather than resolving a handle. */
export interface StopSessionByIdPorts {
  sessionEngine: Pick<SessionEngine, "getSession" | "submit">;
  runtime: Pick<SessionRuntime, "command">;
}

/** A refusal the door words for the model. `text` is a complete sentence. */
export class SuperviseSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuperviseSessionError";
  }
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

export interface StopSessionByIdInput {
  /** Idempotency key: every durable write derives from it. */
  operationId: string;
  sessionId: string;
  reason?: string;
}

/**
 * A person stops a Session's work from the app (VC-269): the same three acts
 * as the tool, with `{ kind: "user" }` as the durable actor and the target
 * named by id. No project bound and no self-guard — a person is not a Session,
 * and the renderer only ever names Sessions it is already showing.
 *
 * NOT-LIVE IS A NAMED REFUSAL (fix-first, review c5714a22), checked before the
 * durable write: a target with no open structured attachment has nothing for
 * the runtime acts to touch, and the island's stop button races the row's own
 * state (it shows only while the child reads `working`) — by the time the
 * click reaches here the child may already have gone idle or fully closed.
 * Recording `session.stop` anyway would durably stamp a no-op as a quiet
 * success; refusing by name lets the door word it and the renderer toast it,
 * the same as every other mutation. A target `stopped` once already but whose
 * attachment is still open is a legitimate RETRY of the runtime release, not
 * a not-live target, so liveness reads the attachment alone.
 */
export async function stopSessionById(
  ports: StopSessionByIdPorts,
  input: StopSessionByIdInput,
): Promise<StopSessionOutcome> {
  const read = async (): Promise<SessionProjection> => {
    const projection = await ports.sessionEngine.getSession({ sessionId: input.sessionId });
    if (projection === null) throw new SuperviseSessionError("Unknown session.");
    return projection;
  };
  const target = await read();
  if (target.attachments.some((attachment) => attachment.adapterId === "terminal")) {
    throw new SuperviseSessionError(
      "That is a terminal session; stop addresses structured chat Sessions only.",
    );
  }
  if (latestStructuredAttachment(target.attachments)?.status !== "open") {
    throw new SuperviseSessionError(
      `Session ${shortSessionId(input.sessionId)} is not live; there is nothing running to stop.`,
    );
  }
  return stopResolvedSession(ports, target, read, {
    operationId: input.operationId,
    by: { kind: "user" },
    reason: input.reason ?? null,
    name: `Session ${shortSessionId(input.sessionId)}`,
    provenance: { kind: "user", id: "renderer", detail: { sessionOrigin: { kind: "user" } } },
  });
}

export interface StopActs {
  operationId: string;
  by: SessionStopActor;
  reason: string | null;
  /** How the target is named in a refusal, as the door's caller knows it. */
  name: string;
  provenance: SessionEventProvenance["source"];
}

/**
 * The three acts of a stop on a target already resolved: record, interrupt,
 * release. `reread` is how the door re-resolves its target after the durable
 * write — by handle or by id, the door's business — so the runtime acts land
 * on the attachment and turn that exist NOW rather than the snapshot resolved
 * before the stop.
 */
export async function stopResolvedSession(
  ports: Pick<StopSessionByIdPorts, "runtime"> & {
    sessionEngine: Pick<SessionEngine, "submit">;
  },
  target: SessionProjection,
  reread: () => Promise<SessionProjection>,
  acts: StopActs,
): Promise<StopSessionOutcome> {
  const previouslyStopped = target.stopped !== null;
  let liveTarget = target;

  if (!previouslyStopped) {
    // The durable fact first: whatever the runtime does next, the stop and its
    // actor exist. A failed durable write is not a stop and must not be hidden.
    const submitted = await ports.sessionEngine.submit({
      commandId: acts.operationId,
      sessionId: target.session.id,
      intent: { kind: "session.stop", reason: acts.reason, by: acts.by },
      provenance: {
        source: acts.provenance,
        venue: { id: "local", kind: "local" },
      },
    });
    if (submitted.receipt?.status !== "completed") {
      throw new SuperviseSessionError(`${acts.name} could not be durably recorded as stopped.`);
    }
    // A turn can be admitted while the stop fact commits. Re-read before
    // interrupting so the release acts on the attachment and turn that exist
    // now, rather than the snapshot we resolved before the stop.
    liveTarget = await reread();
  }

  const failures: string[] = [];
  let interrupted = false;
  let released = false;
  const attachment = latestStructuredAttachment(liveTarget.attachments);
  if (attachment?.status === "open") {
    if (liveTarget.turnActive) {
      try {
        const result = await ports.runtime.command({
          origin:
            acts.by.kind === "session"
              ? { kind: "session", sessionId: acts.by.sessionId }
              : { kind: "user" },
          commandId: `${acts.operationId}:interrupt`,
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
        origin:
          acts.by.kind === "session"
            ? { kind: "session", sessionId: acts.by.sessionId }
            : { kind: "user" },
        commandId: `${acts.operationId}:release`,
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

function latestStructuredAttachment(
  attachments: readonly SessionAttachmentProjection[],
): SessionAttachmentProjection | null {
  return attachments.findLast((attachment) => attachment.adapterId !== "terminal") ?? null;
}

function receiptAccepted(
  receipt: CommandReceipt | null,
): receipt is Extract<CommandReceipt, { status: "accepted" | "completed" }> {
  return receipt?.status === "accepted" || receipt?.status === "completed";
}

function receiptFailure(
  receipt: Exclude<CommandReceipt, { status: "accepted" | "completed" }> | null,
): string {
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
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
