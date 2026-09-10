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

/** The outcomes a Subagent Session completion notice can record. */
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

/** Every host-authored transcript notice understood by this product version. */
export type SessionHostNotice = SubagentSessionHostNotice | BrowserHoldHostNotice;

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
