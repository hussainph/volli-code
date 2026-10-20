/**
 * The board area's router (VC-668, VC-565): the catalog's board commands,
 * projected from the host's handler map.
 *
 * - `ticket.move` is the command both kinds of door serve (VC-668): the agent
 *   socket projects the same `handlers["ticket.move"]`, column-only.
 * - Everything under `board.` is the board's own (VC-565): the reads a Client
 *   paints a Workspace's board from (`board.read`), its writes under a
 *   Client-minted `commandId` answered with a receipt (`board.write`), and the
 *   Workspace's change feed, `board.changes`, whose changes inline the
 *   committed row and name the command behind them (F1, T5).
 *
 * Served on hostd's WebSocket through the composed host router
 * (`host-router.ts`), and on the desktop's generic IPC bridge
 * (`DESKTOP_IPC_EXPOSURE`). Handlers own every
 * effect (T13); a procedure only maps its envelope.
 */
import { tracked } from "@trpc/server";
import {
  BOARD_ENTRIES,
  BOARD_RESOURCE_KINDS,
  HARNESS_SLUG_RE,
  isFeedResnapshotRequired,
  type ArchivedTicket,
  type BoardChange,
  type BoardCommandReceipt,
  type BoardEntry,
  type CatalogKeyOf,
  type DeliberateMoveChoice,
  type HandlerCall,
  type HarnessId,
  type HostHandler,
  type HostHandlerKeyOf,
  type Label,
  type LatestSessionSignal,
  type ModelSelection,
  type Project,
  type ProjectFolderState,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
  type TicketStatusEntry,
  type TicketSummary,
} from "@volli/shared";
import type { JsonUnsafeProcedures } from "@volli/host-protocol";
import { z } from "zod";

import { AsyncQueue } from "./async-queue";
import {
  archivedTicketSchema,
  boardChangeBatchSchema,
  boardId,
  boardRosterSchema,
  boardSnapshotSchema,
  commandIdSchema,
  commentSchema,
  labelSchema,
  latestSignalSchema,
  modelSelectionSchema,
  projectSchema,
  receiptSchema,
  statusEntrySchema,
  ticketEventSchema,
  ticketPrioritySchema,
  ticketSchema,
  ticketStatusSchema,
  ticketSummarySchema,
} from "./board-schema";
import {
  createCatalogBuilders,
  hostAnswer,
  HostProcedureError,
  PROJECT_RESOURCE,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterContextPorts,
  type WorkspaceResource,
} from "./catalog";
import { procedureSchemas } from "./procedure-schema";
import { resnapshotRequired } from "./replay-bound";
import { SESSION_RESOURCE } from "./session-catalog";

/** The board's resource kinds; the context's `resourceWorkspace` answers them. */
export const TICKET_RESOURCE = BOARD_RESOURCE_KINDS.ticket;
export const COMMENT_RESOURCE = BOARD_RESOURCE_KINDS.comment;
export const LABEL_RESOURCE = BOARD_RESOURCE_KINDS.label;

/** What the board router asks of `ticket.move`: the host's handler, structurally. */
export interface BoardTicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
}

/** `board.moveTickets`: one card or one selected group, to a position. */
export type BoardMoveTicketsInput = {
  commandId?: string;
  projectId: string;
  toStatus: TicketStatus;
  choice?: DeliberateMoveChoice;
} & ({ ticketId: string; toIndex?: number } | { ticketIds: string[]; toIndex: number });

interface Receipted {
  readonly receipt: BoardCommandReceipt | null;
  /** The Workspace feed's cursor through which the write is stamped (T5). */
  readonly throughCursor: string;
}

type ProjectRef = { projectId: string };
type TicketRef = { ticketId: string };
type Command = { commandId?: string };

/** One `board.changes` delivery, as the host's feed yields it. */
export interface BoardFeedEmission {
  readonly cursor: string;
  readonly changes: readonly BoardChange[];
}

/**
 * The slice of the host's handler map the board router projects (D2:
 * structural; a composition root's assignment of the host's map checks it).
 */
export interface BoardRouterHandlers {
  readonly "ticket.move": HostHandler<BoardTicketMoveInput, readonly Ticket[]>;
  readonly "board.snapshot": HostHandler<
    ProjectRef,
    { project: Project; tickets: readonly Ticket[]; labels: readonly Label[]; cursor: string }
  >;
  readonly "board.roster": HostHandler<
    ProjectRef,
    { tickets: readonly TicketSummary[]; labels: readonly Label[]; cursor: string }
  >;
  readonly "board.changes": (
    input: ProjectRef & { after: string | null },
    call: HandlerCall,
    sink: { emit(batch: BoardFeedEmission): void | Promise<void>; fail(error: unknown): void },
  ) => Promise<() => void>;
  readonly "board.projectFolder": HostHandler<
    ProjectRef,
    { path: string; state: ProjectFolderState }
  >;
  readonly "board.ticketBody": HostHandler<TicketRef, { body: string }>;
  readonly "board.archivedTickets": HostHandler<ProjectRef, readonly ArchivedTicket[]>;
  readonly "board.ticketEvents": HostHandler<TicketRef, readonly TicketEvent[]>;
  readonly "board.latestSignals": HostHandler<ProjectRef, readonly LatestSessionSignal[]>;
  readonly "board.statusEntries": HostHandler<ProjectRef, readonly TicketStatusEntry[]>;
  readonly "board.comments": HostHandler<TicketRef, readonly TicketComment[]>;
  readonly "board.updateProject": HostHandler<
    ProjectRef & Command & { baseBranch: string | null; setupCommand?: string | null },
    Receipted & { project: Project }
  >;
  readonly "board.setSkillModes": HostHandler<
    ProjectRef & Command & { modes: Record<string, string> },
    Receipted & { project: Project }
  >;
  readonly "board.setSessionDefaults": HostHandler<
    ProjectRef & Command & { model: ModelSelection | null },
    Receipted & { project: Project }
  >;
  readonly "board.createTicket": HostHandler<
    ProjectRef &
      Command & {
        status: TicketStatus;
        title: string;
        priority?: TicketPriority;
        body?: string;
        labels?: string[];
        usesWorktree?: boolean;
        preferredHarnessId?: HarnessId;
        baseBranch?: string | null;
      },
    Receipted & { ticket: Ticket }
  >;
  readonly "board.moveTickets": HostHandler<
    BoardMoveTicketsInput,
    Receipted & { tickets: readonly Ticket[] }
  >;
  readonly "board.setPriority": HostHandler<
    TicketRef & Command & { priority: TicketPriority },
    Receipted & { ticket: Ticket }
  >;
  readonly "board.updateTicket": HostHandler<
    TicketRef &
      Command & {
        title?: string;
        body?: string;
        branch?: string | null;
        baseBranch?: string | null;
        usesWorktree?: boolean;
      },
    Receipted & { ticket: Ticket }
  >;
  readonly "board.setLabels": HostHandler<
    TicketRef & Command & { labels: string[] },
    Receipted & { ticket: Ticket }
  >;
  readonly "board.archiveTicket": HostHandler<TicketRef & Command, Receipted>;
  readonly "board.unarchiveTicket": HostHandler<
    TicketRef & Command,
    Receipted & { ticket: Ticket }
  >;
  readonly "board.deleteTicket": HostHandler<TicketRef & Command, Receipted>;
  readonly "board.createComment": HostHandler<
    TicketRef & Command & { body: string; sessionId?: string | null },
    Receipted & { comment: TicketComment }
  >;
  readonly "board.updateComment": HostHandler<
    { commentId: string; body: string } & Command,
    Receipted & { comment: TicketComment }
  >;
  readonly "board.removeComment": HostHandler<{ commentId: string } & Command, Receipted>;
  readonly "board.setLabelColor": HostHandler<
    { labelId: string; color: string | null } & Command,
    Receipted & { label: Label }
  >;
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
  ticket: z.object({ id, status: ticketStatusSchema, order: z.number() }),
});

/** Frames one board feed may hold unsent to its consumer before it overflows. */
const BOARD_FEED_QUEUE_CAPACITY = 1_024;
const BOARD_FEED_OVERFLOW_MESSAGE = "Board feed fell behind; resume from the last event id";
const BOARD_FEED_SOURCE_FAILURE_MESSAGE = "Board feed source failed; resubscribe to resume";

// Resources. A project is its own Workspace; every other kind is answered by
// the context's `resourceWorkspace` port. Every id an input names is one:
// the subject an operation acts on, and each resource it only refers to
// (`relation: "reference"`), so a reference into another Workspace is refused
// exactly as an absent one. Names a write creates or matches inside the
// subject's own Workspace (a label's name, an armed Automation's id, which the
// move only looks up among its board's own) are not resources.
const project = (input: ProjectRef): WorkspaceResource => ({
  kind: PROJECT_RESOURCE,
  id: input.projectId,
});
const ticket = (input: TicketRef): WorkspaceResource => ({
  kind: TICKET_RESOURCE,
  id: input.ticketId,
});
const comment = (input: { commentId: string }): WorkspaceResource => ({
  kind: COMMENT_RESOURCE,
  id: input.commentId,
});

const projectInput = z.object({ projectId: boardId });
const ticketInput = z.object({ ticketId: boardId });
const branchName = z.string().min(1).max(256);

/**
 * A write's answer: its receipt, the feed cursor its effect is stamped
 * through (a Client that has applied the feed through it holds the write, as
 * `throughSequence` says for a Session), and its row.
 */
const receipted = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ receipt: receiptSchema, throughCursor: z.string(), ...shape });

/** A write's answer always carries its receipt: the router's input demands a `commandId`. */
function withReceipt<Answer extends Receipted>(
  answer: Answer,
): Answer & { receipt: BoardCommandReceipt } {
  if (answer.receipt === null) throw new Error("A board command answered without its receipt");
  return answer as Answer & { receipt: BoardCommandReceipt };
}

/**
 * A handler's domain answer as its wire type. The JSON is the same; what the
 * types disagree on is only that a project's preference documents and a
 * ticket event's payload are opaque JSON on the wire (interfaces carry no
 * index signature) and that the host answers readonly arrays. The output
 * validator checks the value on every network door, and
 * `board-schema.test-d.ts` checks key by key that no domain field is stripped.
 */
function wire<Schema extends z.ZodType>(_schema: Schema, value: unknown): z.output<Schema> {
  return value as z.output<Schema>;
}

const roster = (tickets: readonly Ticket[]): TicketSummary[] =>
  tickets.map(({ body: _body, ...summary }) => summary);

export function createBoardRouter() {
  return catalogRouter({
    ticket: {
      // Column-only, as on the socket: no drop index, so moving to the column
      // a ticket already occupies is a no-op and a repeat is natural.
      move: workspaceProcedure(
        "ticket.move",
        z.object({ projectId: id, ticketId: id, toStatus: ticketStatusSchema }),
        (input): WorkspaceResource[] => [
          // The subject: what the move acts on.
          ticket(input),
          // The board it lands on, Workspace-checked like the ticket, so the
          // two can only ever name the same project.
          { ...project(input), relation: "reference" },
        ],
      )
        .output(movedTicketSchema)
        .mutation(async ({ ctx, input }) => {
          const tickets = await ctx.handlers["ticket.move"](input, ctx.call);
          const moved = tickets.find((candidate) => candidate.id === input.ticketId)!;
          return { ticket: { id: moved.id, status: moved.status, order: moved.order } };
        }),
    },
    board: {
      snapshot: workspaceProcedure("board.snapshot", projectInput, project)
        .output(boardSnapshotSchema)
        .query(async ({ ctx, input }) =>
          wire(boardSnapshotSchema, await ctx.handlers["board.snapshot"](input, ctx.call)),
        ),
      roster: workspaceProcedure("board.roster", projectInput, project)
        .output(boardRosterSchema)
        .query(async ({ ctx, input }) =>
          wire(boardRosterSchema, await ctx.handlers["board.roster"](input, ctx.call)),
        ),
      changes: workspaceProcedure(
        "board.changes",
        z.object({ projectId: boardId, lastEventId: z.string().min(1).max(256).optional() }),
        project,
      ).subscription(async function* ({ ctx, input, signal }) {
        if (signal?.aborted) return;
        const queue = new AsyncQueue<BoardFeedEmission>(BOARD_FEED_QUEUE_CAPACITY);
        const failure: { current: { error: unknown } | null } = { current: null };
        const abort = (): void => queue.close();
        signal?.addEventListener("abort", abort, { once: true });
        let unsubscribe: () => void;
        try {
          unsubscribe = await hostAnswer(() =>
            ctx.handlers["board.changes"](
              { projectId: input.projectId, after: input.lastEventId ?? null },
              ctx.call,
              {
                emit: (batch) => queue.push(batch),
                fail: (error) => {
                  failure.current = { error };
                  queue.close(false);
                },
              },
            ),
          );
        } catch (error) {
          signal?.removeEventListener("abort", abort);
          // The cursor is from another feed instance or epoch, or older than
          // the feed retains: the Client re-reads its snapshot.
          if (isFeedResnapshotRequired(error)) throw resnapshotRequired();
          throw error;
        }
        try {
          for await (const batch of queue) yield tracked(batch.cursor, batch);
          if (queue.overflowed) {
            throw new HostProcedureError("subscription-overflow", BOARD_FEED_OVERFLOW_MESSAGE);
          }
          if (failure.current !== null) {
            // The feed ended under the stream (its Workspace's epoch changed,
            // or the Workspace was removed): resnapshot, not a source failure.
            if (isFeedResnapshotRequired(failure.current.error)) throw resnapshotRequired();
            throw new HostProcedureError(
              "subscription-source-failed",
              BOARD_FEED_SOURCE_FAILURE_MESSAGE,
              failure.current.error,
            );
          }
        } finally {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
      }),
      projectFolder: workspaceProcedure("board.projectFolder", projectInput, project)
        .output(
          z.object({ path: z.string(), state: z.enum(["present", "missing", "not-a-directory"]) }),
        )
        .query(({ ctx, input }) => ctx.handlers["board.projectFolder"](input, ctx.call)),
      ticketBody: workspaceProcedure("board.ticketBody", ticketInput, ticket)
        .output(z.object({ body: z.string() }))
        .query(({ ctx, input }) => ctx.handlers["board.ticketBody"](input, ctx.call)),
      archivedTickets: workspaceProcedure("board.archivedTickets", projectInput, project)
        .output(z.array(archivedTicketSchema))
        .query(async ({ ctx, input }) => [
          ...(await ctx.handlers["board.archivedTickets"](input, ctx.call)),
        ]),
      ticketEvents: workspaceProcedure("board.ticketEvents", ticketInput, ticket)
        .output(z.array(ticketEventSchema))
        .query(async ({ ctx, input }) =>
          wire(
            z.array(ticketEventSchema),
            await ctx.handlers["board.ticketEvents"](input, ctx.call),
          ),
        ),
      latestSignals: workspaceProcedure("board.latestSignals", projectInput, project)
        .output(z.array(latestSignalSchema))
        .query(async ({ ctx, input }) => [
          ...(await ctx.handlers["board.latestSignals"](input, ctx.call)),
        ]),
      statusEntries: workspaceProcedure("board.statusEntries", projectInput, project)
        .output(z.array(statusEntrySchema))
        .query(async ({ ctx, input }) => [
          ...(await ctx.handlers["board.statusEntries"](input, ctx.call)),
        ]),
      comments: workspaceProcedure("board.comments", ticketInput, ticket)
        .output(z.array(commentSchema))
        .query(async ({ ctx, input }) => [
          ...(await ctx.handlers["board.comments"](input, ctx.call)),
        ]),

      updateProject: workspaceProcedure(
        "board.updateProject",
        z.object({
          commandId: commandIdSchema,
          projectId: boardId,
          baseBranch: branchName.nullable(),
          setupCommand: z.string().max(4_096).nullable().optional(),
        }),
        project,
      )
        .output(receipted({ project: projectSchema }))
        .mutation(async ({ ctx, input }) =>
          wire(
            receipted({ project: projectSchema }),
            withReceipt(await ctx.handlers["board.updateProject"](input, ctx.call)),
          ),
        ),
      setSkillModes: workspaceProcedure(
        "board.setSkillModes",
        z.object({
          commandId: commandIdSchema,
          projectId: boardId,
          modes: z.record(z.string().min(1).max(256), z.enum(["auto", "manual", "off"])),
        }),
        project,
      )
        .output(receipted({ project: projectSchema }))
        .mutation(async ({ ctx, input }) =>
          wire(
            receipted({ project: projectSchema }),
            withReceipt(await ctx.handlers["board.setSkillModes"](input, ctx.call)),
          ),
        ),
      setSessionDefaults: workspaceProcedure(
        "board.setSessionDefaults",
        z.object({
          commandId: commandIdSchema,
          projectId: boardId,
          model: modelSelectionSchema.nullable(),
        }),
        project,
      )
        .output(receipted({ project: projectSchema }))
        .mutation(async ({ ctx, input }) =>
          wire(
            receipted({ project: projectSchema }),
            withReceipt(await ctx.handlers["board.setSessionDefaults"](input, ctx.call)),
          ),
        ),

      createTicket: workspaceProcedure(
        "board.createTicket",
        z.object({
          commandId: commandIdSchema,
          projectId: boardId,
          status: ticketStatusSchema,
          title: z.string().min(1),
          priority: ticketPrioritySchema.optional(),
          body: z.string().optional(),
          labels: z.array(z.string().min(1).max(256)).max(256).optional(),
          usesWorktree: z.boolean().optional(),
          preferredHarnessId: z.string().regex(HARNESS_SLUG_RE).optional(),
          baseBranch: branchName.nullable().optional(),
        }),
        project,
      )
        .output(receipted({ ticket: ticketSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(
            await ctx.handlers["board.createTicket"](
              { ...input, preferredHarnessId: input.preferredHarnessId as HarnessId | undefined },
              ctx.call,
            ),
          ),
        ),
      moveTickets: workspaceProcedure(
        "board.moveTickets",
        z.object({
          commandId: commandIdSchema,
          projectId: boardId,
          ticketIds: z.array(boardId).min(1).max(1_024),
          toStatus: ticketStatusSchema,
          toIndex: z.number().int().nonnegative(),
          // The Option-drag pick: an armed Automation to start, or a move only.
          choice: z
            .discriminatedUnion("kind", [
              z.object({ kind: z.literal("automation"), automationId: boardId }),
              z.object({ kind: z.literal("move-only") }),
            ])
            .optional(),
        }),
        (input): WorkspaceResource[] => [
          // Every moved ticket is a subject; the board it lands on a reference.
          ...input.ticketIds.map((ticketId) => ticket({ ticketId })),
          { ...project(input), relation: "reference" },
        ],
      )
        .output(receipted({ tickets: z.array(ticketSummarySchema) }))
        .mutation(async ({ ctx, input }) => {
          const { ticketIds, ...rest } = input;
          const answer = withReceipt(
            await ctx.handlers["board.moveTickets"](
              ticketIds.length === 1
                ? { ...rest, ticketId: ticketIds[0]! }
                : { ...rest, ticketIds },
              ctx.call,
            ),
          );
          return {
            receipt: answer.receipt,
            throughCursor: answer.throughCursor,
            tickets: roster(answer.tickets),
          };
        }),
      setPriority: workspaceProcedure(
        "board.setPriority",
        z.object({ commandId: commandIdSchema, ticketId: boardId, priority: ticketPrioritySchema }),
        ticket,
      )
        .output(receipted({ ticket: ticketSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.setPriority"](input, ctx.call)),
        ),
      // No `worktreePath`: a host path is the host's to stamp, never a Client's.
      updateTicket: workspaceProcedure(
        "board.updateTicket",
        z.object({
          commandId: commandIdSchema,
          ticketId: boardId,
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          branch: branchName.nullable().optional(),
          baseBranch: branchName.nullable().optional(),
          usesWorktree: z.boolean().optional(),
        }),
        ticket,
      )
        .output(receipted({ ticket: ticketSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.updateTicket"](input, ctx.call)),
        ),
      setLabels: workspaceProcedure(
        "board.setLabels",
        z.object({
          commandId: commandIdSchema,
          ticketId: boardId,
          labels: z.array(z.string().min(1).max(256)).max(256),
        }),
        ticket,
      )
        .output(receipted({ ticket: ticketSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.setLabels"](input, ctx.call)),
        ),
      archiveTicket: workspaceProcedure(
        "board.archiveTicket",
        z.object({ commandId: commandIdSchema, ticketId: boardId }),
        ticket,
      )
        .output(receipted({}))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.archiveTicket"](input, ctx.call)),
        ),
      unarchiveTicket: workspaceProcedure(
        "board.unarchiveTicket",
        z.object({ commandId: commandIdSchema, ticketId: boardId }),
        ticket,
      )
        .output(receipted({ ticket: ticketSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.unarchiveTicket"](input, ctx.call)),
        ),
      deleteTicket: workspaceProcedure(
        "board.deleteTicket",
        z.object({ commandId: commandIdSchema, ticketId: boardId }),
        ticket,
      )
        .output(receipted({}))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.deleteTicket"](input, ctx.call)),
        ),
      createComment: workspaceProcedure(
        "board.createComment",
        z.object({
          commandId: commandIdSchema,
          ticketId: boardId,
          body: z.string().min(1),
          sessionId: boardId.nullable().optional(),
        }),
        (input): WorkspaceResource[] => [
          ticket(input),
          // The Session a comment links to is the caller's to name only in
          // its own Workspace; a foreign or absent one is one refusal.
          ...(input.sessionId == null
            ? []
            : [{ kind: SESSION_RESOURCE, id: input.sessionId, relation: "reference" as const }]),
        ],
      )
        .output(receipted({ comment: commentSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.createComment"](input, ctx.call)),
        ),
      updateComment: workspaceProcedure(
        "board.updateComment",
        z.object({ commandId: commandIdSchema, commentId: boardId, body: z.string().min(1) }),
        comment,
      )
        .output(receipted({ comment: commentSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.updateComment"](input, ctx.call)),
        ),
      removeComment: workspaceProcedure(
        "board.removeComment",
        z.object({ commandId: commandIdSchema, commentId: boardId }),
        comment,
      )
        .output(receipted({}))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.removeComment"](input, ctx.call)),
        ),
      setLabelColor: workspaceProcedure(
        "board.setLabelColor",
        z.object({
          commandId: commandIdSchema,
          labelId: boardId,
          color: z.string().min(1).max(64).nullable(),
        }),
        (input): WorkspaceResource => ({ kind: LABEL_RESOURCE, id: input.labelId }),
      )
        .output(receipted({ label: labelSchema }))
        .mutation(async ({ ctx, input }) =>
          withReceipt(await ctx.handlers["board.setLabelColor"](input, ctx.call)),
        ),
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
  return procedureSchemas(router, { "board.changes": boardChangeBatchSchema });
}
