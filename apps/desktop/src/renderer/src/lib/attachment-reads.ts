/** The launch-scoped attachment read door. Cloud metadata never falls back to
 * runner-local SQLite; upload/removal are intentionally not part of this seam.
 */
import type { BlobLinkView, NamedBlobLink } from "@volli/shared";
import { cloudSession } from "./cloud-client";
import { launchStore } from "@renderer/stores/launch";
import { remoteHostOfTicketNow } from "@renderer/stores/remote-project";

interface AttachmentOwner {
  projectId?: string | undefined;
  ticketId?: string | undefined;
  sessionId?: string | undefined;
}

async function cloudLinks(owner: AttachmentOwner): Promise<BlobLinkView[]> {
  const session = cloudSession();
  if (session === null || owner.projectId === undefined) throw new Error("Attachments unavailable");
  return session.client.query(session.api.files.attachments, {
    projectId: owner.projectId,
    ...(owner.ticketId === undefined ? {} : { ticketId: owner.ticketId }),
    ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
  });
}

export async function readTicketAttachments(
  projectId: string,
  ticketId: string,
): Promise<readonly BlobLinkView[]> {
  if (launchStore() === "cloud") return cloudLinks({ projectId, ticketId });
  if (remoteHostOfTicketNow(ticketId) !== null) return [];
  const result = await window.api.attachments.list({ ticketId });
  if (!result.ok) throw new Error(result.error);
  return result.blobs;
}

export async function readMaterializedAttachments(
  owner: AttachmentOwner,
): Promise<readonly NamedBlobLink[]> {
  if (launchStore() === "cloud") {
    const links = await cloudLinks(owner);
    return links.filter((link): link is BlobLinkView & { linkId: string } => link.linkId !== null);
  }
  if (remoteHostOfTicketNow(owner.ticketId) !== null) return [];
  const result = await window.api.attachments.materialized({
    ticketId: owner.ticketId,
    sessionId: owner.sessionId,
  });
  if (!result.ok) throw new Error(result.error);
  return result.links;
}
