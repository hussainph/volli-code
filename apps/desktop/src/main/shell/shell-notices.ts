/**
 * What a Session is TOLD when a background shell it started has something to
 * say (VC-495), and the relay that tells it.
 *
 * The third producer on the one delivery path `watches.ts` and the subagent
 * notice already share (`session-runtime/host-notice-delivery.ts`): a marked
 * `steer` message whose command id is its one durable mark of "told". A
 * Session mid-turn reads it at its next step, an idle one has a turn opened on
 * it, one between attachments has it parked until the next, and a stopped one
 * is told nothing. Nothing here decides which — and nothing waits: `shell_start`
 * returned long ago and the chat stays usable.
 *
 * ## Two events, one id each
 *
 * An exit (`…:exit`) and the first line to match the pattern the Session asked
 * to be told about (`…:match`). The command id is derived from the Session
 * and the shell, so a replayed delivery lands one message, and a shell can
 * never send more than two. The host, not this module, decides WHEN to speak —
 * its own `shell_kill` and a Session's end are silent, an exit the model
 * already read is not repeated — see `background-shell-host.ts`.
 *
 * ## Trust
 *
 * The notice is a `user`-channel message because that is the channel a model
 * is guaranteed to read. What a process printed is another author's prose,
 * and arrives inside a nonce-delimited untrusted envelope, never as Volli's
 * words or the person's; the facts around it — which shell, how it ended,
 * for how long — are Volli's. The host has already redacted every string it
 * hands over, so there is no secret left to scrub here.
 */

import { randomUUID } from "node:crypto";

import {
  formatShellRuntime,
  sessionHostNoticeMetadata,
  shortSessionId,
  untrustedProseLines,
  type SessionHostNotice,
} from "@volli/shared";

import {
  deliverHostNotice,
  errorText,
  type HostNotice,
  type HostNoticeDeliveryPorts,
  type NoticeDelivery,
} from "../session-runtime/host-notice-delivery";
import type { BackgroundShellNotice } from "./background-shell-host";

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The envelope around a process's own words; one trailing newline is the line's, not the text's. */
function shellOutputLines(output: string, nonce: string): string[] {
  return untrustedProseLines({
    kind: "shell output",
    text: output.endsWith("\n") ? output.slice(0, -1) : output,
    id: nonce,
    delivery: "notice",
  });
}

function endedHow(notice: Extract<BackgroundShellNotice, { kind: "exited" }>): string {
  const standing = notice.signal ?? (notice.code === null ? "no exit code" : `code ${notice.code}`);
  if (notice.byPerson) return `was ended by a person from the Activity Island (${standing})`;
  if (notice.signal !== null) return `was killed by signal ${notice.signal}`;
  if (notice.code === null) return "ended without an exit code";
  return `exited with code ${notice.code}`;
}

/**
 * The notice one host event owes its Session: durable ids, the model-facing
 * text, and the metadata every client draws it from. Pure, so the wording is
 * testable apart from the delivery.
 */
export function shellNoticeFor(notice: BackgroundShellNotice, nonce: string): HostNotice {
  const handle = shortSessionId(notice.sessionId);
  const named = `background shell ${notice.shellId} (${JSON.stringify(notice.label)})`;
  const commandId = `shell:${notice.sessionId}:${notice.shellId}:${notice.kind === "exited" ? "exit" : "match"}`;
  const base = {
    sessionId: notice.sessionId,
    commandId,
    messageId: `${commandId}:message`,
  };

  if (notice.kind === "matched") {
    const metadata: SessionHostNotice = {
      kind: "background-shell",
      event: "matched",
      shellId: notice.shellId,
      label: notice.label,
      pattern: notice.pattern,
      regex: notice.regex,
    };
    return {
      ...base,
      metadata: sessionHostNoticeMetadata(metadata),
      label: `shell match notice to ${handle}`,
      text: [
        `[Volli: ${named} printed a line matching your notifyOn ${notice.regex ? "regex" : "text"} ${JSON.stringify(notice.pattern)}. This notice is from Volli, not your user.]`,
        "The matching line follows.",
        ...shellOutputLines(notice.line, nonce),
        "It is still running. This is the only match notice it will send for this shell; shell_output reads what it has printed since you last read it.",
      ].join("\n"),
    };
  }

  const metadata: SessionHostNotice = {
    kind: "background-shell",
    event: "exited",
    shellId: notice.shellId,
    label: notice.label,
    code: notice.code,
    signal: notice.signal,
    runtimeMs: notice.runtimeMs,
    byPerson: notice.byPerson,
  };
  return {
    ...base,
    metadata: sessionHostNoticeMetadata(metadata),
    label: `shell notice to ${handle}`,
    text: [
      `[Volli: ${named} ${endedHow(notice)} after ${formatShellRuntime(notice.runtimeMs)}. This notice is from Volli, not your user.]`,
      ...(notice.tail.length === 0
        ? ["It printed nothing."]
        : [
            `The end of its output follows (${bytesOf(notice.tail)} bytes).`,
            ...shellOutputLines(notice.tail, nonce),
            ...(notice.truncated
              ? [
                  "That is only the end of its output: shell_output with tail reads more of what Volli kept.",
                ]
              : []),
          ]),
    ].join("\n"),
  };
}

export interface ShellNoticeRelayPorts extends HostNoticeDeliveryPorts {
  /** The envelope nonce; injectable so the text is deterministic under test. */
  newId?: () => string;
}

/**
 * The host's `onNotice`, bound to the runtime a notice is steered through.
 * Resolves with where the notice ended up (`failed`: the runtime could not
 * even be asked), and never rejects: a notice nobody is waiting on that cannot
 * be delivered is written to the log, not thrown into the shell host that
 * produced it.
 */
export function relayShellNotices(
  ports: ShellNoticeRelayPorts,
): (notice: BackgroundShellNotice) => Promise<NoticeDelivery | "failed"> {
  const newId = ports.newId ?? randomUUID;
  return async (notice) => {
    const hostNotice = shellNoticeFor(notice, newId());
    try {
      return await deliverHostNotice(ports, hostNotice);
    } catch (error) {
      ports.report(`${hostNotice.label} failed: ${errorText(error)}`);
      return "failed";
    }
  };
}
