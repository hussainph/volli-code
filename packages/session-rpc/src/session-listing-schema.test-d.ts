/**
 * The Session listing's wire schemas strip no domain field (VC-713).
 *
 * A zod object drops every key it does not declare, so a field a listing row
 * gains and `session-listing-schema.ts` does not would vanish at every network
 * door without a type error: the router hands the handler's answer to the
 * validator through `listingWire()`, a cast. These assertions compare the
 * UNCAST inferred schemas key by key, recursively and per union arm, against
 * the domain types, and check that every domain value is accepted (enums,
 * nullability). The same machinery as `board-schema.test-d.ts`. Run by
 * `tsc --noEmit`.
 */
import type {
  ChatSessionRecord,
  SessionListingPage,
  SessionListingRow,
  SessionProvenance,
  SessionRecord,
  SessionUsageSummary,
} from "@volli/shared";
import type { z } from "zod";

import type { SessionRouterHandlers } from "./index";
import type * as schemas from "./session-listing-schema";

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
type Variant<T, Z> = T extends { kind: unknown } ? Matching<T, Z, "kind"> : Z;
type Depth = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
type MissingObject<T, Z, P extends string, D extends number> = {
  [K in keyof T & string]-?: K extends Keys<Z>
    ? Missing<NonNullable<T[K]>, NonNullable<At<Z, K>>, `${P}.${K}`, Depth[D]>
    : `${P}.${K}`;
}[keyof T & string];
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
type RowWire = Wire<typeof schemas.sessionListingRowSchema>;
type Answer<Key extends "session.listing" | "session.listingForTicket"> = Awaited<
  ReturnType<SessionRouterHandlers[Key]>
>;

// The row, whole and arm by arm.
export type RowKeys = NoMissing<Missing<SessionListingRow, RowWire>>;
export type TerminalRowKeys = NoMissing<
  Missing<Extract<SessionListingRow, { kind: "terminal" }>, RowWire>
>;
export type ChatRowKeys = NoMissing<Missing<Extract<SessionListingRow, { kind: "chat" }>, RowWire>>;
export type PageKeys = NoMissing<
  Missing<SessionListingPage, Wire<typeof schemas.sessionListingPageSchema>>
>;
export type ListingAnswerKeys = NoMissing<
  Missing<Answer<"session.listing">, Wire<typeof schemas.sessionListingPageSchema>>
>;
export type TicketListingAnswerKeys = NoMissing<
  Missing<Answer<"session.listingForTicket">, Wire<typeof schemas.sessionListingPageSchema>>
>;

// Every arm of the domain union has its wire arm, and no wire arm is extra.
export type RowArms = Assert<
  [SessionListingRow["kind"]] extends [RowWire["kind"]]
    ? [RowWire["kind"]] extends [SessionListingRow["kind"]]
      ? true
      : false
    : false
>;

// Every domain value is one the wire accepts.
export type ValuesAccepted = [
  Assert<Accepted<SessionListingRow, RowWire>>,
  Assert<Accepted<SessionListingPage, Wire<typeof schemas.sessionListingPageSchema>>>,
  Assert<Accepted<SessionRecord, Extract<RowWire, { kind: "terminal" }>["record"]>>,
  Assert<Accepted<ChatSessionRecord, Extract<RowWire, { kind: "chat" }>["record"]>>,
  Assert<Accepted<SessionUsageSummary, RowWire["usage"]>>,
  Assert<Accepted<SessionProvenance, RowWire["provenance"]>>,
];

// Sanity probe: an optional chat field the wire lacks is a strip.
type MissingOptional = Missing<
  ChatSessionRecord,
  Omit<Extract<RowWire, { kind: "chat" }>["record"], "resumedAfterStop">
>;
// @ts-expect-error an optional record field the wire object lacks is a strip
export type ProbeOptional = NoMissing<MissingOptional>;
