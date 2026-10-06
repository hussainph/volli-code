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
import { type HandlerCall, type WorktreeTrimSettings } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { LOCAL_DESKTOP_CALLER, type RouterCaller } from "./catalog";
import {
  createDesktopRouter,
  desktopProcedureSchemas,
  type DesktopRouter,
  type DesktopRouterContext,
} from "./desktop-router";
import { RpcDiagnosticLog } from "./index";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TRIM: WorktreeTrimSettings = { keepPatterns: [".env"], trimOnFinish: true };

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
      "project.reorder": (input, call) => {
        fixture.calls.push({ key: "project.reorder", input, call });
        return null;
      },
      "worktree.trimSettings": (input, call) => {
        fixture.calls.push({ key: "worktree.trimSettings", input, call });
        return TRIM;
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
      expect(await client.worktree.trimSettings.query()).toEqual(TRIM);
      expect(await client.project.reorder.mutate({ orderedIds: ["b", "a"] })).toBeNull();
      const window = { actor: { kind: "user" }, origin: "desktop-window" };
      expect(fixture.calls).toEqual([
        { key: "worktree.trimSettings", input: undefined, call: window },
        { key: "project.reorder", input: { orderedIds: ["b", "a"] }, call: window },
      ]);
    });

    // Placement-derived policy: host-placed, so device-as-user, and on no
    // network door. A paired device and a Session are refused before input.
    it("refuses every network caller, whatever its Workspace, before the handler", async () => {
      for (const caller of [device, session]) {
        const fixture = host(caller);
        const client = await connect(fixture);
        expect(await expectHostError(client.worktree.trimSettings.query())).toEqual({
          code: "FORBIDDEN",
          message: "worktree.trimSettings is not open to this caller.",
          reason: "verb-refused",
        });
        expect(
          await expectHostError(client.project.reorder.mutate({ orderedIds: [WORKSPACE] })),
        ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
        expect(fixture.calls).toEqual([]);
      }
    });

    it("validates input before the handler, on every link", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(
        await expectHostError(
          client.project.reorder.mutate({ orderedIds: [2] as unknown as string[] }),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
      expect(fixture.calls).toEqual([]);
    });
  },
);

describe("the desktop router's grammar", () => {
  it("publishes both validators of every desktop-only procedure", () => {
    const schemas = desktopProcedureSchemas();
    expect(Object.keys(schemas).toSorted()).toEqual(["project.reorder", "worktree.trimSettings"]);
    expect(schemas["worktree.trimSettings"]).toMatchObject({
      type: "query",
      noInput: true,
      outputValidation: "network-and-tests",
    });
    expect(schemas["project.reorder"]).toMatchObject({
      type: "mutation",
      outputValidation: "network-and-tests",
    });
  });
});
