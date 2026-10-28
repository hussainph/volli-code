/**
 * Name-based ids a runner derives instead of minting, so a retry after a
 * crash names the same record (a Session, a first message, a command) rather
 * than a second one.
 *
 * Every namespace and every `parts` spelling passed here is DURABLE the moment
 * it ships: a changed derivation does not error, it duplicates history on the
 * next retry. Each caller names its namespace as a frozen constant.
 */
import { createHash } from "node:crypto";

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/**
 * A name-based UUID for `parts` joined by `\u0000` under `namespace` (a UUID):
 * RFC 9562's UUIDv8 (§5.8, custom), built the way v5 is but over SHA-256
 * rather than SHA-1. An id, not a secret; SHA-256 only keeps a weak hash out
 * of the codebase.
 */
export function nameBasedUuid(namespace: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256")
    .update(uuidBytes(namespace))
    .update(parts.join("\u0000"), "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The namespace of a cloud Automation Run's runner-derived ids. DURABLE: a
 * re-leased job after a crash must derive the same first message.
 */
export const AUTOMATION_RUN_ID_NAMESPACE = "bca938ed-df6e-465f-ad91-858129e62788";

/**
 * The namespace of an agent's backend command ids derived from its tool call
 * (`<sessionId>:<toolCallId>`), for backend receipts that take only UUIDs.
 * DURABLE: a replayed tool call must answer with the first call's receipt.
 */
export const AGENT_COMMAND_ID_NAMESPACE = "e831af85-72f9-4b49-9a3d-0ce5e28fb083";

/**
 * A cloud Automation Run's ids, all derived from the producer-minted `runId`.
 * FROZEN derivations: `operationId` keys `Sessions.create` (its create command
 * is `<operationId>:create`), and the message ids key the first message.
 */
export function automationRunIds(runId: string): {
  operationId: string;
  messageCommandId: string;
  messageId: string;
} {
  return {
    operationId: `automation-run:${runId}`,
    messageCommandId: nameBasedUuid(AUTOMATION_RUN_ID_NAMESPACE, "first-message-command", runId),
    messageId: nameBasedUuid(AUTOMATION_RUN_ID_NAMESPACE, "first-message", runId),
  };
}

/** The backend command id of an agent's tool call. FROZEN derivation. */
export function agentToolCommandId(sessionId: string, toolCallId: string): string {
  return nameBasedUuid(AGENT_COMMAND_ID_NAMESPACE, `${sessionId}:${toolCallId}`);
}
