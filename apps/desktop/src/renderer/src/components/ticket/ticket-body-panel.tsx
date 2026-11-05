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
import type { TicketBodyStatus } from "@renderer/components/ticket/use-ticket-body";
import { PanelEmptyState } from "@renderer/components/ui/empty-state";
import { LoadingLabel } from "@renderer/components/ui/loading-label";

/**
 * What the Body tab draws while the ticket's body is still a placeholder
 * (VC-387). The editor is deliberately NOT mounted here: it seeds its draft and
 * its autosave baseline from `ticket.body`, so mounting it over the `""` the
 * roster left would let a person type into a body that has not arrived and then
 * save their text over the real one.
 *
 * A held loading region keeps the editor from seeding an incomplete draft.
 */
function TicketBodyPlaceholder() {
  return (
    <div data-testid="ticket-body-loading" aria-busy="true" className="min-h-20">
      <LoadingLabel>Loading ticket</LoadingLabel>
    </div>
  );
}

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
  bodyStatus = "ready",
  onRetryBody,
}: {
  ticket: Ticket;
  fileRefs?: DocumentFileRefs;
  editorRef?: Ref<MonacoDocumentEditorHandle>;
  /** The Ticket's materialized attachments, for inline images in the body (VC-273). */
  attachments?: readonly NamedBlobLink[] | undefined;
  /**
   * Whether `ticket.body` is the canonical Ticket Body yet (VC-387). Defaults to
   * `ready`, which is what every ticket the boot payload carried always is.
   */
  bodyStatus?: TicketBodyStatus;
  /** Re-runs the body read — the one action the `failed` surface offers. */
  onRetryBody: () => void;
}) {
  return (
    // One provider over both surfaces (VC-273): the body's inline images and a
    // comment's resolve against the same attachments, so the same markdown
    // cannot render in one and fail in the other. The editor takes the links
    // directly because Monaco is outside React's tree.
    <MarkdownAttachmentsProvider attachments={attachments}>
      <ContentColumn className="flex flex-col gap-6 pt-4 pb-16">
        {bodyStatus === "loading" ? <TicketBodyPlaceholder /> : null}
        {bodyStatus === "failed" ? (
          <div data-testid="ticket-body-failed">
            <PanelEmptyState
              illustration="failed"
              status="failed"
              title="Couldn’t load the ticket"
              action={{ label: "Try again", onAction: onRetryBody }}
            />
          </div>
        ) : null}
        {bodyStatus === "ready" ? (
          <TicketBodyEditor
            ticket={ticket}
            fileRefs={fileRefs}
            editorRef={editorRef}
            attachments={attachments}
          />
        ) : null}
        <TicketActivityFeed ticket={ticket} />
      </ContentColumn>
    </MarkdownAttachmentsProvider>
  );
}
