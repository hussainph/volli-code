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

/** Inserts `-${n}` before the extension (`spec.png` → `spec-2.png`); an extensionless name gets it appended (`notes` → `notes-2`). */
function withCounterSuffix(fileName: string, n: number): string {
  const dotIndex = fileName.lastIndexOf(".");
  // No dot, or a dot at index 0 (a dotfile with no further extension, e.g.
  // `.env`) — treat as extensionless and append the counter at the end.
  if (dotIndex <= 0) return `${fileName}-${n}`;
  return `${fileName.slice(0, dotIndex)}-${n}${fileName.slice(dotIndex)}`;
}

/**
 * The materialized on-disk file name for each `file`-kind attachment (id →
 * name), in the given (already-chronological) order. Two attachments may
 * share a basename (e.g. two screenshots both named `spec.png`) — the
 * agent-facing materialized names must be stable and collision-free, so the
 * FIRST attachment to use a given `fileName` keeps it verbatim; every later
 * attachment with the same `fileName` gets a `-2`, `-3`, … counter inserted
 * before the extension. `url`-kind attachments are excluded (nothing is
 * materialized for them). Deterministic: the same chronological input always
 * produces the same mapping.
 */
export function materializedAttachmentNames(
  attachments: readonly TicketAttachment[],
): Map<string, string> {
  const seenCounts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const attachment of attachments) {
    if (attachment.kind !== "file") continue;
    const priorUses = seenCounts.get(attachment.fileName) ?? 0;
    seenCounts.set(attachment.fileName, priorUses + 1);
    names.set(
      attachment.id,
      priorUses === 0 ? attachment.fileName : withCounterSuffix(attachment.fileName, priorUses + 1),
    );
  }
  return names;
}

/**
 * `harness-command.ts`'s `composeAttachmentsSection` input, derived from a
 * ticket's attachment rows: each `file` attachment's materialized relative
 * path (`.volli/attachments/<name>`, via {@link materializedAttachmentNames})
 * plus its label, and every `url` attachment verbatim. Pure — reused both
 * when `apps/desktop/src/main/attachment-materialize.ts` has just copied the
 * bytes AND when a caller (a worktree kickoff command, `ticket.brief`)
 * re-derives the same list WITHOUT touching disk, since the mapping is
 * deterministic from the attachment rows alone.
 */
export function attachmentsSectionInput(attachments: readonly TicketAttachment[]): {
  files: { relPath: string; label: string }[];
  urls: { url: string; label: string }[];
} {
  const names = materializedAttachmentNames(attachments);
  const files: { relPath: string; label: string }[] = [];
  const urls: { url: string; label: string }[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      // Never misses: materializedAttachmentNames maps every file-kind
      // attachment in the very list being iterated.
      const name = names.get(attachment.id)!;
      files.push({ relPath: `.volli/attachments/${name}`, label: attachment.label });
    } else {
      urls.push({ url: attachment.url, label: attachment.label });
    }
  }
  return { files, urls };
}
