/**
 * The rules `sessions.command` applies before a command reaches the inbox:
 * which command ids a caller may use, which Sessions an agent may command,
 * and what an inline message body must be.
 *
 * ## Command ids
 *
 * A person's command id is a UUID, as every cloud id is. An agent's may also
 * be the frozen operation id its tool call already carries locally,
 * `${callerSessionId}:${toolCallId}` (`session_send` / `session_stop`): the
 * same tool call replayed after a crash must land on the same job, and a
 * fresh UUID per replay would queue it twice. Such an id is accepted only
 * when it starts with the calling agent's own Session id, so one Session can
 * never claim another's ids, and only up to the derived-id bound.
 *
 * ## Supervision scope (agents only)
 *
 * The local supervision rules (`supervise-session.ts`, VC-86/VC-861), kept
 * once more at the backend because the target may be on another runner:
 *
 * - its own Session: only `session.signal` (`volli session done|blocked`);
 * - a subagent supervises nothing;
 * - a Board (`project`) Session: any Session of its own project;
 * - a Ticket Session: only the subagents it delegated;
 * - and toward another Session only a steer (`message.submit`) or a stop
 *   (`session.stop`, attributed to the calling Session).
 *
 * The owner check (`requireSessionActor`) has already run: an agent acts as
 * its Session's owner and never on anyone else's Session.
 *
 * ## Inline message bodies
 *
 * A `message.submit` whose target may be on another runner carries its body
 * as `artifact`: the canonical JSON of a `SessionTranscriptArtifact`, staged
 * in the same transaction as the job so the target runner can hydrate it
 * (`transcripts.commandArtifact`). The body is bound to the intent: its
 * SHA-256 is the reference's digest, the reference names the transcript
 * media type, and the message is the one user message the command sends,
 * `${commandId}:message`, text parts only.
 */

import { ConvexError } from "convex/values";

import type { SessionCommandIntent } from "@volli/shared";
import {
  INLINE_ARTIFACT_MAX_BYTES,
  artifactDigestHex,
  canonicalJson,
  isDerivedId,
  isUuid,
  utf8Length,
} from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { Caller } from "./actorAuth";

/**
 * The media type of a transcript artifact reference. Frozen: it is
 * `TRANSCRIPT_ARTIFACT_MEDIA_TYPE` in `@volli/session-engine` (which this
 * backend does not bundle), and every runner's artifact store refuses any
 * other. A test pins the two together.
 */
export const COMMAND_ARTIFACT_MEDIA_TYPE = "application/vnd.volli.ui-message+json";

function refuse(code: string, message: string) {
  return new ConvexError({ code, message });
}

/** Whether `caller` may use `commandId` (see the module comment); `invalid_request` when not. */
export function checkCommandId(caller: Caller, commandId: string): void {
  // `as unknown`: `isUuid` is a guard on `string`, which would narrow the rest to `never`.
  if (isUuid(commandId as unknown)) return;
  if (caller.kind === "agent") {
    const prefix = `${caller.agent.sessionId}:`;
    if (
      isDerivedId(commandId) &&
      commandId.length > prefix.length &&
      commandId.startsWith(prefix)
    ) {
      return;
    }
    throw refuse(
      "invalid_request",
      "An agent's command id is a UUID or its own Session's `<sessionId>:<toolCallId>` operation id.",
    );
  }
  throw refuse("invalid_request", "The command id is not a UUID.");
}

/** Throws `forbidden` unless the agent `caller` may send `intent` to `target`. People pass. */
export function checkSupervision(
  caller: Caller,
  target: Doc<"sessions">,
  intent: Exclude<SessionCommandIntent, { kind: "session.create" }>,
): void {
  if (caller.kind !== "agent") {
    // A person's stop is the person's: never recorded as another actor's.
    if (intent.kind === "session.stop" && intent.by.kind !== "user") {
      throw refuse("invalid_request", "A person's stop is recorded as theirs (`by: user`).");
    }
    return;
  }
  const self = caller.agent.session;
  if (target.id === self.id) {
    if (intent.kind === "session.signal") return;
    throw refuse(
      "forbidden",
      "A Session commands itself only with a signal (done or blocked); finish the turn instead.",
    );
  }
  if (self.role === "subagent") {
    throw refuse("forbidden", "A subagent Session cannot steer or stop other Sessions.");
  }
  if (intent.kind !== "message.submit" && intent.kind !== "session.stop") {
    throw refuse(
      "forbidden",
      "An agent may only steer (send) or stop another Session; a person does the rest.",
    );
  }
  if (target.projectId !== self.projectId) {
    throw refuse("forbidden", "An agent supervises only Sessions of its own project.");
  }
  if (
    self.role !== "project" &&
    (self.role !== "ticket" || target.role !== "subagent" || target.parentSessionId !== self.id)
  ) {
    throw refuse(
      "forbidden",
      "That Session is not one this Session delegated; a ticket Session may steer only its own subagents.",
    );
  }
  if (
    intent.kind === "session.stop" &&
    (intent.by.kind !== "session" || intent.by.sessionId !== self.id)
  ) {
    throw refuse("invalid_request", "An agent's stop is recorded as its own Session's.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A checked inline body, ready to stage beside its command. */
export interface CommandArtifact {
  digest: string;
  mediaType: string;
  bytes: number;
  body: string;
}

/**
 * Checks an inline body against the `message.submit` it travels with (see the
 * module comment), or throws `invalid_request` naming what is wrong.
 */
export async function readCommandArtifact(
  artifact: string,
  intent: Extract<SessionCommandIntent, { kind: "message.submit" }>,
  commandId: string,
): Promise<CommandArtifact> {
  const bad = (why: string) => refuse("invalid_request", `The message body ${why}.`);
  const bytes = utf8Length(artifact);
  if (bytes > INLINE_ARTIFACT_MAX_BYTES) {
    throw bad(`is limited to ${INLINE_ARTIFACT_MAX_BYTES} bytes`);
  }
  const { reference } = intent;
  const hex = artifactDigestHex(reference.id);
  if (hex === null || reference.digest !== reference.id) {
    throw bad("needs a `sha256:<hex>` reference whose digest is its id");
  }
  if (reference.mediaType !== COMMAND_ARTIFACT_MEDIA_TYPE) {
    throw bad(`reference must name ${COMMAND_ARTIFACT_MEDIA_TYPE}`);
  }
  if ((await sha256Hex(artifact)) !== hex) throw bad("does not match its reference's digest");
  let value: unknown;
  try {
    value = JSON.parse(artifact);
  } catch {
    throw bad("is not JSON");
  }
  if (canonicalJson(value) !== artifact) throw bad("is not canonical JSON");
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.threadId !== "string" ||
    typeof value.branchId !== "string" ||
    typeof value.attemptId !== "string" ||
    (value.turnId !== null && typeof value.turnId !== "string")
  ) {
    throw bad("is not a transcript artifact");
  }
  const message = value.message;
  if (!isRecord(message) || message.role !== "user") throw bad("must be one user message");
  if (message.id !== `${commandId}:message`) {
    throw bad("must be this command's message (`<commandId>:message`)");
  }
  if (
    !Array.isArray(message.parts) ||
    message.parts.length === 0 ||
    !message.parts.every(
      (part) => isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
  ) {
    throw bad("carries text parts only");
  }
  return { digest: reference.id, mediaType: reference.mediaType, bytes, body: artifact };
}
