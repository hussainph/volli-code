import { describe, expect, it } from "vite-plus/test";
import { runnerInstallTarget } from "./runner-install-target";

const target = {
  appVersion: "0.3.0-canary.1",
  siteUrl: "https://default.convex.site",
  packagedSiteUrl: "https://default.convex.site",
};
describe("Runner install deployment", () => {
  it("omits --server only for the packaged deployment", () => {
    expect(runnerInstallTarget(target)).toEqual({ appVersion: target.appVersion, server: null });
    expect(runnerInstallTarget({ ...target, siteUrl: target.siteUrl + "/" })?.server).toBeNull();
    expect(runnerInstallTarget({ ...target, siteUrl: "https://staging.convex.site" })?.server).toBe(
      "https://staging.convex.site",
    );
    expect(runnerInstallTarget({ ...target, packagedSiteUrl: null })?.server).toBe(target.siteUrl);
    expect(runnerInstallTarget({ ...target, siteUrl: "http://127.0.0.1:3211" })?.server).toBe(
      "http://127.0.0.1:3211",
    );
  });
  it("does not guess absent metadata or expose local deployments", () => {
    expect(runnerInstallTarget({ ...target, appVersion: null })).toBeNull();
    expect(runnerInstallTarget({ ...target, siteUrl: null })).toBeNull();
    expect(runnerInstallTarget({ ...target, deployment: "local" })).toBeNull();
    expect(runnerInstallTarget({ ...target, appVersion: "1/../../latest" })).toBeNull();
    for (const siteUrl of [
      "bad-url",
      "http://box.example",
      "https://a:b@host",
      "https://host/path",
      "https://host/?token=secret",
    ])
      expect(runnerInstallTarget({ ...target, siteUrl })).toBeNull();
  });
});
