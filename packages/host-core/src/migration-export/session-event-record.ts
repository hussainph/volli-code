/**
 * One exported Session event as an importer sends it to Volli Cloud
 * (`migration.importRows`, `projectImports.importRows`): classified the way
 * the backend's intake classifies a drained fact, with its payload and
 * provenance as the JSON text the backend stores.
 *
 * - A kind this build does not know is stored and not folded
 *   (`kindKnown: false`); a known kind it cannot read is stored quarantined
 *   (`malformed_event`, the codec's words), so the history stays whole.
 * - The payload and provenance are the Session codec's encoding
 *   (`storedSessionJson`, the intake's own), sent as text: no key needs to be
 *   a valid Convex field name (`$schema` in an MCP tool schema, a non-ASCII
 *   key), so nothing is spilled to an object nobody reads, and the stored
 *   row is exactly what a drained fact would have been.
 * - `bytes` is left to the mapping, which counts the stored text.
 *
 * The backend reads every stored fact again with its own codec when it folds
 * and when it answers `sessions.history`, so this classification is the
 * import's report, not the reader's verdict.
 *
 * Production callers: the migration dry run (`migration-dry-run/dry-run.ts`);
 * the move engine (MOVE-5) sends a project's events through it too.
 */
import {
  UnknownSessionEventKindError,
  assertSessionEvent,
  decodeSessionEventPayload,
  decodeSessionEventProvenance,
  storedSessionJson,
  type SessionEvent,
} from "@volli/shared";

/** How long a stored quarantine's detail may be (the intake's own bound). */
const QUARANTINE_DETAIL_LENGTH = 1_000;

export function sessionEventImportRecord(record: Record<string, unknown>): Record<string, unknown> {
  const candidate = {
    id: record.id,
    sessionId: record.sessionId,
    sequence: record.sequence,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    attachmentId: record.attachmentId ?? null,
    commandId: record.commandId ?? null,
    provenance: record.provenance,
    payload: record.payload,
  };
  let kindKnown = true;
  let quarantine: { code: string; detail: string } | null = null;
  const context = `Session event ${String(record.sequence)}`;
  try {
    assertSessionEvent(candidate as unknown as SessionEvent, context);
    decodeSessionEventProvenance(candidate.provenance, `${context}.provenance`);
    decodeSessionEventPayload(candidate.payload, `${context}.payload`);
  } catch (error) {
    if (error instanceof UnknownSessionEventKindError) kindKnown = false;
    else {
      const detail = error instanceof Error ? error.message : String(error);
      quarantine = { code: "malformed_event", detail: detail.slice(0, QUARANTINE_DETAIL_LENGTH) };
    }
  }
  return {
    ...record,
    payload: storedSessionJson(record.payload),
    provenance: storedSessionJson(record.provenance),
    kindKnown,
    quarantine,
  };
}
