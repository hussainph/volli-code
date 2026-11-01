import { describe, expect, it } from "vite-plus/test";
import { runnerInstallTarget } from "./runner-install-target";

const target = {
  appVersion: "0.3.0-canary.1",
  backendUrl: "https://default.convex.cloud",
  siteUrl: "https://default.convex.site",
  packagedBackendUrl: "https://default.convex.cloud",
  packagedSiteUrl: "https://default.convex.site",
};
describe("Runner install deployment", () => {
  it("omits both origins only when the entire packaged deployment matches", () => {
    expect(runnerInstallTarget(target)).toEqual({
      appVersion: target.appVersion,
      server: null,
      site: null,
    });
    expect(
      runnerInstallTarget({
        ...target,
        backendUrl: target.backendUrl + "/",
        siteUrl: target.siteUrl + "/",
      }),
    ).toEqual({ appVersion: target.appVersion, server: null, site: null });
    for (const change of [
      { backendUrl: "https://staging.convex.cloud" },
      { siteUrl: "https://staging.convex.site" },
      { packagedBackendUrl: null },
      { packagedSiteUrl: null },
    ]) {
      const input = { ...target, ...change };
      expect(runnerInstallTarget(input)).toEqual({
        appVersion: target.appVersion,
        server: input.backendUrl,
        site: input.siteUrl,
      });
    }
  });
  it.each([
    ["https://staging.convex.cloud", "https://staging.convex.site"],
    ["https://backend.example", "https://actions.example"],
    ["http://127.0.0.1:3210", "http://127.0.0.1:3211"],
  ])("keeps the client and HTTP actions origins distinct (%s)", (backendUrl, siteUrl) => {
    expect(runnerInstallTarget({ ...target, backendUrl, siteUrl })).toEqual({
      appVersion: target.appVersion,
      server: backendUrl,
      site: siteUrl,
    });
  });
  it("does not guess absent metadata or expose local deployments", () => {
    expect(runnerInstallTarget({ ...target, appVersion: null })).toBeNull();
    expect(runnerInstallTarget({ ...target, backendUrl: null })).toBeNull();
    expect(runnerInstallTarget({ ...target, siteUrl: null })).toBeNull();
    expect(runnerInstallTarget({ ...target, deployment: "local" })).toBeNull();
    expect(runnerInstallTarget({ ...target, appVersion: "1/../../latest" })).toBeNull();
    for (const address of [
      "bad-url",
      "http://box.example",
      "https://a:b@host",
      "https://host/path",
      "https://host/?token=secret",
    ]) {
      expect(runnerInstallTarget({ ...target, backendUrl: address })).toBeNull();
      expect(runnerInstallTarget({ ...target, siteUrl: address })).toBeNull();
    }
  });
});
