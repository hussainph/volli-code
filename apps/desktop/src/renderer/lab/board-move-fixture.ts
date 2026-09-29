import { moveTicket, moveTickets, type Ticket } from "@volli/shared";

type TicketsResult = Awaited<ReturnType<typeof window.api.tickets.move>>;
type MoveInput = Parameters<typeof window.api.tickets.move>[0];
type MoveManyInput = Parameters<typeof window.api.tickets.moveMany>[0];

const wrongProject = (): TicketsResult => ({
  ok: false,
  error: "No fixture board for this project.",
});

/** In-memory persistence for real Board gestures. Never schedules or starts work. */
export function createBoardMoveFixture(projectId: string, initial: readonly Ticket[]) {
  let tickets = [...initial];
  return {
    read: (): Ticket[] => tickets,
    reset: (): void => {
      tickets = [...initial];
    },
    move: async (input: MoveInput): Promise<TicketsResult> => {
      if (input.projectId !== projectId) return wrongProject();
      tickets = moveTicket(tickets, input.ticketId, input.toStatus, input.toIndex, Date.now());
      return { ok: true, tickets };
    },
    moveMany: async (input: MoveManyInput): Promise<TicketsResult> => {
      if (input.projectId !== projectId) return wrongProject();
      tickets = moveTickets(tickets, input.ticketIds, input.toStatus, input.toIndex, Date.now());
      return { ok: true, tickets };
    },
  };
}
