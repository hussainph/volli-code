import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { createSessionRouter, RpcDiagnosticLog, type AppRouter } from "./index";
import { sessionHandlersFrom, type LegacySessionPorts } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";

/** What the Session router alone serves: every v1 feature but the board's (VC-565). */
const SESSION_ROUTER_FEATURES = HOST_V1_FEATURES.filter(
  (feature) => !feature.startsWith("board.") && feature !== "host.workspaces",
);
const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const DEVICE = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";

async function connection(features: readonly string[]) {
  const read = vi.fn<NonNullable<LegacySessionPorts["readSessionVerb"]>>(async (verb) => ({
    v: 1,
    ok: true,
    data: verb === "session.list" ? { sessions: [], hidden: 0 } : { text: "read" },
  }));
  const listener = await startHostProtocolListener({
    router: createSessionRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "feature-contract" },
    workspace: () => ({ id: WORKSPACE, epoch: 1 }),
    verifier: {
      verify: async () => ({
        actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
        current: () => true,
      }),
    },
    features: SESSION_ROUTER_FEATURES,
    context: () => ({
      handlers: sessionHandlersFrom({ runtime: {}, readSessionVerb: read }),
      diagnostics: new RpcDiagnosticLog(),
    }),
  });
  const hello = buildHostHello({
    client: { kind: "desktop", version: "feature-contract" },
    workspaceId: WORKSPACE,
    lastSeen: null,
    features,
    credential: "test-only-credential",
  });
  const socket = createWSClient({ url: listener.url, connectionParams: encodeHostHello(hello) });
  const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: socket })] });
  return {
    client,
    read,
    async close() {
      await socket.close();
      await listener.close();
    },
  };
}

async function expectFeatureRefusal(call: Promise<unknown>) {
  expect(await expectHostError(call)).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
}

describe("fixed features at the production listener", () => {
  it("keeps bootstrap available but gates every feature before malformed input parsing", async () => {
    const f = await connection(["unknown.requested.feature"]);
    try {
      expect((await f.client.protocol.welcome.query()).features).toEqual([]);
      const raw = getUntypedClient(f.client);
      expect(HOST_FEATURE_OPERATIONS.sessions).toContain("sessions.create");
      expect(HOST_FEATURE_OPERATIONS["session.read"]).toContain("session.list");
      expect(HOST_FEATURE_OPERATIONS["model-access"]).toContain("modelAccess.inspect");
      await expectFeatureRefusal(raw.mutation("sessions.create", {}));
      await expectFeatureRefusal(raw.query("session.list", {}));
      await expectFeatureRefusal(raw.query("modelAccess.inspect", { refresh: "invalid" }));
      const stream = recordSubscription((handlers) =>
        raw.subscription("session.subscribe", {}, handlers),
      );
      try {
        expect(await stream.ended).toMatchObject({
          kind: "error",
          error: { code: "FORBIDDEN", reason: "verb-refused" },
        });
      } finally {
        stream.unsubscribe();
      }
      expect(f.read).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("grants exactly the Session read set, not Session controls or Model Access", async () => {
    const f = await connection(["session.read", "future.area"]);
    try {
      expect((await f.client.protocol.welcome.query()).features).toEqual(["session.read"]);
      await f.client.session.list.query({ projectId: WORKSPACE });
      await f.client.session.show.query({ projectId: WORKSPACE, session: "handle" });
      await f.client.session.peek.query({ projectId: WORKSPACE, session: "handle" });
      await f.client.session.answer.query({ projectId: WORKSPACE, session: "handle" });
      expect(f.read.mock.calls.map(([verb]) => verb)).toEqual(
        HOST_FEATURE_OPERATIONS["session.read"],
      );
      const raw = getUntypedClient(f.client);
      await expectFeatureRefusal(raw.query("session.snapshot", {}));
      await expectFeatureRefusal(raw.mutation("session.command", {}));
      await expectFeatureRefusal(raw.query("modelAccess.inspect", {}));
      expect(f.read).toHaveBeenCalledTimes(4);
    } finally {
      await f.close();
    }
  });

  it("refuses an unknown server offer before publishing a listener", async () => {
    await expect(
      startHostProtocolListener({
        router: createSessionRouter(),
        bind: { host: "127.0.0.1", port: 0 },
        host: { id: HOST, version: "test" },
        workspace: () => null,
        verifier: { verify: async () => null },
        context: () => ({
          handlers: sessionHandlersFrom({ runtime: {} }),
          diagnostics: new RpcDiagnosticLog(),
        }),
        features: ["future.area"],
      }),
    ).rejects.toThrow("Unknown offered host feature: future.area");
  });
});
