/**
 * The board's rules in Volli Cloud as pure decisions.
 *
 * Each `decide…` function takes the facts a board command needs and the
 * command itself, and answers what changes, which board events record it,
 * and which side effects a machine must carry out. It reads nothing and
 * writes nothing: the backend mutation loads the facts, calls it, and applies
 * the answer in one transaction (allocating event sequence numbers, writing
 * the receipt and turning side effects into runner jobs). A client may run
 * the same function for an optimistic update; the backend's answer replaces
 * it.
 *
 * The rules are the local board's, carried over from the ticket commands and
 * the shared board operations, with the cloud's state shape:
 * - a column position is a fractional key, so a move names its neighbours and
 *   writes only the tickets it moves ({@link decideMoveTickets});
 * - labels are ids on the ticket, resolved from names ignoring ASCII case,
 *   following a merged label to the one it was merged into;
 * - the checked-out state of a ticket (paths, heads) is not here: a Working
 *   copy belongs to a runner, and the board only asks for one to be made or
 *   trimmed ({@link BoardSideEffect}).
 *
 * A refusal is a {@link BoardRuleError} with a stable `code`.
 */

import { applyTicketBodyMutation, type TicketBodyMutation } from "../agent-surface";
import { ARMED_RUN_DELAY_MS, type DeliberateMoveChoice } from "../armed-arrival";
import { labelNameKey } from "../label";
import {
  DEFAULT_HARNESS_ID,
  leavesActiveColumns,
  parseHarnessId,
  TICKET_STATUSES,
  type HarnessId,
  type TicketPriority,
  type TicketStatus,
} from "../ticket";
import { isValidBranchName } from "../ticket-branch";
import type { TicketSignalKind, TicketSignalVerdict } from "../ticket-events";
import { actorUserId, type Actor } from "./actor";
import type { BoardEventPayload, CheckoutMode } from "./board-events";
import type {
  CommentId,
  LabelId,
  ProjectId,
  RunnerId,
  SessionId,
  SignalId,
  TicketId,
  UserId,
} from "./ids";
import {
  comparePositions,
  InvalidPositionError,
  positionBetween,
  positionsBetween,
  type PositionKey,
} from "./positions";

// ── errors and limits ────────────────────────────────────────────────────────

export type BoardRuleCode =
  | "invalid_argument"
  | "archived"
  | "wrong_project"
  | "invalid_position"
  | "body_match_failed"
  | "checkout_mode_locked"
  | "prefix_taken"
  | "forbidden";

/** A board command the rules refuse. `code` is stable; `message` is for a person. */
export class BoardRuleError extends Error {
  readonly code: BoardRuleCode;
  constructor(code: BoardRuleCode, message: string) {
    super(message);
    this.name = "BoardRuleError";
    this.code = code;
  }
}

/** Sized to keep every board document well inside the backend's per-document budget. */
export const BOARD_LIMITS = {
  titleLength: 1_000,
  bodyBytes: 200 * 1024,
  commentBytes: 64 * 1024,
  signalDetailBytes: 4 * 1024,
  labelNameLength: 100,
  labelsPerTicket: 50,
  ticketsPerMove: 100,
} as const;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function invalid(message: string): BoardRuleError {
  return new BoardRuleError("invalid_argument", message);
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw invalid("A ticket needs a title.");
  if (trimmed.length > BOARD_LIMITS.titleLength) {
    throw invalid(`A ticket title is at most ${BOARD_LIMITS.titleLength} characters.`);
  }
  return trimmed;
}

function requireBody(body: string): string {
  if (utf8Length(body) > BOARD_LIMITS.bodyBytes) {
    throw invalid(`A ticket body is at most ${BOARD_LIMITS.bodyBytes} bytes.`);
  }
  return body;
}

function requireHarness(value: string): HarnessId {
  const harness = parseHarnessId(value);
  if (harness === null) throw invalid(`Unknown harness ${JSON.stringify(value)}.`);
  return harness;
}

function requireBranch(value: string | null, what: string): string | null {
  if (value !== null && !isValidBranchName(value)) throw invalid(`Invalid ${what} name.`);
  return value;
}

function requireLive(ticket: BoardTicket, action: string): void {
  if (ticket.archivedAt !== null) {
    throw new BoardRuleError("archived", `Cannot ${action} an archived ticket.`);
  }
}

// ── state ────────────────────────────────────────────────────────────────────

/** The ticket facts the rules read: a board card's roster row, minus attribution and times. */
export interface BoardTicket {
  id: TicketId;
  projectId: ProjectId;
  number: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  position: PositionKey;
  labelIds: LabelId[];
  assigneeUserId: UserId | null;
  checkoutMode: CheckoutMode;
  preferredHarnessId: string;
  branch: string | null;
  baseBranch: string | null;
  retentionKeep: boolean;
  placeRunnerId: RunnerId | null;
  archivedAt: number | null;
}

/** A project label. A merged label stays as an alias of the one it was merged into. */
export interface BoardLabel {
  id: LabelId;
  projectId: ProjectId;
  name: string;
  nameKey: string;
  color: string | null;
  mergedIntoId: LabelId | null;
}

/** The fields of a ticket a decision may change. */
export type TicketPatch = Partial<
  Pick<
    BoardTicket,
    | "title"
    | "status"
    | "priority"
    | "position"
    | "labelIds"
    | "checkoutMode"
    | "preferredHarnessId"
    | "archivedAt"
  >
>;

/** One board event to append; the backend adds its id, sequence, actor and time. */
export interface BoardEventDraft {
  ticketId: TicketId | null;
  payload: BoardEventPayload;
}

/**
 * Work a machine does because of a board write. The backend turns each into
 * runner jobs for the runners that hold the ticket's Working copies or
 * Sessions; nothing here runs in the backend.
 */
export type BoardSideEffect =
  /** Remove ignored content from the ticket's worktrees (a Done move or an archive). */
  | { kind: "trim_working_copies"; ticketId: TicketId; reason: "done" | "archived" }
  /** Interrupt the ticket's running agents: it left the active columns. */
  | { kind: "interrupt_sessions"; ticketId: TicketId; from: TicketStatus; to: TicketStatus }
  /**
   * The ticket arrived in a column: an armed column (or a person's pick)
   * starts an Automation run, not before `notBefore`.
   */
  | {
      kind: "column_arrival";
      ticketId: TicketId;
      from: TicketStatus;
      to: TicketStatus;
      choice: DeliberateMoveChoice | null;
      notBefore: number;
    }
  /** Make the ticket's worktree on its Place: it was just switched to worktree checkout. */
  | { kind: "materialize_working_copy"; ticketId: TicketId };

// ── labels ───────────────────────────────────────────────────────────────────

/** A label name as stored: trimmed, non-empty, bounded. */
function normalizeLabelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw invalid("A label needs a name.");
  if (trimmed.length > BOARD_LIMITS.labelNameLength) {
    throw invalid(`A label name is at most ${BOARD_LIMITS.labelNameLength} characters.`);
  }
  return trimmed;
}

/** The live label a stored one stands for: itself, or the end of its merge chain. */
function canonicalLabel<
  Label extends { readonly id: string; readonly mergedIntoId: string | null },
>(labels: ReadonlyMap<string, Label>, label: Label): Label {
  let current = label;
  const seen = new Set<string>([current.id]);
  while (current.mergedIntoId !== null) {
    const next = labels.get(current.mergedIntoId);
    if (next === undefined || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/**
 * The names a ticket's stored label ids are worn under now: each followed to
 * the live label it was merged into, unknown ids dropped, each label once, in
 * stored order. What a client shows on a card (VC-889).
 */
export function labelNamesOf(
  labelIds: readonly string[],
  labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly mergedIntoId: string | null;
  }[],
): string[] {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of labelIds) {
    const label = byId.get(id);
    if (label === undefined) continue;
    const live = canonicalLabel(byId, label);
    if (seen.has(live.id)) continue;
    seen.add(live.id);
    names.push(live.name);
  }
  return names;
}

/** A project's labels by name key: a live label wins its key over an alias that happens to share it. */
function labelsByKey(labels: ReadonlyArray<BoardLabel>): Map<string, BoardLabel> {
  const byKey = new Map<string, BoardLabel>();
  for (const label of labels) {
    const existing = byKey.get(label.nameKey);
    if (existing === undefined || (existing.mergedIntoId !== null && label.mergedIntoId === null))
      byKey.set(label.nameKey, label);
  }
  return byKey;
}

/** Resolves label names against a project's labels, minting the ones that do not exist. */
class LabelResolver {
  private readonly byId = new Map<LabelId, BoardLabel>();
  private readonly byKey: Map<string, BoardLabel>;
  /** Labels minted while resolving, in mint order. */
  readonly created: BoardLabel[] = [];

  private readonly projectId: ProjectId;
  private readonly mintLabelId: () => LabelId;

  constructor(projectId: ProjectId, labels: ReadonlyArray<BoardLabel>, mintLabelId: () => LabelId) {
    this.projectId = projectId;
    this.mintLabelId = mintLabelId;
    for (const label of labels) this.byId.set(label.id, label);
    this.byKey = labelsByKey(labels);
  }

  /** The label a stored id names, as it is worn now (a merged label resolves to its target). */
  label(id: LabelId): BoardLabel | null {
    const label = this.byId.get(id);
    return label === undefined ? null : canonicalLabel(this.byId, label);
  }

  /** The existing label a name means (matched ignoring ASCII case, merges followed), or `null`. */
  find(name: string): BoardLabel | null {
    const existing = this.byKey.get(labelNameKey(normalizeLabelName(name)));
    return existing === undefined ? null : canonicalLabel(this.byId, existing);
  }

  /** The label a name means: an existing one, or a new one. */
  resolve(name: string): BoardLabel {
    const existing = this.find(name);
    if (existing !== null) return existing;
    const normalized = normalizeLabelName(name);
    const key = labelNameKey(normalized);
    const created: BoardLabel = {
      id: this.mintLabelId(),
      projectId: this.projectId,
      name: normalized,
      nameKey: key,
      color: null,
      mergedIntoId: null,
    };
    this.byId.set(created.id, created);
    this.byKey.set(key, created);
    this.created.push(created);
    return created;
  }

  /** Names to label ids, deduplicated by identity in first-named order. */
  resolveAll(names: readonly string[]): LabelId[] {
    const ids: LabelId[] = [];
    for (const name of names) {
      const { id } = this.resolve(name);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** The name a known id is worn under now (every id the rules name is one the resolver holds). */
  name(id: LabelId): string {
    return this.label(id)!.name;
  }
}

function requireLabelCount(ids: readonly LabelId[]): void {
  if (ids.length > BOARD_LIMITS.labelsPerTicket) {
    throw invalid(`A ticket wears at most ${BOARD_LIMITS.labelsPerTicket} labels.`);
  }
}

function labelsChanged(
  resolver: LabelResolver,
  ticketId: TicketId,
  before: readonly LabelId[],
  after: readonly LabelId[],
): BoardEventDraft | null {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (added.length === 0 && removed.length === 0) return null;
  return {
    ticketId,
    payload: {
      kind: "labels_changed",
      added: added.map((id) => resolver.name(id)),
      removed: removed.map((id) => resolver.name(id)),
    },
  };
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateTicketCommand {
  ticketId: TicketId;
  status: TicketStatus;
  title: string;
  priority?: TicketPriority;
  body?: string;
  /** Label names; an unknown name creates the label. */
  labels?: readonly string[];
  checkoutMode?: CheckoutMode;
  preferredHarnessId?: string;
  baseBranch?: string | null;
}

export interface CreateTicketState {
  projectId: ProjectId;
  /** The number allocated from the project's counter. */
  number: number;
  /** The last position in the destination column, or `null` when it is empty. */
  columnEnd: PositionKey | null;
  labels: readonly BoardLabel[];
  mintLabelId: () => LabelId;
}

export interface CreateTicketDecision {
  ticket: BoardTicket;
  body: string;
  createdLabels: BoardLabel[];
  events: BoardEventDraft[];
}

/** A new ticket at the end of its column, with its body and any labels it named. */
export function decideCreateTicket(
  state: CreateTicketState,
  command: CreateTicketCommand,
): CreateTicketDecision {
  const title = requireTitle(command.title);
  const body = requireBody(command.body ?? "");
  const resolver = new LabelResolver(state.projectId, state.labels, state.mintLabelId);
  const labelIds = resolver.resolveAll(command.labels ?? []);
  requireLabelCount(labelIds);
  const ticket: BoardTicket = {
    id: command.ticketId,
    projectId: state.projectId,
    number: state.number,
    title,
    status: command.status,
    priority: command.priority ?? "medium",
    position: positionBetween(state.columnEnd, null),
    labelIds,
    assigneeUserId: null,
    checkoutMode: command.checkoutMode ?? "worktree",
    preferredHarnessId: requireHarness(command.preferredHarnessId ?? DEFAULT_HARNESS_ID),
    branch: null,
    baseBranch: requireBranch(command.baseBranch ?? null, "base branch"),
    retentionKeep: false,
    placeRunnerId: null,
    archivedAt: null,
  };
  const events: BoardEventDraft[] = [
    { ticketId: ticket.id, payload: { kind: "created", status: ticket.status, title } },
  ];
  const labelEvent = labelsChanged(resolver, ticket.id, [], labelIds);
  if (labelEvent !== null) events.push(labelEvent);
  return { ticket, body, createdLabels: resolver.created, events };
}

// ── update ───────────────────────────────────────────────────────────────────

export interface UpdateTicketCommand {
  title?: string;
  /** The whole new body; never with {@link bodyMutation}. */
  body?: string;
  /** An edit applied to the body as it stands inside the write. */
  bodyMutation?: TicketBodyMutation;
  priority?: TicketPriority;
  preferredHarnessId?: string;
  checkoutMode?: CheckoutMode;
  /** The whole label set, by name; never with {@link addLabels} / {@link removeLabels}. */
  labels?: readonly string[];
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
}

export interface UpdateTicketState {
  ticket: BoardTicket;
  body: string;
  labels: readonly BoardLabel[];
  /** Whether a worktree exists (or is being made) for the ticket on any runner. */
  hasWorktree: boolean;
  mintLabelId: () => LabelId;
}

export interface UpdateTicketDecision {
  patch: TicketPatch;
  /** The new body, or `null` when it did not change. */
  body: string | null;
  createdLabels: BoardLabel[];
  events: BoardEventDraft[];
  sideEffects: BoardSideEffect[];
}

/**
 * One update of a live ticket's fields, priority, body and labels: its events
 * in the local order (fields, then priority, then labels), all or nothing.
 * An unchanged field changes nothing and records nothing.
 */
export function decideUpdateTicket(
  state: UpdateTicketState,
  command: UpdateTicketCommand,
): UpdateTicketDecision {
  const { ticket } = state;
  requireLive(ticket, "update");
  if (command.body !== undefined && command.bodyMutation !== undefined) {
    throw invalid("A ticket update takes a body or a body mutation, not both.");
  }
  const editsLabels = command.addLabels !== undefined || command.removeLabels !== undefined;
  if (command.labels !== undefined && editsLabels) {
    throw invalid("A ticket update sets the labels or edits them, not both.");
  }
  const patch: TicketPatch = {};
  const events: BoardEventDraft[] = [];
  const sideEffects: BoardSideEffect[] = [];

  if (command.title !== undefined) {
    const title = requireTitle(command.title);
    if (title !== ticket.title) {
      patch.title = title;
      events.push({
        ticketId: ticket.id,
        payload: { kind: "retitled", from: ticket.title, to: title },
      });
    }
  }

  let body: string | null = null;
  const requestedBody =
    command.bodyMutation === undefined
      ? command.body
      : mutatedBody(state.body, command.bodyMutation);
  if (requestedBody !== undefined && requestedBody !== state.body) {
    body = requireBody(requestedBody);
    events.push({ ticketId: ticket.id, payload: { kind: "body_edited" } });
  }

  if (command.preferredHarnessId !== undefined) {
    const harness = requireHarness(command.preferredHarnessId);
    if (harness !== ticket.preferredHarnessId) {
      patch.preferredHarnessId = harness;
      events.push({
        ticketId: ticket.id,
        payload: {
          kind: "harness_changed",
          // Stored as written by this rule, so it parses back.
          from: ticket.preferredHarnessId as HarnessId,
          to: harness,
        },
      });
    }
  }

  if (command.checkoutMode !== undefined && command.checkoutMode !== ticket.checkoutMode) {
    // Settable only until a worktree exists: flipping the mode under one would
    // strand the checkout or silently rebind Sessions to the main checkout.
    if (state.hasWorktree) {
      throw new BoardRuleError(
        "checkout_mode_locked",
        "The ticket's worktree already exists, so its checkout mode can no longer change.",
      );
    }
    patch.checkoutMode = command.checkoutMode;
    events.push({
      ticketId: ticket.id,
      payload: {
        kind: "checkout_mode_changed",
        from: ticket.checkoutMode,
        to: command.checkoutMode,
      },
    });
    if (command.checkoutMode === "worktree") {
      sideEffects.push({ kind: "materialize_working_copy", ticketId: ticket.id });
    }
  }

  if (command.priority !== undefined && command.priority !== ticket.priority) {
    patch.priority = command.priority;
    events.push({
      ticketId: ticket.id,
      payload: { kind: "priority_changed", from: ticket.priority, to: command.priority },
    });
  }

  const resolver = new LabelResolver(ticket.projectId, state.labels, state.mintLabelId);
  if (command.labels !== undefined || editsLabels) {
    const current = currentLabelIds(resolver, ticket.labelIds);
    const next =
      command.labels !== undefined
        ? resolver.resolveAll(command.labels)
        : editedLabelIds(resolver, current, command.addLabels ?? [], command.removeLabels ?? []);
    requireLabelCount(next);
    const labelEvent = labelsChanged(resolver, ticket.id, current, next);
    if (labelEvent !== null) {
      patch.labelIds = next;
      events.push(labelEvent);
    } else if (!sameIds(ticket.labelIds, next)) {
      // Only aliases were rewritten to the labels they were merged into.
      patch.labelIds = next;
    }
  }

  return { patch, body, createdLabels: resolver.created, events, sideEffects };
}

function mutatedBody(current: string, mutation: TicketBodyMutation): string {
  const next = applyTicketBodyMutation(current, mutation);
  if (!next.ok) throw new BoardRuleError("body_match_failed", next.message);
  return next.body;
}

function sameIds(a: readonly LabelId[], b: readonly LabelId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** A ticket's stored label ids as worn now: aliases resolved, duplicates and unknown ids dropped. */
function currentLabelIds(resolver: LabelResolver, stored: readonly LabelId[]): LabelId[] {
  const ids: LabelId[] = [];
  for (const id of stored) {
    const label = resolver.label(id);
    if (label !== null && !ids.includes(label.id)) ids.push(label.id);
  }
  return ids;
}

/**
 * The labels after an edit: removals resolved as names are (ignoring case,
 * following a merge to its target; a name the ticket does not wear, or that
 * names no label, is ignored and never creates one), additions resolved and
 * appended unless already worn, the rest kept in order.
 */
function editedLabelIds(
  resolver: LabelResolver,
  current: readonly LabelId[],
  add: readonly string[],
  remove: readonly string[],
): LabelId[] {
  const removed = new Set(remove.map((name) => resolver.find(name)?.id));
  const kept = current.filter((id) => !removed.has(id));
  for (const id of resolver.resolveAll(add)) {
    if (!kept.includes(id)) kept.push(id);
  }
  return kept;
}

// ── move ─────────────────────────────────────────────────────────────────────

export interface MoveTicketsCommand {
  ticketIds: readonly TicketId[];
  toStatus: TicketStatus;
  /** The ticket the moved group lands after; absent (or null) with no `beforeTicketId` means the column's end. */
  afterTicketId?: TicketId | null;
  /** The ticket the moved group lands before. */
  beforeTicketId?: TicketId | null;
  /** What an Option-drag picker named: a specific Automation, or "just move". */
  choice?: DeliberateMoveChoice | null;
}

export interface MoveTicketsState {
  /** The tickets the command names, in any order. */
  tickets: readonly BoardTicket[];
  /**
   * The resolved gap in the destination column the group lands in: the
   * neighbours the backend read inside the transaction, never one of the moved
   * tickets. `null` is the column's start (`after`) or end (`before`).
   */
  after: BoardTicket | null;
  before: BoardTicket | null;
  now: number;
}

export interface TicketChange {
  ticketId: TicketId;
  patch: TicketPatch;
}

export interface MoveTicketsDecision {
  changes: TicketChange[];
  events: BoardEventDraft[];
  sideEffects: BoardSideEffect[];
}

/** Whether a command names no neighbour: a column-only move. */
function isColumnOnlyMove(command: MoveTicketsCommand): boolean {
  return (command.afterTicketId ?? null) === null && (command.beforeTicketId ?? null) === null;
}

function isMoving(command: MoveTicketsCommand, ticket: BoardTicket): boolean {
  return !isColumnOnlyMove(command) || ticket.status !== command.toStatus;
}

/**
 * The tickets a move actually moves: every named one, except that a
 * column-only move leaves a ticket already in the column where it is. The
 * backend reads the gap around these and no others, so a ticket that stays
 * is a neighbour like any other.
 */
export function movingTicketIds(
  command: MoveTicketsCommand,
  tickets: readonly BoardTicket[],
): TicketId[] {
  return tickets.filter((ticket) => isMoving(command, ticket)).map((ticket) => ticket.id);
}

/**
 * Board order: column left to right, then position, then number. A client
 * orders its board by the same comparison (VC-889).
 */
export function compareBoardOrder(
  a: Pick<BoardTicket, "status" | "position" | "number">,
  b: Pick<BoardTicket, "status" | "position" | "number">,
): number {
  return (
    TICKET_STATUSES.indexOf(a.status) - TICKET_STATUSES.indexOf(b.status) ||
    comparePositions(a.position, b.position) ||
    a.number - b.number
  );
}

function within(
  position: PositionKey,
  after: PositionKey | null,
  before: PositionKey | null,
): boolean {
  return (after === null || after < position) && (before === null || position < before);
}

/**
 * One deliberate move of one or more tickets into a column, between two
 * neighbours. Exactly the moved tickets change: each gets a fresh key in the
 * gap, in board order, so concurrent moves elsewhere in the column cannot
 * collide with it. A ticket that crosses columns records `status_changed` and
 * its consequences (a Done trim, an interrupt when it leaves the active
 * columns, an arrival an armed column reacts to). A reorder records no event.
 *
 * A column-only move (no neighbour named) leaves a ticket already in the
 * column where it is, as the local board does; a move that lands every ticket
 * where it already sits changes nothing.
 */
export function decideMoveTickets(
  state: MoveTicketsState,
  command: MoveTicketsCommand,
): MoveTicketsDecision {
  const ids = [...new Set(command.ticketIds)];
  if (ids.length === 0) throw invalid("A move names at least one ticket.");
  if (ids.length > BOARD_LIMITS.ticketsPerMove) {
    throw invalid(`A move takes at most ${BOARD_LIMITS.ticketsPerMove} tickets.`);
  }
  const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
  const tickets = ids.map((id) => {
    const ticket = byId.get(id);
    if (ticket === undefined) throw invalid("A move names a ticket that does not exist.");
    requireLive(ticket, "move");
    return ticket;
  });
  const projectId = tickets[0]!.projectId;
  if (tickets.some((ticket) => ticket.projectId !== projectId)) {
    throw new BoardRuleError("wrong_project", "A move's tickets belong to one project.");
  }
  const moving = tickets.filter((ticket) => isMoving(command, ticket)).toSorted(compareBoardOrder);
  for (const neighbour of [state.after, state.before]) {
    if (neighbour === null) continue;
    if (
      neighbour.projectId !== projectId ||
      neighbour.status !== command.toStatus ||
      neighbour.archivedAt !== null ||
      moving.some((ticket) => ticket.id === neighbour.id)
    ) {
      throw new BoardRuleError(
        "invalid_position",
        "A move's neighbours are live tickets of the destination column, other than the ones moving.",
      );
    }
  }
  const after = state.after?.position ?? null;
  const before = state.before?.position ?? null;
  if (after !== null && before !== null && comparePositions(after, before) >= 0) {
    throw new BoardRuleError("invalid_position", "A move's neighbours are out of order.");
  }

  const settled = moving.every(
    (ticket) => ticket.status === command.toStatus && within(ticket.position, after, before),
  );
  if (settled) return { changes: [], events: [], sideEffects: [] };

  let keys: PositionKey[];
  try {
    keys = positionsBetween(after, before, moving.length);
  } catch (error) {
    throw new BoardRuleError("invalid_position", (error as InvalidPositionError).message);
  }
  const changes: TicketChange[] = [];
  const events: BoardEventDraft[] = [];
  const sideEffects: BoardSideEffect[] = [];
  moving.forEach((ticket, index) => {
    const patch: TicketPatch = { position: keys[index]! };
    const from = ticket.status;
    const to = command.toStatus;
    if (from !== to) patch.status = to;
    changes.push({ ticketId: ticket.id, patch });
    if (from === to) return;
    events.push({ ticketId: ticket.id, payload: { kind: "status_changed", from, to } });
    if (to === "done")
      sideEffects.push({ kind: "trim_working_copies", ticketId: ticket.id, reason: "done" });
    if (leavesActiveColumns(from, to)) {
      sideEffects.push({ kind: "interrupt_sessions", ticketId: ticket.id, from, to });
    }
    sideEffects.push({
      kind: "column_arrival",
      ticketId: ticket.id,
      from,
      to,
      choice: command.choice ?? null,
      notBefore: state.now + ARMED_RUN_DELAY_MS,
    });
  });
  return { changes, events, sideEffects };
}

// ── archive ──────────────────────────────────────────────────────────────────

export interface ArchiveDecision {
  patch: TicketPatch;
  events: BoardEventDraft[];
  sideEffects: BoardSideEffect[];
}

/**
 * Archives a ticket: off the board, everything kept. Its worktrees are
 * trimmed, because an archived ticket is the longest-lived carrier of a dead
 * dependency tree. Archiving an archived ticket changes nothing.
 */
export function decideArchiveTicket(ticket: BoardTicket, now: number): ArchiveDecision {
  if (ticket.archivedAt !== null) return { patch: {}, events: [], sideEffects: [] };
  return {
    patch: { archivedAt: now },
    events: [{ ticketId: ticket.id, payload: { kind: "archived" } }],
    sideEffects: [{ kind: "trim_working_copies", ticketId: ticket.id, reason: "archived" }],
  };
}

/**
 * Returns an archived ticket to the end of its retained column. Unarchiving a
 * live ticket changes nothing.
 */
export function decideUnarchiveTicket(
  ticket: BoardTicket,
  columnEnd: PositionKey | null,
): ArchiveDecision {
  if (ticket.archivedAt === null) return { patch: {}, events: [], sideEffects: [] };
  return {
    patch: { archivedAt: null, position: positionBetween(columnEnd, null) },
    events: [{ ticketId: ticket.id, payload: { kind: "unarchived" } }],
    sideEffects: [],
  };
}

// ── comments and signals ─────────────────────────────────────────────────────

/** The Session an actor speaks for, if any: only an agent cites one. */
function actorSessionId(actor: Actor): SessionId | null {
  if (actor.kind === "agent") return actor.sessionId;
  if (actor.kind === "automation") return actor.sessionId ?? null;
  return null;
}

function requireCommentBody(body: string): string {
  if (body.trim().length === 0) throw invalid("A comment needs a body.");
  if (utf8Length(body) > BOARD_LIMITS.commentBytes) {
    throw invalid(`A comment is at most ${BOARD_LIMITS.commentBytes} bytes.`);
  }
  return body;
}

export interface CreateCommentDecision {
  comment: {
    id: CommentId;
    ticketId: TicketId;
    projectId: ProjectId;
    sessionId: SessionId | null;
    body: string;
  };
  events: BoardEventDraft[];
}

/** A comment on a live ticket, citing the Session its author speaks for. */
export function decideCreateComment(
  ticket: BoardTicket,
  command: { commentId: CommentId; body: string },
  actor: Actor,
): CreateCommentDecision {
  requireLive(ticket, "comment on");
  return {
    comment: {
      id: command.commentId,
      ticketId: ticket.id,
      projectId: ticket.projectId,
      sessionId: actorSessionId(actor),
      body: requireCommentBody(command.body),
    },
    events: [{ ticketId: ticket.id, payload: { kind: "commented", commentId: command.commentId } }],
  };
}

/** Whether `actor` may edit or remove a comment: its author's person, whoever spoke for them. */
function canEditComment(actor: Actor, comment: { author: Actor }): boolean {
  const author = actorUserId(comment.author);
  return author !== null && author === actorUserId(actor);
}

/**
 * The body an edit leaves. Edits and removals record no board event, as on
 * the local board: the comment row carries `editedAt` / `deletedAt`.
 */
export function decideEditComment(
  comment: { author: Actor; deletedAt: number | null },
  body: string,
  actor: Actor,
): string {
  requireCommentEditable(comment, actor);
  return requireCommentBody(body);
}

export function requireCommentEditable(
  comment: { author: Actor; deletedAt: number | null },
  actor: Actor,
): void {
  if (comment.deletedAt !== null) throw invalid("That comment was removed.");
  if (!canEditComment(actor, comment)) {
    throw new BoardRuleError("forbidden", "Only a comment's author can change it.");
  }
}

export interface CreateSignalCommand {
  signalId: SignalId;
  kind: TicketSignalKind;
  verdict: TicketSignalVerdict;
  detail?: string | null;
}

export interface CreateSignalDecision {
  signal: {
    id: SignalId;
    ticketId: TicketId;
    projectId: ProjectId;
    sessionId: SessionId | null;
    kind: TicketSignalKind;
    verdict: TicketSignalVerdict;
    detail: string | null;
  };
  events: BoardEventDraft[];
}

/**
 * One typed verdict on a live ticket. Append-only and never a board move: a
 * later signal of the same kind supersedes an earlier one by being newer.
 */
export function decideCreateSignal(
  ticket: BoardTicket,
  command: CreateSignalCommand,
  actor: Actor,
): CreateSignalDecision {
  requireLive(ticket, "signal on");
  const trimmed = command.detail?.trim() ?? "";
  const detail = trimmed.length === 0 ? null : trimmed;
  if (detail !== null && utf8Length(detail) > BOARD_LIMITS.signalDetailBytes) {
    throw invalid(`A signal's detail is at most ${BOARD_LIMITS.signalDetailBytes} bytes.`);
  }
  return {
    signal: {
      id: command.signalId,
      ticketId: ticket.id,
      projectId: ticket.projectId,
      sessionId: actorSessionId(actor),
      kind: command.kind,
      verdict: command.verdict,
      detail,
    },
    events: [
      {
        ticketId: ticket.id,
        payload: { kind: "signaled", signalKind: command.kind, verdict: command.verdict, detail },
      },
    ],
  };
}

// ── label colour ───────────────────────────────────────────────────────────────

/** A label's stored colour (1–64 characters, as the local board takes it), or `null` to derive it from the name. */
export function normalizeLabelColor(color: string | null): string | null {
  if (color === null) return null;
  if (color.length === 0 || color.length > 64) throw invalid("A label colour is 1–64 characters.");
  return color;
}

// ── label merge ──────────────────────────────────────────────────────────────

export interface MergeLabelsCommand {
  /** The name to retire. Matched ignoring ASCII case; a retired name follows its merge. */
  from: string;
  /** The name it folds into. */
  into: string;
}

export interface MergeLabelsDecision {
  from: BoardLabel;
  into: BoardLabel;
  /**
   * Every stored label id that is worn as `from` now: `from` itself and the
   * aliases already merged into it. A ticket wearing any of them is one the
   * merge relabels.
   */
  fromIds: LabelId[];
  /** The patch to `from`'s row: it becomes an alias of `into`. */
  patch: { mergedIntoId: LabelId };
  events: BoardEventDraft[];
}

/**
 * Folds one label into another: `from` becomes an alias of `into`, so every
 * ticket that wore `from` wears `into` (each label once), and the retired
 * name keeps resolving to `into`. No ticket row is rewritten: the label ids a
 * ticket stores are followed to the live label they were merged into
 * ({@link labelNamesOf}). One project-level `label_merged` event records it.
 *
 * Refused: a name the project has no label for (the refusal names the ones
 * it has), and two names that are already the same label.
 */
export function decideMergeLabels(
  labels: readonly BoardLabel[],
  command: MergeLabelsCommand,
): MergeLabelsDecision {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const byKey = labelsByKey(labels);
  const vocabulary = () => {
    const names = labels
      .filter((label) => label.mergedIntoId === null)
      .map((label) => label.name)
      .toSorted();
    return names.length > 0 ? `Its labels are: ${names.join(", ")}.` : "It has no labels yet.";
  };
  const find = (name: string) => {
    const found = byKey.get(labelNameKey(normalizeLabelName(name)));
    if (found === undefined) {
      throw invalid(`This project has no label named ${name.trim()}. ${vocabulary()}`);
    }
    return canonicalLabel(byId, found);
  };
  const from = find(command.from);
  const into = find(command.into);
  if (from.id === into.id) {
    throw invalid(`${command.from} and ${command.into} are already the same label.`);
  }
  const fromIds = labels
    .filter((label) => canonicalLabel(byId, label).id === from.id)
    .map((label) => label.id);
  return {
    from,
    into,
    fromIds,
    patch: { mergedIntoId: into.id },
    events: [
      { ticketId: null, payload: { kind: "label_merged", labelId: from.id, intoLabelId: into.id } },
    ],
  };
}
