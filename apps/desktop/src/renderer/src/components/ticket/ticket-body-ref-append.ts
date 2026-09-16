/**
 * Appending one `@file` reference to a Ticket Body that this renderer may not
 * hold (VC-387).
 *
 * The board store keeps a `""` PLACEHOLDER for a ticket the steady-state roster
 * introduced, because the roster reads no bodies. `""` is also a legal body, so
 * the append path cannot tell them apart by value — and appending to the
 * placeholder writes one `@ref` over the person's real Ticket Body. This module
 * is the one place that distinction is enforced: a placeholder is resolved to
 * the canonical body BEFORE anything is appended to it.
 *
 * Extracted from `ticket-detail.tsx` as a plain module so the ordering it exists
 * for — read, then append, then write — is assertable without mounting the
 * ticket workspace.
 */
import { appendFileRef } from "@renderer/editor/file-refs";
import { toastError } from "@renderer/lib/toast";
import { isTicketBodyLoaded, useBoardStore } from "@renderer/stores/board";

/** The reads and writes this append needs — narrow and fake-able in tests. */
export interface TicketBodyRefGateway {
  /** The canonical Ticket Body, read on demand. */
  readBody(input: { ticketId: string }): Promise<{ ok: true; body: string } | { ok: false }>;
  /** Reports a failure a person is waiting on. */
  reportFailure(message: string): void;
}

const defaultGateway: TicketBodyRefGateway = {
  readBody: async (input) => {
    const result = await window.api.tickets.body(input);
    return result.ok ? { ok: true, body: result.body } : { ok: false };
  },
  reportFailure: (message) => {
    toastError(message);
  },
};

/**
 * Appends `token` to a ticket's Ticket Body and writes it through.
 *
 * The body is read FRESH from the store rather than from a render's `ticket`: a
 * multi-file drop appends one ref per file, and each append patches the slice
 * synchronously, so a render-time body could be a turn behind and would drop the
 * previous ref — which for a repository document is the whole attachment.
 *
 * When the store's body is a placeholder, the canonical body is read first and
 * adopted, then the ref is appended to THAT. A failed read appends nothing and
 * is reported: a person dragged a file in and is waiting for it to land, so this
 * is not background refinement (CLAUDE.md).
 */
export async function appendRefToTicketBody(
  ticket: { id: string; projectId: string },
  token: string,
  gateway: TicketBodyRefGateway = defaultGateway,
): Promise<void> {
  const board = useBoardStore.getState();
  const current = board.ticketsByProject[ticket.projectId]?.find(
    (candidate) => candidate.id === ticket.id,
  );
  if (current === undefined) return; // not a ticket this board holds

  let body = current.body;
  if (!isTicketBodyLoaded(board, ticket.id)) {
    const read = await gateway.readBody({ ticketId: ticket.id });
    if (!read.ok) {
      gateway.reportFailure("Couldn't attach the file: this ticket's body didn't load.");
      return;
    }
    // Adopt first, so a second file in the same drop appends to a body that is
    // no longer a placeholder and never pays for this read twice.
    useBoardStore.getState().adoptTicketBody(ticket.projectId, ticket.id, read.body);
    body = read.body;
  }

  await useBoardStore.getState().updateTicket({
    ticketId: ticket.id,
    body: appendFileRef(body, token),
  });
}
