/**
 * A TEST-ONLY example area router: the walk-through HP § Command catalog,
 * "Adding a command", follows step by step. Nothing in production imports it;
 * it exists so the pattern VC-565 onward copies is proven through the real
 * builders, not described.
 *
 * It models two board commands the way an area ticket would:
 *
 * - `ticket.create`: a workspace-scoped, `command-id` write whose router actor
 *   is `session-own` (the person, or a Session the area's policy lets act on
 *   the parent it files under), with an output schema;
 * - `ticket.move`: the same, naming TWO resources: the ticket it moves (the
 *   subject, judged by policy) and the ticket it lands after (a reference,
 *   Workspace-checked but needing no authority).
 *
 * In production the entries are Verb Registry rows, the router lives in
 * `packages/session-rpc/src/<area>-router.ts`, and the ledger is a host-core
 * function the composition root wires into the context ports.
 */
import type { SessionId, WorkspaceId } from "@volli/host-protocol";
import {
  COMMAND_INTENT_CONFLICT,
  type CatalogKeyOf,
  type CommandIntentConflict,
  type VerbEntry,
} from "@volli/shared";
import { z } from "zod";

import {
  createCatalogBuilders,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type ResourceRelation,
  type WorkspaceResource,
} from "./catalog";

// ---- Step 1: the entries (in production, rows of VERB_REGISTRY) ------------

export const EXAMPLE_AREA_ENTRIES = [
  {
    key: "ticket.create",
    // One entry on both doors: the CLI over the socket, and the WebSocket.
    accessModes: ["cli", "hostApi"],
    // What the socket, tools and CLI judge, unchanged: per-project policy.
    actor: "session",
    handler: { site: "main", id: "ticket.create" },
    listed: true,
    group: "Write",
    summary: "File a ticket under a parent ticket.",
    options: [],
    // What a router judges: the person, or a Session the area's policy lets act.
    catalog: { actor: "session-own", scope: "workspace", idempotency: "command-id" },
  },
  {
    key: "ticket.move",
    accessModes: ["cli", "hostApi"],
    actor: "session",
    handler: { site: "main", id: "ticket.move" },
    listed: true,
    group: "Write",
    summary: "Move a ticket to land after another.",
    options: [],
    catalog: { actor: "session-own", scope: "workspace", idempotency: "command-id" },
  },
] as const satisfies readonly VerbEntry[];

export type ExampleAreaEntry = (typeof EXAMPLE_AREA_ENTRIES)[number];

// ---- The area's resources and ports ---------------------------------------

/** The area's own resource kind: no edit to `@volli/session-rpc` names it. */
export const TICKET_RESOURCE = "ticket";

/** A ticket the command names; a subject unless it says otherwise. */
function ticketResource(id: string, relation?: ResourceRelation): WorkspaceResource {
  return relation === undefined
    ? { kind: TICKET_RESOURCE, id }
    : { kind: TICKET_RESOURCE, id, relation };
}

/** One ticket, as the example ledger keeps it. */
export interface ExampleTicket {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  /** The Sessions coordinating on it: several may, and none is "the owner". */
  readonly sessions: readonly SessionId[];
  readonly parentId: string | null;
  readonly afterId: string | null;
}

/** A command id reused for a different intent: branded, so every router answers `command-conflict`. */
export class ExampleIntentConflictError extends Error implements CommandIntentConflict {
  readonly [COMMAND_INTENT_CONFLICT] = true as const;
}

const receiptSchema = z.object({
  commandId: z.string(),
  ticketId: z.string(),
  status: z.enum(["accepted", "completed"]),
});
export type ExampleReceipt = z.output<typeof receiptSchema>;

/**
 * The area's handler half: in production a host-core function, the SAME one
 * the socket verb calls (HP step 3). Idempotent by command id: the same
 * intent answers its receipt again; another intent under that id is a
 * branded conflict.
 */
export class ExampleTicketLedger {
  readonly tickets = new Map<string, ExampleTicket>();
  readonly #receipts = new Map<string, { intent: string; receipt: ExampleReceipt }>();
  #next = 1;

  constructor(tickets: readonly ExampleTicket[]) {
    for (const ticket of tickets) this.tickets.set(ticket.id, ticket);
  }

  workspaceOf(id: string): WorkspaceId | null {
    return this.tickets.get(id)?.workspaceId ?? null;
  }

  /**
   * The area's own coordination rule, standing in for production's ticket
   * policy: a Session may act on a ticket it is coordinating on.
   */
  sessionMayAct(id: string, sessionId: SessionId): boolean {
    return this.tickets.get(id)?.sessions.includes(sessionId) ?? false;
  }

  create(input: { commandId: string; parentTicketId: string; title: string }): ExampleReceipt {
    return this.#once(input.commandId, { create: input }, () => {
      const parent = this.tickets.get(input.parentTicketId)!;
      const id = `ticket-${this.#next++}`;
      this.tickets.set(id, { ...parent, id, parentId: parent.id, afterId: null });
      return id;
    });
  }

  move(input: { commandId: string; ticketId: string; afterTicketId: string }): ExampleReceipt {
    return this.#once(input.commandId, { move: input }, () => {
      const ticket = this.tickets.get(input.ticketId)!;
      this.tickets.set(ticket.id, { ...ticket, afterId: input.afterTicketId });
      return ticket.id;
    });
  }

  #once(commandId: string, intent: unknown, apply: () => string): ExampleReceipt {
    const stated = JSON.stringify(intent);
    const prior = this.#receipts.get(commandId);
    if (prior !== undefined) {
      if (prior.intent !== stated) {
        throw new ExampleIntentConflictError(
          `Command ${commandId} was already accepted with different intent`,
        );
      }
      return prior.receipt;
    }
    const receipt: ExampleReceipt = { commandId, ticketId: apply(), status: "completed" };
    this.#receipts.set(commandId, { intent: stated, receipt });
    return receipt;
  }
}

/** The area router's context: the catalog's ports, plus the area's own. */
export interface ExampleAreaContext extends CatalogCallerContext {
  tickets: ExampleTicketLedger;
}

// ---- Step 2: the procedures, from the area's own builder family -----------

const { workspaceProcedure, catalogRouter } = createCatalogBuilders<
  ExampleAreaContext,
  ExampleAreaEntry
>({ entries: EXAMPLE_AREA_ENTRIES });

const commandId = z.uuidv4();
const ticketId = z.string().min(1);

export function createExampleAreaRouter() {
  return catalogRouter({
    ticket: {
      create: workspaceProcedure(
        "ticket.create",
        z.object({ commandId, parentTicketId: ticketId, title: z.string().min(1) }),
        // Every resource the input names: here, the parent it files under.
        (input) => ticketResource(input.parentTicketId),
      )
        .output(receiptSchema)
        .mutation(({ ctx, input }) => ctx.tickets.create(input)),
      move: workspaceProcedure(
        "ticket.move",
        z.object({ commandId, ticketId, afterTicketId: ticketId }),
        // Two resources, both Workspace-checked. The moved ticket is the
        // subject, judged by the area's policy for a Session; the one it lands
        // after is only a reference, so a Session needs no authority over it.
        (input) => [
          ticketResource(input.ticketId),
          ticketResource(input.afterTicketId, "reference"),
        ],
      )
        .output(receiptSchema)
        .mutation(({ ctx, input }) => ctx.tickets.move(input)),
    },
  });
}

export type ExampleAreaRouter = ReturnType<typeof createExampleAreaRouter>;

// ---- Step 3: the binding assertion (production: the composition root's) ---

type AssertNever<Type extends never> = Type;
/** Every example procedure has its entry, and every entry its procedure. */
export type ExampleAreaCatalogBinding = AssertNever<
  CatalogMismatch<
    ProcedurePaths<ExampleAreaRouter["_def"]["record"]>,
    CatalogKeyOf<ExampleAreaEntry>
  >
>;

/** The context ports, wired as a composition root wires them to host-core. */
export function exampleAreaContext(
  tickets: ExampleTicketLedger,
  caller: CatalogCallerContext["caller"],
  diagnostics: CatalogCallerContext["diagnostics"],
): ExampleAreaContext {
  return {
    caller,
    tickets,
    diagnostics,
    resourceWorkspace: (resource) =>
      resource.kind === TICKET_RESOURCE ? tickets.workspaceOf(resource.id) : null,
    // From the area's existing policy, never a single owner field.
    sessionMayAct: (resource, sessionId) =>
      resource.kind === TICKET_RESOURCE && tickets.sessionMayAct(resource.id, sessionId),
  };
}
