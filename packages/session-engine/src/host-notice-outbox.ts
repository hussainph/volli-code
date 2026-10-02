/**
 * Host-owned durable delivery, never a Client Surface API. Producers sanitize
 * EVERY field before enqueueing, including the complete model-facing text and
 * its untrusted-prose nonce. An outbox keeps that first payload byte-for-byte:
 * retrying an id must not rebuild the message or mint a different nonce.
 *
 * Storage implementations commit put/settle before resolving. A terminal
 * receipt discards the payload but retains the id, so producer replays cannot
 * resurrect a delivered or deliberately dropped notice. Runtime acceptance is
 * evidence, not an exactly-once guarantee from the executor.
 *
 * Plain TypeScript; the host supplies storage and the live runtime.
 */
import type { SessionHostNoticeMetadata } from "@volli/shared";

export interface HostNotice {
  sessionId: string;
  commandId: string;
  messageId: string;
  text: string;
  metadata: SessionHostNoticeMetadata;
  /** Sanitized description for host diagnostics. */
  label: string;
}

export type HostNoticeReceipt =
  | { status: "accepted" }
  | { status: "rejected"; code: string; detail: string | null }
  | { status: "dropped"; reason: "reader-stopped" };

export interface HostNoticeOutbox {
  /** First writer wins. null means this id already has a terminal receipt. */
  put(notice: HostNotice): Promise<HostNotice | null>;
  /** First-in order, so recovery cannot put a shell's exit before its match. */
  pending(): Promise<readonly HostNotice[]>;
  /** Atomically discard the payload and keep the first terminal receipt. */
  settle(commandId: string, receipt: HostNoticeReceipt): Promise<void>;
}
