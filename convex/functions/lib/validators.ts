/**
 * Validator building blocks for the schema and for function arguments.
 *
 * Every closed vocabulary is built FROM the constant in `@volli/shared/cloud`,
 * so the schema and the shared types cannot drift: adding a value there is an
 * additive schema change here, made in the same commit. Ids are plain strings
 * in the schema (our UUIDs, never `Id<"…">`); every mutation that writes one
 * checks it with the shared guard (`parseId`).
 */

import { v, type GenericValidator, type VLiteral, type VUnion } from "convex/values";

import { CLIENT_KINDS, LEGACY_ACTOR_TOKENS, VOLLI_REASONS } from "@volli/shared/cloud";

/** A union of string literals from a shared `as const` list. */
export function literals<const T extends readonly [string, ...string[]]>(
  values: T,
): VUnion<T[number], VLiteral<T[number], "required">[], "required", never> {
  return v.union(...values.map((value) => v.literal(value))) as VUnion<
    T[number],
    VLiteral<T[number], "required">[],
    "required",
    never
  >;
}

/** `T | null`: the wire form of an absent value (null, never undefined). */
export function nullable<T extends GenericValidator>(validator: T) {
  return v.union(validator, v.null());
}

/** One of our lowercase UUIDs. Stored as a string; format checked by the writing mutation. */
export const uuid = v.string();

/** Epoch milliseconds. */
export const time = v.number();

/** Bounded JSON whose shape a shared codec checks inside the writing mutation. */
export const json = v.any();

/** A value sealed under a key the backend (or the gateway) holds, never returned by a query. */
export const sealed = v.object({ kid: v.string(), ciphertext: v.bytes() });

/** The two deletion fields every aggregate root carries. */
export const deletion = { deletedAt: nullable(time), purgeAfter: nullable(time) };

/** The Actor (v1). Mirrors `Actor` in `@volli/shared/cloud`; a test holds the two equal. */
export const actor = v.union(
  v.object({ kind: v.literal("person"), userId: uuid, via: v.optional(literals(CLIENT_KINDS)) }),
  v.object({
    kind: v.literal("agent"),
    userId: uuid,
    sessionId: uuid,
    ticketId: v.optional(nullable(uuid)),
  }),
  v.object({
    kind: v.literal("automation"),
    userId: uuid,
    automationId: v.string(),
    runId: v.string(),
    sessionId: v.optional(uuid),
  }),
  v.object({
    kind: v.literal("volli"),
    reason: literals(VOLLI_REASONS),
    onBehalfOf: v.optional(uuid),
    runnerId: v.optional(uuid),
  }),
  v.object({
    kind: v.literal("legacy"),
    was: literals(LEGACY_ACTOR_TOKENS),
    sessionId: v.optional(v.string()),
  }),
);
