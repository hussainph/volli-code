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
 */
export function terminalSessionRecord(projection: SessionProjection): SessionRecord {
  const attachment = latestTerminalAttachment(projection.attachments);
  const detail = attachment ? readTerminalAttachmentDetail(attachment.native) : null;
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
    endedAt: attachment?.status === "open" ? null : (attachment?.closedAt ?? null),
    exitCode: detail?.exitCode ?? null,
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
