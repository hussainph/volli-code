/**
 * One host-authored notice into one Session, delivered when it can be read.
 *
 * Shared by the things in main that tell a Session about work it is not
 * doing itself: a subagent's completion (`delegate-session.ts`), a watched
 * Session or Ticket changing (`watches.ts`), and a background shell exiting or
 * matching (`shell/shell-notices.ts`, VC-495). All are the same act — a marked
 * `steer` message whose command id is its one durable mark of "told" — so
 * both take the same three answers about WHEN:
 *
 * - The reader holds a live executor: submit now. Mid-turn, `steer` delivery
 *   is read at the next step; idle, it opens a turn. The chat never waits on
 *   the notice, and the notice never waits on a tool call.
 * - The reader is between attachments: park on its own stream and submit at
 *   its next `attachment.opened`. A `message.submit` into a Session with no
 *   executor is refused durably under the command id it was sent with, so a
 *   refused notice would read as delivered forever.
 * - The reader has stopped: nobody to tell. The drop is reported, never
 *   silent.
 *
 * ## Never awaited on the submit
 *
 * The receipt is read, not awaited by a caller, and the reason is a deadlock
 * rather than taste: a `message.submit` into an IDLE reader answers when the
 * turn it opened ends, and callers here sit inside stream listeners — the
 * runtime paces each publish by its slowest listener, so a listener parked on
 * the reader's own turn would hold the very frames that turn needs to publish.
 */

import { shortSessionId } from "@volli/shared";
import type {
  HostNotice,
  SessionRuntime,
  SessionRuntimeCommandRequest,
} from "@volli/session-engine";
export type { HostNotice } from "@volli/session-engine";
import { isSessionStreamFrame } from "@volli/session-engine";

export interface HostNoticeDeliveryPorts {
  runtime: Pick<SessionRuntime, "command" | "subscribe" | "projection">;
  report: (message: string) => void;
  /** Optional during migration: watches and subagents keep their existing ports. */
  delivery?: HostNoticeDelivery;
}

/** Where a notice ended up, for the log and for tests. */
export type NoticeDelivery = "delivered" | "parked" | "reader-stopped" | "already-settled";

export interface HostNoticeDelivery {
  deliver(notice: HostNotice): Promise<NoticeDelivery>;
  /** Reconstruct subscriptions from storage, without waiting for idle turns. */
  recover(): Promise<void>;
  /** Release this host's subscriptions; leave pending payloads durable. */
  close(): void;
}

export function hostNoticeCommand(notice: HostNotice): SessionRuntimeCommandRequest {
  return {
    commandId: notice.commandId,
    origin: {
      kind: "volli",
      reason:
        notice.metadata.notice.kind === "watch"
          ? "watch-notice"
          : notice.metadata.notice.kind === "subagent"
            ? "subagent-notice"
            : notice.metadata.notice.kind === "background-shell"
              ? "shell-notice"
              : "browser-notice",
    },
    sessionId: notice.sessionId,
    command: {
      kind: "message.submit",
      delivery: "steer",
      message: {
        id: notice.messageId,
        role: "user",
        metadata: notice.metadata,
        parts: [{ type: "text", text: notice.text }],
      },
    },
  };
}

/** Submit one notice now; the receipt is read, and a refusal is reported. */
export function submitHostNotice(ports: HostNoticeDeliveryPorts, notice: HostNotice): void {
  void ports.runtime
    .command(hostNoticeCommand(notice))
    .then((result) => {
      const receipt = result.receipt;
      if (receipt !== null && receipt.status === "rejected") {
        ports.report(`${notice.label} was refused: ${receipt.code} ${receipt.detail}`);
      }
    })
    .catch((error: unknown) => {
      ports.report(`${notice.label} failed: ${errorText(error)}`);
    });
}

/**
 * The one delivery: now, parked until the reader's next attachment, or
 * dropped (and reported) for a reader that stopped.
 */
export async function deliverHostNotice(
  ports: HostNoticeDeliveryPorts,
  notice: HostNotice,
): Promise<NoticeDelivery> {
  if (ports.delivery !== undefined) return ports.delivery.deliver(notice);
  const { projection, throughSequence } = await ports.runtime.projection({
    sessionId: notice.sessionId,
  });
  if (projection.stopped !== null) {
    ports.report(
      `${notice.label} was not delivered: Session ${shortSessionId(notice.sessionId)} is stopped`,
    );
    return "reader-stopped";
  }
  if (projection.liveExecutor !== null) {
    submitHostNotice(ports, notice);
    return "delivered";
  }
  // Replay-safe on purpose. `subscribe` replays everything after the cursor
  // BEFORE it returns, so an attachment that opened between the projection
  // read above and the subscription lands here while `subscribe` is still
  // running — with no unsubscribe to call yet. The listener only records that
  // it is done; whoever holds the handle (the listener, once it exists, or the
  // line after `subscribe` returns) releases it.
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  const settle = (): void => {
    settled = true;
    unsubscribe?.();
  };
  const release = await ports.runtime.subscribe(
    { sessionId: notice.sessionId, afterSequence: throughSequence },
    (emission) => {
      if (settled || !isSessionStreamFrame(emission)) return;
      const kind = emission.event.payload.kind;
      if (kind === "session.stopped") {
        settle();
        ports.report(
          `${notice.label} was not delivered: Session ${shortSessionId(notice.sessionId)} stopped before it attached again`,
        );
        return;
      }
      if (kind !== "attachment.opened") return;
      settle();
      submitHostNotice(ports, notice);
    },
    (error) => {
      ports.report(`parked ${notice.label} lost its stream: ${errorText(error)}`);
    },
  );
  unsubscribe = release;
  if (settled) release();
  return "parked";
}

/**
 * The first `limit` UTF-16 units of `text`, never ending on half a surrogate
 * pair: a notice cut through an emoji or a CJK extension character would hand
 * the model a lone surrogate, which some providers reject outright.
 */
export function cutAtCodePoint(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
