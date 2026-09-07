/**
 * The attachments a markdown image source can name (VC-273).
 *
 * Markdown that writes `.volli/attachments/spec.png` is naming a file in the
 * Session's checkout, and what is there is the Session's links and its Ticket's
 * together, under names derived from that combined list. This hook fetches
 * exactly that list — one query in main, the same one `blob-materialize.ts`
 * copies from — so the renderer never re-derives a naming rule it could get
 * wrong.
 *
 * Reloaded when the owner changes and when `revision` does, which is how a file
 * attached while a body or a transcript is open becomes renderable without
 * remounting anything.
 */
import * as React from "react";
import type { NamedBlobLink } from "@volli/shared";

export interface MaterializedAttachmentsOwner {
  ticketId?: string | undefined;
  sessionId?: string | undefined;
}

const NONE: readonly NamedBlobLink[] = [];

export function useMaterializedAttachments(
  owner: MaterializedAttachmentsOwner,
  revision = 0,
): readonly NamedBlobLink[] {
  const [links, setLinks] = React.useState<readonly NamedBlobLink[]>(NONE);
  const { ticketId, sessionId } = owner;

  React.useEffect(() => {
    if (ticketId === undefined && sessionId === undefined) {
      setLinks(NONE);
      return;
    }
    let cancelled = false;
    void window.api.attachments
      .materialized({ ticketId, sessionId })
      .then((result) => {
        if (cancelled) return;
        // A failure here costs a picture, not a mutation the user is waiting
        // on: the markdown still renders and unresolved images say so on the
        // page. Nothing to toast — there is no action a person could take.
        setLinks(result.ok ? result.links : NONE);
      })
      .catch(() => {
        if (!cancelled) setLinks(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId, sessionId, revision]);

  return links;
}
