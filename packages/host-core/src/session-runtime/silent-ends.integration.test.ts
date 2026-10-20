import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ChatSessionClient,
  createSurfaceStore,
  messageDeliveryLabels,
} from "../../../session-presentation/src/index";
import { runtimeTransport } from "../../../session-rpc/test-fixtures/runtime-transport";
import { gatedProvider } from "../../../agent-runtime/test-fixtures/gated-provider";
import { createSessionEngine, isSessionStreamQueue } from "@volli/session-engine";
import type { SessionEvent } from "@volli/shared";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { silentEndsFixture } from "../testing/silent-ends";

const releases: Array<() => void> = [];
const fixtures: Awaited<ReturnType<typeof silentEndsFixture>>[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const opened of fixtures.splice(0)) await opened.close();
});
async function fixture(options: Parameters<typeof silentEndsFixture>[0] = {}) {
  const f = await silentEndsFixture(options);
  fixtures.push(f);
  return f;
}

function failureRows(events: readonly SessionEvent[]) {
  return events.filter((event) => event.payload.kind === "attention.raised");
}

// Only provider responses and host failures are scripted. Pi, codecs, sidecar,
// native adapter, engine and SQLite commits are real and no provider is called.
describe("silent ends audit (VC-758)", () => {
  it("delivers an ordinary default client send before the gated Pi reply finishes", async () => {
    const provider = gatedProvider();
    releases.push(provider.release);
    const f = await fixture({ provider });
    await f.attach();
    const store = createSurfaceStore();
    store.getState().seed(f.sessionId, "ready");
    const client = new ChatSessionClient(f.sessionId, {
      ...runtimeTransport(f.runtime),
      store,
      notify: () => {},
      renameSession: () => {},
    });
    try {
      await client.connect();
      let outcome: string | undefined;
      const sent = client.submit({ id: "ordinary-prompt", text: "Ordinary prompt" });
      void sent.then((result) => {
        outcome = result;
      });
      await provider.entered;
      await vi.waitFor(() => expect(outcome).toBe("delivered"));
      await vi.waitFor(() => {
        const transcript = store.getState().sessions[f.sessionId]!.transcript;
        expect(messageDeliveryLabels(transcript.frames).get("ordinary-prompt")).toBe("Delivered");
        expect(transcript.messages).toContainEqual(expect.objectContaining({ role: "assistant" }));
      });
      expect((await f.projection()).turnActive).toBe(true);
      expect((await f.events()).some((event) => event.payload.kind === "turn.completed")).toBe(
        false,
      );
      expect((await f.peek())["transcript"]).toContainEqual(
        expect.objectContaining({ role: "user", text: "Ordinary prompt", delivery: "Delivered" }),
      );
      // Real opening acceptance is correlated to this command, not guessed
      // from whichever turn event happened to arrive next.
      expect((await f.events()).map((event) => event.payload)).toContainEqual(
        expect.objectContaining({
          kind: "command.receipt.recorded",
          receipt: expect.objectContaining({ commandId: "ordinary-prompt", status: "accepted" }),
        }),
      );
      provider.release();
      await f.terminal;
      await sent;
      await vi.waitFor(() =>
        expect(store.getState().sessions[f.sessionId]!.lifecycle).toBe("ready"),
      );
      expect(store.getState().sessions[f.sessionId]!.transcript.turnActive).toBe(false);
    } finally {
      provider.release();
      client.dispose();
    }
  });

  it.each(["before stream", "between tool steps"])(
    "records a provider rejection %s durably",
    async (phase) => {
      const f = await fixture({
        replies: [
          ...(phase === "between tool steps"
            ? [{ tool: { name: "read", args: { path: "absent" } } }]
            : []),
          { throw: "Fixture provider request failed" },
        ],
      });
      expect((await f.attach()).receipt?.status).toBe("accepted");
      await f.submit();
      expect((await f.projection()).turnActive).toBe(false);
      expect(failureRows(await f.events())).toHaveLength(1);
      expect((await f.projection()).attention.active).toContainEqual(
        expect.objectContaining({
          kind: "adapter_unrecoverable",
          detail: expect.stringContaining("Fixture provider request failed"),
        }),
      );
      const peeked = await f.peek();
      expect(peeked["attention"]).toMatchObject({
        message: "Runtime stopped",
        recovery: "Retry",
        detail: expect.stringContaining("Fixture provider request failed"),
      });
      expect(peeked["transcript"]).toContainEqual(
        expect.objectContaining({ role: "user", text: "send", delivery: "Delivered" }),
      );
    },
  );

  it("records expired sign-in with one existing authentication recovery", async () => {
    const f = await fixture({ replies: [{ throw: "401 authentication_error: sign-in expired" }] });
    await f.attach();
    await f.submit();
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ kind: "auth_required" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect((await f.projection()).turnActive).toBe(false);
  });

  it("records context assembly failing before attach", async () => {
    const f = await fixture({
      adapter: {
        resolveRuntimeContext: async () => {
          throw new Error("Context assembly failed");
        },
      },
    });
    expect((await f.attach()).receipt?.status).toBe("rejected");
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "Context assembly failed" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect((await f.projection()).turnActive).toBe(false);
  });

  it("records MCP startup failing through the actual port resolver", async () => {
    const f = await fixture({
      mcp: true,
      adapter: {
        resolveMcpPort: () => {
          throw new Error("Tool startup failed");
        },
      },
    });
    expect((await f.attach()).receipt?.status).toBe("rejected");
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "Tool startup failed" }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
  });

  it("keeps a failed MCP call visible while the model recovers between steps", async () => {
    const f = await fixture({
      mcp: true,
      replies: [
        { tool: { name: "mcp__fixture_read", args: {} } },
        { text: "The server refused that call" },
      ],
      adapter: {
        resolveMcpPort: () => ({
          call: async () => ({
            content: [{ type: "text", text: "Fixture server refused the call" }],
            isError: true,
          }),
          dispose: async () => undefined,
        }),
      },
    });
    await f.attach();
    await f.submit();
    const snapshot = await f.runtime.snapshot({ sessionId: f.sessionId });
    expect(
      snapshot.frames.flatMap((frame) => frame.transcript?.message.parts ?? []),
    ).toContainEqual(
      expect.objectContaining({
        type: "dynamic-tool",
        state: "output-error",
        errorText: expect.stringContaining("Fixture server refused the call"),
      }),
    );
    expect(JSON.stringify(f.requests)).toContain("Fixture server refused the call");
    expect(snapshot.projection.turnActive).toBe(false);
    expect(failureRows(await f.events())).toEqual([]);
  });

  it("preserves a runtime fatal observation as a durable recovery, not just a close", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "late output",
          wait: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    expect((await f.projection()).turnActive).toBe(true);
    await f.crash();
    expect((await f.projection()).liveExecutor).toBeNull();
    expect((await f.projection()).turnActive).toBe(false);
    expect((await f.projection()).attention.active).toContainEqual(
      expect.objectContaining({ detail: "The runtime stopped unexpectedly", attachmentId: null }),
    );
    expect(failureRows(await f.events())).toHaveLength(1);
    expect(await f.peek()).toMatchObject({
      lastTurnOutcome: "failed",
      attention: {
        message: "Runtime stopped",
        detail: "The runtime stopped unexpectedly",
        recovery: "Retry",
      },
    });
    const coldEngine = createSessionEngine({
      ledger: createSqliteSessionLedger(f.db.db),
      clock: { now: () => 2000 },
      ids: { next: (kind) => `cold-${kind}` },
    });
    expect(
      (await coldEngine.getSession({ sessionId: f.sessionId }))?.attention.active,
    ).toContainEqual(
      expect.objectContaining({
        kind: "adapter_unrecoverable",
        detail: "The runtime stopped unexpectedly",
      }),
    );
    release.resolve();
    expect((await f.attach("recover")).receipt?.status).toBe("accepted");
    expect((await f.projection()).attention.active).toEqual([]);
  });

  it("records attachment preparation failing before the first model step", async () => {
    const f = await fixture({
      adapter: {
        prepareTurnAttachments: async () => {
          throw new Error("The attached file could not be read");
        },
      },
    });
    await f.attach();
    expect((await f.submit()).receipt?.status).toBe("rejected");
    // A definitive non-delivery is a rejected receipt, not a failed model turn.
    // The timeline can recover by resending; executor.retry would have no tail.
    expect((await f.events()).map((e) => e.payload)).toContainEqual(
      expect.objectContaining({
        kind: "command.receipt.recorded",
        receipt: expect.objectContaining({
          status: "rejected",
          detail: "The attached file could not be read",
        }),
      }),
    );
    expect(failureRows(await f.events())).toEqual([]);
    expect((await f.peek())["transcript"]).toContainEqual(
      expect.objectContaining({ role: "user", text: "send", delivery: "Not delivered" }),
    );
  });

  it("keeps a provider stall working without inventing a failure", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "finished",
          wait: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    expect((await f.projection()).turnActive).toBe(true);
    expect(failureRows(await f.events())).toEqual([]);
    release.resolve();
    await f.terminal;
    expect((await f.projection()).turnActive).toBe(false);
  });

  it.each(["queue", "steer"] as const)(
    "keeps %s pending until real Pi consumption",
    async (delivery) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      const f = await fixture({
        replies: [
          {
            text: "first step",
            wait: async () => {
              entered.resolve();
              await release.promise;
            },
          },
          { text: "follow-up done" },
        ],
      });
      await f.attach();
      await f.submit("first", "steer", true);
      await entered.promise;
      const queued = Promise.withResolvers<void>();
      const releasing = Promise.withResolvers<void>();
      const drained = Promise.withResolvers<void>();
      let sawQueued = false;
      const stop = await f.runtime.subscribe(
        { sessionId: f.sessionId, afterSequence: 0 },
        (emission) => {
          if (!isSessionStreamQueue(emission)) return;
          if (emission.queue.some((item) => item.state === "queued")) {
            sawQueued = true;
            queued.resolve();
          }
          if (emission.queue.some((item) => item.state === "releasing")) releasing.resolve();
          if (sawQueued && emission.queue.length === 0) drained.resolve();
        },
      );
      expect((await f.submit("queued", "queue")).receipt?.status).toBe("accepted");
      await queued.promise;
      expect((await f.projection()).queue).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ id: "queued" }),
          state: "queued",
        }),
      );
      expect((await f.projection()).turnActive).toBe(true);
      expect(JSON.stringify((await f.tail()).entries)).not.toContain('"text":"queued"');
      let steered: ReturnType<typeof f.submit> | undefined;
      if (delivery === "steer") {
        steered = f.submit("steer-command", "steer", true, "queued");
        await releasing.promise;
        expect((await f.projection()).queue?.[0]?.state).toBe("releasing");
      }
      release.resolve();
      if (steered) expect((await steered).receipt?.status).toBe("accepted");
      await drained.promise;
      stop();
      const tail = await f.tail();
      expect(
        tail.entries.filter((entry) => entry.role === "user" && entry.text.includes("queued")),
      ).toHaveLength(1);
      expect((await f.projection()).queue).toEqual([]);
    },
  );

  it("records deliberate cancellation without failure Attention", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    const f = await fixture({
      replies: [
        {
          text: "cancelled",
          wait: async (signal) => {
            signal!.addEventListener("abort", () => release.resolve(), { once: true });
            entered.resolve();
            await release.promise;
          },
        },
      ],
    });
    await f.attach();
    await f.submit("send", "steer", true);
    await entered.promise;
    const interrupted = f.runtime.command({
      commandId: "interrupt",
      sessionId: f.sessionId,
      command: { kind: "executor.interrupt" },
    });
    await interrupted;
    await f.terminal;
    expect((await f.events()).some((e) => e.payload.kind === "turn.interrupted")).toBe(true);
    expect(failureRows(await f.events())).toEqual([]);
  });
});
