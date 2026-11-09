/**
 * Host-authored transcript notices projected for every Session client.
 *
 * A notice is stored as a `user` message because the Agent Runtime must read
 * it in-band. Recorded command provenance identifies the host producer; its
 * metadata describes the notice, but cannot independently prove authorship.
 *
 * A bounded tail or legacy history without producer provenance degrades to a
 * neutral ordinary message with its full original content. Neither metadata,
 * a frozen message-id suffix nor a familiar text frame can promote it. Older
 * text formats are parsed only after recorded host provenance establishes the
 * corresponding producer.
 */

import {
  SESSION_HOST_NOTICE_METADATA_KIND,
  SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
  SUBAGENT_NOTICE_STATES,
  WATCH_NOTICE_FACTS,
  formatShellRuntime,
  shellStanding,
  shortSessionId,
  type BackgroundShellHostNotice,
  type SubagentNoticeReason,
  type SubagentNoticeState,
  type WatchNoticeEvent,
  type WatchNoticeFact,
  type SessionOrigin,
} from "@volli/shared";
import type { UIMessage } from "ai";

export interface SubagentNotice {
  kind: "subagent";
  /** Absent only for a notice written before the metadata carried the durable id. */
  childSessionId: string | null;
  sessionHandle: string;
  title: string;
  state: SubagentNoticeState;
  reason: SubagentNoticeReason | null;
}

export interface BrowserHoldNotice {
  kind: "browser-hold";
  tabId: string;
  /** The Session Presentation Contract's person-facing name. */
  label: string;
  action: "person-took" | "ask-to-leave";
}

/** Changes to watched Sessions and Tickets (VC-457). */
export interface WatchNotice {
  kind: "watch";
  events: readonly WatchNoticeEvent[];
}

export interface UnknownHostNotice {
  kind: "unknown";
  text: string;
}

/** One host row in the portable Session Surface Model. */
export type TranscriptHostNotice =
  | SubagentNotice
  | BrowserHoldNotice
  | WatchNotice
  | UnknownHostNotice
  | BackgroundShellHostNotice;

/**
 * Read one transcript message as a host notice.
 *
 * `null` means host authorship is not established, or the format is not a
 * notice. Only recorded producer evidence permits malformed/newer host
 * payloads to become unknown host notices instead of ordinary message content.
 */
export function readHostNotice(
  message: Pick<UIMessage, "id" | "role" | "metadata" | "parts">,
  origin?: SessionOrigin | null,
): TranscriptHostNotice | null {
  if (message.role !== "user") return null;
  // Missing command evidence and explicit conflict are both untrusted for
  // authorship. In particular, an adapter-only bounded tail must not promote
  // caller-controlled metadata while waiting for its older command to load.
  if (origin?.kind !== "volli") return null;
  if (
    !["subagent-notice", "browser-notice", "watch-notice", "shell-notice"].includes(origin.reason)
  )
    return null;
  const text = messageText(message.parts);
  const metadata = recordOf(message.metadata);

  if (metadata?.kind === SESSION_HOST_NOTICE_METADATA_KIND) {
    const notice = readSharedNotice(metadata.notice);
    if (notice === null) return unknownNotice(text);
    const expected =
      notice.kind === "subagent"
        ? "subagent-notice"
        : notice.kind === "browser-hold"
          ? "browser-notice"
          : notice.kind === "watch"
            ? "watch-notice"
            : "shell-notice";
    return origin.reason === expected ? notice : unknownNotice(text);
  }

  // Historical host messages had no metadata. A foreign marker means another
  // producer owns the message, even when its id or prose resembles an old one.
  if (message.metadata !== undefined) return null;
  if (origin?.kind === "volli" && origin.reason === "browser-notice") {
    return readBrowserHoldText(text) ?? unknownNotice(text);
  }
  if (origin.reason !== "subagent-notice") return null;
  if (!message.id.endsWith(SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX)) return null;
  if (!text.startsWith("[Subagent Session ")) return null;
  return readHistoricalSubagent(text) ?? unknownNotice(text);
}

function readSharedNotice(
  value: unknown,
): SubagentNotice | BrowserHoldNotice | WatchNotice | BackgroundShellHostNotice | null {
  const notice = recordOf(value);
  if (notice?.kind === "background-shell") return readShellNotice(notice);
  if (notice?.kind === "watch") {
    if (!Array.isArray(notice.events)) return null;
    const events = notice.events.map(watchEvent);
    return events.length > 0 && events.every((event) => event !== null)
      ? { kind: "watch", events: events as WatchNoticeEvent[] }
      : null;
  }
  if (notice?.kind === "subagent") {
    const childSessionId = nonEmptyString(notice.childSessionId);
    const title = typeof notice.title === "string" ? notice.title : null;
    const state = subagentState(notice.state);
    const reason = subagentReason(notice.reason);
    if (childSessionId === null || title === null || state === null || reason === undefined) {
      return null;
    }
    return {
      kind: "subagent",
      childSessionId,
      sessionHandle: shortSessionId(childSessionId),
      title,
      state,
      reason,
    };
  }
  if (notice?.kind === "browser-hold") {
    const tabId = nonEmptyString(notice.tabId);
    const action = browserHoldAction(notice.action);
    if (tabId === null || action === null) return null;
    return {
      kind: "browser-hold",
      tabId,
      label: browserHoldLabel(
        tabId,
        typeof notice.tabTitle === "string" ? notice.tabTitle : "",
        typeof notice.tabHostname === "string" ? notice.tabHostname : "",
      ),
      action,
    };
  }
  return null;
}

/** A background shell's notice (VC-495); anything this build cannot fully read is unknown, not a person. */
function readShellNotice(notice: Record<string, unknown>): BackgroundShellHostNotice | null {
  const shellId = nonEmptyString(notice.shellId);
  if (shellId === null || typeof notice.label !== "string") return null;
  if (notice.event === "matched") {
    const pattern = nonEmptyString(notice.pattern);
    return pattern === null || typeof notice.regex !== "boolean"
      ? null
      : {
          kind: "background-shell",
          event: "matched",
          shellId,
          label: notice.label,
          pattern,
          regex: notice.regex,
        };
  }
  if (notice.event !== "exited") return null;
  const { code, signal, runtimeMs, byPerson } = notice;
  if (
    (code !== null && typeof code !== "number") ||
    (signal !== null && typeof signal !== "string") ||
    typeof runtimeMs !== "number" ||
    !(runtimeMs >= 0) ||
    typeof byPerson !== "boolean"
  ) {
    return null;
  }
  return {
    kind: "background-shell",
    event: "exited",
    shellId,
    label: notice.label,
    code,
    signal,
    runtimeMs,
    byPerson,
  };
}

function readHistoricalSubagent(text: string): SubagentNotice | null {
  const match = /^\[Subagent Session (\S+) \(("(?:\\.|[^"\\])*")\) ([\s\S]+)\]$/u.exec(text);
  if (match === null) return null;
  // All three captures are required by the expression. The title capture is a
  // JSON string literal, so a successful parse is a string; malformed escape
  // sequences still take the compatibility fallback below.
  const sessionHandle = match[1]!;
  const encodedTitle = match[2]!;
  const outcome = match[3]!;
  let title: string;
  try {
    title = JSON.parse(encodedTitle) as string;
  } catch {
    return null;
  }
  const historical = historicalOutcome(outcome);
  return historical === null
    ? null
    : {
        kind: "subagent",
        childSessionId: null,
        sessionHandle,
        title,
        state: historical.state,
        reason: historical.reason,
      };
}

function historicalOutcome(
  text: string,
): { state: SubagentNoticeState; reason: SubagentNoticeReason | null } | null {
  if (text.startsWith("completed its task.")) return { state: "completed", reason: null };
  if (text.startsWith("was interrupted before it answered.")) {
    return { state: "interrupted", reason: null };
  }
  if (text.startsWith("was mid-turn when Volli relaunched,")) {
    return { state: "interrupted", reason: "app-relaunched" };
  }
  if (text.startsWith("was stopped before it answered.")) return { state: "stopped", reason: null };
  if (text.startsWith("failed before it answered.")) return { state: "failed", reason: null };
  if (text.startsWith("did not finish within its time bound and was stopped.")) {
    return { state: "timed-out", reason: null };
  }
  return null;
}

function readBrowserHoldText(text: string): BrowserHoldNotice | null {
  const took = /^\[Volli: the person took Browser Tab ([^\]]+)\]/u.exec(text);
  if (took?.[1]) {
    return {
      kind: "browser-hold",
      tabId: took[1],
      label: browserHoldLabel(took[1], "", ""),
      action: "person-took",
    };
  }
  const leave = /^\[Volli: the person asks you to leave Browser Tab ([^\]]+)\]/u.exec(text);
  return leave?.[1]
    ? {
        kind: "browser-hold",
        tabId: leave[1],
        label: browserHoldLabel(leave[1], "", ""),
        action: "ask-to-leave",
      }
    : null;
}

function unknownNotice(text: string): UnknownHostNotice {
  return {
    kind: "unknown",
    text: text.length > 0 ? text : "Volli recorded a notice this client cannot display.",
  };
}

function messageText(parts: UIMessage["parts"]): string {
  return parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function watchEvent(value: unknown): WatchNoticeEvent | null {
  const event = recordOf(value);
  if (event === null) return null;
  const subject = event.subject === "session" || event.subject === "ticket" ? event.subject : null;
  const id = nonEmptyString(event.id);
  const label = nonEmptyString(event.label);
  const fact =
    typeof event.fact === "string" && (WATCH_NOTICE_FACTS as readonly string[]).includes(event.fact)
      ? (event.fact as WatchNoticeFact)
      : null;
  const detail = event.detail === null ? null : nonEmptyString(event.detail);
  if (subject === null || id === null || label === null || fact === null) return null;
  if (event.detail !== null && detail === null) return null;
  return { subject, id, label, fact, detail };
}

function subagentState(value: unknown): SubagentNoticeState | null {
  return typeof value === "string" && (SUBAGENT_NOTICE_STATES as readonly string[]).includes(value)
    ? (value as SubagentNoticeState)
    : null;
}

function subagentReason(value: unknown): SubagentNoticeReason | null | undefined {
  return value === null ? null : value === "app-relaunched" ? value : undefined;
}

function browserHoldAction(value: unknown): BrowserHoldNotice["action"] | null {
  return value === "person-took" || value === "ask-to-leave" ? value : null;
}

function browserHoldLabel(tabId: string, title: string, hostname: string): string {
  const cleanTitle = title.trim();
  if (cleanTitle.length > 0) return cleanTitle;
  const cleanHostname = hostname.trim();
  return cleanHostname.length > 0 ? cleanHostname : `Browser Tab ${tabId.slice(0, 8)}`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/* ------------------------------------------------------------------- copy */

const STATE_WORD: Record<SubagentNoticeState, string> = {
  completed: "done",
  interrupted: "interrupted",
  stopped: "stopped",
  failed: "failed",
  "timed-out": "timed out",
};

export interface SubagentNoticeCopy {
  headline: string;
  state: string;
  /**
   * Why it ended, when that is a fact the state word does not carry. Only a
   * relaunch is: "interrupted" says what happened, not that Volli did it.
   */
  cause: string | null;
}

export function subagentNoticeCopy(notice: SubagentNotice): SubagentNoticeCopy {
  const title = notice.title.trim();
  return {
    headline: title.length > 0 ? title : "Subagent",
    state: STATE_WORD[notice.state],
    cause: notice.reason === "app-relaunched" ? "Volli relaunched" : null,
  };
}

const WATCH_FACT_WORD: Record<WatchNoticeFact, string> = {
  "turn-completed": "finished its turn",
  "turn-interrupted": "was interrupted",
  "signaled-done": "signaled done",
  "signaled-blocked": "signaled blocked",
  stopped: "was stopped",
  "ticket-moved": "moved",
  "ticket-commented": "has a new comment",
  "ticket-signaled": "was signaled",
};

export interface WatchNoticeCopy {
  headline: string;
  /** One line per change, in delivery order. */
  lines: readonly string[];
}

export function watchNoticeCopy(notice: WatchNotice): WatchNoticeCopy {
  const lines = notice.events.map((event) => {
    const detail = event.detail === null ? "" : ` (${event.detail})`;
    return `${event.label} ${WATCH_FACT_WORD[event.fact]}${detail}`;
  });
  return {
    headline: lines.length === 1 ? lines[0]! : `${lines.length} watched changes`,
    lines,
  };
}

export interface ShellNoticeCopy {
  headline: string;
  /** `exited 3`, `exited by SIGTERM`, or `matched`. */
  state: string;
  note: string;
}

/** The words a person reads for a background shell's notice (VC-495). */
export function shellNoticeCopy(notice: BackgroundShellHostNotice): ShellNoticeCopy {
  const label = notice.label.trim();
  const headline = label.length > 0 ? label : `Shell ${notice.shellId.slice(0, 8)}`;
  if (notice.event === "matched") {
    return {
      headline,
      state: "matched",
      note: notice.regex
        ? `Printed a line matching /${notice.pattern}/.`
        : `Printed ${JSON.stringify(notice.pattern)}.`,
    };
  }
  return {
    headline,
    state: shellStanding({ state: "exited", code: notice.code, signal: notice.signal }),
    note: `${notice.byPerson ? "You ended it. " : ""}Ran ${formatShellRuntime(notice.runtimeMs)}.`,
  };
}

export interface BrowserHoldNoticeCopy {
  headline: string;
  /** The hold, as a status: who has the tab now, or that it was asked back. */
  state: string;
}

export function browserHoldNoticeCopy(notice: BrowserHoldNotice): BrowserHoldNoticeCopy {
  return {
    headline: notice.label,
    state: notice.action === "person-took" ? "You took control" : "Asked to leave",
  };
}
