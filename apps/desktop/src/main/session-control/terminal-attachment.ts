import type {
  SessionAttachmentProjection,
  SessionNativeDetail,
  SessionNativeReference,
  SessionProjection,
} from "@volli/shared";
import type { HarnessId, SessionLaunchKind, SessionPlacement, SessionRecord } from "@volli/shared";
import { isSessionLaunchKind, isSessionPlacement, parseHarnessId } from "@volli/shared";

/** The terminal adapter's opaque native payload. It never becomes a Session column. */
export interface TerminalAttachmentDetail {
  readonly [key: string]: SessionNativeDetail;
  kind: "volli.terminal.v1";
  cwd: string;
  harnessId: HarnessId;
  activeHarnessId: HarnessId | null;
  harnessSessionId: string | null;
  launchKind: SessionLaunchKind;
  placement: SessionPlacement;
  exitCode: number | null;
}

export function terminalNativeReference(detail: TerminalAttachmentDetail): SessionNativeReference {
  return { id: detail.harnessSessionId, detail };
}

export function readTerminalAttachmentDetail(
  native: SessionNativeReference | null,
): TerminalAttachmentDetail | null {
  if (native === null || native.detail === null) return null;
  const value = native.detail;
  if (!isRecord(value) || value.kind !== "volli.terminal.v1") return null;
  const harnessId = typeof value.harnessId === "string" ? parseHarnessId(value.harnessId) : null;
  const activeHarnessId =
    value.activeHarnessId === null
      ? null
      : typeof value.activeHarnessId === "string"
        ? parseHarnessId(value.activeHarnessId)
        : null;
  if (
    typeof value.cwd !== "string" ||
    harnessId === null ||
    (activeHarnessId === null && value.activeHarnessId !== null) ||
    (value.harnessSessionId !== null && typeof value.harnessSessionId !== "string") ||
    !isSessionLaunchKind(value.launchKind) ||
    !isSessionPlacement(value.placement) ||
    (value.exitCode !== null &&
      (!Number.isInteger(value.exitCode) || !Number.isFinite(value.exitCode)))
  ) {
    return null;
  }
  return {
    kind: "volli.terminal.v1",
    cwd: value.cwd,
    harnessId,
    activeHarnessId,
    harnessSessionId: value.harnessSessionId,
    launchKind: value.launchKind,
    placement: value.placement,
    exitCode: value.exitCode === null ? null : (value.exitCode as number),
  };
}

/**
 * Temporary IPC/UI compatibility projection. The ledger is its only input;
 * this deliberately does not read a second terminal-owned database record.
 *
 * `null` when the Session has no terminal attachment, because then no honest
 * `SessionRecord` exists: that DTO is terminal harness/process facts, and a
 * structured (chat) Session has none. Fabricating one handed every caller a
 * never-ending `claude-code` terminal with an empty cwd — see
 * `@volli/shared`'s `SessionRecord`. The rule lives here, with the attachments
 * it is about, rather than as a predicate each listing has to remember: the
 * renderer's two listings remembered it and the CLI socket's did not.
 */
export function terminalSessionRecord(projection: SessionProjection): SessionRecord | null {
  const attachment = latestTerminalAttachment(projection.attachments);
  if (attachment === null) return null;
  // A terminal attachment whose native detail is unreadable (absent, or written
  // by a shape this build no longer parses) is still honestly a terminal. The
  // defaults below cover only that narrower case, which is what `unknown`
  // launch/placement metadata has always meant.
  const detail = readTerminalAttachmentDetail(attachment.native);
  return {
    id: projection.session.id,
    projectId: projection.session.projectId,
    ticketId: projection.session.ticketId,
    harnessId: detail?.harnessId ?? "claude-code",
    activeHarnessId: detail?.activeHarnessId ?? null,
    harnessSessionId: detail?.harnessSessionId ?? null,
    launchKind: detail?.launchKind ?? "unknown",
    placement: detail?.placement ?? "unknown",
    title: projection.session.title ?? "Session",
    cwd: detail?.cwd ?? "",
    createdAt: projection.session.createdAt,
    endedAt: attachment.status === "open" ? null : attachment.closedAt,
    exitCode: detail?.exitCode ?? null,
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
  };
}

/**
 * The native detail to re-reference when a PTY exits with `exitCode`, or `null`
 * when there is nothing honest to write (VC-290).
 *
 * The exit code is the one fact about a terminal's ending that only the PTY
 * observes, and it used to reach the live renderer and nothing else: the ledger
 * recorded a completed/failed OUTCOME, so a closed record read back
 * `exitCode: null` — the same answer a boot sweep leaves for a process nobody
 * saw end. Two different facts, one indistinguishable null, and a session-detail
 * view that could only ever say "unavailable".
 *
 * It re-emits the attachment's CURRENT detail with the code stamped on, never
 * the launch snapshot: hooks and the `volli` CLI socket link a newer harness id
 * and harness session id onto this same attachment while it runs, and replaying
 * the snapshot would roll that evidence back on the way out
 * (`agent-dispatch/harness-verbs.ts` takes the same care, for the same reason).
 *
 * `null` covers every case where writing would be a guess or a lie: no
 * projection, an attachment that is not this one, one the ledger has already
 * closed, a native detail this build cannot parse, and the code already being
 * recorded — the last of which keeps a re-observed exit from appending an event
 * that changes nothing.
 */
export function terminalExitDetail(
  projection: SessionProjection | null,
  attachmentId: string,
  exitCode: number,
): TerminalAttachmentDetail | null {
  if (projection === null) return null;
  const attachment = projection.attachments.find(
    (candidate) => candidate.id === attachmentId && candidate.adapterId === "terminal",
  );
  if (attachment === undefined || attachment.status !== "open") return null;
  const detail = readTerminalAttachmentDetail(attachment.native);
  if (detail === null || detail.exitCode === exitCode) return null;
  return { ...detail, exitCode };
}

export function latestTerminalAttachment(
  attachments: readonly SessionAttachmentProjection[],
): SessionAttachmentProjection | null {
  const matching = attachments.filter((attachment) => attachment.adapterId === "terminal");
  return matching.at(-1) ?? null;
}

function isRecord(
  value: SessionNativeDetail,
): value is { readonly [key: string]: SessionNativeDetail } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
