import { describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { runnerSetup } from "./runner-setup";

describe("Runner setup transport", () => {
  it("uses the person client and generated references, never a runner credential", async () => {
    const cloud = fakeCloud();
    const action = vi.fn(
      async (_reference: Parameters<typeof getFunctionName>[0], _args: unknown) => ({
        installTokenId: "id",
        installToken: "vrt_test",
        expiresAt: 100,
      }),
    );
    const setup = runnerSetup(() => ({
      ...cloud.session,
      client: { ...cloud.session.client, action: action as never },
    }));
    await setup.create(" box ");
    expect(getFunctionName(action.mock.calls[0]![0]!)).toBe("runners:createInstallToken");
    expect(action.mock.calls[0]![1]).toEqual({ nameHint: "box", defaultWorkspaceId: null });
    const revoke = setup.revoke("id");
    expect(cloud.mutations[0]).toMatchObject({
      name: "runners:revokeInstallToken",
      args: { installTokenId: "id" },
    });
    cloud.mutations[0]!.resolve(null);
    await revoke;
    const preview = setup.preview("ABCD-EFGH");
    expect(cloud.mutations[1]).toMatchObject({
      name: "runners:previewLink",
      args: { userCode: "ABCD-EFGH" },
    });
    cloud.mutations[1]!.resolve({ ok: false, code: "not_found" });
    await preview;
    const decide = setup.decide("request", "ABCD-EFGH", "approve");
    expect(cloud.mutations[2]).toMatchObject({
      name: "runners:decideLink",
      args: { requestId: "request", userCode: "ABCD-EFGH", decision: "approve" },
    });
    cloud.mutations[2]!.resolve({ ok: true });
    await decide;
  });

  it("subscribes to token status, surfaces read errors and unsubscribes", () => {
    const cloud = fakeCloud();
    const setup = runnerSetup(() => cloud.session);
    const receive = vi.fn();
    const fail = vi.fn();
    const stop = setup.watch("id", receive, fail);
    const args = { installTokenId: "id" };
    expect(cloud.watchers("runners:installTokenStatus", args)).toBe(1);
    cloud.answer("runners:installTokenStatus", args, {
      state: "waiting",
      expiresAt: 100,
      runner: null,
    });
    expect(receive).toHaveBeenCalledWith({ state: "waiting", expiresAt: 100, runner: null });
    cloud.fail("runners:installTokenStatus", args, new Error("read failed"));
    expect(fail).toHaveBeenCalledOnce();
    stop();
    expect(cloud.watchers("runners:installTokenStatus", args)).toBe(0);
  });

  it("refuses writes when signed out or disconnected", () => {
    const setup = runnerSetup(() => null);
    expect(() => setup.create("box")).toThrow("Not connected");
    expect(() => setup.preview("code")).toThrow("Not connected");
    const cloud = fakeCloud();
    cloud.connected = false;
    expect(() => runnerSetup(() => cloud.session).revoke("id")).toThrow("Not connected");
    const fail = vi.fn();
    setup.watch("id", vi.fn(), fail)();
    expect(fail).toHaveBeenCalledOnce();
  });
});
