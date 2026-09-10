/**
 * Host-authored transcript notices projected for every Session client.
 *
 * A notice is stored as a `user` message because the Agent Runtime must read
 * it in-band. Its shared metadata says who actually authored it. This module
 * turns that durable fact into a framework-neutral row model; clients render
 * the model and never interpret message metadata themselves.
 *
 * Messages written before the shared metadata existed are recognized by the
 * delegation notice's frozen message-id suffix or a Browser hold notice's
 * frozen Volli text frame. This keeps existing Session history out of the
 * person's voice without broadly guessing from ordinary prose.
 */

import {
  SESSION_HOST_NOTICE_METADATA_KIND,
  SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
  SUBAGENT_NOTICE_STATES,
  shortSessionId,
  type SubagentNoticeReason,
  type SubagentNoticeState,
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

export interface UnknownHostNotice {
  kind: "unknown";
  text: string;
}

/** One host row in the portable Session Surface Model. */
export type TranscriptHostNotice = SubagentNotice | BrowserHoldNotice | UnknownHostNotice;

/**
 * Read one transcript message as a host notice.
 *
 * `null` means the message has no host marker and is an ordinary Turn. Once a
 * known host marker is present, malformed or newer payloads become an unknown
 * host notice rather than falling back to a user bubble.
 */
export function readHostNotice(
  message: Pick<UIMessage, "id" | "role" | "metadata" | "parts">,
): TranscriptHostNotice | null {
  if (message.role !== "user") return null;
  const text = messageText(message.parts);
  const metadata = recordOf(message.metadata);

  if (metadata?.kind === SESSION_HOST_NOTICE_METADATA_KIND) {
    return readSharedNotice(metadata.notice) ?? unknownNotice(text);
  }

  // Historical host messages had no metadata. A foreign marker means another
  // producer owns the message, even when its id or prose resembles an old one.
  if (message.metadata !== undefined) return null;
  const historicalHold = readBrowserHoldText(text);
  if (historicalHold !== null) return historicalHold;
  if (!message.id.endsWith(SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX)) return null;
  if (!text.startsWith("[Subagent Session ")) return null;
  return readHistoricalSubagent(text) ?? unknownNotice(text);
}

function readSharedNotice(value: unknown): SubagentNotice | BrowserHoldNotice | null {
  const notice = recordOf(value);
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

const STATE_NOTE: Record<SubagentNoticeState, string> = {
  completed: "Finished its task; its answer is in its own Session.",
  interrupted: "Its turn ended before it answered.",
  stopped: "It was stopped before it answered.",
  failed: "Its executor failed before it answered.",
  "timed-out": "It did not finish within its time bound and was stopped.",
};

export interface SubagentNoticeCopy {
  headline: string;
  state: string;
  note: string;
}

export function subagentNoticeCopy(notice: SubagentNotice): SubagentNoticeCopy {
  const title = notice.title.trim();
  return {
    headline: title.length > 0 ? title : "Subagent",
    state: STATE_WORD[notice.state],
    note:
      notice.reason === "app-relaunched"
        ? "Volli relaunched while its turn was active, so the turn ended before it answered."
        : STATE_NOTE[notice.state],
  };
}

export interface BrowserHoldNoticeCopy {
  headline: string;
  note: string;
}

export function browserHoldNoticeCopy(notice: BrowserHoldNotice): BrowserHoldNoticeCopy {
  return {
    headline: notice.label,
    note:
      notice.action === "person-took"
        ? "You took control; Session writes are refused until you hand it back."
        : "You asked the Session to leave; it will release the tab when it is safe.",
  };
}
