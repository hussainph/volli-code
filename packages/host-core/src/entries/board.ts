/**
 * `@volli/host-core/board`: Projects and Tickets: create, relink, roots, base branch, ticket commands, moves and wakes.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  BOARD_FEED_RETENTION,
  BoardChangeFeed,
  createBoardChangeFeed,
  type BoardChangeFeedOptions,
  type BoardFeedBatch,
  type BoardFeedListener,
} from "../board/change-feed";
export {
  ticketSummary,
  type BoardHandlerSignatures,
  type BoardRoster,
  type BoardSnapshot,
  type BoardWriteResult,
} from "../board/commands";
export { BOARD_RECEIPT_RETENTION_MS, BoardCommandIntentConflictError } from "../board/receipts";
export { boardResourceWorkspace } from "../board/resources";
export type { DetachedWorkPort } from "../detached-work";
export { createProject } from "../project-create";
export { inspectProjectFolder, relinkProject } from "../project-relink";
export { isRealPathWithinRoots, isWithinRoots, syncProjectRoots } from "../project-roots";
export {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  deleteTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  unarchiveTicketCommand,
  updateTicketFieldsCommand,
} from "../ticket-commands";
export { trimFinishedTicketInBackground } from "../ticket-move";
export { subscribeTicketWake, type TicketWake, withTicketWake } from "../ticket-wake";
