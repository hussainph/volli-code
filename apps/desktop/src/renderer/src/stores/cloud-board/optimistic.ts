/**
 * The cloud board's optimistic updates (VC-889): each write's paint before
 * the backend answers, computed by the same shared rules the backend runs
 * (`@volli/shared/cloud`'s `decide…`), over the rows in the window's Convex
 * client — its pending updates included, so two quick moves compose in order.
 *
 * Convex runs an update when its mutation is issued, again whenever the
 * results under it change (a teammate's move lands, and ours is replayed over
 * it), and drops it when the mutation completes: the confirmed rows replace
 * it, with no visible change when nothing raced it (the parity suite,
 * `convex/test/board-optimistic.parity.test.ts`). A rejected mutation rolls
 * its update back on its own.
 *
 * Every update here is a no-op when the query it would patch is not loaded,
 * or when the rules refuse the write (the backend refuses it with the same
 * code, and the source says so). None mutates a row it was given. Ids are
 * the client's own (minted for the command); ticket numbers and new label
 * ids are the backend's: an optimistic ticket has number `0` (no key shown),
 * an optimistic label a `pending:` id that is never sent.
 */
import {
  applyTicketChanges,
  boardLabelFromRow,
  boardTicketFromRow,
  columnEnd,
  decideCreateTicket,
  decideUnarchiveTicket,
  decideUpdateTicket,
  newId,
  normalizeLabelColor,
  predictMove,
  type BoardLabel,
  type BoardLabelRow,
  type BoardTicketRow,
  type CreateTicketCommand,
  type LabelId,
  type MoveTicketsCommand,
  type ProjectId,
  type UpdateTicketCommand,
} from "@volli/shared/cloud";

/** The slice of Convex's optimistic local store an update reads and writes. */
export interface LocalStore {
  getQuery(query: never, args: Record<string, unknown>): unknown;
  setQuery(query: never, args: Record<string, unknown>, value: unknown): void;
}

/** The board queries an update patches (`api.board`'s references). */
export interface BoardQueries {
  readonly roster: unknown;
  readonly getTicket: unknown;
  readonly comments: unknown;
}

type TicketRow = BoardTicketRow & Record<string, unknown>;
type LabelRow = BoardLabelRow & Record<string, unknown>;

interface Roster {
  readonly tickets: readonly TicketRow[];
  readonly labels: readonly LabelRow[];
}

interface TicketRead {
  readonly ticket: TicketRow;
  readonly body: string;
  readonly bodyRevision: number;
}

interface CommentRow extends Record<string, unknown> {
  readonly id: string;
}

const get = <T>(store: LocalStore, query: unknown, args: Record<string, unknown>) =>
  store.getQuery(query as never, args) as T | undefined;

const put = (store: LocalStore, query: unknown, args: Record<string, unknown>, value: unknown) =>
  store.setQuery(query as never, args, value);

/** Runs a rule; a refusal paints nothing (the backend will refuse it too). */
function decided<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

/** The label rows a decision created, as the roster holds labels until the backend names them. */
function pendingLabels(created: readonly BoardLabel[], now: number): LabelRow[] {
  return created.map((label) => ({
    ...label,
    mergedAt: null,
    mergedBy: null,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * A `pending:` label id: never sent, replaced by the backend's own. Unique
 * across writes, so two pending writes' new labels never share one.
 */
function pendingLabelMinter(): () => LabelId {
  return () => `pending:${newId("label")}` as LabelId;
}

/** One deliberate move: §6.2's update, over the roster as it stands now. */
export function optimisticMove(
  store: LocalStore,
  queries: BoardQueries,
  input: { readonly projectId: string; readonly command: MoveTicketsCommand; readonly now: number },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  if (roster === undefined) return;
  const facts = roster.tickets.map(boardTicketFromRow);
  const decision = decided(() => predictMove(facts, input.command, input.now));
  if (decision === null || decision.changes.length === 0) return;
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      ...roster,
      tickets: applyTicketChanges(roster.tickets, decision.changes),
    },
  );
}

/** A new ticket at its column's end, with no key yet, and its body ready to open. */
export function optimisticCreate(
  store: LocalStore,
  queries: BoardQueries,
  input: {
    readonly projectId: string;
    readonly command: CreateTicketCommand;
    readonly createdBy: unknown;
    readonly now: number;
  },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  if (roster === undefined) return;
  const decision = decided(() =>
    decideCreateTicket(
      {
        projectId: input.projectId as ProjectId,
        number: 0,
        columnEnd: columnEnd(roster.tickets, input.command.status),
        labels: roster.labels.map(boardLabelFromRow),
        mintLabelId: pendingLabelMinter(),
      },
      input.command,
    ),
  );
  if (decision === null) return;
  const row: TicketRow = {
    ...decision.ticket,
    pullRequests: [],
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
    purgeAfter: null,
  };
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      tickets: [...roster.tickets, row],
      labels: [...roster.labels, ...pendingLabels(decision.createdLabels, input.now)],
    },
  );
  put(store, queries.getTicket, { ticketId: decision.ticket.id }, {
    ticket: row,
    body: decision.body,
    bodyRevision: 0,
  } satisfies TicketRead);
}

/** One update of a ticket's fields, priority, labels or body. */
export function optimisticUpdate(
  store: LocalStore,
  queries: BoardQueries,
  input: {
    readonly projectId: string;
    readonly ticketId: string;
    readonly command: UpdateTicketCommand;
    readonly now: number;
  },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  const row = roster?.tickets.find((ticket) => ticket.id === input.ticketId);
  if (roster === undefined || row === undefined) return;
  const read = get<TicketRead>(store, queries.getTicket, { ticketId: input.ticketId });
  const decision = decided(() =>
    decideUpdateTicket(
      {
        ticket: boardTicketFromRow(row),
        body: read?.body ?? "",
        labels: roster.labels.map(boardLabelFromRow),
        // The backend knows; a locked checkout mode is refused and rolled back.
        hasWorktree: false,
        mintLabelId: pendingLabelMinter(),
      },
      input.command,
    ),
  );
  if (decision === null) return;
  const changed =
    Object.keys(decision.patch).length > 0 ||
    decision.body !== null ||
    decision.createdLabels.length > 0;
  if (!changed) return;
  const patched = { ...row, ...decision.patch, updatedAt: input.now };
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      tickets: roster.tickets.map((ticket) => (ticket.id === input.ticketId ? patched : ticket)),
      labels: [...roster.labels, ...pendingLabels(decision.createdLabels, input.now)],
    },
  );
  if (read !== undefined) {
    put(
      store,
      queries.getTicket,
      { ticketId: input.ticketId },
      {
        ...read,
        ticket: patched,
        body: decision.body ?? read.body,
      },
    );
  }
}

/** An archive: the card leaves the board at once. */
export function optimisticArchive(
  store: LocalStore,
  queries: BoardQueries,
  input: { readonly projectId: string; readonly ticketId: string },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  if (roster === undefined) return;
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      ...roster,
      tickets: roster.tickets.filter((ticket) => ticket.id !== input.ticketId),
    },
  );
}

/** An unarchive: the card returns to its retained column's end, when its row is at hand. */
export function optimisticUnarchive(
  store: LocalStore,
  queries: BoardQueries,
  input: { readonly projectId: string; readonly ticketId: string; readonly now: number },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  const read = get<TicketRead>(store, queries.getTicket, { ticketId: input.ticketId });
  if (roster === undefined || read === undefined) return;
  if (roster.tickets.some((ticket) => ticket.id === input.ticketId)) return;
  const ticket = boardTicketFromRow(read.ticket);
  const decision = decideUnarchiveTicket(ticket, columnEnd(roster.tickets, ticket.status));
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      ...roster,
      tickets: [...roster.tickets, { ...read.ticket, ...decision.patch, updatedAt: input.now }],
    },
  );
}

/** A label's color, as the backend will store it. */
export function optimisticLabelColor(
  store: LocalStore,
  queries: BoardQueries,
  input: { readonly projectId: string; readonly labelId: string; readonly color: string | null },
): void {
  const roster = get<Roster>(store, queries.roster, { projectId: input.projectId });
  const color = decided(() => normalizeLabelColor(input.color));
  if (roster === undefined || (color === null && input.color !== null)) return;
  const label = roster.labels.find(({ id }) => id === input.labelId);
  if (label === undefined) return;
  const recolored = { ...label, color };
  put(
    store,
    queries.roster,
    { projectId: input.projectId },
    {
      ...roster,
      labels: roster.labels.map((existing) => (existing === label ? recolored : existing)),
    },
  );
}

/** A comment on the open ticket: added, edited or removed in its loaded list. */
export function optimisticComment(
  store: LocalStore,
  queries: BoardQueries,
  input:
    | { readonly kind: "create"; readonly ticketId: string; readonly comment: CommentRow }
    | {
        readonly kind: "update";
        readonly ticketId: string;
        readonly commentId: string;
        readonly body: string;
        readonly now: number;
      }
    | { readonly kind: "remove"; readonly ticketId: string; readonly commentId: string },
): void {
  const comments = get<readonly CommentRow[]>(store, queries.comments, {
    ticketId: input.ticketId,
  });
  if (comments === undefined) return;
  const next =
    input.kind === "create"
      ? [...comments, input.comment]
      : input.kind === "update"
        ? comments.map((comment) =>
            comment.id === input.commentId
              ? { ...comment, body: input.body, editedAt: input.now }
              : comment,
          )
        : comments.filter((comment) => comment.id !== input.commentId);
  put(store, queries.comments, { ticketId: input.ticketId }, next);
}
