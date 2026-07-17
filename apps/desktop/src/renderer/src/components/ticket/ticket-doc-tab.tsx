import type { Ticket } from "@volli/shared";

import type { MarkdownFileRefs } from "@renderer/components/editor/markdown-live-editor";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { TicketActivityFeed } from "@renderer/components/ticket/ticket-activity-feed";
import { TicketBodyEditor } from "@renderer/components/ticket/ticket-body-editor";

/**
 * The Doc tab (ticket-detail-mvp step 4): the ticket's markdown body as a
 * Notion-like click-to-edit block (typeset-rendered, debounced autosave), with
 * the merged property-change + comment Activity feed and its composer below.
 * `fileRefs` threads the `@file` picker + chip decoration into the body editor.
 */
export function TicketDocTab({
  ticket,
  fileRefs,
}: {
  ticket: Ticket;
  fileRefs?: MarkdownFileRefs;
}) {
  return (
    <ContentColumn className="flex flex-col gap-8 pt-3 pb-16">
      <TicketBodyEditor ticket={ticket} fileRefs={fileRefs} />
      <TicketActivityFeed ticket={ticket} />
    </ContentColumn>
  );
}
