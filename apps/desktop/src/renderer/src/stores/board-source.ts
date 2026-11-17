/**
 * Where one project's board reads and writes go (VC-889, VC-1260): the one
 * interface the board store and the per-surface door (`lib/board-api.ts`)
 * use, and the functions that pick its adapter.
 *
 * - **A cloud launch:** every project's board is Volli Cloud's
 *   ({@link ConvexBoardSource}, `cloud-board/source.ts`).
 * - **A local launch:** a project a remote host serves (VC-711, flag on,
 *   until that host model is retired) goes through the board protocol's sync
 *   engine (`board-sync.ts`, wrapped in `lib/board-protocol.ts`); every other
 *   project is this Mac's, over its own IPC (`local-board-source.ts`), with
 *   the `cloud` flag on as with it off.
 *
 * The row half ({@link BoardRowSource}) is the board sync engine's own public
 * surface, so the sync engine and Volli Cloud's source satisfy it unchanged;
 * {@link composeBoardSource} adds the rest for them.
 */
import type {
  ArchivedTicket,
  DeliberateMoveChoice,
  Ticket,
  TicketPriority,
  TicketStatus,
} from "@volli/shared";

import type { BoardApi } from "@renderer/lib/board-api";
import { boardProtocol } from "@renderer/lib/board-protocol";
import { cloudBoardApi } from "@renderer/lib/cloud-board-api";

import type { BoardSync } from "./board-sync";
import type { ConvexBoardSource } from "./cloud-board/source";
import { launchStore } from "./launch";
import { LocalBoardSource } from "./local-board-source";
import { projectPlaceNow } from "./project-place";

/** A ticket's create fields, as `addTicket` hands them over. */
export type CreateFields = Parameters<BoardSync["createTicket"]>[1];

/** A ticket's update fields (never a runner's path). */
export type UpdateFields = Parameters<BoardSync["updateTicket"]>[1];

/** A board's rows: what the sync engine and Volli Cloud's source each implement. */
export interface BoardRowSource {
  /** Whether the source follows the project's board now. */
  follows(projectId: string): boolean;
  /** The followed project whose board holds this ticket. */
  projectOf(ticketId: string): string | undefined;
  open(projectId: string): Promise<void>;
  close(projectId: string): void;
  closeAll(): void;
  /** Records a body read on its own (the open ticket), so repaints keep it. */
  adoptBody(ticketId: string, body: string): void;
  createTicket(projectId: string, fields: CreateFields): Promise<Ticket | null>;
  moveTickets(
    projectId: string,
    ticketIds: string[],
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void>;
  setPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void>;
  updateTicket(projectId: string, input: UpdateFields): Promise<Ticket | null>;
  setLabels(projectId: string, ticketId: string, labels: string[]): Promise<void>;
  setLabelColor(projectId: string, labelId: string, color: string | null): Promise<void>;
  archiveTicket(projectId: string, ticketId: string): Promise<boolean>;
  unarchiveTicket(projectId: string, archived: ArchivedTicket): Promise<Ticket | null>;
  deleteTicket(projectId: string, ticketId: string): Promise<boolean>;
  archivedTickets(projectId: string): Promise<ArchivedTicket[] | null>;
}

/** Where one project's board goes: its rows, its moves, and its per-surface door. */
export interface BoardSource extends BoardRowSource {
  /**
   * Whether the source delivers the project's rows itself (painting the
   * store), rather than the store hydrating them from this Mac's boot data:
   * a wholesale hydrate keeps such a project's slice as its source painted it.
   */
  readonly deliversOwnRows: boolean;
  /** The board surfaces' reads and writes (comments, history, bodies, settings) for its projects. */
  readonly api: BoardApi;
  /** One card's move (a one-card group is {@link BoardRowSource.moveTickets}). */
  moveTicket(
    projectId: string,
    ticketId: string,
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void>;
}

/**
 * A {@link BoardSource} over `rows`, each row call delegated as it is made
 * (so the row source's own methods, as they are now, answer it).
 */
function composeBoardSource(
  rows: BoardRowSource,
  rest: Pick<BoardSource, "deliversOwnRows" | "api" | "moveTicket">,
): BoardSource {
  return {
    deliversOwnRows: rest.deliversOwnRows,
    api: rest.api,
    moveTicket: rest.moveTicket,
    follows: (projectId) => rows.follows(projectId),
    projectOf: (ticketId) => rows.projectOf(ticketId),
    open: (projectId) => rows.open(projectId),
    close: (projectId) => rows.close(projectId),
    closeAll: () => rows.closeAll(),
    adoptBody: (ticketId, body) => rows.adoptBody(ticketId, body),
    createTicket: (projectId, fields) => rows.createTicket(projectId, fields),
    moveTickets: (projectId, ticketIds, toStatus, toIndex, choice) =>
      rows.moveTickets(projectId, ticketIds, toStatus, toIndex, choice),
    setPriority: (projectId, ticketId, priority) => rows.setPriority(projectId, ticketId, priority),
    updateTicket: (projectId, input) => rows.updateTicket(projectId, input),
    setLabels: (projectId, ticketId, labels) => rows.setLabels(projectId, ticketId, labels),
    setLabelColor: (projectId, labelId, color) => rows.setLabelColor(projectId, labelId, color),
    archiveTicket: (projectId, ticketId) => rows.archiveTicket(projectId, ticketId),
    unarchiveTicket: (projectId, archived) => rows.unarchiveTicket(projectId, archived),
    deleteTicket: (projectId, ticketId) => rows.deleteTicket(projectId, ticketId),
    archivedTickets: (projectId) => rows.archivedTickets(projectId),
  };
}

/**
 * A source that delivers its own rows (the sync engine, Volli Cloud's),
 * with `api` as its door: one card's move is a one-card group.
 */
export function deliveringBoardSource(rows: BoardRowSource, api: BoardApi): BoardSource {
  return composeBoardSource(rows, {
    deliversOwnRows: true,
    api,
    moveTicket: (projectId, ticketId, toStatus, toIndex, choice) =>
      rows.moveTickets(projectId, [ticketId], toStatus, toIndex, choice),
  });
}

let localSource: BoardSource | null = null;

/** The board store's one call (`stores/board.ts`): this Mac's board, over its own IPC. */
export function installLocalBoardSource(source: BoardSource): void {
  localSource = source;
  awaitingCloud = null;
}

const storeNotLoaded = (): never => {
  throw new Error("The board store has not loaded");
};

/**
 * This Mac's board. Until the board store installs its own, its door still
 * answers (it needs no store), and a write fails loudly.
 */
function local(): BoardSource {
  localSource ??= new LocalBoardSource({
    tickets: storeNotLoaded,
    setTickets: storeNotLoaded,
    reconcileTickets: storeNotLoaded,
    labels: storeNotLoaded,
    reconcileLabels: storeNotLoaded,
    findTicket: storeNotLoaded,
    markBodyLoaded: storeNotLoaded,
  });
  return localSource;
}

let cloudSource: ConvexBoardSource | null = null;
let cloudBoard: BoardSource | null = null;
let awaitingCloud: BoardSource | null = null;

/** Boot's one call in a cloud launch: the source every project's board goes through. */
export function installCloudBoardSource(source: ConvexBoardSource | null): void {
  cloudSource = source;
  cloudBoard = source === null ? null : deliveringBoardSource(source, cloudBoardApi());
}

/** The cloud launch's board source, once boot installed it; `null` otherwise. */
export function cloudBoardSource(): ConvexBoardSource | null {
  return cloudSource;
}

/**
 * A cloud launch's board before boot installs its source: the store's writes
 * stay this Mac's, as they always were in that window, while every board
 * surface's read or write already goes to Volli Cloud's door.
 */
function cloudBoardNow(): BoardSource {
  if (cloudBoard !== null) return cloudBoard;
  if (awaitingCloud === null) {
    const rows = local();
    awaitingCloud = composeBoardSource(rows, {
      deliversOwnRows: rows.deliversOwnRows,
      api: cloudBoardApi(),
      moveTicket: (projectId, ticketId, toStatus, toIndex, choice) =>
        rows.moveTicket(projectId, ticketId, toStatus, toIndex, choice),
    });
  }
  return awaitingCloud;
}

/**
 * The source a project's board goes through: Volli Cloud's for every project
 * of a cloud launch; in a local launch, the board protocol's for a remote
 * host's project, and this Mac's for every other one.
 */
export function boardSourceFor(projectId: string | null | undefined): BoardSource {
  if (launchStore() === "cloud") return cloudBoardNow();
  const protocol = boardProtocol();
  if (protocol === null || projectId === null || projectId === undefined) return local();
  // A board the engine still follows stays its own until it is closed, even
  // once its host's claim has gone.
  return protocol.sync.follows(projectId) || projectPlaceNow(projectId) === "remote-host"
    ? protocol.source
    : local();
}

/** The source of the board that holds `ticketId`: a followed remote board's, or as {@link boardSourceFor}. */
export function boardSourceForTicket(ticketId: string): BoardSource {
  if (launchStore() === "cloud") return cloudBoardNow();
  const protocol = boardProtocol();
  return protocol !== null && protocol.sync.projectOf(ticketId) !== undefined
    ? protocol.source
    : local();
}

/** The source of the board whose ticket holds `commentId`, as far as this window has seen it. */
export function boardSourceForComment(commentId: string): BoardSource {
  if (launchStore() === "cloud") return cloudBoardNow();
  const protocol = boardProtocol();
  if (protocol === null) return local();
  const ticketId = protocol.commentTickets.get(commentId);
  return ticketId !== undefined && protocol.sync.projectOf(ticketId) !== undefined
    ? protocol.source
    : local();
}
