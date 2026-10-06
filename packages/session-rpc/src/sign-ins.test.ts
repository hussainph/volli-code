/**
 * The sign-in procedures (VC-702) at the router's unit layer: each is a
 * projection of its one handler, a branded refusal becomes its protocol
 * reason on every path (middleware and stream), the stream ends after its
 * terminal update and never ends as if whole after dropping one, and a
 * network door's connection reaches the handler.
 */
import { LOCAL_DEVICE_ACTOR, type HostActor } from "@volli/host-protocol";
import {
  SignInRefusedError,
  type HandlerCall,
  type HostSignInStatus,
  type HostSignInUpdate,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  createSessionRouter,
  RpcDiagnosticLog,
  sessionProcedureSchemas,
  type SignInRouterHandlers,
} from "./index";
import { sessionContext } from "./session-handlers.test-support";

const DEVICE: HostActor = {
  kind: "device",
  deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
  workspaceId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
};
const STATUS: HostSignInStatus = {
  providers: [{ providerId: "xai", label: "xAI", state: "missing", kind: null, methods: [] }],
  git: [{ host: "github.com", state: "signed-in", kind: "git" }],
};

function routerFor(
  signIns: Partial<SignInRouterHandlers>,
  door: { connection?: boolean; welcome?: boolean; signal?: AbortSignal } = {},
) {
  const closed = new AbortController();
  const context = {
    ...sessionContext({
      caller:
        door.connection === true
          ? { actor: DEVICE, current: () => true }
          : { actor: LOCAL_DEVICE_ACTOR },
      runtime: {},
      signIns,
      diagnostics: new RpcDiagnosticLog(),
    }),
    ...(door.connection === true
      ? {
          transport: "websocket" as const,
          connectionId: "connection-1",
          admission: { signal: closed.signal, openStream: () => true, closeStream: () => {} },
          ...(door.welcome === true
            ? {
                welcome: {
                  protocolVersion: 1,
                  host: { id: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b", version: "t" },
                  workspace: { id: DEVICE.workspaceId, epoch: 1 },
                  actor: DEVICE,
                  features: ["sign-ins", "auth.callback"],
                  proof: null,
                },
              }
            : {}),
        }
      : {}),
  };
  return {
    caller: createSessionRouter().createCaller(
      context,
      door.signal === undefined ? {} : { signal: door.signal },
    ),
    closed,
  };
}

async function drain(stream: AsyncIterable<HostSignInUpdate>): Promise<HostSignInUpdate[]> {
  const seen: HostSignInUpdate[] = [];
  for await (const update of stream) seen.push(update);
  return seen;
}

async function reasonOf(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return (error as { reason?: string }).reason;
  }
  throw new Error("expected a refusal");
}

describe("the sign-in procedures", () => {
  it("project each handler, write-only values in and nulls out", async () => {
    const calls: [string, unknown][] = [];
    const record =
      <Answer>(key: string, answer: Answer) =>
      (input: unknown) => {
        calls.push([key, input]);
        return answer;
      };
    const { caller } = routerFor({
      "signIns.status": record("signIns.status", STATUS),
      "signIns.setApiKey": record("signIns.setApiKey", STATUS),
      "signIns.signOut": record("signIns.signOut", STATUS),
      "signIns.start": record("signIns.start", { flowId: "flow-1" }),
      "signIns.answer": record("signIns.answer", undefined),
      "signIns.cancel": record("signIns.cancel", undefined),
      "signIns.setGitCredential": record("signIns.setGitCredential", STATUS),
      "signIns.clearGitCredential": record("signIns.clearGitCredential", STATUS),
      "auth.callback.deliver": record("auth.callback.deliver", { status: 200 }),
    });
    expect(await caller.signIns.status()).toEqual(STATUS);
    expect(await caller.signIns.setApiKey({ providerId: "xai", key: "k-0123456789" })).toEqual(
      STATUS,
    );
    expect(await caller.signIns.signOut({ providerId: "xai" })).toEqual(STATUS);
    expect(await caller.signIns.start({ providerId: "xai" })).toEqual({ flowId: "flow-1" });
    expect(
      await caller.signIns.answer({ flowId: "flow-1", promptId: "p", value: "pasted" }),
    ).toBeNull();
    expect(await caller.signIns.cancel({ flowId: "flow-1" })).toBeNull();
    expect(
      await caller.signIns.setGitCredential({ host: "github.com", username: "x", password: "t" }),
    ).toEqual(STATUS);
    expect(await caller.signIns.clearGitCredential({ host: "github.com" })).toEqual(STATUS);
    expect(
      await caller.auth.callback.deliver({ flowId: "flow-1", pathAndQuery: "/callback?code=c" }),
    ).toEqual({ status: 200 });
    expect(calls.map(([key]) => key)).toEqual([
      "signIns.status",
      "signIns.setApiKey",
      "signIns.signOut",
      "signIns.start",
      "signIns.answer",
      "signIns.cancel",
      "signIns.setGitCredential",
      "signIns.clearGitCredential",
      "auth.callback.deliver",
    ]);
    // A request target, never a URL.
    expect(
      await reasonOf(
        caller.auth.callback.deliver({ flowId: "f", pathAndQuery: "https://evil.test/" }),
      ),
    ).toBeUndefined();
  });

  it("takes a blank answer, as a step may want one, but never a blank key or password", () => {
    const schemas = sessionProcedureSchemas();
    // GitHub Copilot: "GitHub Enterprise URL/domain (blank for github.com)".
    expect(
      schemas["signIns.answer"]!.input.safeParse({ flowId: "flow", promptId: "prompt", value: "" })
        .success,
    ).toBe(true);
    expect(
      schemas["signIns.answer"]!.input.safeParse({
        flowId: "flow",
        promptId: "prompt",
        value: "x".repeat(16_385),
      }).success,
    ).toBe(false);
    expect(
      schemas["signIns.setApiKey"]!.input.safeParse({ providerId: "p", key: "" }).success,
    ).toBe(false);
    expect(
      schemas["signIns.setGitCredential"]!.input.safeParse({
        host: "github.com",
        username: "x",
        password: "",
      }).success,
    ).toBe(false);
  });

  it("names a branded refusal by its reason, and an absent service as unavailable", async () => {
    const { caller } = routerFor({
      "signIns.cancel": () => {
        throw new SignInRefusedError("sign-in-unknown", "There is no such sign-in.");
      },
      "signIns.subscribe": async () => {
        throw new SignInRefusedError("sign-in-unknown", "There is no such sign-in.");
      },
    });
    expect(await reasonOf(caller.signIns.cancel({ flowId: "f" }))).toBe("sign-in-unknown");
    expect(await reasonOf(drain(await caller.signIns.subscribe({ flowId: "f" })))).toBe(
      "sign-in-unknown",
    );
    expect(await reasonOf(caller.signIns.status())).toBe("operation-unavailable");
    const unserved = routerFor({});
    expect(await reasonOf(drain(await unserved.caller.signIns.subscribe({ flowId: "f" })))).toBe(
      "operation-unavailable",
    );
  });

  it("streams a flow to its end, and fails it with the reason the handler gave", async () => {
    const { caller } = routerFor({
      "signIns.subscribe": async ({ flowId }, _call, sink) => {
        if (flowId === "ends") {
          void sink.emit({ kind: "progress", message: "Waiting" });
          void sink.emit({ kind: "done" });
          // Nothing after the end reaches the stream.
          void sink.emit({ kind: "progress", message: "late" });
        } else {
          void sink.emit({ kind: "progress", message: "Waiting" });
          sink.fail(new SignInRefusedError("sign-in-conflict", "That provider is busy."));
        }
        return () => {};
      },
    });
    expect(await drain(await caller.signIns.subscribe({ flowId: "ends" }))).toEqual([
      { kind: "progress", message: "Waiting" },
      { kind: "done" },
    ]);
    const failing = await caller.signIns.subscribe({ flowId: "fails" });
    const seen: HostSignInUpdate[] = [];
    const reason = await reasonOf(
      (async () => {
        for await (const update of failing) seen.push(update);
      })(),
    );
    expect(seen).toEqual([{ kind: "progress", message: "Waiting" }]);
    expect(reason).toBe("sign-in-conflict");
  });

  it("never ends as if whole after dropping an update", async () => {
    let released = false;
    const { caller } = routerFor({
      "signIns.subscribe": async (_input, _call, sink) => {
        for (let index = 0; index <= 256; index++) {
          void sink.emit({ kind: "progress", message: `${index}` });
        }
        return () => {
          released = true;
        };
      },
    });
    expect(await reasonOf(drain(await caller.signIns.subscribe({ flowId: "f" })))).toBe(
      "subscription-overflow",
    );
    expect(released).toBe(true);
  });

  it("stops at once when the caller stops listening", async () => {
    let released = 0;
    const handlers: Partial<SignInRouterHandlers> = {
      "signIns.subscribe": async (_input, _call, sink) => {
        void sink.emit({ kind: "progress", message: "Waiting" });
        return () => {
          released += 1;
        };
      },
    };
    const aborted = new AbortController();
    aborted.abort();
    const gone = routerFor(handlers, { signal: aborted.signal });
    expect(await drain(await gone.caller.signIns.subscribe({ flowId: "f" }))).toEqual([]);
    const live = new AbortController();
    const open = await routerFor(handlers, { signal: live.signal }).caller.signIns.subscribe({
      flowId: "f",
    });
    const iterator = open[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ kind: "progress", message: "Waiting" });
    live.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(released).toBe(1);
  });

  it("hands the handler the connection a network door minted, and none on IPC", async () => {
    const seen: (HandlerCall["connection"] | undefined)[] = [];
    const start: SignInRouterHandlers["signIns.start"] = (_input, call) => {
      seen.push(call.connection);
      return { flowId: "f" };
    };
    await routerFor({ "signIns.start": start }).caller.signIns.start({ providerId: "xai" });
    const network = routerFor({ "signIns.start": start }, { connection: true, welcome: true });
    await network.caller.signIns.start({ providerId: "xai" });
    const bare = routerFor({ "signIns.start": start }, { connection: true });
    await bare.caller.signIns.start({ providerId: "xai" });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatchObject({ id: "connection-1", features: ["sign-ins", "auth.callback"] });
    expect(seen[1]!.closed.aborted).toBe(false);
    network.closed.abort();
    expect(seen[1]!.closed.aborted).toBe(true);
    // A door with no welcome grants no client capability.
    expect(seen[2]).toMatchObject({ id: "connection-1", features: [] });
  });
});
