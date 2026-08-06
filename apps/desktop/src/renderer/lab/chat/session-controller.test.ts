/**
 * Starting and re-attaching a lab Session over the RPC boundary the
 * controller uses.
 *
 * The transcript fold and the wire validators these two commands lean on
 * live in `@renderer/chat/transcript` and `@renderer/chat/wire` now, with
 * their own tests; what stays here is lab-specific — the two-step
 * create-then-attach sequence and its retry, which only exist because this
 * surface mints a durable Session before a harness has agreed to serve it.
 */
import { describe, expect, it } from "vite-plus/test";

import { attachLabExecutor, startLabSession } from "./session-controller";

describe("startLabSession", () => {
  it("keeps the durable Session but reports an error when OpenCode rejects its attachment", async () => {
    const mutations: unknown[] = [];
    const rpc = {
      session: {
        command: {
          mutate: async (input: unknown) => {
            mutations.push(input);
            return mutations.length === 1
              ? { sessionId: "durable-session" }
              : {
                  sessionId: "durable-session",
                  receipt: {
                    status: "rejected",
                    code: "adapter_unavailable",
                    detail: "OpenCode is unavailable",
                  },
                };
          },
        },
      },
    } as unknown as Parameters<typeof startLabSession>[0];

    await expect(startLabSession(rpc, null)).resolves.toEqual({
      sessionId: "durable-session",
      lifecycle: "error",
      error: "Could not start OpenCode: OpenCode is unavailable",
    });
    expect(mutations).toHaveLength(2);
  });

  it("keeps the durable Session when the attachment throws instead of answering", async () => {
    // The other half of the same guarantee. A refusal is a completed round
    // trip; this is the transport failing mid-attach, and the Session is
    // already in the ledger either way — losing the id here would strand it.
    let mutations = 0;
    const rpc = {
      session: {
        command: {
          mutate: async () => {
            mutations += 1;
            if (mutations === 1) return { sessionId: "durable-session" };
            throw new Error("socket hang up");
          },
        },
      },
    } as unknown as Parameters<typeof startLabSession>[0];

    await expect(startLabSession(rpc, null)).resolves.toEqual({
      sessionId: "durable-session",
      lifecycle: "error",
      error: "Could not start OpenCode: socket hang up",
    });
  });

  it("has no Session to keep when the create itself never answered", async () => {
    const rpc = {
      session: {
        command: {
          mutate: async () => {
            throw new Error("socket hang up");
          },
        },
      },
    } as unknown as Parameters<typeof startLabSession>[0];

    await expect(startLabSession(rpc, null)).rejects.toThrow("socket hang up");
  });
});

describe("attachLabExecutor", () => {
  it("retries onto the Session the refused attach left behind, not a new one", async () => {
    // A rejected attach does not un-create the Session, so the retry must not
    // create one either: one `session.create`, and every attempt after it is
    // another `adapter.attach` addressed to the same durable id.
    const mutations: Array<Record<string, unknown>> = [];
    const rpc = {
      session: {
        command: {
          mutate: async (input: unknown) => {
            mutations.push(input as Record<string, unknown>);
            if (mutations.length === 1) return { sessionId: "durable-session" };
            if (mutations.length === 2) {
              return {
                sessionId: "durable-session",
                receipt: {
                  status: "rejected",
                  code: "adapter_unavailable",
                  detail: "OpenCode is unavailable",
                },
              };
            }
            return { sessionId: "durable-session", receipt: { status: "accepted" } };
          },
        },
      },
    } as unknown as Parameters<typeof startLabSession>[0];

    const started = await startLabSession(rpc, null);
    expect(started.lifecycle).toBe("error");

    await expect(attachLabExecutor(rpc, started.sessionId, null)).resolves.toEqual({
      sessionId: "durable-session",
      lifecycle: "ready",
      error: null,
    });

    expect(mutations.map((sent) => (sent.command as { kind: string }).kind)).toEqual([
      "session.create",
      "adapter.attach",
      "adapter.attach",
    ]);
    expect(mutations[1]?.sessionId).toBe("durable-session");
    expect(mutations[2]?.sessionId).toBe("durable-session");
  });

  it("keeps the Session id when the retried attach throws too", async () => {
    const rpc = {
      session: {
        command: {
          mutate: async () => {
            throw new Error("socket hang up");
          },
        },
      },
    } as unknown as Parameters<typeof startLabSession>[0];

    await expect(attachLabExecutor(rpc, "durable-session", null)).resolves.toEqual({
      sessionId: "durable-session",
      lifecycle: "error",
      error: "Could not start OpenCode: socket hang up",
    });
  });
});
