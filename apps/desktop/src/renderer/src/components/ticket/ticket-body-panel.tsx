import type { Ref } from "react";
import type { NamedBlobLink, Ticket } from "@volli/shared";

import type {
  DocumentFileRefs,
  MonacoDocumentEditorHandle,
} from "@renderer/components/editor/monaco-document-editor";
import { MarkdownAttachmentsProvider } from "@renderer/components/attachments/markdown-image";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { TicketActivityFeed } from "@renderer/components/ticket/ticket-activity-feed";
import { TicketBodyEditor } from "@renderer/components/ticket/ticket-body-editor";

/**
 * The Ticket Body tab (ticket-detail-mvp step 4): the ticket's markdown body as a
 * Notion-like click-to-edit block (typeset-rendered, debounced autosave), with
 * the merged property-change + comment Activity feed and its composer below.
 * `fileRefs` threads the `@file` picker + chip decoration into the body editor.
 *
 * `editorRef` is the host's way in (VC-106): the detail view splices `@` refs
 * into the body when a repository file is attached elsewhere on the view — a
 * drop on the Files rail, or on this tab while Monaco is still loading — the
 * same handle the New-ticket composer's paperclip drives.
 */
export function TicketBodyPanel({
  ticket,
  fileRefs,
  editorRef,
  attachments,
}: {
  ticket: Ticket;
  fileRefs?: DocumentFileRefs;
  editorRef?: Ref<MonacoDocumentEditorHandle>;
  /** The Ticket's materialized attachments, for inline images in the body (VC-273). */
  attachments?: readonly NamedBlobLink[] | undefined;
}) {
  return (
    // One provider over both surfaces (VC-273): the body's inline images and a
    // comment's resolve against the same attachments, so the same markdown
    // cannot render in one and fail in the other. The editor takes the links
    // directly because Monaco is outside React's tree.
    <MarkdownAttachmentsProvider attachments={attachments}>
      <ContentColumn className="flex flex-col gap-8 pt-4 pb-16">
        <TicketBodyEditor
          ticket={ticket}
          fileRefs={fileRefs}
          editorRef={editorRef}
          attachments={attachments}
        />
        <TicketActivityFeed ticket={ticket} />
      </ContentColumn>
    </MarkdownAttachmentsProvider>
  );
}
