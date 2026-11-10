import { EventEmitter } from "node:events";
import { deserialize, serialize } from "node:v8";
import { createServer, type Server } from "node:net";
import type { PiSignIn } from "@volli/agent-runtime";
import { ModelAccessSignInService } from "@volli/host-core/session-runtime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { handlers, windows } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  windows: [] as { webContents: ReturnType<typeof windowContents> }[],
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { MODEL_ACCESS_CHANNELS } from "../ipc-descriptors";
import { registerModelAccessIpcHandlers } from "./ipc";

function invoke(channel: string, sender: unknown = {}, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...args: unknown[]) => unknown)({ sender }, ...args);
}

beforeEach(() => {
  handlers.clear();
  windows.length = 0;
});

// The degraded half of the surface (VC-76): a runtime that never came up must
// answer WHY, on every channel, instead of leaving a nameless refusal — the
// renderer toasts this exact string from its "Couldn't start sign-in" path.
describe("registerModelAccessIpcHandlers (degraded)", () => {
  it("claims every channel and answers with the caller's classified reason", () => {
    const reason =
      "Sign-in is unavailable — the local database failed to open: " +
      "better-sqlite3 was built for a different Node ABI.";
    registerModelAccessIpcHandlers(null, reason);
    expect([...handlers.keys()].toSorted()).toEqual([...MODEL_ACCESS_CHANNELS].toSorted());
    for (const channel of MODEL_ACCESS_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: reason });
    }
  });

  it("falls back to the generic refusal when no reason is given", () => {
    registerModelAccessIpcHandlers(null);
    for (const channel of MODEL_ACCESS_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: "The agent runtime is unavailable." });
    }
  });
});

// --- a page that goes away mid sign-in (VC-831) --------------------------------
//
// A reload keeps the WebContents, so an owner that let go only on `destroyed`
// kept the provider's one attempt slot — and the flow's loopback callback
// server on its fixed port — for as long as the window lived, while the
// reloaded page, which no longer knew the attempt id, was told "This provider
// is already signing in." The flow below has pi-ai's OAuth shape: it listens on
// a real loopback server, parks on a pasted-code question raced against it,
// and closes the server however the attempt ends.

/** The app window's WebContents, able to fire any page-lifetime event. */
function windowContents(id = 1) {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  });
}

function loopbackFlow() {
  const servers: Server[] = [];
  const pi: PiSignIn = {
    offers: () => true,
    login: async (_providerId, _type, _signal, steps) => {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await steps.ask(
          {
            promptId: steps.newId(),
            kind: "manual-code",
            message: "Paste the code",
            placeholder: null,
            options: [],
          },
          undefined,
        );
      } finally {
        server.close();
      }
    },
    logout: async () => undefined,
  };
  return { pi, servers };
}

async function begin(sender: unknown): Promise<unknown> {
  const result = invoke("volli:model-access-sign-in-begin", sender, "anthropic", "oauth");
  // Let the flow reach its question with its server listening.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return result;
}

describe("registerModelAccessIpcHandlers (a page that goes away mid sign-in)", () => {
  it.each(["did-navigate", "render-process-gone"])(
    "frees the provider and closes the old flow's loopback server on %s",
    async (event) => {
      const flow = loopbackFlow();
      registerModelAccessIpcHandlers(new ModelAccessSignInService({ pi: flow.pi }));
      const contents = windowContents();

      expect(await begin(contents)).toMatchObject({ ok: true });
      expect(flow.servers[0]?.listening).toBe(true);
      expect(await begin(contents)).toEqual({
        ok: false,
        error: "This provider is already signing in.",
      });
      const sentBefore = contents.send.mock.calls.length;

      contents.emit(event);
      await vi.waitFor(() => expect(flow.servers[0]?.listening).toBe(false));
      const second = (await begin(contents)) as { ok: true; attemptId: string };
      expect(second).toMatchObject({ ok: true });
      expect(flow.servers).toHaveLength(2);
      expect(flow.servers[1]?.listening).toBe(true);
      // Nothing about the abandoned attempt reaches the page that replaced it.
      const sentAfter = contents.send.mock.calls
        .slice(sentBefore)
        .map(([, update]) => (update as { attemptId: string }).attemptId);
      expect(sentAfter.length).toBeGreaterThan(0);
      expect(sentAfter.every((attemptId) => attemptId === second.attemptId)).toBe(true);

      contents.emit("destroyed");
      await vi.waitFor(() => expect(flow.servers[1]?.listening).toBe(false));
    },
  );

  it("frees the provider for the next window when this one is destroyed", async () => {
    const flow = loopbackFlow();
    registerModelAccessIpcHandlers(new ModelAccessSignInService({ pi: flow.pi }));
    const closing = windowContents();

    expect(await begin(closing)).toMatchObject({ ok: true });
    closing.isDestroyed.mockReturnValue(true);
    closing.emit("destroyed");
    await vi.waitFor(() => expect(flow.servers[0]?.listening).toBe(false));

    const next = windowContents();
    expect(await begin(next)).toMatchObject({ ok: true });
    next.emit("destroyed");
    await vi.waitFor(() => expect(flow.servers[1]?.listening).toBe(false));
  });

  it("keeps the attempt through an in-page or refused navigation", async () => {
    const flow = loopbackFlow();
    registerModelAccessIpcHandlers(new ModelAccessSignInService({ pi: flow.pi }));
    const contents = windowContents();

    expect(await begin(contents)).toMatchObject({ ok: true });
    contents.emit("did-navigate-in-page");
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flow.servers[0]?.listening).toBe(true);
    expect(await begin(contents)).toEqual({
      ok: false,
      error: "This provider is already signing in.",
    });

    contents.emit("destroyed");
    await vi.waitFor(() => expect(flow.servers[0]?.listening).toBe(false));
  });
});

/** Exercise Electron's structured-clone shape, never shared object references. */
function wire<T>(value: T): T {
  return deserialize(serialize(value)) as T;
}

describe("accepted credential changes across windows", () => {
  it("keeps prompts addressed and broadcasts only a payload-free accepted sign-in", async () => {
    const opener = windowContents(1);
    const peer = windowContents(2);
    const gone = windowContents(3);
    gone.isDestroyed.mockReturnValue(true);
    windows.push(...[opener, peer, gone].map((webContents) => ({ webContents })));
    registerModelAccessIpcHandlers(
      new ModelAccessSignInService({
        pi: {
          offers: () => true,
          login: async (_providerId, _type, _signal, steps) => {
            await steps.ask(
              {
                promptId: "key",
                kind: "secret",
                message: "API key",
                placeholder: null,
                options: [],
              },
              undefined,
            );
          },
          logout: async () => {},
        },
      }),
    );
    const started = wire(
      invoke("volli:model-access-sign-in-begin", opener, ...wire(["anthropic", "api-key"])),
    ) as { ok: true; attemptId: string };
    expect(started.ok).toBe(true);
    expect(wire(opener.send.mock.calls)).toEqual([
      ["volli:model-access-sign-in", expect.objectContaining({ kind: "prompt" })],
    ]);
    expect(peer.send).not.toHaveBeenCalled();
    expect(gone.send).not.toHaveBeenCalled();

    expect(
      wire(
        invoke(
          "volli:model-access-sign-in-respond",
          opener,
          ...wire([started.attemptId, "key", "test-only-secret"]),
        ),
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(peer.send).toHaveBeenCalledExactlyOnceWith("volli:model-access-changed"),
    );
    expect(opener.send.mock.calls.map(([, update]) => (update as { kind: string }).kind)).toEqual([
      "prompt",
      "settled",
    ]);
    expect(gone.send).not.toHaveBeenCalled();
    expect(JSON.stringify(wire(peer.send.mock.calls))).not.toContain("test-only-secret");
  });

  it("notifies the replacement page when a saved credential outlives its opener", async () => {
    const opener = windowContents(1);
    const peer = windowContents(2);
    windows.push({ webContents: opener }, { webContents: peer });
    const saved = Promise.withResolvers<void>();
    registerModelAccessIpcHandlers(
      new ModelAccessSignInService({
        pi: {
          offers: () => true,
          // A credential write already underway may complete despite abandonment.
          login: () => saved.promise,
          logout: async () => {},
        },
      }),
    );
    invoke("volli:model-access-sign-in-begin", opener, "anthropic", "oauth");
    opener.emit("did-navigate");
    saved.resolve();
    await vi.waitFor(() =>
      expect(peer.send).toHaveBeenCalledExactlyOnceWith("volli:model-access-changed"),
    );
    expect(opener.send).toHaveBeenCalledExactlyOnceWith("volli:model-access-changed");
  });

  it("notifies peers only after sign-out succeeds", async () => {
    const opener = windowContents(1);
    const peer = windowContents(2);
    windows.push({ webContents: opener }, { webContents: peer });
    const logout = Promise.withResolvers<void>();
    let fail = false;
    registerModelAccessIpcHandlers(
      new ModelAccessSignInService({
        pi: {
          offers: () => true,
          login: async () => {
            throw new Error("Sign-in failed");
          },
          logout: async () => {
            await logout.promise;
            if (fail) throw new Error("Could not remove credential");
          },
        },
      }),
    );
    invoke("volli:model-access-sign-in-begin", opener, "anthropic", "oauth");
    await vi.waitFor(() => expect(opener.send).toHaveBeenCalled());
    expect(peer.send).not.toHaveBeenCalled();
    opener.send.mockClear();
    const pending = invoke("volli:model-access-sign-out", opener, "anthropic");
    expect(peer.send).not.toHaveBeenCalled();
    logout.resolve();
    expect(wire(await pending)).toEqual({ ok: true });
    expect(wire(peer.send.mock.calls)).toEqual([["volli:model-access-changed"]]);
    expect(opener.send).not.toHaveBeenCalled();

    peer.send.mockClear();
    fail = true;
    expect(wire(await invoke("volli:model-access-sign-out", opener, "anthropic"))).toEqual({
      ok: false,
      error: "Could not remove credential",
    });
    expect(peer.send).not.toHaveBeenCalled();
  });
});
