import type {
  AnyProcedure,
  AnyRouter,
  inferProcedureInput,
  inferProcedureOutput,
} from "@trpc/server";

/**
 * JSON safety as a type, checked once at the router.
 *
 * The Electron transport copies values by structured clone, which carries a
 * `Date`, a `Map`, a `Set`, and a key holding `undefined` without complaint.
 * Any other transport sends JSON text, which turns the `Date` into a string,
 * the `Map` into `{}`, and drops the key. `docs/BOUNDARIES.md` rule 3 says
 * payloads stay JSON-safe; this module is what enforces it.
 *
 * The check is "does `T` read the same on both sides of a JSON wire":
 * {@link JsonRoundTrip} is what `T` becomes after `JSON.parse(JSON.stringify)`,
 * and {@link IsJsonSafe} asks whether that is assignable to and from `T`. The
 * transform is deliberately lazy — array syntax and mapped types, never an
 * eager walk — because the payloads it has to cover include recursive JSON
 * aliases and the AI SDK's `UIMessage`, and an eager walk over those does not
 * terminate inside TypeScript's instantiation budget.
 */

type JsonPrimitive = string | number | boolean | null;

/**
 * A type JSON carries verbatim. Matching this is the short-circuit that keeps
 * a recursive JSON alias (`SessionNativeDetail`) from being walked at all.
 * The symbol signature is there so a symbol-keyed object cannot match by way
 * of the string one, which says nothing about symbols.
 */
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue; readonly [key: symbol]: never };

type AnyFunction = ((...args: never[]) => unknown) | (abstract new (...args: never[]) => unknown);

/**
 * What structured clone carries and JSON does not. `JSON.stringify` throws on
 * a `bigint`, drops a `symbol` or a function, and turns a `Date` into a string
 * and a `Map` or `Set` into `{}`. None of them comes back as itself, which is
 * the only property the check cares about, so they all map to `never`.
 */
type NeverJson =
  | bigint
  | symbol
  | AnyFunction
  | Date
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | WeakMap<WeakKey, unknown>
  | WeakSet<WeakKey>
  | PromiseLike<unknown>;

/**
 * An `Error` looks like a JSON object structurally, but its standard fields are
 * non-enumerable and `JSON.stringify(new Error("boom"))` returns `{}`.
 * Check it before the {@link JsonValue} shortcut so that shortcut cannot hide
 * the runtime loss.
 */
type JsonValueLookalike = Error;

/** `any` and `unknown` admit `undefined` without being it; the check cannot see inside either. */
type IsOpaque<T> = 0 extends 1 & T ? true : unknown extends T ? true : false;

/**
 * What `T` reads as on the far side of a JSON wire. A value JSON cannot carry
 * as itself becomes `never`, so it can never be mutually assignable with `T`.
 *
 * Arrays are written as `X[]`, not mapped, on purpose: inside a type alias an
 * array type is a deferred reference TypeScript resolves on demand, while a
 * mapped type over an array instantiates its element eagerly. The eager form
 * recurses without end on a self-referential record such as the AI SDK's
 * `JSONObject`, whose values admit `undefined` and so miss the {@link JsonValue}
 * short-circuit. Tuples are finite and keep the mapped form, which is what
 * preserves their length. At the top level tRPC deliberately carries
 * `void`/`undefined` without JSON text and the client reads `undefined`, so the
 * primitive fallback leaves that one procedure result intact; object keys and
 * array slots still take their normal JSON damage below.
 */
type JsonRoundTrip<T> =
  IsOpaque<T> extends true
    ? T
    : T extends object
      ? keyof T extends never
        ? never
        : JsonRoundTripStructured<T>
      : T extends JsonValue
        ? T
        : T extends NeverJson
          ? never
          : T;

/** JSON damage for an object whose declaration exposes at least one key. */
type JsonRoundTripStructured<T extends object> = T extends JsonValueLookalike
  ? never
  : T extends JsonValue
    ? T
    : T extends NeverJson
      ? never
      : T extends readonly [] | readonly [unknown, ...unknown[]]
        ? { [K in keyof T]: JsonRoundTripSlot<T[K]> }
        : T extends (infer Slot)[]
          ? JsonRoundTripSlot<Slot>[]
          : T extends readonly (infer Slot)[]
            ? readonly JsonRoundTripSlot<Slot>[]
            : JsonRoundTripObject<T>;

/** An array slot is never dropped: `undefined`/`void` there serialises as `null`. */
type JsonRoundTripSlot<T> = IsOpaque<T> extends true ? T : T extends void ? null : JsonRoundTrip<T>;

/**
 * Keys whose value admits `undefined`, and so may be absent after the round
 * trip. `tsconfig.base.json` does not set `exactOptionalPropertyTypes`, so an
 * optional key reads as `T | undefined` too — both land here, and the split
 * below makes both optional. That is exactly right for a `?:` key and exactly
 * wrong for a required one, which is how the required one fails the check.
 * An `unknown` or `any` value is left alone: it admits `undefined` the way it
 * admits everything, and turning it optional would fail the required
 * `input: unknown` every AI SDK tool part carries.
 */
type DroppableKeys<T> = {
  [K in keyof T]-?: IsOpaque<T[K]> extends true ? never : undefined extends T[K] ? K : never;
}[keyof T];

/**
 * Two mapped types over the same `keyof T`, so each keeps the modifiers of
 * the key it carries; only the droppable half adds `?`. A symbol key is in
 * neither: `JSON.stringify` ignores it, so a required one leaves the round
 * trip short of a property `T` demands.
 */
type JsonRoundTripObject<T> = {
  [K in keyof T as K extends symbol | DroppableKeys<T> ? never : K]: JsonRoundTrip<T[K]>;
} & {
  [
    K in keyof T as K extends symbol ? never : K extends DroppableKeys<T> ? K : never
  ]?: JsonRoundTrip<Exclude<T[K], undefined>>;
};

/** `true` when `T` survives a JSON round trip with its type intact. */
export type IsJsonSafe<T> = [T] extends [JsonRoundTrip<T>]
  ? [JsonRoundTrip<T>] extends [T]
    ? true
    : false
  : false;

/** A modern tRPC subscription is an async iterable; its wire payload is each yielded value. */
type IterableYield<T> = T extends AsyncIterable<infer Yield> ? Yield : T;

type ProcedureInput<Procedure extends AnyProcedure> = Exclude<inferProcedureInput<Procedure>, void>;

type ProcedureOutput<Procedure extends AnyProcedure> =
  Procedure["_def"]["type"] extends "subscription"
    ? IterableYield<inferProcedureOutput<Procedure>>
    : Exclude<inferProcedureOutput<Procedure>, void>;

/**
 * The dotted procedure-and-direction names in `Record` that are not JSON-safe.
 * A clean record reduces to `never`, ready for an `AssertNever` seam check.
 */
type UnsafeProcedures<Record, Prefix extends string> = {
  [Key in keyof Record & string]: Record[Key] extends AnyProcedure
    ?
        | (IsJsonSafe<ProcedureInput<Record[Key]>> extends true ? never : `${Prefix}${Key}.input`)
        | (IsJsonSafe<ProcedureOutput<Record[Key]>> extends true ? never : `${Prefix}${Key}.output`)
    : Record[Key] extends object
      ? UnsafeProcedures<Record[Key], `${Prefix}${Key}.`>
      : never;
}[keyof Record & string];

/**
 * Every raw input or output in `Router` that changes across a JSON wire,
 * reported as `"namespace.procedure.input"` or `"...output"`.
 */
export type JsonUnsafeProcedures<Router extends AnyRouter> = UnsafeProcedures<
  Router["_def"]["record"],
  ""
>;
