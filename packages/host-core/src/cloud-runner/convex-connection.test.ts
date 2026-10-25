import { describe, expect, it, vi } from "vite-plus/test";

const clients = vi.hoisted(() => ({ made: [] as FakeClient[] }));

interface FakeClient {
  url: string;
  options: unknown;
  token: unknown;
  connected: boolean;
  listener: ((state: { isWebSocketConnected: boolean }) => void) | null;
  mutation: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  queries: {
    ref: unknown;
    args: unknown;
    callback: (value: unknown) => void;
    off: ReturnType<typeof vi.fn>;
  }[];
}

vi.mock("convex/browser", () => ({
  // A constructor function: `new` returns the object it builds.
  ConvexClient: function FakeConvexClient(url: string, options: unknown) {
    const client: FakeClient = {
      url,
      options,
      token: null,
      connected: false,
      listener: null,
      mutation: vi.fn(async (_ref: unknown, args: unknown) => ({ echoed: args })),
      close: vi.fn(async () => {}),
      queries: [],
    };
    clients.made.push(client);
    return {
      setAuth: (token: unknown) => (client.token = token),
      mutation: client.mutation,
      onUpdate: (ref: unknown, args: unknown, callback: (value: unknown) => void) => {
        const off = vi.fn();
        client.queries.push({ ref, args, callback, off });
        return off;
      },
      connectionState: () => ({ isWebSocketConnected: client.connected }),
      subscribeToConnectionState: (listener: FakeClient["listener"]) => {
        client.listener = listener;
        return () => (client.listener = null);
      },
      close: client.close,
    };
  },
}));

const { convexBackendConnection } = await import("./convex-connection");
type ConvexClientModule = import("./convex-connection").ConvexClientModule;
const { ConvexClient } = await import("convex/browser");
const { getFunctionName, makeFunctionReference } = await import("convex/server");

const token = async () => "jwt";

describe("the Convex connection", () => {
  it("opens a ConvexClient authenticated by the runner token, calls functions by name, and reports connectivity changes only", async () => {
    // The real exports, handed in as the composition root would (this line
    // is also the compile-time check that they fit the port).
    const convex: ConvexClientModule = { ConvexClient, makeFunctionReference };
    const connection = convexBackendConnection("https://dep.convex.cloud", convex)(token);
    const client = clients.made[0]!;
    expect(client.url).toBe("https://dep.convex.cloud");
    expect(client.options).toEqual({ unsavedChangesWarning: false });
    expect(client.token).toBe(token);

    await expect(connection.mutation("runners:heartbeat", { bootId: "b" })).resolves.toEqual({
      echoed: { bootId: "b" },
    });
    expect(getFunctionName(client.mutation.mock.calls[0]![0] as never)).toBe("runners:heartbeat");

    const changes: boolean[] = [];
    const unsubscribe = connection.onConnectionChange((up) => changes.push(up));
    expect(connection.isConnected()).toBe(false);
    client.connected = true;
    client.listener!({ isWebSocketConnected: true });
    client.listener!({ isWebSocketConnected: true });
    client.listener!({ isWebSocketConnected: false });
    expect(changes).toEqual([true, false]);
    unsubscribe();
    expect(client.listener).toBeNull();
    const updates: unknown[] = [];
    const stop = connection.onUpdate("runnerJobs:wake", {}, (value) => updates.push(value));
    const query = client.queries[0]!;
    expect(getFunctionName(query.ref as never)).toBe("runnerJobs:wake");
    query.callback({ ready: 3 });
    expect(updates).toEqual([{ ready: 3 }]);
    stop();
    expect(query.off).toHaveBeenCalled();
    await connection.close();
    expect(client.close).toHaveBeenCalled();
  });
});
