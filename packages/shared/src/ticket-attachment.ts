/**
 * A ticket's attachments (`ticket_attachments` table, migration 011): spec
 * material — a file or URL — attached to a ticket and materialized into the
 * agent's worktree at session boot (CONCEPT decision #19). Distinct from
 * `ticket-comment.ts`'s work-log content and from the append-only audit
 * trail in `ticket-events.ts` (creating/removing an attachment also fires an
 * `attachment_added`/`attachment_removed` event so it's discoverable from the
 * event log without duplicating the attachment itself there).
 *
 * Two variants share one row shape (`kind` discriminates): a `file`
 * attachment's bytes live under Electron `userData`, keyed by attachment id
 * (`apps/desktop/src/main/attachment-store.ts`) — `fileName` here is the
 * original basename ONLY, never a path, so a stored file never escapes its
 * id directory. A `url` attachment has no bytes; `url` is the spec link
 * itself. `label` is always non-empty — callers default it via
 * {@link defaultAttachmentLabel} when the user doesn't supply one.
 */
export type TicketAttachment =
  | {
      id: string;
      ticketId: string;
      kind: "file";
      label: string;
      fileName: string;
      createdAt: number;
    }
  | { id: string; ticketId: string; kind: "url"; label: string; url: string; createdAt: number };

/**
 * The label an attachment gets when the caller doesn't supply one: a file's
 * basename, or a URL verbatim. Kept pure/shared so both the repo layer
 * (`attachments-repo.ts`) and any future UI default the same way.
 */
export function defaultAttachmentLabel(
  input: { kind: "file"; fileName: string } | { kind: "url"; url: string },
): string {
  return input.kind === "file" ? input.fileName : input.url;
}
