/**
 * Host-authored facts that ride a Session transcript message.
 *
 * The message stays in the `user` channel because that is the channel the
 * Agent Runtime is guaranteed to read. This metadata records the different
 * semantic fact: Volli, not the person, authored the notice. Hosts write this
 * vocabulary and every client projects it through the Session Presentation
 * Contract, so a desktop host, a future server, and mobile/web clients do not
 * invent private marker strings or outcome lists.
 */

/**
 * The outcomes a Subagent Session completion notice can record.
 *
 * `timed-out` is history only: VC-457 removed the subagent wall clock, so no
 * writer produces it again, but notices written before then still carry it and
 * must keep reading as what they were (tolerant on read).
 */
export const SUBAGENT_NOTICE_STATES = [
  "completed",
  "interrupted",
  "stopped",
  "failed",
  "timed-out",
] as const;

export type SubagentNoticeState = (typeof SUBAGENT_NOTICE_STATES)[number];

/** Extra context that changes how an otherwise identical outcome is explained. */
export type SubagentNoticeReason = "app-relaunched";

export interface SubagentSessionHostNotice {
  kind: "subagent";
  childSessionId: string;
  title: string;
  state: SubagentNoticeState;
  reason: SubagentNoticeReason | null;
}

export interface BrowserHoldHostNotice {
  kind: "browser-hold";
  tabId: string;
  /** Bounded Browser Tab state, not presentation copy or a URL with path/query data. */
  tabTitle: string;
  tabHostname: string;
  action: "person-took" | "ask-to-leave";
}

/**
 * The facts a watch notice can report (VC-457): what replaced `session_await`
 * and `ticket_await`. Each is a durable fact another Session or a person
 * produced ON PURPOSE — never bookkeeping — so a watcher is woken only for
 * something it has a decision to make about.
 */
export const WATCH_NOTICE_FACTS = [
  "turn-completed",
  "turn-interrupted",
  "signaled-done",
  "signaled-blocked",
  "stopped",
  "ticket-moved",
  "ticket-commented",
  "ticket-signaled",
] as const;

export type WatchNoticeFact = (typeof WATCH_NOTICE_FACTS)[number];

/** One watched change inside a (possibly coalesced) watch notice. */
export interface WatchNoticeEvent {
  subject: "session" | "ticket";
  /** The durable id of the Session or Ticket that changed. */
  id: string;
  /** Host-minted name: a Ticket display id, or a Session's short handle. */
  label: string;
  fact: WatchNoticeFact;
  /** Host-minted qualifier, e.g. the column a Ticket moved to; never another author's prose. */
  detail: string | null;
}

/** Changes to watched Sessions and Tickets, delivered together (VC-457). */
export interface WatchHostNotice {
  kind: "watch";
  events: readonly WatchNoticeEvent[];
}

/**
 * A background shell the Session started has something to say (VC-495): it
 * exited on its own, or its output matched the pattern the Session asked to be
 * told about. Only host-minted facts live here — the shell's output rides the
 * model-facing text, inside an untrusted envelope, and is never stored as
 * metadata a client could mistake for Volli's own words.
 */
export type BackgroundShellHostNotice = {
  kind: "background-shell";
  shellId: string;
  /** The Session's own title for the shell, or its command's first line: scrubbed and short. */
  label: string;
} & (
  | {
      event: "exited";
      /** `null` when a signal ended it. */
      code: number | null;
      signal: string | null;
      runtimeMs: number;
      /** A person ended it from the Activity Island; the Session's own kill never notifies. */
      byPerson: boolean;
    }
  | {
      event: "matched";
      /** The Session's own `notifyOn`, bounded at the tool. */
      pattern: string;
      regex: boolean;
    }
);

/** Every host-authored transcript notice understood by this product version. */
export type SessionHostNotice =
  | SubagentSessionHostNotice
  | BrowserHoldHostNotice
  | WatchHostNotice
  | BackgroundShellHostNotice;

/** The durable marker shared by notice writers and Session clients. */
export const SESSION_HOST_NOTICE_METADATA_KIND = "session-host-notice" as const;

export interface SessionHostNoticeMetadata {
  kind: typeof SESSION_HOST_NOTICE_METADATA_KIND;
  notice: SessionHostNotice;
}

/** Build the one metadata envelope a host-authored transcript notice uses. */
export function sessionHostNoticeMetadata(notice: SessionHostNotice): SessionHostNoticeMetadata {
  return { kind: SESSION_HOST_NOTICE_METADATA_KIND, notice };
}

/**
 * The frozen suffix on a delegation's notice message id.
 *
 * It is shared because current writers mint it and the presentation contract
 * uses it to identify notices written before structured metadata existed.
 */
export const SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX = ":answer-message";
