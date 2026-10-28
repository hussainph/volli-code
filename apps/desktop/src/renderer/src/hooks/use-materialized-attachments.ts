/**
 * The attachments a markdown image source can name (VC-273).
 *
 * Markdown that writes `.volli/attachments/spec.png` is naming a file in the
 * Session's checkout, and what is there is the Session's links and its Ticket's
 * together, under names derived from that combined list. This hook fetches
 * exactly that list through the launch's attachment read door — local mode's
 * materialization query or the cloud's authorized links — so both feed the
 * same shared filename rule.
 *
 * Reloaded when the owner changes and when `revision` does, which is how a file
 * attached while a body or a transcript is open becomes renderable without
 * remounting anything.
 */
import * as React from "react";
import type { NamedBlobLink } from "@volli/shared";
import { cloudSession, followCloudSession, type CloudSession } from "@renderer/lib/cloud-client";
import { readMaterializedAttachments } from "@renderer/lib/attachment-reads";

export interface MaterializedAttachmentsOwner {
  projectId?: string | undefined;
  ticketId?: string | undefined;
  sessionId?: string | undefined;
}

const NONE: readonly NamedBlobLink[] = [];

/**
 * A `revision` for a strip, as its CONTENT rather than its size.
 *
 * A count is the obvious thing to reach for and is wrong in the one case that
 * matters: removing one attachment and adding another leaves the length
 * untouched, so the refetch never fires and the new picture stays unresolvable
 * until something unrelated re-renders. Hashes are already the identity of
 * these things, so joining them is the whole rule.
 */
export function attachmentsRevision(attachments: readonly { blobHash: string }[]): string {
  return attachments.map((attachment) => attachment.blobHash).join(",");
}

export function useMaterializedAttachments(
  owner: MaterializedAttachmentsOwner,
  /**
   * Anything that changes when the owner's attachments do — see
   * {@link attachmentsRevision}. `null` means the strip itself has not landed
   * yet: the read is held rather than issued against an empty list, which for
   * a ticket that HAS attachments would otherwise be a second read a moment
   * later when the real revision arrives (VC-373).
   */
  revision: string | number | null = 0,
): readonly NamedBlobLink[] {
  const { projectId, ticketId, sessionId } = owner;
  const cloud = React.useSyncExternalStore(followCloudSession, cloudSession, () => null);
  const scope = `${projectId ?? ""}|${ticketId ?? ""}|${sessionId ?? ""}`;
  const [loaded, setLoaded] = React.useState<{
    scope: string;
    cloud: CloudSession | null;
    links: readonly NamedBlobLink[];
  } | null>(null);

  React.useEffect(() => {
    const setLinks = (links: readonly NamedBlobLink[]) => setLoaded({ scope, cloud, links });
    if (ticketId === undefined && sessionId === undefined) {
      setLinks(NONE);
      return;
    }
    // The owner's strip is unknown, so the question is not answerable yet.
    // Nothing is painted and nothing is read; the effect re-runs when the
    // real revision lands.
    if (revision === null) return;
    let cancelled = false;
    void readMaterializedAttachments({ projectId, ticketId, sessionId })
      .then((result) => {
        if (cancelled) return;
        // A failure here costs a picture, not a mutation the user is waiting
        // on: the markdown still renders and unresolved images say so on the
        // page. Nothing to toast — there is no action a person could take.
        setLinks(result);
      })
      .catch(() => {
        if (!cancelled) setLinks(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ticketId, sessionId, revision, cloud, scope]);

  return loaded?.scope === scope && loaded.cloud === cloud ? loaded.links : NONE;
}
