/**
 * `@volli/shared/cloud`: the Volli Cloud data model's Convex-independent half
 * (ids, the Actor, attention items, board events, the activity feed, runner jobs, column positions, object-storage
 * keys and their presigned URLs, ticket keys, transcript packs, visibility,
 * Member rules, the bounded Session fold, streamed-text chunks). The backend (`convex/`), the runner and clients import it
 * from here; nothing in it names a backend row id.
 */
export * from "./activity";
export * from "./actor";
export * from "./agent-tokens";
export * from "./attention";
export * from "./board-client";
export * from "./board-events";
export * from "./board-receipts";
export * from "./board-rules";
export * from "./gateway";
export * from "./github";
export * from "./ids";
export * from "./job-payloads";
export * from "./jobs";
export * from "./members";
export * from "./migration-import";
export * from "./positions";
export * from "./preview-access";
export * from "./project-rules";
export * from "./r2-keys";
export * from "./s3-presign";
export * from "./session-signal";
export * from "./stream-chunks";
export * from "./runners";
export * from "./secrets";
export * from "./session-state";
export * from "./ticket-key";
export * from "./transcript-pack";
export * from "./visibility";

// The board vocabulary the cloud schema validates against, re-exported so the
// backend can import this entry point alone.
export type { SessionRole } from "../agent-runtime";
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
