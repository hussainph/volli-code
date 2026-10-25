/**
 * Where one project's board reads and writes go (VC-889): the shape
 * `board.ts` dispatches to, and the one function that picks it.
 *
 * - **A cloud launch:** every project's board is Volli Cloud's
 *   ({@link ConvexBoardSource}, `cloud-board/source.ts`).
 * - **A local launch:** a project a remote host serves (VC-711, flag on,
 *   until that host model is retired) goes through the board protocol's sync
 *   engine (`board-sync.ts`); every other project answers `null`, and the
 *   board store keeps its legacy write-through to this Mac's database, with
 *   the `cloud` flag on as with it off.
 *
 * The surface is the board sync engine's own public one, so the sync engine
 * satisfies it unchanged.
 */
import type {
  ArchivedTicket,
  DeliberateMoveChoice,
  Ticket,
  TicketPriority,
  TicketStatus,
} from "@volli/shared";

import { boardProtocol } from "@renderer/lib/board-protocol";

import type { BoardSync } from "./board-sync";
import type { ConvexBoardSource } from "./cloud-board/source";
import { launchStore } from "./launch";
import { projectPlaceNow } from "./project-place";

/** A ticket's create fields, as `addTicket` hands them over. */
export type CreateFields = Parameters<BoardSync["createTicket"]>[1];

/** A ticket's update fields (never a runner's path). */
export type UpdateFields = Parameters<BoardSync["updateTicket"]>[1];

export interface BoardSource {
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

let cloudSource: ConvexBoardSource | null = null;

/** Boot's one call in a cloud launch: the source every project's board goes through. */
export function installCloudBoardSource(source: ConvexBoardSource | null): void {
  cloudSource = source;
}

/** The cloud launch's board source, once boot installed it; `null` otherwise. */
export function cloudBoardSource(): ConvexBoardSource | null {
  return cloudSource;
}

/**
 * The source a project's board goes through, or `null` for the legacy
 * write-through: Volli Cloud's for every project of a cloud launch; in a
 * local launch, the board protocol's for a remote host's project.
 */
export function boardSourceFor(projectId: string | null | undefined): BoardSource | null {
  if (launchStore() === "cloud") return cloudSource;
  const sync = boardProtocol()?.sync;
  if (sync === undefined || projectId === null || projectId === undefined) return null;
  // A board the engine still follows stays its own until it is closed, even
  // once its host's claim has gone.
  return sync.follows(projectId) || projectPlaceNow(projectId) === "remote-host" ? sync : null;
}
