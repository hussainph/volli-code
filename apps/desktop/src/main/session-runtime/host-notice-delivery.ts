/**
 * One host-authored notice into one Session, delivered when it can be read.
 *
 * Shared by the two things in main that tell a Session about work it is not
 * doing itself: a subagent's completion (`delegate-session.ts`) and a watched
 * Session or Ticket changing (`watches.ts`). Both are the same act — a marked
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
import type { SessionHostNoticeMetadata } from "@volli/shared";
import type { SessionRuntime } from "@volli/session-engine";
import { isSessionStreamFrame } from "@volli/session-engine";

export interface HostNoticeDeliveryPorts {
  runtime: Pick<SessionRuntime, "command" | "subscribe" | "projection">;
  report: (message: string) => void;
}

export interface HostNotice {
  /** The Session that reads the notice. */
  sessionId: string;
  /** Durable ids: the command id is the one mark of "told", so replays land once. */
  commandId: string;
  messageId: string;
  /** What the model reads, in-band. */
  text: string;
  /** What every Session client reads to draw it as Volli's row, not a person's. */
  metadata: SessionHostNoticeMetadata;
  /** How the log names this notice, e.g. "subagent notice for ab12 to parent cd34". */
  label: string;
}

/** Where a notice ended up, for the log and for tests. */
export type NoticeDelivery = "delivered" | "parked" | "reader-stopped";

/** Submit one notice now; the receipt is read, and a refusal is reported. */
export function submitHostNotice(ports: HostNoticeDeliveryPorts, notice: HostNotice): void {
  void ports.runtime
    .command({
      commandId: notice.commandId,
      sessionId: notice.sessionId,
      command: {
        kind: "message.submit",
        delivery: "steer",
        message: {
          id: notice.messageId,
          role: "user",
          // Shared semantic metadata lets every Session client draw this
          // message as a host-authored row. The adapter delivers only the
          // text to the Agent Runtime.
          metadata: notice.metadata,
          parts: [{ type: "text", text: notice.text }],
        },
      },
    })
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
