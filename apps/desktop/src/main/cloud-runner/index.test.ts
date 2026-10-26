import { describe, expect, it } from "vite-plus/test";

import { LOCAL_LAUNCH, OperationUnavailableError, THIS_MAC_RUNNER_OFF } from "@volli/shared";

import { chooseProductStore } from "../cloud-launch";
import { runnerAccountPort, thisMacRunnerLaunch } from "./index";
import type { MacRunner } from "./mac-runner";

describe("which launch makes this Mac a runner", () => {
  it("only a Volli Cloud launch with an HTTP actions origin; a local (and every flag-off) launch composes nothing", () => {
    expect(thisMacRunnerLaunch(LOCAL_LAUNCH)).toBeNull();
    // Main's own boot decision with the flag off: no marker is read, nothing is composed.
    const flagOff = chooseProductStore({
      cloudFlag: false,
      readMarker: () => {
        throw new Error("a flag-off boot reads no marker");
      },
      backendUrl: "https://a.convex.cloud",
      signInConfigured: true,
    });
    expect(thisMacRunnerLaunch(flagOff)).toBeNull();
    const cloud = { store: "cloud", userId: "u", backendUrl: "https://a.convex.cloud" } as const;
    expect(thisMacRunnerLaunch(cloud)).toBeNull();
    expect(thisMacRunnerLaunch({ ...cloud, siteUrl: "https://a.convex.site" })).toEqual({
      userId: "u",
      backendUrl: "https://a.convex.cloud",
      siteUrl: "https://a.convex.site",
    });
  });
});

describe("the runners port", () => {
  it("refuses with the flag off, answers off without a runner, and passes through to one", async () => {
    let enabled = false;
    const off = runnerAccountPort(null, () => enabled);
    expect(() => off.thisMac()).toThrow(OperationUnavailableError);
    enabled = true;
    expect(off.thisMac()).toBe(THIS_MAC_RUNNER_OFF);
    const seen: unknown[] = [];
    (off.subscribeThisMac((snapshot) => seen.push(snapshot)) as () => void)();
    expect(seen).toEqual([THIS_MAC_RUNNER_OFF]);
    expect(() => off.addThisMac()).toThrow("Sign in");
    expect(() => off.removeThisMac()).toThrow("Sign in");

    const calls: string[] = [];
    const runner = {
      snapshot: () => ({ ...THIS_MAC_RUNNER_OFF, state: "online" }),
      subscribe: () => () => {},
      addThisMac: async () => void calls.push("add"),
      removeThisMac: async () => void calls.push("remove"),
    } as unknown as MacRunner;
    const on = runnerAccountPort(runner, () => enabled);
    expect((on.thisMac() as { state: string }).state).toBe("online");
    await on.addThisMac();
    await on.removeThisMac();
    expect(typeof on.subscribeThisMac(() => {})).toBe("function");
    expect(calls).toEqual(["add", "remove"]);
  });
});
