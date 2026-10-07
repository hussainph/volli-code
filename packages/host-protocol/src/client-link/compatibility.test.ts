import { once } from "node:events";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { createHostRouter, RpcDiagnosticLog } from "../../../session-rpc/src/index";
import { startHostProtocolListener } from "../../../session-rpc/src/websocket-server";
import { hostError, readHostError } from "../errors";
import { classifyHandshakeFailure, createHostScopeLink } from "./index";

const preModelDefaults = JSON.parse(
  readFileSync(new URL("../../fixtures/pre-vc729-host-models.json", import.meta.url), "utf8"),
) as {
  sourceRevision: string;
  received: [
    { id: number; result: { data: { host: { id: string }; features: string[] } } },
    { id: number; error: { data: unknown } },
  ];
};

const refusal = JSON.parse(
  readFileSync(new URL("../../fixtures/pre-vc722-host-refusal.json", import.meta.url), "utf8"),
) as {
  sent: unknown[];
  received: { error: { data: unknown } }[];
  close: { code: number; reason: string };
};
const workspace = JSON.parse(
  readFileSync(new URL("../../fixtures/pre-vc722-workspace.json", import.meta.url), "utf8"),
) as {
  sent: unknown[];
  requestedFeatures: string[];
  received: {
    result: {
      data: {
        host: { id: string; version: string };
        workspace: { id: string; epoch: number };
        actor: { kind: "device"; deviceId: string; workspaceId: string };
        features: string[];
      };
    };
  }[];
};

/** This frozen driver sends the actual old client's frames unchanged. No
 * current hello builder, feature negotiation or welcome serializer participates. */
async function exchange(url: string, sent: unknown[]) {
  const socket = new WebSocket(`${url}?connectionParams=1`);
  const message = once(socket, "message");
  await once(socket, "open");
  for (const frame of sent) socket.send(JSON.stringify(frame));
  const [data] = await message;
  return { socket, received: JSON.parse(data.toString()) as unknown };
}

describe("frozen pre-VC-729 host model compatibility", () => {
  it("reads the independently captured old host welcome through a real host scope link", async () => {
    expect(preModelDefaults.sourceRevision).toBe("49fc56278edba86607999b7c1d366e87ac02a800");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("No fixture port");
    const paths: string[] = [];
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id?: number; params?: { path: string } };
        if (!request.params) return;
        paths.push(request.params.path);
        const recorded =
          request.params.path === "protocol.hostWelcome"
            ? preModelDefaults.received[0]
            : preModelDefaults.received[1];
        socket.send(JSON.stringify({ ...recorded, id: request.id }));
      }),
    );
    const link = createHostScopeLink({
      url: `ws://127.0.0.1:${address.port}`,
      hostId: preModelDefaults.received[0].result.data.host.id,
      client: { kind: "desktop", version: "head" },
      features: ["host.workspaces", "host.model-defaults"],
      credential: () => "fixture-not-a-secret",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error("Old peer did not become ready"));
        }, 3000);
        const stop = link.subscribeState((state) => {
          if (state.status !== "ready") return;
          clearTimeout(timer);
          stop();
          resolve();
        });
      });
      const welcome = await link.query("protocol.hostWelcome");
      expect(welcome).toEqual(preModelDefaults.received[0].result.data);
      const state = link.getState();
      expect(state.status === "ready" && state.welcome.features).toEqual(["host.workspaces"]);
      // Absence is the compatibility decision, not a trial call or spinner.
      expect(paths.every((path) => path === "protocol.hostWelcome")).toBe(true);
      expect(readHostError({ data: preModelDefaults.received[1].error.data })).toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      link.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("frozen pre-VC-722 wire compatibility", () => {
  it("reads the actual old host refusal envelope and close, only tagging a host attempt unsupported", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 5383 });
    await once(server, "listening");
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id?: number };
        if (request.id !== 1) return;
        socket.send(JSON.stringify(refusal.received[0]));
        socket.close(refusal.close.code, refusal.close.reason);
      });
    });
    try {
      const { socket, received } = await exchange("ws://127.0.0.1:5383", refusal.sent);
      const [code, closeReason] = await once(socket, "close");
      expect(received).toEqual(refusal.received[0]);
      expect({ code, reason: closeReason.toString() }).toEqual(refusal.close);
      const error = readHostError({ data: refusal.received[0]!.error.data });
      expect(classifyHandshakeFailure(error, code, "host")).toEqual({
        status: "refused",
        error,
        closeCode: 4400,
        compatibility: "host-scope-unsupported",
      });
      expect(classifyHandshakeFailure(error, null, "host")).toMatchObject({
        status: "refused",
        compatibility: "host-scope-unsupported",
      });
      expect(classifyHandshakeFailure(error, 4401, "host")).not.toHaveProperty("compatibility");
      expect(classifyHandshakeFailure(error, code, "workspace")).toEqual({
        status: "refused",
        error,
        closeCode: 4400,
      });
      for (const reason of [
        "credential-invalid",
        "workspace-unknown",
        "protocol-version-unsupported",
      ] as const) {
        expect(
          classifyHandshakeFailure(hostError(reason, "Fixture refusal"), code, "host"),
        ).not.toHaveProperty("compatibility");
      }
      expect(
        classifyHandshakeFailure({ code: "BAD_REQUEST", message: "Generic failure" }, code, "host"),
      ).toMatchObject({ status: "unreachable" });
      expect(
        classifyHandshakeFailure(hostError("workspace-epoch-fenced", "Fence"), code, "host"),
      ).toMatchObject({ status: "fenced" });
      // Even a malformed mismatched envelope is not evidence of this refusal.
      expect(
        classifyHandshakeFailure({ ...error, code: "UNAUTHORIZED" }, code, "host"),
      ).not.toHaveProperty("compatibility");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves the unchanged old Workspace request, grants and welcome through the new real listener", async () => {
    const oldWelcome = workspace.received[0]!.result.data;
    const listener = await startHostProtocolListener({
      router: createHostRouter(),
      bind: { host: "127.0.0.1", port: 5384 },
      host: oldWelcome.host,
      // A new feature must not leak into the old request's grants.
      features: [...oldWelcome.features, "host.workspaces", "host.model-defaults"],
      workspace: (id) => (id === oldWelcome.workspace.id ? oldWelcome.workspace : null),
      verifier: { verify: async () => ({ actor: oldWelcome.actor, current: () => true }) },
      context: () => ({ handlers: {} as never, diagnostics: new RpcDiagnosticLog() }),
    });
    let socket: WebSocket | undefined;
    try {
      const answer = await exchange(listener.url, workspace.sent);
      socket = answer.socket;
      expect(answer.received).toEqual(workspace.received[0]);
      expect(oldWelcome.features).toEqual(["sessions", "board.read", "sign-ins", "host.logs"]);
      expect(workspace.requestedFeatures).toContain("future.feature");
      expect(oldWelcome.features).not.toContain("future.feature");
      expect(oldWelcome).not.toHaveProperty("scope");
    } finally {
      socket?.close();
      await listener.close();
    }
  });
});
