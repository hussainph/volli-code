import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { browserIslandAgentsApi, islandAgentsApi } from "./island-agents-api";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({ sessionRpcClient: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
});
