/**
 * Where a project's Session listing is read from (VC-713).
 *
 * This Mac's projects read `volli:session-list` and `-for-ticket`, exactly as
 * before. A project on a remote host reads the host protocol's
 * `session.listing`/`session.listingForTicket` over its Workspace link instead
 * (HP § The Session listing): the same rows, so the rail, Home and the ticket
 * panel draw a remote Session the way they draw a local one. Nothing here
 * ever calls `window.api` with a remote project's id.
 *
 * The remote half is registered by whoever owns the Workspace links (the
 * relay binding, behind `cloud`); with nothing registered, which is the flag
 * off, every read is the local one.
 */
import type { SessionListingReader } from "./remote-session-wire";

export type { SessionListingReader } from "./remote-session-wire";

/** Which reader serves a project, or a ticket, when it is on a remote host; `null` for This Mac. */
export interface RemoteSessionListing {
  forProject(projectId: string): SessionListingReader | null;
  forTicket(ticketId: string): SessionListingReader | null;
}

let remote: RemoteSessionListing | null = null;

/**
 * Registers the remote half. Returns the unregister, which only removes this
 * registration (a later one stays).
 */
export function setRemoteSessionListing(listing: RemoteSessionListing): () => void {
  remote = listing;
  return () => {
    if (remote === listing) remote = null;
  };
}

function localReader(): SessionListingReader {
  return {
    list: (input) => window.api.sessions.list(input),
    listForTicket: (input) => window.api.sessions.listForTicket(input),
  };
}

/** The reader a project's listing comes from. */
export function sessionListingReaderForProject(projectId: string): SessionListingReader {
  return remote?.forProject(projectId) ?? localReader();
}

/** The reader a ticket's listing comes from. */
export function sessionListingReaderForTicket(ticketId: string): SessionListingReader {
  return remote?.forTicket(ticketId) ?? localReader();
}
