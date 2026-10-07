import { once } from "node:events";
import { readFileSync } from "node:fs";
import { initTRPC, TRPCError, tracked } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  generateDeviceKey,
  mintDeviceCredential,
} from "../../../host-install/src/remote-hosts-device-key";
import { signedDeviceVerifier } from "../../../host-install/src/testing/signed-device-verifier";
import {
  negotiateWelcome,
  readHostHello,
  type HostScopeHello,
  type HostScopeWelcome,
} from "../handshake";
import { hostError, type HostError } from "../errors";
import { createHostScopeLink, type HostScopeLinkOptions } from "./host-scope-link";
import type { HostScopeLink } from "./host-scope-link";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const DEVICE = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const OTHER = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
class Refusal extends Error {
  constructor(readonly envelope: HostError) {
    super(envelope.message);
  }
}

async function host() {
  const key = generateDeviceKey("enrolled");
  const auth = signedDeviceVerifier(HOST, Date.now);
  auth.enroll(DEVICE, key.privateKeyPem);
  const state: {
    hostId: string;
    error: HostError | null;
    missing: boolean;
    malformed: boolean;
    older: boolean;
    hold: Promise<void> | null;
    hellos: HostScopeHello[];
    mutations: unknown[];
  } = {
    hostId: HOST,
    error: null,
    missing: false,
    malformed: false,
    older: false,
    hold: null,
    hellos: [],
    mutations: [],
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const t = initTRPC.context<{ welcome: HostScopeWelcome }>().create({
    errorFormatter: ({ shape, error }) => ({
      ...shape,
      data: {
        ...shape.data,
        hostError: error.cause instanceof Refusal ? error.cause.envelope : null,
      },
    }),
  });
  const fail = (error: HostError): never => {
    throw new TRPCError({ code: error.code, cause: new Refusal(error), message: error.message });
  };
  const router = t.router({
    protocol: t.router({
      hostWelcome: t.procedure.query(async ({ ctx }) => {
        await state.hold;
        if (state.error !== null) fail(state.error);
        if (state.missing) throw new TRPCError({ code: "NOT_FOUND" });
        return state.malformed ? null : ctx.welcome;
      }),
    }),
    query: t.procedure.query(() => "host query"),
    mutate: t.procedure
      .input((input: unknown) => input)
      .mutation(({ input }) => {
        state.mutations.push(input);
        return input;
      }),
    feed: t.procedure.subscription(async function* () {
      yield tracked("1", "host event");
    }),
  });
  const handler = applyWSSHandler({
    wss: server,
    router,
    keepAlive: { enabled: false },
    createContext: async ({ info, res }) => {
      const hello = readHostHello(info.connectionParams);
      if (hello === null || !("scope" in hello))
        return fail(hostError("hello-invalid", "Expected host scope"));
      state.hellos.push(hello);
      if (state.older) {
        res.close(4400, "hello-invalid");
        return fail(hostError("hello-invalid", "N-1 peer"));
      }
      const grant = await auth.verifier.verify({
        scope: "host",
        credential: hello.credential,
        nonce: hello.nonce,
        client: hello.client,
      });
      if (grant === null || !("scope" in grant.actor)) {
        res.close(4401, "credential-invalid");
        return fail(hostError("credential-invalid", "Not enrolled"));
      }
      const verdict = negotiateWelcome(
        hello,
        {
          scope: "host",
          host: { id: state.hostId, version: "1" },
          protocol: { min: 1, max: 1 },
          features: [],
        },
        grant.actor,
      );
      if (!verdict.ok) return fail(verdict.error);
      return { welcome: verdict.welcome };
    },
  });
  cleanups.push(async () => {
    handler.broadcastReconnectNotification();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options: HostScopeLinkOptions = {
    url,
    hostId: HOST,
    features: [],
    client: { kind: "desktop", version: "test" },
    WebSocket: NodeWebSocket as unknown as typeof WebSocket,
    credential: () =>
      mintDeviceCredential({
        privateKeyPem: key.privateKeyPem,
        hostId: HOST,
        deviceId: DEVICE,
        scope: "host",
        now: Date.now(),
      }),
    timing: {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 100,
      backoffBaseMs: 20,
      backoffCapMs: 40,
    },
  };
  const create = (override: Partial<HostScopeLinkOptions> = {}) => {
    const link = createHostScopeLink({ ...options, ...override });
    cleanups.push(() => link.close());
    return link;
  };
  return { state, server, options, auth, create };
}
async function until(link: HostScopeLink, status: string): Promise<void> {
  if (link.getState().status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      detach();
      reject(new Error(`Wanted ${status}, got ${link.getState().status}`));
    }, 2_000);
    const detach = link.subscribeState((state) => {
      if (state.status === status) {
        clearTimeout(timer);
        detach();
        resolve();
      }
    });
  });
}

describe("host-scope link shares transport without Workspace wire fields", () => {
  it("is renderer-safe, validates its pinned id, and sends query/mutate/subscription only after welcome", async () => {
    const f = await host();
    expect(() => createHostScopeLink({ ...f.options, hostId: "invalid" })).toThrow("pinned host");
    const logs: unknown[] = [];
    const link = f.create({ log: (event) => logs.push(event) });
    expect(link.hostId).toBe(HOST);
    expect(link).not.toHaveProperty("workspaceId");
    await expect(link.mutate("mutate", "must not queue")).rejects.toMatchObject({
      hostError: { reason: "host-unreachable" },
    });
    const received: unknown[] = [];
    link.subscribe("feed", undefined, {
      onData: (data, cursor) => received.push([data, cursor]),
      onError: (error) => {
        throw error;
      },
      onResnapshot: () => {},
    });
    await until(link, "ready");
    expect(logs).toContainEqual(
      expect.objectContaining({ kind: "state", to: "ready", hostId: HOST }),
    );
    expect(logs.at(-1) as Record<string, unknown>).not.toHaveProperty("epoch");
    expect(f.state.hellos[0]).not.toHaveProperty("workspaceId");
    expect(f.state.hellos[0]).not.toHaveProperty("lastSeen");
    expect(await link.query("query")).toBe("host query");
    expect(await link.mutate("mutate", "sent")).toBe("sent");
    expect(f.state.mutations).toEqual(["sent"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([[{ id: "1", data: "host event" }, { id: "1" }]]);
  });

  it("fails closed for another pinned host before ready, and proof refusal never opens traffic", async () => {
    const f = await host();
    f.state.hostId = OTHER;
    const link = f.create();
    await until(link, "refused");
    expect(link.getState()).toMatchObject({ error: { reason: "welcome-invalid" } });
    f.state.hostId = HOST;
    const proof = hostError("welcome-invalid", "Pinned proof failed");
    const refused = f.create({ verifyProof: () => proof });
    await until(refused, "refused");
    expect(refused.getState()).toMatchObject({ error: proof });
    const accepted = f.create({
      verifyProof: (welcome, hello) => {
        expect(welcome.scope).toBe("host");
        expect(hello.scope).toBe("host");
        return null;
      },
    });
    await until(accepted, "ready");
  });

  it.each(["missing", "unavailable", "credentials", "malformed", "older"] as const)(
    "classifies %s bootstrap/refusal without treating auth as N-1",
    async (mode) => {
      const f = await host();
      f.state.older = mode === "older";
      f.state.missing = mode === "missing";
      f.state.malformed = mode === "malformed";
      if (mode === "unavailable")
        f.state.error = hostError("operation-unavailable", "No host bootstrap");
      if (mode === "credentials") f.auth.enrolled.delete(DEVICE);
      const link = f.create();
      await until(link, mode === "missing" || mode === "unavailable" ? "unreachable" : "refused");
      if (mode === "older")
        expect(link.getState()).toHaveProperty("compatibility", "host-scope-unsupported");
      else expect(link.getState()).not.toHaveProperty("compatibility");
      expect(link.getState()).toMatchObject({
        error:
          mode === "missing"
            ? { code: "NOT_FOUND" }
            : {
                reason:
                  mode === "unavailable"
                    ? "operation-unavailable"
                    : mode === "credentials"
                      ? "credential-invalid"
                      : mode === "older"
                        ? "hello-invalid"
                        : "welcome-invalid",
              },
      });
    },
  );

  it("never probes or downgrades a named Workspace refusal carrying NOT_FOUND", async () => {
    const f = await host();
    f.state.error = hostError("workspace-unknown", "No Workspace");
    const paths: string[] = [];
    f.server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { params?: { path: string } };
        if (request.params !== undefined) paths.push(request.params.path);
      }),
    );
    const link = f.create();
    await until(link, "refused");
    expect(link.getState()).toMatchObject({ error: { reason: "workspace-unknown" } });
    expect(link.getState()).not.toHaveProperty("compatibility");
    expect(paths).toEqual(["protocol.hostWelcome"]);
  });

  it("tags the frozen actual pre-VC-722 refusal through the production transport", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../fixtures/pre-vc722-host-refusal.json", import.meta.url), "utf8"),
    ) as {
      received: { id: number; error: unknown }[];
      close: { code: number; reason: string };
    };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 5385 });
    await once(server, "listening");
    const paths: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id?: number; params?: { path: string } };
        if (request.id === undefined) return;
        paths.push(request.params!.path);
        if (request.params!.path === "protocol.hostWelcome") {
          // The frozen old router has no HOST bootstrap procedure. Its
          // NOT_FOUND is not the hello refusal and must not retire/downgrade.
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32004,
                message: "No procedure found on path protocol.hostWelcome",
                data: { code: "NOT_FOUND", httpStatus: 404, path: "protocol.hostWelcome" },
              },
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ ...fixture.received[0], id: request.id }));
        socket.close(fixture.close.code, fixture.close.reason);
      });
    });
    cleanups.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const link = createHostScopeLink({
      url: "ws://127.0.0.1:5385",
      hostId: HOST,
      features: [],
      client: { kind: "desktop", version: "test" },
      credential: () => "fixture",
      WebSocket: NodeWebSocket as unknown as typeof WebSocket,
    });
    cleanups.push(() => link.close());
    await until(link, "refused");
    expect(paths).toEqual(["protocol.hostWelcome", "protocol.welcome"]);
    expect(link.getState()).toMatchObject({
      compatibility: "host-scope-unsupported",
      error: { code: "BAD_REQUEST", reason: "hello-invalid" },
    });
  });

  it("drops late credentials and welcomes after close, and reconnects with new signed statements", async () => {
    const f = await host();
    let deliver!: (credential: string) => void;
    const pending = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const closed = f.create({ credential: () => pending });
    closed.close();
    deliver(await f.options.credential());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.server.clients.size).toBe(0);
    let welcome!: () => void;
    f.state.hold = new Promise<void>((resolve) => {
      welcome = resolve;
    });
    const late = f.create();
    await new Promise((resolve) => setTimeout(resolve, 10));
    late.close();
    welcome();
    expect(late.getState().status).toBe("closed");
    f.state.hold = null;
    const live = f.create();
    await until(live, "ready");
    const first = f.auth.accepted.at(-1)!.claims.jti;
    for (const socket of f.server.clients) socket.terminate();
    await until(live, "unreachable");
    await until(live, "ready");
    expect(f.auth.accepted.at(-1)!.claims.jti).not.toBe(first);
    expect(f.state.hellos.at(-1)!.nonce).not.toBe(f.state.hellos.at(-2)!.nonce);
  });
});
