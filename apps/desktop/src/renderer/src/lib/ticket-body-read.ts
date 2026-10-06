/**
 * One ticket's Markdown body, read for the ticket that is open (VC-387), over
 * the router-generic IPC bridge: `ticket.body`, the desktop-only tier's read
 * that replaced `volli:ticket-body` (VC-608). A ticket that is gone answers
 * `null` there, and `{ ok: false }` here, as the channel did.
 */
import { sessionRpcClient } from "./session-rpc-ipc-link";

/** The body, or that there is none to read; a transport failure rejects. */
export type TicketBodyRead = { ok: true; body: string } | { ok: false };

export async function readTicketBody(input: { ticketId: string }): Promise<TicketBodyRead> {
  const body = await sessionRpcClient().ticket.body.query(input);
  return body === null ? { ok: false } : { ok: true, body };
}
