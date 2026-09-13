/**
 * What a Session is TOLD when the person moves a hold (VC-239), and the relay
 * that tells it.
 *
 * In-band on purpose, the way supervision steers are: the transcript is the
 * one channel a model is guaranteed to read, so a takeover it would otherwise
 * learn about by failing arrives as one line before the next write. One line,
 * because the Session is mid-turn and this is a fact to act on, not a
 * conversation. Each notice names the rule the next refusal would cite, so
 * the two are recognisably the same event.
 *
 * Delivered as a `steer` into the live attachment. A steer joins a running
 * turn; the host's hold events only fire for tabs a Session holds, and a
 * Session holds a tab only during a turn, so there is no idle Session for a
 * steer to wake. A delivery that fails is logged and dropped: nobody is
 * waiting on it, the pill already shows the new state, and the Session's next
 * write is refused with the same words either way.
 *
 * One known and accepted gap: the hold ends on the turn observation, a few
 * milliseconds after Pi's own turn end, and the pill lags the state push by
 * a frame. A press that lands in that window steers a Session whose turn is
 * already over, and a steer on an idle attachment is submitted as a prompt
 * (`runtime.ts`, `submitUserMessage`) — one short turn nobody asked for,
 * reading a line about a tab it no longer holds. Rare enough to accept; the
 * honest fix, if it ever matters, is a steer-or-drop delivery in the runtime
 * rather than a guess here about whether the turn is still live.
 */

import { sessionHostNoticeMetadata } from "@volli/shared";
import type { SessionHostNoticeMetadata } from "@volli/shared";

import type { BrowserHoldEvent } from "./tab-host";

/**
 * One line of Volli's own words steered into a Session's live turn, and the
 * shared semantic metadata that tells every client it is Volli's (VC-330).
 */
export interface HoldNotice {
  sessionId: string;
  text: string;
  metadata: SessionHostNoticeMetadata;
}

/**
 * The durable transcript message for a hold notice.
 *
 * Kept beside the notice mapping so the required semantic metadata cannot be
 * dropped by Electron bootstrap glue while it builds `message.submit`.
 */
export function holdNoticeMessage(notice: HoldNotice, messageId: string) {
  return {
    id: messageId,
    role: "user" as const,
    metadata: notice.metadata,
    parts: [{ type: "text" as const, text: notice.text }],
  };
}

/** The one line the displaced Session reads after a takeover. */
export function takeoverNotice(tabId: string): string {
  return `[Volli: the person took Browser Tab ${tabId}] Your writes there are refused (browser.person-has-tab) until they hand it back; carry on with other work or wait, and take a fresh snapshot before you act there again.`;
}

/** The one line the holding Session reads when asked to leave. */
export function askToLeaveNotice(tabId: string): string {
  return `[Volli: the person asks you to leave Browser Tab ${tabId}] Release it with browser_release as soon as it is safe to stop; the hold stays yours until you do or your turn ends.`;
}

/** The steer door, narrowed to what the relay needs and what a test can fake. */
export interface HoldNoticePorts {
  steer(notice: HoldNotice): Promise<void>;
  log?(message: string): void;
}

/**
 * The notice one hold event owes, or null when it owes none. Pure, so the
 * mapping is testable apart from the delivery: a takeover that displaced
 * nobody has nobody to tell.
 */
export function holdNoticeFor(event: BrowserHoldEvent): HoldNotice | null {
  switch (event.kind) {
    case "person-took":
      return event.displaced === null
        ? null
        : {
            sessionId: event.displaced.sessionId,
            text: takeoverNotice(event.tabId),
            metadata: sessionHostNoticeMetadata({
              kind: "browser-hold",
              tabId: event.tabId,
              tabTitle: event.tabTitle,
              tabHostname: event.tabHostname,
              action: "person-took",
            }),
          };
    case "ask-to-leave":
      return {
        sessionId: event.holder.sessionId,
        text: askToLeaveNotice(event.tabId),
        metadata: sessionHostNoticeMetadata({
          kind: "browser-hold",
          tabId: event.tabId,
          tabTitle: event.tabTitle,
          tabHostname: event.tabHostname,
          action: "ask-to-leave",
        }),
      };
    case "taken":
    case "released":
    case "person-handed-back":
      return null;
  }
}

/**
 * Subscribes the relay to a host's hold events. Returns the unsubscribe.
 * The host is typed by its one method so the relay needs no Electron.
 */
export function relayHoldNotices(
  host: { onHoldChange(listener: (event: BrowserHoldEvent) => void): () => void },
  ports: HoldNoticePorts,
): () => void {
  return host.onHoldChange((event) => {
    const notice = holdNoticeFor(event);
    if (notice === null) return;
    void ports.steer(notice).catch((error: unknown) => {
      ports.log?.(
        `[volli] could not tell Session ${notice.sessionId} about Browser Tab ${event.tabId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
}
