import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { browserIslandAgentsApi, islandAgentsApi } from "./island-agents-api";
import { setRemoteChatTransports } from "@renderer/chat/transport";
import { rememberRemoteProject, resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import type { RemoteSessionClient } from "@renderer/lib/remote-session-wire";
import { forgetSessionProject, rememberSessionProject } from "@renderer/lib/session-project";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({ sessionRpcClient: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetRemoteOwnersForTest();
  forgetSessionProject("remote-child");
});

const result = {
  sessionId: "child",
  receipt: null,
  throughSequence: 9,
  refusal: null,
  stop: {
    sessionId: "child",
    handle: "child",
    title: null,
    previouslyStopped: false,
    interrupted: true,
    released: false,
    failures: ["release failed"],
  },
};

describe("island agents stop door", () => {
  it("uses session.command and preserves the runtime failures", async () => {
    const command = vi.fn(async () => result);
    const api = islandAgentsApi(command, () => "command-1");
    expect(await api.stop({ sessionId: "child", reason: "Runaway" })).toEqual({
      ok: true,
      interrupted: true,
      released: false,
      failures: ["release failed"],
    });
    expect(command).toHaveBeenCalledWith({
      commandId: "command-1",
      sessionId: "child",
      command: { kind: "session.stop", reason: "Runaway" },
    });
    await api.stop({ sessionId: "child" });
    expect(command).toHaveBeenLastCalledWith({
      commandId: "command-1",
      sessionId: "child",
      command: { kind: "session.stop" },
    });
  });

  it("propagates a router refusal and refuses an outcome-less response", async () => {
    await expect(
      islandAgentsApi(
        async () => {
          throw new Error("not live");
        },
        () => "c",
      ).stop({ sessionId: "child" }),
    ).rejects.toThrow("not live");
    await expect(
      islandAgentsApi(
        async () => ({ ...result, stop: undefined }),
        () => "c",
      ).stop({ sessionId: "child" }),
    ).rejects.toThrow("no runtime outcome");
  });

  it("has no Electron fallback in a host without the RPC bridge", () => {
    vi.stubGlobal("window", undefined);
    expect(browserIslandAgentsApi()).toBeUndefined();
    vi.stubGlobal("window", {});
    expect(browserIslandAgentsApi()).toBeUndefined();
  });

  it("adapts the Electron RPC client, minting the command id at press time", async () => {
    const command = vi.fn(async () => result);
    vi.mocked(sessionRpcClient).mockReturnValue({
      session: { command: { mutate: command } },
    } as unknown as ReturnType<typeof sessionRpcClient>);
    vi.stubGlobal("window", { api: { sessionRpc: {} } });
    vi.stubGlobal("crypto", { randomUUID: () => "new-command" });
    await browserIslandAgentsApi()!.stop({ sessionId: "child" });
    expect(command).toHaveBeenCalledWith({
      commandId: "new-command",
      sessionId: "child",
      command: { kind: "session.stop" },
    });
  });

  it("stops a remote subagent on its host, never over This Mac's IPC (VC-713, B2)", async () => {
    const local = vi.fn(async () => result);
    vi.mocked(sessionRpcClient).mockReturnValue({
      session: { command: { mutate: local } },
    } as unknown as ReturnType<typeof sessionRpcClient>);
    vi.stubGlobal("window", { api: { sessionRpc: {} } });
    vi.stubGlobal("crypto", { randomUUID: () => "new-command" });
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    const remote = vi.fn(async (_input: { sessionId?: string }) => result);
    const client = { session: { command: { mutate: remote } } } as unknown as Pick<
      RemoteSessionClient,
      "session"
    >;
    const unregister = setRemoteChatTransports({
      forProject: () => null,
      clientFor: (projectId) => (projectId === "remote" ? client : null),
    });
    try {
      // A child no listing names lives where its parent's project does.
      await browserIslandAgentsApi("remote")!.stop({ sessionId: "unlisted-child" });
      // One the window knows is routed by its own project.
      rememberSessionProject("remote-child", "remote");
      await browserIslandAgentsApi("local")!.stop({ sessionId: "remote-child" });
      expect(remote.mock.calls.map(([input]) => input.sessionId)).toEqual([
        "unlisted-child",
        "remote-child",
      ]);
      expect(local).not.toHaveBeenCalled();
      // Its Workspace not bound now: refused in the host's name, still not local.
      unregister();
      await expect(
        browserIslandAgentsApi("remote")!.stop({ sessionId: "remote-child" }),
      ).rejects.toThrow("hetzner-1 isn’t connected");
      expect(local).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
