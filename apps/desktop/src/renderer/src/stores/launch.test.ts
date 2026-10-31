import { afterEach, expect, it } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch, cloudAccountScope, cloudLaunchNow, launchStore } from "./launch";

afterEach(() => adoptLaunch(LOCAL_LAUNCH));
it("keeps local Drafts outside every cloud account scope", () => {
  adoptLaunch(LOCAL_LAUNCH);
  expect(launchStore()).toBe("local");
  expect(cloudLaunchNow()).toBeNull();
  expect(cloudAccountScope()).toBeNull();
});
it("scopes client Drafts by both backend and person", () => {
  const launch = {
    store: "cloud" as const,
    backendUrl: "https://one.convex.cloud",
    userId: "person",
  };
  adoptLaunch(launch);
  expect(launchStore()).toBe("cloud");
  expect(cloudLaunchNow()).toEqual(launch);
  const first = cloudAccountScope();
  expect(first).toBe(JSON.stringify([launch.backendUrl, launch.userId]));
  adoptLaunch({ ...launch, userId: "other" });
  expect(cloudAccountScope()).not.toBe(first);
  adoptLaunch({ ...launch, backendUrl: "https://two.convex.cloud" });
  expect(cloudAccountScope()).not.toBe(first);
});
