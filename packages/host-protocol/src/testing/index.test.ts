import { initTRPC, TRPCError, tracked } from "@trpc/server";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeHostHello,
  readHostHello,
  type HostHello,
  type HostConnectionHello,
} from "../handshake";
import {
  describeContract,
  expectHostError,
  ipcContractLink,
  recordSubscription,
  webSocketContractLink,
  type ContractLink,
} from "./index";

interface ToyHost {
  readonly greeting: string;
}
interface ToyContext extends ToyHost {
  readonly hello: HostConnectionHello | null;
}

const t = initTRPC.context<ToyContext>().create();
const toyRouter = t.router({
  greet: t.procedure
    .input((value: unknown) => value as { name: string })
    .query(({ ctx, input }) => ({ text: `${ctx.greeting}, ${input.name}`, absent: undefined })),
  hello: t.procedure.query(({ ctx }) => ctx.hello?.client.kind ?? null),
  refuse: t.procedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not for this actor" });
  }),
  count: t.procedure
    .input((value: unknown) => value as { lastEventId?: string; fail?: boolean })
    .subscription(async function* ({ input }) {
      const from = input.lastEventId === undefined ? 0 : Number(input.lastEventId);
      for (let sequence = from + 1; sequence <= 3; sequence += 1) {
        yield tracked(String(sequence), { sequence });
      }
      if (input.fail === true) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Fell behind" });
      }
    }),
  forever: t.procedure.subscription(async function* ({ signal }) {
    yield tracked("1", { sequence: 1 });
    await new Promise((resolve) => signal?.addEventListener("abort", resolve));
  }),
});
type ToyRouter = typeof toyRouter;

const hello: HostHello = {
  protocol: { min: 1, max: 1 },
  client: { kind: "cli", version: "test" },
  workspaceId: "6f1cbc6b-0b8e-4d4e-9a39-2a0c5f4f2d11",
  lastSeen: null,
  features: [],
  credential: "token",
  nonce: "bm9uY2Utb2YtdGhlLWNvbnRyYWN0LWhhcm5lc3M",
};

const links: ContractLink<ToyHost, ToyRouter>[] = [
  webSocketContractLink({
    router: toyRouter,
    createContext: (host, { connectionParams }) => ({
      ...host,
      hello: readHostHello(connectionParams),
    }),
    connectionParams: encodeHostHello(hello),
  }),
  // In-process IPC has no handshake: the composition root states who calls.
  ipcContractLink({
    router: toyRouter,
    createContext: (host) => ({ ...host, hello }),
  }),
];

describeContract("the contract harness", links, ({ connect, link }) => {
  it("names the link it runs over", () => {
    expect(["websocket", "ipc"]).toContain(link);
  });

  it("serves queries from the host fixture, as each wire carries them", async () => {
    const client = await connect({ greeting: "Hello" });
    // `absent` is gone over JSON text and kept by structured clone: the reason
    // every router seam proves its payloads JSON-safe.
    expect(await client.greet.query({ name: "Ada" })).toStrictEqual(
      link === "websocket" ? { text: "Hello, Ada" } : { text: "Hello, Ada", absent: undefined },
    );
  });

  it("hands the context the hello the client sent before its first operation", async () => {
    const client = await connect({ greeting: "Hi" });
    expect(await client.hello.query()).toBe("cli");
  });

  it("reads a refusal as the one error envelope", async () => {
    const client = await connect({ greeting: "Hi" });
    expect(await expectHostError(client.refuse.mutate())).toEqual({
      code: "FORBIDDEN",
      message: "Not for this actor",
    });
  });

  it("records a tracked subscription to completion, and resumes it from an event id", async () => {
    const client = await connect({ greeting: "Hi" });
    const first = recordSubscription<{ id: string; data: { sequence: number } }>((handlers) =>
      client.count.subscribe({}, handlers),
    );
    await first.started;
    expect(await first.received(3)).toStrictEqual([
      { id: "1", data: { sequence: 1 } },
      { id: "2", data: { sequence: 2 } },
      { id: "3", data: { sequence: 3 } },
    ]);
    expect(await first.received(1)).toHaveLength(3);
    expect(await first.ended).toStrictEqual({ kind: "complete" });

    const resumed = recordSubscription<{ id: string }>((handlers) =>
      client.count.subscribe({ lastEventId: "2" }, handlers),
    );
    expect((await resumed.received(1)).map(({ id }) => id)).toStrictEqual(["3"]);
    resumed.unsubscribe();
  });

  it("ends a failing subscription with the envelope, not a clean completion", async () => {
    const client = await connect({ greeting: "Hi" });
    const stream = recordSubscription((handlers) =>
      client.count.subscribe({ lastEventId: "3", fail: true }, handlers),
    );
    expect(await stream.ended).toStrictEqual({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS", message: "Fell behind" },
    });
  });
});

describe("the harness's own guards", () => {
  it("sends no connectionParams when the link was given none", async () => {
    const connection = await webSocketContractLink<ToyHost, ToyRouter>({
      router: toyRouter,
      createContext: (host, { connectionParams }) => ({
        ...host,
        hello: connectionParams === null ? null : hello,
      }),
    }).open({ greeting: "Hi" });
    try {
      expect(await connection.client.hello.query()).toBeNull();
    } finally {
      await connection.close();
    }
  });

  // Closing an IPC connection is a window closing: its peer is destroyed, so
  // the server stops every stream it still holds for it.
  it("tears down a live IPC stream when its connection closes", async () => {
    const connection = await ipcContractLink<ToyHost, ToyRouter>({
      router: toyRouter,
      createContext: (host) => ({ ...host, hello: null }),
    }).open({ greeting: "Hi" });
    const stream = recordSubscription((handlers) =>
      connection.client.forever.subscribe(undefined, handlers),
    );
    expect(await stream.received(1)).toHaveLength(1);
    await connection.close();
    expect(stream.frames).toHaveLength(1);
  });

  it("fails a case that expected a refusal and got an answer", async () => {
    await expect(expectHostError(Promise.resolve("fine"))).rejects.toThrow(
      "Expected the host to refuse this call, and it answered",
    );
  });
});
