/**
 * A chat Session's durable listing row, for a surface that has a tab for it but
 * no resident client yet (VC-515).
 *
 * Home's strip opens every persisted chat tab at relaunch but only the one in
 * front is adopted — the rest attach when they are shown. Until then the strip
 * still owes them their title and their state, and the project listing already
 * holds both, pushed and kept fresh by `volli:session-activity`. A listing can
 * name thousands of Sessions, so each project's rows are indexed once per
 * array identity rather than scanned per tab per write.
 */
import type { ChatSessionRecord } from "@volli/shared";

import { projectOfSession } from "@renderer/lib/session-project";
import type { ProjectSessionRows } from "@renderer/stores/project-sessions";

const indexes = new WeakMap<readonly ChatSessionRecord[], Map<string, ChatSessionRecord>>();

function indexOf(rows: readonly ChatSessionRecord[]): Map<string, ChatSessionRecord> {
  let index = indexes.get(rows);
  if (index === undefined) {
    index = new Map(rows.map((row) => [row.sessionId, row]));
    indexes.set(rows, index);
  }
  return index;
}

/** The Session's row in its project's listing, or `null` when that listing does not name it. */
export function listedChatRecord(
  byProject: Readonly<Record<string, ProjectSessionRows>>,
  sessionId: string,
): ChatSessionRecord | null {
  const projectId = projectOfSession(sessionId);
  if (projectId === null) return null;
  const rows = byProject[projectId];
  return rows === undefined ? null : (indexOf(rows.chat).get(sessionId) ?? null);
}
