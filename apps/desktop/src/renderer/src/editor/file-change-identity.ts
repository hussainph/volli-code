import type { FileChangedEvent, FileSource } from "@volli/shared";

export interface ResolvedFileChangeIdentity {
  projectId: string;
  ticketId: string | null;
  relPath: string;
  source: FileSource;
}

/** File-change delivery is safe only when the complete resolved identity matches. */
export function matchesFileChangeIdentity(
  event: FileChangedEvent,
  identity: ResolvedFileChangeIdentity,
): boolean {
  return (
    event.projectId === identity.projectId &&
    event.ticketId === identity.ticketId &&
    event.relPath === identity.relPath &&
    event.source === identity.source
  );
}
