import { describe, expect, it } from "vite-plus/test";

import {
  BARE_LAUNCHD_PATH,
  createLoginPathBootstrap,
  currentPathIsIncomplete,
  decideLoginPathAdoption,
  loginPathLogLine,
} from "./login-path-adoption";

describe("currentPathIsIncomplete", () => {
  it("is true for launchd's exact bare set", () => {
    expect(currentPathIsIncomplete(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin")).toBe(true);
  });

  it("is true when the current PATH is missing", () => {
    expect(currentPathIsIncomplete(undefined, "/opt/homebrew/bin")).toBe(true);
  });

  it("is true when the current PATH lacks an entry the login shell has", () => {
    expect(currentPathIsIncomplete("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/bin")).toBe(true);
  });

  it("is false when the current PATH already holds every entry the login shell has", () => {
    // A dev boot's PATH: rich, script-local dirs the login shell knows nothing
    // about, but not missing anything the login shell would add.
    expect(
      currentPathIsIncomplete(
        "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin",
        "/opt/homebrew/bin:/usr/bin",
      ),
    ).toBe(false);
  });

  it("is false when the two paths hold the same entries in a different order", () => {
    expect(
      currentPathIsIncomplete("/usr/bin:/opt/homebrew/bin", "/opt/homebrew/bin:/usr/bin"),
    ).toBe(false);
  });
});

describe("decideLoginPathAdoption", () => {
  it("reports the probe failure when the login shell could not answer", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, null)).toEqual({ kind: "probe-failed" });
  });

  it("reports the probe failure when the login shell answered with nothing", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "")).toEqual({ kind: "probe-failed" });
  });

  it("unions a login PATH ahead of what launchd handed the app", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin:/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      entryCount: 5,
    });
  });

  // "Kept because nothing changed" and "kept because the probe failed" used
  // to be one outcome and one log line, which is how adoption failure hid in
  // plain sight as health.
  it("distinguishes an already-complete PATH from a failed probe", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, BARE_LAUNCHD_PATH)).toEqual({
      kind: "already-complete",
    });
  });

  it("puts a login shell's directories ahead of a dev boot without dropping its private bin", () => {
    const rich = "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin";
    expect(decideLoginPathAdoption(rich, "/opt/homebrew/bin:/usr/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/repo/node_modules/.bin",
      entryCount: 3,
    });
  });

  it("deduplicates repeated directories while preserving login then current order", () => {
    expect(
      decideLoginPathAdoption(
        "/repo/node_modules/.bin:/usr/bin:/repo/node_modules/.bin",
        "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin",
      ),
    ).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/repo/node_modules/.bin",
      entryCount: 3,
    });
  });

  it("adopts when the current PATH is entirely unset", () => {
    expect(decideLoginPathAdoption(undefined, "/opt/homebrew/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin",
      entryCount: 1,
    });
  });
});

describe("loginPathLogLine", () => {
  it("names the entry count on adoption", () => {
    expect(
      loginPathLogLine({ kind: "adopted", path: "/opt/homebrew/bin:/usr/bin", entryCount: 2 }),
    ).toBe("[volli] PATH adopted from login shell (2 entries)");
  });

  it("says the healthy kept reason when the PATH was already complete", () => {
    expect(loginPathLogLine({ kind: "already-complete" })).toBe(
      "[volli] PATH kept (already complete)",
    );
  });

  it("names the probe failure instead of reading like health", () => {
    expect(loginPathLogLine({ kind: "probe-failed" })).toBe(
      "[volli] PATH kept (login shell probe failed)",
    );
  });
});

describe("createLoginPathBootstrap", () => {
  it("starts probing immediately but shares one deferred apply", async () => {
    let resolveProbe: ((path: string | null) => void) | undefined;
    let probeCount = 0;
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => BARE_LAUNCHD_PATH,
      writePath: (path) => mutations.push(path),
      resolveLoginPath: () => {
        probeCount += 1;
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      },
      log: (line) => logs.push(line),
    });

    expect(probeCount).toBe(1);
    expect(mutations).toEqual([]);
    expect(logs).toEqual([]);

    const firstApply = bootstrap.apply();
    const secondApply = bootstrap.apply();
    expect(secondApply).toBe(firstApply);

    resolveProbe?.("/opt/homebrew/bin:/usr/bin:/bin");
    await firstApply;

    expect(mutations).toEqual(["/profile/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"]);
    expect(logs).toEqual(["[volli] PATH adopted from login shell (5 entries)"]);
  });

  it("keeps a failed probe while deduplicating and re-prepending the profile bin", async () => {
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => "/usr/bin:/profile/bin:/bin:/profile/bin",
      writePath: (path) => mutations.push(path),
      resolveLoginPath: async () => Promise.reject(new Error("profile failed")),
      log: (line) => logs.push(line),
    });

    await expect(bootstrap.apply()).resolves.toEqual({ kind: "probe-failed" });
    await bootstrap.apply();

    expect(mutations).toEqual(["/profile/bin:/usr/bin:/bin"]);
    expect(logs).toEqual(["[volli] PATH kept (login shell probe failed)"]);
  });

  it("reports an already-complete PATH without pretending the probe failed", async () => {
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      // The login shell's own PATH, already leading: merging changes nothing,
      // which is the healthy dev-boot answer — not a probe failure.
      readCurrentPath: () => "/opt/homebrew/bin:/profile/bin",
      writePath: (path) => mutations.push(path),
      resolveLoginPath: async () => "/opt/homebrew/bin",
      log: (line) => logs.push(line),
    });

    await expect(bootstrap.apply()).resolves.toEqual({ kind: "already-complete" });
    expect(mutations).toEqual(["/profile/bin:/opt/homebrew/bin"]);
    expect(logs).toEqual(["[volli] PATH kept (already complete)"]);
  });
});
