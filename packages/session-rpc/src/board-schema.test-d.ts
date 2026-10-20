/**
 * The board's wire schemas strip no domain field (VC-565; HP § Command
 * catalog, "Validation doors").
 *
 * A zod object drops every key it does not declare, so a field the domain
 * gains and `board-schema.ts` does not would vanish at every network door
 * without a type error: the router hands handler answers to the validator
 * through `wire()`, a cast. These assertions compare the UNCAST inferred
 * schemas key by key, recursively and per union arm, against the domain
 * types the host answers, the same machinery as
 * `output-schema-exactness.test-d.ts`. Run by `tsc --noEmit`.
 */
import type {
  ArchivedTicket,
  BoardChange,
  BoardCommandReceipt,
  BoardCommentChange,
  BoardLabelChange,
  BoardProjectChange,
  BoardTicketChange,
  BoardTicketEventChange,
  Label,
  LatestSessionSignal,
  ModelSelection,
  Project,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketStatusEntry,
  TicketSummary,
} from "@volli/shared";
import type { z } from "zod";

import type { BoardRouterHandlers } from "./board-router";
import type * as schemas from "./board-schema";

// Uncast inferred schemas only: comparing a `ZodType<Domain>` alias would
// compare the domain type to itself and miss every strip.
type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type Keys<T> = T extends unknown ? keyof T : never;
type At<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type Element<T> = T extends readonly (infer E)[] ? E : never;
type Matching<T, Z, K extends keyof T> = Z extends unknown
  ? K extends keyof Z
    ? [T[K] & Z[K]] extends [never]
      ? never
      : Z
    : never
  : never;
// Match the union arm first, so a field on another arm cannot conceal a strip.
type Variant<T, Z> = T extends { kind: unknown }
  ? Matching<T, Z, "kind">
  : T extends { status: unknown }
    ? Matching<T, Z, "status">
    : T extends { op: unknown }
      ? Matching<T, Z, "op">
      : Z;
type Depth = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
type MissingObject<T, Z, P extends string, D extends number> = {
  [K in keyof T & string]-?: K extends Keys<Z>
    ? Missing<NonNullable<T[K]>, NonNullable<At<Z, K>>, `${P}.${K}`, Depth[D]>
    : `${P}.${K}`;
}[keyof T & string];
// A project's preference documents and a ticket event's payload are opaque
// JSON on the wire (board-schema.ts): their records admit every key, so the
// traversal is bounded rather than skipped.
type Missing<T, Z, P extends string = "", D extends number = 12> = D extends 0
  ? never
  : 0 extends 1 & T
    ? never
    : unknown extends T
      ? never
      : T extends Primitive
        ? never
        : T extends readonly (infer E)[]
          ? Missing<E, Element<Z>, `${P}[]`, Depth[D]>
          : T extends object
            ? MissingObject<T, Variant<T, Z>, P, D>
            : never;
type NoMissing<T extends never> = T;
type DeepMutable<T> = T extends Primitive
  ? T
  : T extends readonly (infer E)[]
    ? DeepMutable<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;
type Assert<T extends true> = T;
type Accepted<T, Z> = [DeepMutable<T>] extends [Z] ? true : false;

type Wire<Schema extends z.ZodType> = z.output<Schema>;
type Answer<Key extends keyof BoardRouterHandlers> = Awaited<ReturnType<BoardRouterHandlers[Key]>>;

// Each domain row against its own schema.
export type ProjectKeys = NoMissing<Missing<Project, Wire<typeof schemas.projectSchema>>>;
export type ModelSelectionKeys = NoMissing<
  Missing<ModelSelection, Wire<typeof schemas.modelSelectionSchema>>
>;
export type TicketKeys = NoMissing<Missing<Ticket, Wire<typeof schemas.ticketSchema>>>;
export type SummaryKeys = NoMissing<
  Missing<TicketSummary, Wire<typeof schemas.ticketSummarySchema>>
>;
export type ArchivedKeys = NoMissing<
  Missing<ArchivedTicket, Wire<typeof schemas.archivedTicketSchema>>
>;
export type LabelKeys = NoMissing<Missing<Label, Wire<typeof schemas.labelSchema>>>;
export type CommentKeys = NoMissing<Missing<TicketComment, Wire<typeof schemas.commentSchema>>>;
export type EventKeys = NoMissing<Missing<TicketEvent, Wire<typeof schemas.ticketEventSchema>>>;
export type SignalKeys = NoMissing<
  Missing<LatestSessionSignal, Wire<typeof schemas.latestSignalSchema>>
>;
export type EntryKeys = NoMissing<
  Missing<TicketStatusEntry, Wire<typeof schemas.statusEntrySchema>>
>;
export type ReceiptKeys = NoMissing<
  Missing<BoardCommandReceipt, Wire<typeof schemas.receiptSchema>>
>;

// The change feed: the whole union, and each arm alone against the union, so
// an arm whose fields went missing cannot hide behind a sibling's.
type ChangeWire = Wire<typeof schemas.boardChangeSchema>;
export type ChangeKeys = NoMissing<Missing<BoardChange, ChangeWire>>;
export type ProjectChangeKeys = NoMissing<Missing<BoardProjectChange, ChangeWire>>;
export type TicketChangeKeys = NoMissing<Missing<BoardTicketChange, ChangeWire>>;
export type LabelChangeKeys = NoMissing<Missing<BoardLabelChange, ChangeWire>>;
export type CommentChangeKeys = NoMissing<Missing<BoardCommentChange, ChangeWire>>;
export type TicketEventChangeKeys = NoMissing<Missing<BoardTicketEventChange, ChangeWire>>;
export type ChangeBatchKeys = NoMissing<
  Missing<
    { cursor: string; changes: readonly BoardChange[] },
    Wire<typeof schemas.boardChangeBatchSchema>
  >
>;

// Every arm of the domain union has its wire arm, and no wire arm is extra.
export type ChangeArms = Assert<
  [BoardChange["kind"]] extends [ChangeWire["kind"]]
    ? [ChangeWire["kind"]] extends [BoardChange["kind"]]
      ? true
      : false
    : false
>;

// The envelopes the handler map answers, against the schemas the router binds.
export type SnapshotKeys = NoMissing<
  Missing<Answer<"board.snapshot">, Wire<typeof schemas.boardSnapshotSchema>>
>;
export type RosterKeys = NoMissing<
  Missing<Answer<"board.roster">, Wire<typeof schemas.boardRosterSchema>>
>;

// Key presence is complemented by value acceptance (enums, nullability) for
// every row whose fields are all wire-typed. A project's preference documents
// are interfaces with no index signature, which TypeScript will not assign to
// a JSON record; they are key-checked above and the rest is value-checked here.
type ProjectJsonFields = "themeOverride" | "themeCanvas" | "decisionModel" | "authorityPolicy";
export type ValuesAccepted = [
  Assert<
    Accepted<
      Omit<Project, ProjectJsonFields>,
      Omit<Wire<typeof schemas.projectSchema>, ProjectJsonFields>
    >
  >,
  Assert<Accepted<Ticket, Wire<typeof schemas.ticketSchema>>>,
  Assert<Accepted<TicketSummary, Wire<typeof schemas.ticketSummarySchema>>>,
  Assert<Accepted<ArchivedTicket, Wire<typeof schemas.archivedTicketSchema>>>,
  Assert<Accepted<Label, Wire<typeof schemas.labelSchema>>>,
  Assert<Accepted<TicketComment, Wire<typeof schemas.commentSchema>>>,
  Assert<
    Accepted<Omit<TicketEvent, "payload">, Omit<Wire<typeof schemas.ticketEventSchema>, "payload">>
  >,
  Assert<Accepted<LatestSessionSignal, Wire<typeof schemas.latestSignalSchema>>>,
  Assert<Accepted<TicketStatusEntry, Wire<typeof schemas.statusEntrySchema>>>,
  Assert<Accepted<BoardCommandReceipt, Wire<typeof schemas.receiptSchema>>>,
  Assert<Accepted<BoardTicketChange, ChangeWire>>,
  Assert<Accepted<BoardLabelChange, ChangeWire>>,
  Assert<Accepted<BoardCommentChange, ChangeWire>>,
  Assert<Accepted<BoardTicketEventChange, ChangeWire>>,
];

// Sanity probes: each would compile without the missing-key guard, since the
// removed fields are optional. An unused @ts-expect-error fails tsc.
type MissingProjectField = Missing<Project, Omit<Wire<typeof schemas.projectSchema>, "skillModes">>;
// @ts-expect-error an optional project field the wire object lacks is a strip
export type ProbeOptional = NoMissing<MissingProjectField>;
type MissingArmField = Missing<
  BoardTicketChange,
  | Exclude<ChangeWire, { kind: "ticket" }>
  | { kind: "ticket"; op: "upsert"; id: string; projectId: string }
>;
// @ts-expect-error a ticket arm without its row strips it, whatever other arms carry
export type ProbeArm = NoMissing<MissingArmField>;
type MissingNested = Missing<
  { tickets: readonly TicketSummary[] },
  { tickets: Omit<Wire<typeof schemas.ticketSummarySchema>, "prUrl">[] }
>;
// @ts-expect-error array elements are checked recursively
export type ProbeNested = NoMissing<MissingNested>;
