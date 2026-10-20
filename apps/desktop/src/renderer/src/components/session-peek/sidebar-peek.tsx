/**
 * VC-30 — the peek wiring both sidebars share.
 *
 * The left band and the in-ticket rail mounted the same controller through two
 * hand-written copies of the same four things: the pull door, the answer and
 * send paths, the unread dot, and the global hold. The copies had already
 * drifted — one threw on a refused read and the other returned `null`, one
 * checked whether a trailing message was delivered and the other did not — and
 * a peek that behaves differently depending on which sidebar it opened from is
 * the bug this module exists to make impossible.
 *
 * WHAT IS GENUINELY PER-SURFACE stays a parameter: how a row is activated
 * (a nav row navigates, a rail row selects a pane), where the conversation
 * overlay lives, and which store holds the read receipts — the left band's
 * `project-sessions`, the rail's `ticket-session-records`. Everything else is
 * here, once.
 *
 * ONE FAILURE CONVENTION FOR THE PULL. `readContent` REJECTS when the door
 * refuses, rather than answering `null`. A failed local fold is retried on
 * the next glance; an empty fold is remembered. Utility refusal/failure keeps
 * the readable local fold and may retry after the summary cooldown, never on
 * a background timer.
 *
 * ACTING ADOPTS, READING DOES NOT. A peek first pulls a local fold; only an
 * explicit unpinned glance may ask for utility refinement. An
 * answer, a send or viewing the conversation is an explicit intent, and only
 * then is the Session adopted so the SHIPPED delivery path — `answerInteraction`
 * and the resident client's `submit` — does the work. Neither is re-implemented
 * here, and every refusal is reported as `false` rather than swallowed
 * (AGENTS.md: never silently swallow a failed mutation).
 *
 * A PEEK NEVER READS (D6). `readContent` marks nothing. Reading happens on a
 * successful answer or send, on opening the Session, on viewing its
 * conversation, and on an explicit `setRead`.
 */
import * as React from "react";
import {
  getChatClient,
  type InteractionSubmission,
  type MessageDelivery,
} from "@volli/session-presentation";

import { notAvailableOn } from "@renderer/components/hosts/use-remote-project";
import { remoteHostOfSession } from "@renderer/lib/session-project";
import { answerInteraction } from "@renderer/components/chat/chat-plane-model";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useSessionOrderStore } from "@renderer/stores/session-order";

import { peekSessionId } from "./peek-subject";
import type { SessionPeekPorts } from "./use-session-peek";

/** One id per message a card sends, as `chat-plane.tsx` mints them. */
function peekMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `peek-${Date.now()}-${Math.random()}`;
}

/** The four things a surface answers for itself; the rest of the peek is shared. */
export interface SidebarPeekSurface {
  /** The surface's own row activation (navigates). Reading is added here. */
  openRow(rowId: string): void;
  openTicket(ticketId: string): void;
  /** Shows the PeekConversation overlay for this Session. */
  showConversation(sessionId: string): void;
  /**
   * The surface's read store: `project-sessions` or `ticket-session-records`
   * `setSessionRead`, already bound to its project or ticket.
   */
  setRead(sessionId: string, unread: boolean): void;
}

/** Independent of the surface: rebuilding its action ports must not invalidate peek reads. */
const readContent: SessionPeekPorts["readContent"] = async (sessionId, refine = false) => {
  // A remote Session's transcript is its host's (VC-713); this Mac's peek
  // reads only its own ledger.
  const host = remoteHostOfSession(sessionId);
  if (host !== null) throw new Error(notAvailableOn(host));
  const result = await window.api.sessions.peekContent({ sessionId, refine });
  // A refusal is a failed read, not an empty Session or a read receipt.
  if (!result.ok) throw new Error(result.error);
  return result.content;
};

/** The peek ports both sidebars share; only activation, conversation and the read store differ. */
export function createSidebarPeekPorts(surface: SidebarPeekSurface): SessionPeekPorts {
  const read = (sessionId: string): void => {
    surface.setRead(sessionId, false);
  };
  return {
    readContent,

    async answer(sessionId, interactionId, submission: InteractionSubmission) {
      const client = adopt(sessionId);
      // A Session this window cannot hold a client for — a Draft, or one closed
      // between the pull and the press — is refused rather than silently dropped.
      if (client === undefined) return false;
      // `answerInteraction` hands the trailing message to `deliver` as a fire-
      // and-forget act; collecting its promise here is what lets the refusal
      // reach the card. The array is the collector because a `let` assigned
      // inside that callback is not a value TypeScript will narrow afterwards.
      const deliveries: Promise<MessageDelivery>[] = [];
      const resolved = await answerInteraction(interactionId, submission, {
        resolve: (id, resolution) => client.resolveInteraction(id, resolution),
        deliver: (message) => {
          deliveries.push(client.submit({ id: peekMessageId(), text: message }, "queue"));
        },
        // The card owns its own submission latch (`interaction-ui.tsx`); there
        // is no second in-flight set to keep here.
        resolving: () => {},
      });
      if (!resolved) return false;
      // The decision landed, but the words that could not ride it may not have.
      // A card that said "Sent" over a refused message would be reporting an act
      // that did not happen.
      const outcomes = await Promise.all(deliveries);
      if (outcomes.includes("refused")) return false;
      read(sessionId);
      return true;
    },

    async sendMessage(sessionId, text) {
      const client = adopt(sessionId);
      if (client === undefined) return false;
      const delivery = await client.submit({ id: peekMessageId(), text }, "queue");
      if (delivery === "refused") return false;
      read(sessionId);
      return true;
    },

    openSession(rowId) {
      surface.openRow(rowId);
      const sessionId = peekSessionId(rowId);
      if (sessionId !== null) read(sessionId);
    },

    openTicket(ticketId) {
      surface.openTicket(ticketId);
    },

    viewConversation(sessionId) {
      surface.showConversation(sessionId);
      read(sessionId);
    },

    setRead(sessionId, unread) {
      surface.setRead(sessionId, unread);
    },
  };
}

/** Adoption is idempotent, so a Session already in front takes this path too. */
function adopt(sessionId: string): ReturnType<typeof getChatClient> {
  useChatSessionsStore.getState().adoptChatSession(sessionId);
  return getChatClient(sessionId);
}

/**
 * The unread mark (VC-108, D6), in a row's trailing slot.
 *
 * Blue because it is the one hue neither a state badge nor a vendor logo
 * wears, so it cannot be read as either. `bg-info` is a generated token; the
 * word rides out of band, since a row this narrow has no room to print it.
 */
export function UnreadDot(): React.ReactElement {
  return (
    <span data-unread-dot="" className="flex size-4 shrink-0 items-center justify-center">
      <span aria-hidden className="size-2 rounded-full bg-info" />
      <span className="sr-only">Unread</span>
    </span>
  );
}

/**
 * The global session-order hold (D7), for as long as this surface is pointed at
 * or shows a card. It freezes EVERY key: the left band must not re-order under
 * a person reading a card that opened out of the rail, and the reverse.
 *
 * A LAYOUT effect on purpose. `useHeldSessionOrder` commits in a passive effect,
 * and passive effects of a commit run after layout effects of the same commit —
 * so a hold taken passively could land after the very commit the pointer's
 * arrival was supposed to freeze, and a row could move out from under it.
 */
export function usePeekHold(holding: boolean): void {
  React.useLayoutEffect(() => {
    if (!holding) return;
    return useSessionOrderStore.getState().hold();
  }, [holding]);
}

/**
 * The ONE accessible name for a row's mark: who is working, then what it is
 * doing.
 *
 * The words are `SESSION_ACTIVITY_LABEL`'s, composed here because since VC-30
 * no row PRINTS them — this name is the only place the state is said at all,
 * on either sidebar.
 */
export function sessionGlyphName(providerLabel: string, state: StatusDotState | null): string {
  switch (state) {
    case null:
      return providerLabel;
    case "working":
    case "setup":
    case "starting":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.working}`;
    case "waiting":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.waiting}`;
    case "interrupted":
    case "error":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.interrupted}`;
    // An ended Session is named for how it ended, never as merely quiet: the
    // rail's record fold prints these same words on the line under the mark.
    case "parked":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.parked}`;
    case "exited":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.exited}`;
    case "stopped":
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.stopped}`;
    default:
      return `${providerLabel} · ${SESSION_ACTIVITY_LABEL.idle}`;
  }
}
