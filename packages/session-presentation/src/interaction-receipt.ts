import type {
  SessionInteractionAnswer,
  SessionInteractionResolution,
  TranscriptReference,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { ChatSessionFrame } from "./transcript";

export interface InteractionReceiptEvidence {
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly reference: TranscriptReference;
  readonly body: string;
  readonly answer: InteractionReceipt;
}

/** A settled answer, and the attachment whose question it answered. */
export interface InteractionReceipt extends InteractionResolutionMessage {
  attachmentId: string;
}

function bodyKey(message: Pick<UIMessage, "id" | "role" | "metadata" | "parts">): string | null {
  try {
    return JSON.stringify([message.id, message.role, message.metadata, message.parts]);
  } catch {
    return null;
  }
}
function resolutionKey(resolution: SessionInteractionResolution): string {
  return JSON.stringify([
    resolution.optionIds,
    resolution.response,
    resolution.answers?.length
      ? resolution.answers.map((answer) => [answer.promptId, answer.optionIds, answer.response])
      : null,
  ]);
}
function sameReference(left: TranscriptReference, right: TranscriptReference): boolean {
  return left.id === right.id && left.digest === right.digest && left.mediaType === right.mediaType;
}

interface ResolveCommandRead {
  readonly sequence: number;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly attachmentId: string;
  readonly routeAttachmentId: string | null;
  readonly resolution: string;
}
interface ReceiptRead {
  readonly sequence: number;
  readonly status: "accepted" | "rejected" | "completed" | "unreconciled";
  readonly resultKind: string | null;
  readonly resultSessionId: string | null;
  readonly attachmentId: string | null;
}
interface InteractionFactRead {
  readonly sequence: number;
  readonly attachmentId: string;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The interaction.resolve commands whose answer the window's ordered history
 * proves was settled — recorded intent alone never is (a resolve command and
 * its artifact persist BEFORE delivery, and the delivery can be refused).
 *
 * The ledger's lifecycle, as the Session Engine and the Pi adapter write it on
 * both the local host and a runner:
 * `command.recorded` → (adapter) `interaction.resolved` → `command.receipt.recorded`
 * accepted, or a rejected receipt and no fact (refused before routing,
 * PI_INTERACTION_NOT_RECORDED, PI_INTERACTION_UNKNOWN — the last may follow a
 * committed fact when a withdrawal won the claim). `unreconciled` is uncertain
 * delivery that a later terminal receipt may settle; a rejected or completed
 * receipt is terminal and an accepted one never regresses.
 *
 * The fact carries no commandId, so it is joined conservatively: one opened
 * question on the command's attachment, recorded before the command; exactly
 * one resolution fact for it, after the command, on the same attachment and
 * with the same answer (including per-question answers); no cancellation; this
 * command delivered (accepted/completed for interaction.resolved, nothing
 * rejected, every receipt after the command); and no other resolve command for
 * the same question also delivered. Anything less — a partial window, a
 * refused first try, a same-answer retry, a cancelled question — proves
 * nothing, and the message stays neutral recorded content.
 */
function settledResolveCommands(frames: readonly ChatSessionFrame[]): ReadonlySet<string> {
  const commands = new Map<string, ResolveCommandRead>();
  const conflicted = new Set<string>();
  const receipts = new Map<string, ReceiptRead[]>();
  const opened = new Map<string, InteractionFactRead[]>();
  const resolved = new Map<
    string,
    (InteractionFactRead & { commandId: string | null; resolution: string })[]
  >();
  const cancelled = new Set<string>();
  for (const frame of frames) {
    const event = frame.event;
    // A kind this build does not know settles nothing it could name.
    if (!event) continue;
    const payload = event.payload;
    if (
      payload.kind === "command.recorded" &&
      payload.command.intent.kind === "interaction.resolve"
    ) {
      const { command } = payload;
      const intent = payload.command.intent;
      const read: ResolveCommandRead = {
        sequence: frame.sequence,
        sessionId: command.sessionId,
        interactionId: intent.interactionId,
        attachmentId: intent.attachmentId,
        routeAttachmentId: command.route?.attachmentId ?? null,
        resolution: resolutionKey(intent.resolution),
      };
      const previous = commands.get(command.id);
      // An idempotent replay of the same command keeps its first position.
      if (!previous) commands.set(command.id, read);
      else if (
        previous.sessionId !== read.sessionId ||
        previous.interactionId !== read.interactionId ||
        previous.attachmentId !== read.attachmentId ||
        previous.routeAttachmentId !== read.routeAttachmentId ||
        previous.resolution !== read.resolution
      )
        conflicted.add(command.id);
    } else if (payload.kind === "command.receipt.recorded") {
      const { receipt } = payload;
      pushTo(receipts, receipt.commandId, {
        sequence: frame.sequence,
        status: receipt.status,
        resultKind:
          receipt.status === "accepted" || receipt.status === "completed"
            ? receipt.result.kind
            : null,
        resultSessionId:
          receipt.status === "accepted" || receipt.status === "completed"
            ? receipt.result.sessionId
            : null,
        attachmentId: event.attachmentId ?? null,
      });
    } else if (payload.kind === "interaction.opened") {
      pushTo(opened, payload.interaction.id, {
        sequence: frame.sequence,
        attachmentId: payload.interaction.attachmentId,
      });
    } else if (payload.kind === "interaction.resolved") {
      pushTo(resolved, payload.interactionId, {
        sequence: frame.sequence,
        attachmentId: payload.attachmentId,
        commandId: event.commandId ?? null,
        resolution: resolutionKey(payload.resolution),
      });
    } else if (payload.kind === "interaction.cancelled") {
      cancelled.add(payload.interactionId);
    }
  }
  const delivered = (commandId: string, command: ResolveCommandRead): boolean => {
    const list = receipts.get(commandId) ?? [];
    return (
      list.some(
        (receipt) =>
          (receipt.status === "accepted" || receipt.status === "completed") &&
          receipt.resultKind === "interaction.resolved" &&
          receipt.resultSessionId === command.sessionId,
      ) &&
      list.every(
        (receipt) =>
          receipt.sequence > command.sequence &&
          receipt.status !== "rejected" &&
          (receipt.attachmentId === null || receipt.attachmentId === command.attachmentId),
      )
    );
  };
  const deliveredPerInteraction = new Map<string, number>();
  for (const [id, command] of commands) {
    if (!conflicted.has(id) && delivered(id, command))
      deliveredPerInteraction.set(
        command.interactionId,
        (deliveredPerInteraction.get(command.interactionId) ?? 0) + 1,
      );
  }
  const settled = new Set<string>();
  for (const [id, command] of commands) {
    if (conflicted.has(id) || cancelled.has(command.interactionId)) continue;
    if (command.routeAttachmentId !== command.attachmentId) continue;
    if (!delivered(id, command) || deliveredPerInteraction.get(command.interactionId) !== 1)
      continue;
    const opens = opened.get(command.interactionId) ?? [];
    if (
      opens.length === 0 ||
      opens.some(
        (open) => open.attachmentId !== command.attachmentId || open.sequence >= command.sequence,
      )
    )
      continue;
    const facts = resolved.get(command.interactionId) ?? [];
    if (
      facts.length === 0 ||
      facts.some(
        (fact) =>
          fact.sequence <= command.sequence ||
          fact.attachmentId !== command.attachmentId ||
          fact.resolution !== command.resolution ||
          (fact.commandId !== null && fact.commandId !== id),
      )
    )
      continue;
    settled.add(id);
  }
  return settled;
}

/**
 * A hydrated reference is joined only to its recorded interaction.resolve
 * command, and only once that command's answer is settled in the same window
 * ({@link settledResolveCommands}). A normal submit with the same message
 * id/reference, any conflicting resolve, or an observation with different
 * content/reference makes the id ambiguous. Adapter-only tails cannot prove
 * that this was an answer.
 */
export function indexInteractionResolutionMessages(
  frames: readonly ChatSessionFrame[],
): ReadonlyMap<string, InteractionReceiptEvidence | null> {
  const receipts = new Map<string, InteractionReceiptEvidence | null>();
  const settled = settledResolveCommands(frames);
  const submittedReferences = new Set<string>();
  for (const frame of frames) {
    const payload = frame.event?.payload;
    if (payload?.kind === "command.recorded" && payload.command.intent.kind === "message.submit")
      submittedReferences.add(payload.command.intent.reference.id);
  }
  for (const frame of frames) {
    const event = frame.event;
    const message = frame.transcript?.message;
    if (event?.payload.kind !== "command.recorded" || message?.role !== "user") continue;
    const command = event.payload.command;
    const intent = command.intent;
    let candidate: InteractionReceiptEvidence | null = null;
    if (
      intent.kind === "interaction.resolve" &&
      command.sessionId === frame.sessionId &&
      event.sessionId === frame.sessionId &&
      message.parts.length === 1 &&
      message.parts[0]?.type === "data-interaction-resolution" &&
      !submittedReferences.has(intent.reference.id) &&
      settled.has(command.id)
    ) {
      const answer = readInteractionResolutionContent(message);
      const body = bodyKey(message);
      if (
        answer &&
        body !== null &&
        answer.interactionId === intent.interactionId &&
        resolutionKey(answer.resolution) === resolutionKey(intent.resolution)
      )
        candidate = {
          commandId: command.id,
          messageId: message.id,
          sequence: frame.sequence,
          reference: intent.reference,
          body,
          answer: { ...answer, attachmentId: intent.attachmentId },
        };
    }
    if (!receipts.has(message.id)) receipts.set(message.id, candidate);
    else {
      const previous = receipts.get(message.id);
      if (
        !previous ||
        !candidate ||
        previous.commandId !== candidate.commandId ||
        previous.body !== candidate.body ||
        !sameReference(previous.reference, candidate.reference)
      )
        receipts.set(message.id, null);
    }
  }
  for (const frame of frames) {
    const message = frame.transcript?.message;
    if (message?.role !== "user") continue;
    const evidence = receipts.get(message.id);
    const payload = frame.event?.payload;
    if (
      !evidence ||
      frame.sequence < evidence.sequence ||
      bodyKey(message) !== evidence.body ||
      (payload?.kind === "transcript.referenced" &&
        !sameReference(payload.reference, evidence.reference))
    )
      receipts.set(message.id, null);
  }
  return receipts;
}

/** Missing producer evidence is neutral content, never a receipt or a dropped message. */
export function readInteractionResolutionMessage(
  message: UIMessage,
  evidence?: InteractionReceiptEvidence | null,
): InteractionReceipt | null {
  return message.role === "user" &&
    evidence &&
    message.id === evidence.messageId &&
    bodyKey(message) === evidence.body
    ? evidence.answer
    : null;
}

/** A durable answer, at the transcript position where it was given. */
export interface InteractionResolutionMessage {
  interactionId: string;
  resolution: SessionInteractionResolution;
}

/**
 * Decode stored resolution CONTENT only. This shape is caller-controlled and
 * is not proof of an interaction receipt; the public recognition function
 * above requires its matching recorded command/reference. Kept separate so
 * historical per-question/flat decoding does not acquire authorship semantics.
 * Malformed content reads as null rather than throwing inside a render.
 *
 * **`answers` is read, not re-derived.** The runtime writes the whole
 * resolution to the artifact, so the per-question answers are already there.
 * Decoding only the flat pair threw them away and left the receipt to
 * `readInteractionAnswers`'s fallback, which stamps the flattened union onto
 * the first prompt — so a two-question request rendered as one question's
 * labels and every later answer vanished from the transcript.
 */
export function readInteractionResolutionContent(message: {
  metadata?: unknown;
  parts: readonly unknown[];
}): InteractionResolutionMessage | null {
  const interactionId = stringField(message.metadata, "interactionId");
  if (interactionId === null) return null;
  for (const part of message.parts) {
    if (stringField(part, "type") !== "data-interaction-resolution") continue;
    const data = objectField(part, "data");
    const optionIds = data?.optionIds;
    if (!Array.isArray(optionIds)) continue;
    const answers = readStoredAnswers(data?.answers);
    const resolution: SessionInteractionResolution = {
      optionIds: optionIds.filter((id): id is string => typeof id === "string"),
      response: typeof data?.response === "string" ? data.response : null,
    };
    return { interactionId, resolution: answers ? { ...resolution, answers } : resolution };
  }
  return null;
}

/**
 * The per-question answers a stored resolution carries, or undefined where it
 * carries none we can read.
 *
 * Undefined rather than an empty array on purpose: that is the value
 * `readInteractionAnswers` treats as "not written with answers", so a record
 * from before the field existed keeps its flat reading instead of projecting as
 * an interaction that was answered with nothing — which is how a refusal reads.
 */
function readStoredAnswers(value: unknown): readonly SessionInteractionAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const answers = value.flatMap((entry) => {
    const promptId = stringField(entry, "promptId");
    if (promptId === null || !isRecord(entry) || !Array.isArray(entry.optionIds)) return [];
    return [
      {
        promptId,
        optionIds: entry.optionIds.filter((id): id is string => typeof id === "string"),
        response: typeof entry.response === "string" ? entry.response : null,
      },
    ];
  });
  return answers.length > 0 ? answers : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  /* v8 ignore next -- the sole call site already narrowed `value` to a record via `stringField`'s own match. */
  const nested = isRecord(value) ? value[key] : undefined;
  return isRecord(nested) ? nested : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" && field.length > 0 ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
