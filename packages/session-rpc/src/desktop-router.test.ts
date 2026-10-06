/**
 * The desktop-only tier's policy, judged by the router the same way over both
 * links (VC-608): the generic IPC bridge and a real WebSocket, one set of
 * cases (`describeContract`), no procedure list of their own.
 */
import {
  describeContract,
  expectHostError,
  ipcContractLink,
  webSocketContractLink,
} from "@volli/host-protocol/testing";
import { type HandlerCall, type Label } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { LOCAL_DESKTOP_CALLER, PROJECT_RESOURCE, type RouterCaller } from "./catalog";
import {
  createDesktopRouter,
  desktopProcedureSchemas,
  LABEL_RESOURCE,
  type DesktopRouter,
  type DesktopRouterContext,
} from "./desktop-router";
import { RpcDiagnosticLog } from "./index";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const BUG: Label = { id: "label-1", projectId: WORKSPACE, name: "bug", color: null };

interface Host {
  readonly caller: RouterCaller;
  readonly calls: { key: string; input: unknown; call: HandlerCall }[];
}

function host(caller: RouterCaller): Host {
  return { caller, calls: [] };
}

function context(fixture: Host): DesktopRouterContext {
  return {
    caller: fixture.caller,
    diagnostics: new RpcDiagnosticLog(),
    // Every resource this host knows is in the one Workspace, so a refusal
    // below is the entry's policy, never the Workspace check.
    resourceWorkspace: () => WORKSPACE,
    handlers: {
      "ticket.body": (input, call) => {
        fixture.calls.push({ key: "ticket.body", input, call });
        return input.ticketId === "ticket-1" ? "# Scope" : null;
      },
      "label.setColor": (input, call) => {
        fixture.calls.push({ key: "label.setColor", input, call });
        return input.labelId === BUG.id ? { ...BUG, color: input.color } : null;
      },
    },
  };
}

const device: RouterCaller = {
  actor: {
    kind: "device",
    deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
    workspaceId: WORKSPACE,
  },
  current: () => true,
};
const session: RouterCaller = {
  actor: { kind: "session", sessionId: "session-1", workspaceId: WORKSPACE },
  current: () => true,
};

describeContract<Host, DesktopRouter>(
  "the desktop-only tier",
  [
    ipcContractLink({ router: createDesktopRouter(), createContext: context }),
    webSocketContractLink({ router: createDesktopRouter(), createContext: context }),
  ],
  ({ connect }) => {
    it("serves the desktop's own window, as the person, through the host's map", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(await client.ticket.body.query({ ticketId: "ticket-1" })).toBe("# Scope");
      expect(await client.ticket.body.query({ ticketId: "gone" })).toBeNull();
      expect(await client.label.setColor.mutate({ labelId: BUG.id, color: "#123456" })).toEqual({
        ...BUG,
        color: "#123456",
      });
      expect(await client.label.setColor.mutate({ labelId: "gone", color: null })).toBeNull();
      expect(fixture.calls.map(({ key, call }) => [key, call])).toEqual([
        ["ticket.body", { actor: { kind: "user" }, origin: "desktop-window" }],
        ["ticket.body", { actor: { kind: "user" }, origin: "desktop-window" }],
        ["label.setColor", { actor: { kind: "user" }, origin: "desktop-window" }],
        ["label.setColor", { actor: { kind: "user" }, origin: "desktop-window" }],
      ]);
    });

    // Placement-derived policy: the person's, on no network door. A paired
    // device in the very Workspace, and a Session, are refused before input.
    it("refuses every network caller, whatever its Workspace, before the handler", async () => {
      for (const caller of [device, session]) {
        const fixture = host(caller);
        const client = await connect(fixture);
        expect(await expectHostError(client.ticket.body.query({ ticketId: "ticket-1" }))).toEqual({
          code: "FORBIDDEN",
          message: "ticket.body is not open to this caller.",
          reason: "verb-refused",
        });
        expect(
          await expectHostError(client.label.setColor.mutate({ labelId: BUG.id, color: null })),
        ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
        expect(fixture.calls).toEqual([]);
      }
    });

    it("validates input before the handler, on every link", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(
        await expectHostError(client.label.setColor.mutate({ labelId: "", color: null })),
      ).toMatchObject({ code: "BAD_REQUEST" });
      expect(fixture.calls).toEqual([]);
    });
  },
);

describe("the desktop router's grammar", () => {
  it("names a ticket and a label as its Workspace resources", () => {
    expect(LABEL_RESOURCE).toBe("label");
    expect(LABEL_RESOURCE).not.toBe(PROJECT_RESOURCE);
  });

  it("publishes both validators of every desktop-only procedure", () => {
    const schemas = desktopProcedureSchemas();
    expect(Object.keys(schemas).toSorted()).toEqual(["label.setColor", "ticket.body"]);
    expect(schemas["ticket.body"]).toMatchObject({
      type: "query",
      outputValidation: "network-and-tests",
    });
    expect(schemas["label.setColor"]).toMatchObject({
      type: "mutation",
      outputValidation: "network-and-tests",
    });
  });
});
