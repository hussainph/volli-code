import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { remoteSessionClient } from "@renderer/lib/remote-session-wire";
import { rememberRemoteProject, resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import { sessionCommandFor, sessionPictureFor, setRemoteChatTransports } from "./transport";

function stubWindow() {
  vi.stubGlobal("window", {
    api: { sessionRpc: { request: vi.fn(), onEvent: () => () => undefined, cancel: vi.fn() } },
  });
}
afterEach(() => {
  resetRemoteOwnersForTest();
  vi.unstubAllGlobals();
});
describe("Session picture ownership", () => {
  it("loads local and remote pictures through their owning host and never falls back from a closed host", async () => {
    stubWindow();
    const answer = { data: "YWJj", mimeType: "image/png", nextOffset: null };
    vi.mocked(window.api.sessionRpc.request).mockResolvedValue({ ok: true, data: answer });
    const input = { sessionId: "s", pictureId: "pic", offset: 0 };
    expect(await sessionPictureFor(null)(input)).toEqual(answer);
    expect(window.api.sessionRpc.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "session.picture", input }),
    );
    vi.mocked(window.api.sessionRpc.request).mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "s" },
    });
    expect(
      await sessionCommandFor(null)({
        commandId: "stop-local",
        sessionId: "s",
        command: { kind: "session.stop" },
      }),
    ).toEqual({ sessionId: "s" });
    vi.mocked(window.api.sessionRpc.request).mockClear();
    rememberRemoteProject("remote", { hostId: "box", hostName: "box-1" });
    const query = vi.fn(async () => answer);
    const client = remoteSessionClient(
      { query, mutate: query, subscribe: () => ({ unsubscribe() {} }) },
      "box-1",
    );
    const unregister = setRemoteChatTransports({ forProject: () => null, clientFor: () => client });
    expect(await sessionPictureFor("remote")(input)).toEqual(answer);
    expect(query).toHaveBeenCalledWith("session.picture", input, {});
    expect(window.api.sessionRpc.request).not.toHaveBeenCalled();
    unregister();
    await expect(sessionPictureFor("remote")(input)).rejects.toThrow("box-1 isn’t connected");
    expect(window.api.sessionRpc.request).not.toHaveBeenCalled();
  });
});
