import { initTRPC, tracked } from "@trpc/server";
import { describe, expectTypeOf, it } from "vite-plus/test";
import type { AppRouter, SessionRouterJsonSafety } from "./index";
import type { IsJsonSafe, JsonUnsafeProcedures } from "./json-safe";

/**
 * Every assertion here is settled by `tsc`, not at runtime: `pnpm typecheck`
 * is the test. The `it` blocks exist so the file reads as a specification and
 * runs under the same runner as everything else.
 */
describe("IsJsonSafe", () => {
  it("makes unsafe payloads uninhabitable and admits the two transport exceptions", () => {
    // @ts-expect-error — a Date comes back from JSON as a string.
    acceptJsonSafe<{ when: Date }>({ when: new Date() });
    // @ts-expect-error — a Map comes back from JSON as an empty object.
    acceptJsonSafe<{ byId: Map<string, number> }>({ byId: new Map() });
    // @ts-expect-error — JSON drops the required key, violating its declared shape.
    acceptJsonSafe<{ answer: string | undefined }>({ answer: undefined });

    acceptJsonSafe<{ answer?: string }>({});
    acceptJsonSafe<void>(undefined);
  });

  it("accepts what JSON carries as itself", () => {
    expectTypeOf<
      IsJsonSafe<{ id: string; at: number; ok: boolean; none: null }>
    >().toEqualTypeOf<true>();
  });

  it("rejects a Date, which comes back as a string", () => {
    expectTypeOf<IsJsonSafe<{ when: Date }>>().toEqualTypeOf<false>();
  });

  it("rejects broad object declarations that can hide an unsafe runtime value", () => {
    expectTypeOf<IsJsonSafe<object>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<Date | {}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<Error>>().toEqualTypeOf<false>();
  });

  it("rejects a Map or Set, which come back as {}", () => {
    expectTypeOf<IsJsonSafe<{ byId: Map<string, number> }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ ids: Set<string> }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ byId: ReadonlyMap<string, number> }>>().toEqualTypeOf<false>();
  });

  it("rejects what JSON.stringify throws on or drops: bigint, symbol, functions", () => {
    expectTypeOf<IsJsonSafe<{ big: bigint }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ tag: symbol }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ run: () => void }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ make: new () => object }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ [tag]: string }>>().toEqualTypeOf<false>();
  });

  it("looks inside arrays and nested objects", () => {
    expectTypeOf<IsJsonSafe<{ rows: { at: number }[] }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ rows: readonly { at: Date }[] }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ a: { b: { c: Map<string, string> } } }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ pair: [string, number] }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ pair: [string, Date] }>>().toEqualTypeOf<false>();
  });

  it("accepts an optional key: JSON drops the value and `?:` already allows the absence", () => {
    expectTypeOf<IsJsonSafe<{ answers?: string[] }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ readonly title?: string | null }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ output?: never }>>().toEqualTypeOf<true>();
  });

  it("rejects a required key typed `T | undefined`: the reader sees an absent key the type promised", () => {
    expectTypeOf<IsJsonSafe<{ answers: string[] | undefined }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ nested: { title: string | undefined } }>>().toEqualTypeOf<false>();
  });

  it("rejects `undefined` or `void` in an array slot, which comes back as null", () => {
    expectTypeOf<IsJsonSafe<{ slots: (string | undefined)[] }>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonSafe<{ slots: void[] }>>().toEqualTypeOf<false>();
  });

  it("passes `unknown` and `any` through: it cannot see inside them", () => {
    // The AI SDK `UIMessage` shape: `metadata?: unknown`, tool `input`/`output`
    // and data-part `data` are `unknown`, and `input` is REQUIRED on some arms.
    expectTypeOf<IsJsonSafe<{ input: unknown; metadata?: unknown }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ loose: any }>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<unknown>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<any>>().toEqualTypeOf<true>();
  });

  it("terminates on a recursive JSON alias and answers by its leaves", () => {
    expectTypeOf<IsJsonSafe<Detail>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonSafe<{ detail: Detail | null }>>().toEqualTypeOf<true>();
  });

  it("terminates on a recursive record whose values admit undefined (the AI SDK's JSONObject)", () => {
    expectTypeOf<IsJsonSafe<LooseJsonObject>>().toEqualTypeOf<true>();
    expectTypeOf<
      IsJsonSafe<{ providerMetadata?: Record<string, LooseJsonObject> }>
    >().toEqualTypeOf<true>();
    // Still not blind to what sits beside it.
    expectTypeOf<IsJsonSafe<{ meta: LooseJsonObject; when: Date }>>().toEqualTypeOf<false>();
  });
});

describe("the Session router JSON seam", () => {
  it("guards every raw input and output published by AppRouter", () => {
    expectTypeOf<JsonUnsafeProcedures<AppRouter>>().toEqualTypeOf<never>();
    expectTypeOf<SessionRouterJsonSafety>().toEqualTypeOf<never>();
  });
});

describe("JsonUnsafeProcedures", () => {
  const t = initTRPC.create();
  const input = <T>() => t.procedure.input((value: unknown) => value as T);

  it("names every procedure whose input or output would not survive the wire, by path and direction", () => {
    const router = t.router({
      session: t.router({
        dated: t.procedure.query((): { when: Date } => ({ when: new Date() })),
        broad: t.procedure.query((): object => new Date()),
        errored: t.procedure.query((): Error => new Error("boom")),
        mapped: input<{ byId: Map<string, number> }>().mutation(() => "ok"),
        halfSet: t.procedure.query((): { title: string | undefined } => ({ title: undefined })),
        both: input<{ ids: Set<string> }>().mutation((): { big: bigint } => ({ big: 1n })),
      }),
    });
    expectTypeOf<JsonUnsafeProcedures<typeof router>>().toEqualTypeOf<
      | "session.dated.output"
      | "session.broad.output"
      | "session.errored.output"
      | "session.mapped.input"
      | "session.halfSet.output"
      | "session.both.input"
      | "session.both.output"
    >();
  });

  it("is never for a router that only carries JSON, including void, optional input and unknown", () => {
    const router = t.router({
      session: t.router({
        cancel: input<{ id: string }>().mutation((): void => undefined),
        list: input<{ afterId?: number } | undefined>().query(() => [{ id: 1 }]),
        opaque: t.procedure.query((): { data: unknown } => ({ data: null })),
        stream: input<{ afterSequence?: number }>().subscription(async function* () {
          yield { sequence: 1, transcript: null as { message: string } | null };
        }),
      }),
      health: t.procedure.query(() => "ok" as const),
    });
    expectTypeOf<JsonUnsafeProcedures<typeof router>>().toEqualTypeOf<never>();
  });

  it("reads a subscription by what it yields, through a tracked envelope", () => {
    const router = t.router({
      stream: t.procedure.subscription(async function* () {
        yield tracked("1", { at: new Date() });
      }),
    });
    expectTypeOf<JsonUnsafeProcedures<typeof router>>().toEqualTypeOf<"stream.output">();
  });

  it("does not mistake an ordinary symbol tuple for tRPC's tracked envelope", () => {
    const router = t.router({
      stream: t.procedure.subscription(async function* () {
        yield ["ordinary", { at: 1 }, Symbol("not-tracked")] as const;
      }),
    });
    expectTypeOf<JsonUnsafeProcedures<typeof router>>().toEqualTypeOf<"stream.output">();
  });
});

type JsonSafePayload<Payload> = IsJsonSafe<Payload> extends true ? Payload : never;

function acceptJsonSafe<Payload>(payload: JsonSafePayload<Payload>): void {
  void payload;
}

declare const tag: unique symbol;

/** The shape of `SessionNativeDetail` in `@volli/shared`. */
type Detail =
  | null
  | boolean
  | number
  | string
  | readonly Detail[]
  | { readonly [key: string]: Detail };

/** The shape of `@ai-sdk/provider`'s `JSONValue`, which `UIMessage` carries as `providerMetadata`. */
type LooseJsonValue = null | string | number | boolean | LooseJsonObject | LooseJsonValue[];
type LooseJsonObject = { [key: string]: LooseJsonValue | undefined };
