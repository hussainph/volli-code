/**
 * The remote half of the Session listing (VC-713's `session-listing-reader`),
 * over each remote project's Workspace link (VC-711): a remote project's rail,
 * Home and ticket panel read `session.listing` / `session.listingForTicket`
 * through main's relay, so nothing ever asks `window.api` about its id.
 *
 * A project is remote when the host-connection store claims it for a remote
 * host; a ticket is its board's (`BoardSync.workspaceOf`). Anything else is
 * This Mac's (`null`), read as before. A failure answers the listing's own
 * `{ ok: false, error }`, which the stores say or keep quiet as they choose.
 */
import type { HostLinkCalls } from "@volli/host-protocol/client-link";
import type { SessionListingRow } from "@volli/shared";

import type { SessionsResult } from "../../../ipc/contract";
import { failureMessage } from "../stores/board-sync";
import type { RemoteSessionListing, SessionListingReader } from "./session-listing-reader";

/** A listing page as the host answers it (`SessionListingPage`): rows, and how many it left out. */
interface ListingPage {
  readonly sessions: SessionListingRow[];
  readonly omitted: number;
}

async function rows(read: () => Promise<unknown>): Promise<SessionsResult> {
  try {
    const page = (await read()) as ListingPage;
    return { ok: true, sessions: page.sessions };
  } catch (error) {
    return { ok: false, error: failureMessage(error) };
  }
}

/** One remote project's listing, over its link. */
export function relaySessionListingReader(
  link: Pick<HostLinkCalls, "query">,
): SessionListingReader {
  return {
    list: (input) => rows(() => link.query("session.listing", input)),
    listForTicket: (input) => rows(() => link.query("session.listingForTicket", input)),
  };
}

export function relaySessionListing(options: {
  /** Whether a remote host serves the project. */
  isRemote(projectId: string): boolean;
  /** The project whose board holds the ticket, if any board this window follows does. */
  projectOfTicket(ticketId: string): string | undefined;
  /** The project's Workspace link (`relayHostLink`). */
  link(projectId: string): Pick<HostLinkCalls, "query">;
}): RemoteSessionListing {
  const forProject = (projectId: string | undefined): SessionListingReader | null =>
    projectId === undefined || !options.isRemote(projectId)
      ? null
      : relaySessionListingReader(options.link(projectId));
  return {
    forProject,
    forTicket: (ticketId) => forProject(options.projectOfTicket(ticketId)),
  };
}
