import type { SessionInteractionAnswer, SessionInteractionResolution, TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";
import type { ChatSessionFrame } from "./transcript";

export interface InteractionReceiptEvidence {
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly reference: TranscriptReference;
  readonly body: string;
  readonly answer: InteractionResolutionMessage;
}

function bodyKey(message: Pick<UIMessage, "id" | "role" | "metadata" | "parts">): string | null {
  try { return JSON.stringify([message.id, message.role, message.metadata, message.parts]); }
  catch { return null; }
}
function resolutionKey(resolution: SessionInteractionResolution): string {
  return JSON.stringify([resolution.optionIds, resolution.response, resolution.answers?.length ? resolution.answers.map((answer) => [answer.promptId, answer.optionIds, answer.response]) : null]);
}
function sameReference(left: TranscriptReference, right: TranscriptReference): boolean {
  return left.id === right.id && left.digest === right.digest && left.mediaType === right.mediaType;
}

/**
 * A hydrated reference is joined only to its recorded interaction.resolve
 * command. A normal submit with the same message id/reference, any conflicting
 * resolve, or an observation with different content/reference makes the id
 * ambiguous. Adapter-only tails cannot prove that this was an answer.
 */
export function indexInteractionResolutionMessages(frames: readonly ChatSessionFrame[]): ReadonlyMap<string, InteractionReceiptEvidence | null> {
  const receipts = new Map<string, InteractionReceiptEvidence | null>();
  const submittedReferences = new Set<string>();
  for (const frame of frames) {
    const payload = frame.event?.payload;
    if (payload?.kind === "command.recorded" && payload.command.intent.kind === "message.submit") submittedReferences.add(payload.command.intent.reference.id);
  }
  for (const frame of frames) {
    const event = frame.event;
    const message = frame.transcript?.message;
    if (event?.payload.kind !== "command.recorded" || message?.role !== "user") continue;
    const command = event.payload.command;
    const intent = command.intent;
    let candidate: InteractionReceiptEvidence | null = null;
    if (intent.kind === "interaction.resolve" && command.sessionId === frame.sessionId && event.sessionId === frame.sessionId && message.parts.length === 1 && message.parts[0]?.type === "data-interaction-resolution" && !submittedReferences.has(intent.reference.id)) {
      const answer = readInteractionResolutionContent(message);
      const body = bodyKey(message);
      if (answer && body !== null && answer.interactionId === intent.interactionId && resolutionKey(answer.resolution) === resolutionKey(intent.resolution)) candidate = { commandId: command.id, messageId: message.id, sequence: frame.sequence, reference: intent.reference, body, answer };
    }
    if (!receipts.has(message.id)) receipts.set(message.id, candidate);
    else {
      const previous = receipts.get(message.id);
      if (!previous || !candidate || previous.commandId !== candidate.commandId || previous.body !== candidate.body || !sameReference(previous.reference, candidate.reference)) receipts.set(message.id, null);
    }
  }
  for (const frame of frames) {
    const message = frame.transcript?.message;
    if (message?.role !== "user") continue;
    const evidence = receipts.get(message.id);
    const payload = frame.event?.payload;
    if (!evidence || frame.sequence < evidence.sequence || bodyKey(message) !== evidence.body || (payload?.kind === "transcript.referenced" && !sameReference(payload.reference, evidence.reference))) receipts.set(message.id, null);
  }
  return receipts;
}

/** Missing producer evidence is neutral content, never a receipt or a dropped message. */
export function readInteractionResolutionMessage(message: UIMessage, evidence?: InteractionReceiptEvidence | null): InteractionResolutionMessage | null {
  return message.role === "user" && evidence && message.id === evidence.messageId && bodyKey(message) === evidence.body ? evidence.answer : null;
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
