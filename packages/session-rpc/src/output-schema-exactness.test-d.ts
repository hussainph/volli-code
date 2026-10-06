import type { z } from "zod";
import type { RendererSessionEvent, SessionPresentationProjection } from "@volli/shared";
import type {
  SessionTranscriptArtifact,
  SessionStreamOverlay,
  SessionStreamCompactionProgress,
} from "@volli/session-engine";
import type { RendererSessionCommandResult, RendererSessionStreamFrame } from "./index";
import type * as schemas from "./output-schema";

// These assertions use only uncast inferred schemas. Comparing the public
// ZodType<Domain> aliases would merely compare Domain to itself and miss strips.
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
// Match variants first: a field in a different variant cannot conceal a strip.
type Variant<T, Z> = T extends { kind: unknown }
  ? Matching<T, Z, "kind">
  : T extends { status: unknown }
    ? Matching<T, Z, "status">
    : T extends { op: unknown }
      ? Matching<T, Z, "op">
      : T extends { type: unknown }
        ? Matching<T, Z, "type">
        : Z;
type Depth = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
type MissingObject<T, Z, P extends string, D extends number> = {
  [K in keyof T & string]-?: K extends Keys<Z>
    ? Missing<NonNullable<T[K]>, NonNullable<At<Z, K>>, `${P}.${K}`, Depth[D]>
    : `${P}.${K}`;
}[keyof T & string];
// Opaque SDK data/metadata and JSON Schema documents are intentionally open.
// Bound traversal through recursive JSON values; twelve envelope levels exceed
// the Session grammar's nesting, while opaque part data remains extensible.
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

export type Projection = NoMissing<
  Missing<SessionPresentationProjection, z.output<typeof schemas.projectionWireSchema>>
>;
export type FullProjection = NoMissing<
  Missing<SessionPresentationProjection, z.output<typeof schemas.fullProjectionSchema>>
>;
export type Event = NoMissing<Missing<RendererSessionEvent, z.output<typeof schemas.eventSchema>>>;
export type Transcript = NoMissing<
  Missing<SessionTranscriptArtifact, z.output<typeof schemas.transcriptWireSchema>>
>;
export type Command = NoMissing<
  Missing<RendererSessionCommandResult, z.output<typeof schemas.sessionCommandWireSchema>>
>;
export type Frame = NoMissing<
  Missing<RendererSessionStreamFrame, z.output<typeof schemas.frameWireSchema>>
>;
export type Overlay = NoMissing<
  Missing<SessionStreamOverlay, z.output<typeof schemas.streamEmissionWireSchema>>
>;
export type Compaction = NoMissing<
  Missing<SessionStreamCompactionProgress, z.output<typeof schemas.streamEmissionWireSchema>>
>;
// Complement key presence with domain-to-wire acceptance (enums/nullability).
// SDK transcript/overlay values can contain unknown non-JSON data in TypeScript;
// their JSON safety restriction is intentional, so only keys are checked there.
export type ValuesAccepted = [
  Assert<Accepted<SessionPresentationProjection, z.output<typeof schemas.fullProjectionSchema>>>,
  Assert<Accepted<RendererSessionEvent, z.output<typeof schemas.eventSchema>>>,
  Assert<Accepted<RendererSessionCommandResult, z.output<typeof schemas.sessionCommandWireSchema>>>,
  Assert<
    Accepted<SessionStreamCompactionProgress, z.output<typeof schemas.streamEmissionWireSchema>>
  >,
];

// Sanity probes: each would compile without the missing-key guard, since all
// removed fields are optional. Unused @ts-expect-error directives fail tsc.
// @ts-expect-error nested optional field is absent from the inferred wire object
export type NestedOptional = NoMissing<Missing<{ a: { b?: string } }, { a: {} }>>;
type MissingOptionalContainer = Missing<{ a?: { b?: string } | null }, { a?: {} | null }>;
// @ts-expect-error nullable/optional containers do not hide nested missing fields
export type OptionalContainer = NoMissing<MissingOptionalContainer>;
// @ts-expect-error array elements are checked recursively, including readonly arrays
export type ArrayOptional = NoMissing<Missing<{ a: readonly { b?: string }[] }, { a: {}[] }>>;
type MissingKindVariant = Missing<
  { kind: "a"; detail?: string } | { kind: "b"; detail?: string },
  { kind: "a" } | { kind: "b"; detail?: string }
>;
// @ts-expect-error a key on the other kind variant cannot mask its absence
export type KindVariant = NoMissing<MissingKindVariant>;
type MissingStatusVariant = Missing<
  { status: "accepted"; result?: string },
  { status: "accepted" } | { status: "rejected"; result?: string }
>;
// @ts-expect-error status variants are matched independently
export type StatusVariant = NoMissing<MissingStatusVariant>;
type MissingOpVariant = Missing<
  { op: "reset"; message?: string },
  { op: "reset" } | { op: "remove"; message?: string }
>;
// @ts-expect-error op variants are matched independently
export type OpVariant = NoMissing<MissingOpVariant>;
export type CompleteOptional = NoMissing<
  Missing<{ a?: { b?: string }[] }, { a?: { b?: string }[] }>
>;
