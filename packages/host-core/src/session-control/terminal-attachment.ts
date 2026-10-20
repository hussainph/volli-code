import type {
  SessionAttachmentProjection,
  SessionNativeDetail,
  SessionNativeReference,
  SessionProjection,
} from "@volli/shared";
import type { HarnessId, SessionLaunchKind, SessionPlacement, SessionRecord } from "@volli/shared";
import { isSessionLaunchKind, isSessionPlacement, parseHarnessId } from "@volli/shared";

/**
 * The terminal adapter's opaque native payload. It never becomes a Session
 * column.
 *
 * Adapter correlation and launch metadata ONLY. How the process ended is not
 * in here: an exit status is product vocabulary the Session ledger owns
 * (`attachment.exited`, VC-290), and a client that had to reparse this object
 * to learn it would be reimplementing one host's private encoding.
 */
export interface TerminalAttachmentDetail {
  readonly [key: string]: SessionNativeDetail;
  kind: "volli.terminal.v1";
  cwd: string;
  harnessId: HarnessId;
  activeHarnessId: HarnessId | null;
  harnessSessionId: string | null;
  launchKind: SessionLaunchKind;
  placement: SessionPlacement;
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
    !isSessionPlacement(value.placement)
  ) {
    return null;
  }
  // Named fields only, so a key an older build wrote (an `exitCode` that never
  // carried a value, before the exit became a Session fact) is dropped rather
  // than carried forward as a second answer about how the terminal ended.
  return {
    kind: "volli.terminal.v1",
    cwd: value.cwd,
    harnessId,
    activeHarnessId,
    harnessSessionId: value.harnessSessionId,
    launchKind: value.launchKind,
    placement: value.placement,
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
    // The ledger's own answer, carried along and not re-derived: `null` is an
    // exit nothing observed, and it must never be softened by the close's
    // completed/failed outcome (VC-290).
    exitCode: attachment.exitCode,
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
  };
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
