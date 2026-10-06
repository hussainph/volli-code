/**
 * JSON-wire schemas for the board router (VC-565). Product envelopes are
 * explicit; the project's nested preference documents (theme, canvas,
 * authority policy, decision model) and a ticket event's payload are JSON,
 * because their grammar is owned and validated where they are written, and a
 * board reader only carries them. No transforms: these validators also
 * publish through `z.toJSONSchema` (VC-669).
 *
 * The change feed's `kind` is HP's third open union: a later area adds its
 * kinds to the Workspace feed, and a board reader drops a kind it does not
 * know (every change names state another reader owns), so the union may grow
 * without a protocol bump. Every other union here is closed.
 */
import {
  REASONING_LEVELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type ArchivedTicket,
  type BoardChange,
  type Label,
  type LatestSessionSignal,
  type Project,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketStatusEntry,
  type TicketSummary,
} from "@volli/shared";
import { z } from "zod";

const text = z.string();
const integer = z.number().int();
/** Ids this app mints: non-empty, bounded. */
export const boardId = z.string().min(1).max(256);
/** A Client-minted idempotency key (HP § Commands): a UUID. */
export const commandIdSchema = z.uuid();

export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);

export const modelSelectionSchema = z.object({
  providerId: text,
  modelId: text,
  reasoningLevel: z.enum(REASONING_LEVELS),
});

export const projectSchema = z.object({
  id: text,
  name: text,
  path: text,
  ticketPrefix: text,
  baseBranch: text.nullable().optional(),
  setupCommand: text.nullable().optional(),
  themeOverride: z.json().optional(),
  themeCanvas: z.json().optional(),
  themeAppearance: z.enum(["light", "dark", "auto"]).nullable().optional(),
  skillModes: z.record(text, z.enum(["auto", "manual", "off"])).optional(),
  sessionModel: modelSelectionSchema.nullable().optional(),
  decisionModel: z.json().optional(),
  authorityPolicy: z.json().optional(),
  colorIndex: integer,
  sortOrder: integer,
  createdAt: integer,
  updatedAt: integer,
});

const ticketFields = {
  id: text,
  projectId: text,
  ticketNumber: integer,
  title: text,
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  labels: z.array(text),
  usesWorktree: z.boolean(),
  preferredHarnessId: text,
  order: z.number(),
  worktreePath: text.nullable(),
  branch: text.nullable(),
  baseBranch: text.nullable(),
  prUrl: text.nullable(),
  createdAt: integer,
  updatedAt: integer,
};

export const ticketSummarySchema = z.object(ticketFields);
export const ticketSchema = z.object({ ...ticketFields, body: text });
export const archivedTicketSchema = z.object({ ...ticketFields, body: text, archivedAt: integer });

export const labelSchema = z.object({
  id: text,
  projectId: text,
  name: text,
  color: text.nullable(),
});

export const commentSchema = z.object({
  id: text,
  ticketId: text,
  sessionId: text.nullable(),
  actor: text,
  body: text,
  createdAt: integer,
  updatedAt: integer,
});

export const ticketEventSchema = z.object({
  id: text,
  ticketId: text,
  actor: z.enum(["user", "session", "automation", "unauthenticated"]),
  actorContext: z.object({ sessionId: text, ticketId: text.nullable() }).nullable().optional(),
  createdAt: integer,
  payload: z.object({ kind: text }).catchall(z.json()),
});

export const latestSignalSchema = z.object({
  ticketId: text,
  sessionId: text.nullable(),
  signal: z.enum(["done", "blocked"]),
  reason: text.nullable(),
  createdAt: integer,
});

export const statusEntrySchema = z.object({
  ticketId: text,
  status: ticketStatusSchema,
  enteredAt: integer,
});

export const receiptSchema = z.object({
  commandId: text,
  status: z.literal("completed"),
  replayed: z.boolean(),
});

const changeBase = {
  op: z.enum(["upsert", "delete"]),
  id: text,
  projectId: text,
  commandId: text.optional(),
};

export const boardChangeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("project"), ...changeBase, project: projectSchema.optional() }),
    z.object({
      kind: z.literal("ticket"),
      ...changeBase,
      ticket: ticketSummarySchema.optional(),
      checkoutMoved: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("label"), ...changeBase, label: labelSchema.optional() }),
    z.object({
      kind: z.literal("comment"),
      ...changeBase,
      ticketId: text,
      comment: commentSchema.optional(),
    }),
    z.object({ kind: z.literal("ticketEvent"), ...changeBase, ticketId: text }),
  ])
  .meta({ "x-volli-open-union": "kind" });

/** One `board.changes` yield: the changes stamped through `cursor`, oldest first. */
export const boardChangeBatchSchema = z.object({
  cursor: text,
  changes: z.array(boardChangeSchema),
});

export const boardSnapshotSchema = z.object({
  project: projectSchema,
  tickets: z.array(ticketSchema),
  labels: z.array(labelSchema),
  cursor: text,
});

export const boardRosterSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  labels: z.array(labelSchema),
  cursor: text,
});

// Typed views the router binds, so a strip shows up as a type error at the
// procedure (the exactness test compares the uncast schemas to these types).
export type ProjectWire = z.output<typeof projectSchema>;
export type BoardWireTypes = {
  readonly project: Project;
  readonly ticket: Ticket;
  readonly summary: TicketSummary;
  readonly archived: ArchivedTicket;
  readonly label: Label;
  readonly comment: TicketComment;
  readonly event: TicketEvent;
  readonly signal: LatestSessionSignal;
  readonly entry: TicketStatusEntry;
  readonly change: BoardChange;
};
