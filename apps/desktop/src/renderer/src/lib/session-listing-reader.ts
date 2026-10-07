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
import { useBoardStore } from "@renderer/stores/board";

import { remoteOwnerOf } from "./remote-owners";
import { closedListingReader, type SessionListingReader } from "./remote-session-wire";

export type { SessionListingReader } from "./remote-session-wire";

/** Which reader serves a project when it is on a remote host; `null` when not bound here now. */
export interface RemoteSessionListing {
  forProject(projectId: string): SessionListingReader | null;
}

let remote: RemoteSessionListing | null = null;
/** Registrations not yet removed: the remote-Sessions binding is meant to be the only one. */
const active = new Set<RemoteSessionListing>();

/**
 * Registers the remote half. Returns the unregister, which only removes this
 * registration (a later one stays). Its one production owner is the
 * remote-Sessions binding (`bindRemoteSessionsWhileCloud`).
 */
export function setRemoteSessionListing(listing: RemoteSessionListing): () => void {
  remote = listing;
  active.add(listing);
  return () => {
    active.delete(listing);
    if (remote === listing) remote = null;
  };
}

/** How many remote listing registrations are in place: one with `cloud` on, none off. */
export function remoteSessionListingRegistrations(): number {
  return active.size;
}

function localReader(): SessionListingReader {
  return {
    list: (input) => window.api.sessions.list(input),
    listForTicket: (input) => window.api.sessions.listForTicket(input),
  };
}

/** The project a ticket is on, from the board this window holds. */
function projectOfTicket(ticketId: string): string | null {
  for (const [projectId, tickets] of Object.entries(useBoardStore.getState().ticketsByProject)) {
    if (tickets.some((ticket) => ticket.id === ticketId)) return projectId;
  }
  return null;
}

/**
 * The reader a project's listing comes from: its host's for a remote
 * project, `volli:session-list` for This Mac's. A project known remote whose
 * Workspace is not bound now reads nothing and says why (VC-713, B1).
 */
export function sessionListingReaderForProject(projectId: string): SessionListingReader {
  const owner = remoteOwnerOf(projectId);
  if (owner === null) return localReader();
  return remote?.forProject(projectId) ?? closedListingReader(owner.hostName);
}

/** The reader a ticket's listing comes from, by the project the ticket is on. */
export function sessionListingReaderForTicket(ticketId: string): SessionListingReader {
  const projectId = projectOfTicket(ticketId);
  const owner = remoteOwnerOf(projectId);
  if (owner === null) return localReader();
  return remote?.forProject(projectId!) ?? closedListingReader(owner.hostName);
}
