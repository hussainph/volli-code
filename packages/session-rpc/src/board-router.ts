import { procedureSchemas } from "./procedure-schema";
/**
 * The board area's router (VC-668): the catalog's board commands, projected
 * from the host's handler map. Its first and, until VC-565, only command is
 * `ticket.move`, the first command both kinds of door serve: the agent socket
 * projects the same `handlers["ticket.move"]` (`@volli/host-core`'s
 * `AGENT_VERB_TABLE`), and so does the desktop's `volli:ticket-move` channel
 * until VC-565 moves the renderer onto this router.
 *
 * No production door mounts it yet: hostd's WebSocket listener is VC-663's,
 * and the desktop's generic IPC bridge VC-608's. The contract harness serves
 * it over a real WebSocket.
 */
import {
  BOARD_ENTRIES,
  TICKET_STATUSES,
  type BoardEntry,
  type CatalogKeyOf,
  type HostHandler,
  type HostHandlerKeyOf,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";
import type { JsonUnsafeProcedures } from "@volli/host-protocol";
import { z } from "zod";

import {
  createCatalogBuilders,
  PROJECT_RESOURCE,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterContextPorts,
  type WorkspaceResource,
} from "./catalog";

/** The board's resource kind; the context's `resourceWorkspace` answers it. */
export const TICKET_RESOURCE = "ticket";

/** What the board router asks of `ticket.move`: the host's handler, structurally. */
export interface BoardTicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
}

/** The slice of the host's handler map the board router projects (D2: structural). */
export interface BoardRouterHandlers {
  readonly "ticket.move": HostHandler<BoardTicketMoveInput, readonly Ticket[]>;
}

type AssertNever<Type extends never> = Type;

/** The board family's keys and the slice's keys are one set. */
export type BoardRouterHandlersCoverage = AssertNever<
  CatalogMismatch<keyof BoardRouterHandlers & string, HostHandlerKeyOf<BoardEntry>>
>;

/** The board router's context: the catalog's ports and the map, nothing else. */
export interface BoardRouterContext extends CatalogCallerContext {
  handlers: BoardRouterHandlers;
}

export type BoardRouterContextPorts = AssertNever<RouterContextPorts<BoardRouterContext>>;

const { workspaceProcedure, catalogRouter } = createCatalogBuilders<BoardRouterContext, BoardEntry>(
  { entries: BOARD_ENTRIES },
);

const id = z.string().min(1);

const movedTicketSchema = z.object({
  ticket: z.object({ id, status: z.enum(TICKET_STATUSES), order: z.number() }),
});

export function createBoardRouter() {
  return catalogRouter({
    ticket: {
      // Column-only, as on the socket: no drop index, so moving to the column
      // a ticket already occupies is a no-op and a repeat is natural.
      move: workspaceProcedure(
        "ticket.move",
        z.object({ projectId: id, ticketId: id, toStatus: z.enum(TICKET_STATUSES) }),
        (input): WorkspaceResource[] => [
          // The subject: what the move acts on.
          { kind: TICKET_RESOURCE, id: input.ticketId },
          // The board it lands on, Workspace-checked like the ticket, so the
          // two can only ever name the same project.
          { kind: PROJECT_RESOURCE, id: input.projectId, relation: "reference" },
        ],
      )
        .output(movedTicketSchema)
        .mutation(async ({ ctx, input }) => {
          const tickets = await ctx.handlers["ticket.move"](input, ctx.call);
          const moved = tickets.find((ticket) => ticket.id === input.ticketId)!;
          return { ticket: { id: moved.id, status: moved.status, order: moved.order } };
        }),
    },
  });
}

export type BoardRouter = ReturnType<typeof createBoardRouter>;

/** Every board procedure has its entry, and every board entry its procedure. */
export type BoardRouterCatalogBinding = AssertNever<
  CatalogMismatch<ProcedurePaths<BoardRouter["_def"]["record"]>, CatalogKeyOf<BoardEntry>>
>;

/** Every board procedure's input and output survive JSON (docs/BOUNDARIES.md, rule 3). */
export type BoardRouterJsonSafety = AssertNever<JsonUnsafeProcedures<BoardRouter>>;

/** Published grammar from the board's actual validators, not a parallel shape. */
export function boardProcedureSchemas(router: BoardRouter = createBoardRouter()) {
  return procedureSchemas(router);
}
