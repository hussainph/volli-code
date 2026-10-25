/**
 * `@volli/shared/cloud`: the Volli Cloud data model's Convex-independent half
 * (ids, the Actor, board events, runner jobs, column positions, object-storage
 * keys, ticket keys, visibility). The backend (`convex/`), the runner and
 * clients import it from here; nothing in it names a backend row id.
 */
export * from "./actor";
export * from "./board-events";
export * from "./ids";
export * from "./jobs";
export * from "./positions";
export * from "./r2-keys";
export * from "./ticket-key";
export * from "./visibility";

// The board vocabulary the cloud schema validates against, re-exported so the
// backend can import this entry point alone.
export {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "../ticket";
export {
  TICKET_SIGNAL_KINDS,
  TICKET_SIGNAL_VERDICTS,
  type TicketSignalKind,
  type TicketSignalVerdict,
} from "../ticket-events";
