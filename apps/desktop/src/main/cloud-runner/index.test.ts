import { describe, expect, it } from "vite-plus/test";

import { LOCAL_LAUNCH, OperationUnavailableError, THIS_MAC_RUNNER_OFF } from "@volli/shared";

import { resolveRunnerSiteUrl, runnerAccountPort, thisMacRunnerLaunch } from "./index";
import type { MacRunner } from "./mac-runner";

const resolve = (env: Record<string, string>, backendUrl: string | null, packaged = false) =>
  resolveRunnerSiteUrl({ env, packaged, backendUrl });

describe("the runner's HTTP actions origin", () => {
  it("is the deployment's .convex.site twin, or what an unpackaged build names", () => {
    expect(resolve({}, "https://happy-otter-1.convex.cloud")).toBe(
      "https://happy-otter-1.convex.site",
    );
    expect(
      resolve({ VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3211" }, "http://127.0.0.1:3210"),
    ).toBe("http://127.0.0.1:3211");
    expect(
      resolve({ VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3211" }, "https://a.convex.cloud", true),
    ).toBe("https://a.convex.site");
    expect(resolve({ VOLLI_CONVEX_SITE_URL: "nope" }, "http://127.0.0.1:3210")).toBeNull();
    expect(resolve({ VOLLI_CONVEX_SITE_URL: "ftp://x" }, null)).toBeNull();
    expect(resolve({}, "not a url")).toBeNull();
  });
});

describe("which launch makes this Mac a runner", () => {
  it("only a Volli Cloud launch with an HTTP actions origin; a local (and every flag-off) launch composes nothing", () => {
    expect(thisMacRunnerLaunch(LOCAL_LAUNCH, "https://a.convex.site")).toBeNull();
    const cloud = { store: "cloud", userId: "u", backendUrl: "https://a.convex.cloud" } as const;
    expect(thisMacRunnerLaunch(cloud, null)).toBeNull();
    expect(thisMacRunnerLaunch(cloud, "https://a.convex.site")).toEqual({
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
