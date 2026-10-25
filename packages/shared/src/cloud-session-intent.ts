/** The full Session codec is intentionally outside the lightweight cloud entry point. */
import type { SessionCommandIntent } from "./session-ledger";
import type { FollowUpIntent } from "./cloud/follow-ups";
import { decodeSessionCommandIntent } from "./session-event-codec";

/** These runtime controls deliberately do not extend the immutable event command vocabulary. */
export function decodeCloudSessionIntent(value: unknown): SessionCommandIntent | FollowUpIntent {
  if (value === null || typeof value !== "object")
    return decodeSessionCommandIntent(value, "intent");
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "message.edit" &&
    raw.kind !== "message.cancel" &&
    !(raw.kind === "message.submit" && raw.delivery !== undefined)
  )
    return decodeSessionCommandIntent(value, "intent");
  if (typeof raw.messageId !== "string" || raw.messageId.length === 0 || raw.messageId.length > 512)
    throw new Error("A follow-up needs its message id.");
  const revision = raw.expectedRevision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0))
    throw new Error("A queue revision must be a nonnegative integer.");
  if (raw.kind === "message.cancel")
    return {
      kind: raw.kind,
      messageId: raw.messageId,
      ...(revision === undefined ? {} : { expectedRevision: revision as number }),
    };
  if (raw.kind === "message.submit" && raw.delivery === "steer" && raw.reference === undefined)
    return { kind: "message.submit", delivery: "steer", messageId: raw.messageId };
  const submit = decodeSessionCommandIntent(
    { kind: "message.submit", reference: raw.reference },
    "intent",
  ) as Extract<SessionCommandIntent, { kind: "message.submit" }>;
  if (raw.kind === "message.edit")
    return {
      kind: raw.kind,
      messageId: raw.messageId,
      reference: submit.reference,
      ...(revision === undefined ? {} : { expectedRevision: revision as number }),
    };
  if (raw.delivery !== "queue" && raw.delivery !== "steer")
    throw new Error("Unknown message delivery.");
  return {
    kind: "message.submit",
    delivery: raw.delivery,
    messageId: raw.messageId,
    reference: submit.reference,
  };
}
