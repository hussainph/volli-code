/**
 * A cloud Session's message body, built once for the client that sends it,
 * the backend that stages it and the runner that delivers it.
 *
 * A `message.submit` intent names its body by reference; the body itself is
 * a transcript artifact. The artifact here is exactly the one the runner's
 * Session runtime writes for the same command (`thread:<session>:root`,
 * `branch:<session>:main`, `attempt:<command>`, `turn:<command>`), and the
 * reference is the transcript store's own: `sha256:<hex>` over the
 * artifact's canonical JSON, as both `id` and `digest`. So the reference the
 * client queues is the reference the runner's ledger records, and the body
 * the backend stages is byte-for-byte the body the runner later packs.
 *
 * An interaction answer carries no body: its artifact is derived entirely
 * from the intent (as the runtime derives it), so its reference is checked,
 * not staged.
 *
 * Errors name what is wrong with the body, never where anything lives.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { INLINE_ARTIFACT_MAX_BYTES } from "./cloud/transcript-pack";
import { decodeSessionCommandIntent } from "./session-event-codec";
import { transcriptCanonicalJson as canonicalJson } from "./transcript-canonical-json";
import type {
  SessionCommandIntent,
  SessionInteractionResolution,
  TranscriptReference,
} from "./session-ledger";

/** The transcript store's media type for a UI-message artifact. */
export const CLOUD_MESSAGE_MEDIA_TYPE = "application/vnd.volli.ui-message+json";

/** A message as a client sends it: a UI message's JSON shape. */
export interface CloudUiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: readonly unknown[];
  metadata?: unknown;
}

/** The transcript artifact of one cloud command (the runtime's `SessionTranscriptArtifact`). */
export interface CloudMessageArtifact {
  version: 1;
  threadId: string;
  branchId: string;
  attemptId: string;
  turnId: string | null;
  message: CloudUiMessage;
}

/** The staged body and its reference. `bytes` is the body's UTF-8 length. */
export interface CloudMessageBody {
  body: string;
  bytes: number;
  reference: TranscriptReference;
}

/** What `sessions.command` takes for a command: the intent's JSON text and, for a message, its body. */
export interface CloudCommandArgs {
  intent: string;
  /** Present only for `message.submit`. */
  body?: string;
  reference: TranscriptReference;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function referenceOf(body: string): TranscriptReference {
  const id = `sha256:${bytesToHex(sha256(utf8ToBytes(body)))}`;
  return { id, digest: id, mediaType: CLOUD_MESSAGE_MEDIA_TYPE };
}

function encoded(artifact: CloudMessageArtifact): CloudMessageBody {
  const body = canonicalJson(artifact);
  return { body, bytes: utf8ToBytes(body).length, reference: referenceOf(body) };
}

/** The artifact the runtime writes for a message sent as `commandId`. */
export function cloudMessageArtifact(input: {
  sessionId: string;
  commandId: string;
  message: CloudUiMessage;
}): CloudMessageArtifact {
  return {
    version: 1,
    threadId: `thread:${input.sessionId}:root`,
    branchId: `branch:${input.sessionId}:main`,
    attemptId: `attempt:${input.commandId}`,
    turnId: `turn:${input.commandId}`,
    message: input.message,
  };
}

/** The artifact the runtime writes for an interaction answer sent as `commandId`. */
export function cloudInteractionArtifact(input: {
  sessionId: string;
  commandId: string;
  interactionId: string;
  resolution: SessionInteractionResolution;
}): CloudMessageArtifact {
  return {
    version: 1,
    threadId: `thread:${input.sessionId}:root`,
    branchId: `branch:${input.sessionId}:main`,
    attemptId: `attempt:${input.commandId}`,
    turnId: null,
    message: {
      id: input.commandId,
      role: "user",
      metadata: { kind: "interaction-resolution", interactionId: input.interactionId },
      parts: [{ type: "data-interaction-resolution", data: input.resolution }],
    },
  };
}

/**
 * A `message.submit` command for `sessions.command`: the intent's JSON text,
 * the canonical body to stage beside it, and the reference both name.
 * Throws when the body is past the inline limit.
 */
export function cloudMessageSubmit(input: {
  sessionId: string;
  commandId: string;
  message: CloudUiMessage;
}): CloudCommandArgs & { body: string } {
  const { body, bytes, reference } = encoded(cloudMessageArtifact(input));
  if (bytes > INLINE_ARTIFACT_MAX_BYTES)
    throw new Error(`A message is limited to ${INLINE_ARTIFACT_MAX_BYTES} bytes.`);
  const intent: SessionCommandIntent = { kind: "message.submit", reference };
  return { intent: JSON.stringify(intent), body, reference };
}

/**
 * An `interaction.resolve` command for `sessions.command` (no body). The
 * resolution is read through the Session codec first, so the reference is
 * over exactly what the backend and the runner will read back.
 */
export function cloudInteractionResolve(input: {
  sessionId: string;
  commandId: string;
  attachmentId: string;
  interactionId: string;
  resolution: SessionInteractionResolution;
}): CloudCommandArgs {
  const draft = {
    kind: "interaction.resolve",
    attachmentId: input.attachmentId,
    interactionId: input.interactionId,
    resolution: input.resolution,
    reference: { id: "", mediaType: null, digest: null },
  };
  const decoded = decodeSessionCommandIntent(JSON.parse(JSON.stringify(draft)), "interaction");
  /* v8 ignore next -- the draft's kind is fixed above. */
  if (decoded.kind !== "interaction.resolve") throw new Error("Not an interaction answer.");
  const { reference } = encoded(
    cloudInteractionArtifact({
      sessionId: input.sessionId,
      commandId: input.commandId,
      interactionId: decoded.interactionId,
      resolution: decoded.resolution,
    }),
  );
  return { intent: JSON.stringify({ ...decoded, reference }), reference };
}

function sameReference(left: TranscriptReference, right: TranscriptReference): boolean {
  return left.id === right.id && left.digest === right.digest && left.mediaType === right.mediaType;
}

/**
 * Checks an interaction answer's reference against the artifact its intent
 * derives. Throws when they differ.
 */
export function assertCloudInteractionReference(
  scope: { sessionId: string; commandId: string },
  intent: Extract<SessionCommandIntent, { kind: "interaction.resolve" }>,
): void {
  const { reference } = encoded(
    cloudInteractionArtifact({
      ...scope,
      interactionId: intent.interactionId,
      resolution: intent.resolution,
    }),
  );
  if (!sameReference(reference, intent.reference))
    throw new Error("The answer's reference is not this command's.");
}

/**
 * Reads a staged message body for `commandId`: within the inline limit,
 * canonical JSON, the artifact this command's message makes (a user message,
 * this Session's thread, this command's attempt and turn), and the bytes
 * `reference` names. Throws a path-free error on any mismatch.
 */
export function readCloudMessageBody(input: {
  sessionId: string;
  commandId: string;
  reference: TranscriptReference;
  body: string;
}): CloudMessageArtifact {
  const { body } = input;
  if (utf8ToBytes(body).length > INLINE_ARTIFACT_MAX_BYTES)
    throw new Error(`A message is limited to ${INLINE_ARTIFACT_MAX_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("The message body is not JSON.");
  }
  if (!isRecord(value) || !isRecord(value.message))
    throw new Error("The message body is not a transcript artifact.");
  const message = value.message;
  if (
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    message.role !== "user" ||
    !Array.isArray(message.parts)
  )
    throw new Error("The message body is not a user message.");
  const expected = cloudMessageArtifact({
    sessionId: input.sessionId,
    commandId: input.commandId,
    message: message as unknown as CloudUiMessage,
  });
  if (canonicalJson(value) !== body || canonicalJson(expected) !== body)
    throw new Error("The message body is not this command's canonical artifact.");
  if (!sameReference(referenceOf(body), input.reference))
    throw new Error("The message body does not match its reference.");
  return expected;
}
