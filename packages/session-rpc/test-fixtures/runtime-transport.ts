/** TEST-ONLY: the real router codecs, with JSON round trips on every boundary. */
import type { SessionRuntime } from "@volli/session-engine";
import type { ChatSessionRpc, ChatSessionTransport } from "../../session-presentation/src/client";
import { createSessionRouter, LOCAL_DESKTOP_CALLER, RpcDiagnosticLog } from "../src/index";
import { sessionContext } from "../src/session-handlers.test-support";

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function runtimeTransport(runtime: SessionRuntime): ChatSessionTransport {
  const router = createSessionRouter();
  const context = sessionContext({
    runtime,
    caller: LOCAL_DESKTOP_CALLER,
    transport: "electron-ipc",
    diagnostics: new RpcDiagnosticLog(),
  });
  const caller = router.createCaller(context);
  const rpc: ChatSessionRpc = {
    session: {
      snapshot: { query: async (input) => json(await caller.session.snapshot(json(input))) },
      history: { query: async (input) => json(await caller.session.history(json(input))) },
      projection: { query: async (input) => json(await caller.session.projection(json(input))) },
      command: { mutate: async (input) => json(await caller.session.command(json(input))) },
      cancelQueued: {
        mutate: async (input) => json(await caller.session.cancelQueued(json(input))),
      },
      editQueued: { mutate: async (input) => json(await caller.session.editQueued(json(input))) },
      cancelInteraction: {
        mutate: async (input) => json(await caller.session.cancelInteraction(json(input))),
      },
      reconcile: { mutate: async (input) => json(await caller.session.reconcile(json(input))) },
      subscribe: {
        subscribe(input, handlers) {
          const abort = new AbortController();
          void (async () => {
            try {
              const source = router.createCaller(context, { signal: abort.signal });
              const stream = await source.session.subscribe(json(input));
              handlers.onStarted();
              for await (const tracked of stream) {
                const envelope: unknown = json(tracked);
                if (!Array.isArray(envelope) || typeof envelope[0] !== "string")
                  throw new Error("Expected a tracked Session envelope");
                if (abort.signal.aborted) break;
                handlers.onData({ id: envelope[0], data: envelope[1] });
              }
              if (!abort.signal.aborted) handlers.onComplete();
            } catch (error) {
              if (!abort.signal.aborted) handlers.onError(error);
            }
          })();
          return { unsubscribe: () => abort.abort() };
        },
      },
    },
  };
  return {
    rpc,
    scheduler: {
      schedule(flush) {
        const timer = setTimeout(flush, 0);
        return () => clearTimeout(timer);
      },
    },
    newCommandId: () => crypto.randomUUID(),
    createSession: async () => {
      throw new Error("Fixture adopts a durable Session");
    },
    attachSession: async () => {
      throw new Error("Fixture is already attached");
    },
  };
}
