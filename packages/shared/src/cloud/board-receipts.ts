/**
 * Board command receipts in Volli Cloud: what makes every board write
 * idempotent by its `commandId`.
 *
 * Every board mutation carries a caller-minted `commandId`. The backend
 * records `commandId → reply` in the same transaction as the write, with a
 * digest of the canonical intent. A repeat with the same intent inside
 * {@link BOARD_RECEIPT_TTL_MS} changes nothing and answers the recorded
 * reply; the same id with another intent is the caller's conflict. Past the
 * window a receipt reads as absent whether or not it has been pruned yet,
 * and the create-by-id check still refuses a duplicate row.
 *
 * The digest is the local board's rule kept verbatim (sha256 of the canonical
 * JSON of `{operation, intent}`), so the two cannot disagree about what
 * "the same command" means.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** How long a receipt answers a retry: far past any client's reconnect backoff. */
const BOARD_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stable JSON: object keys sorted by code unit, `undefined` members dropped
 * (as `JSON.stringify` drops them), arrays kept in order. Board intents are
 * validated JSON values, so nothing here meets a cycle or a class instance.
 */
function canonicalJson(value: unknown): string {
  // Only an array item can be undefined here (members are dropped below): JSON writes null.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

/** The digest a receipt stores: sha256 (hex) of the canonical `{operation, intent}`. */
export function boardIntentDigest(operation: string, intent: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson({ operation, intent: intent ?? null }))));
}

/** When a receipt recorded at `recordedAt` stops answering. */
export function boardReceiptExpiry(recordedAt: number): number {
  return recordedAt + BOARD_RECEIPT_TTL_MS;
}

/** What a stored receipt means for a command arriving at `now`. */
export type BoardReceiptVerdict =
  | { kind: "absent" }
  | { kind: "replay"; reply: unknown }
  | { kind: "conflict" };

/**
 * Whether a stored receipt (or none) answers this command. An expired receipt
 * is absent; a live one with another operation or intent is a conflict.
 */
export function boardReceiptVerdict(
  stored: { operation: string; intentDigest: string; reply: unknown; expiresAt: number } | null,
  command: { operation: string; intent: unknown; now: number },
): BoardReceiptVerdict {
  if (stored === null || stored.expiresAt <= command.now) return { kind: "absent" };
  if (
    stored.operation !== command.operation ||
    stored.intentDigest !== boardIntentDigest(command.operation, command.intent)
  ) {
    return { kind: "conflict" };
  }
  return { kind: "replay", reply: stored.reply };
}
