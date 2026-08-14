import { describe, expect, it } from "vite-plus/test";

import {
  BARE_LAUNCHD_PATH,
  createLoginPathBootstrap,
  currentPathIsIncomplete,
  decideLoginPathAdoption,
  loginPathLogLine,
  parseLoginShellPathOutput,
  resolveLoginShellPath,
} from "./login-shell-path";

type ShellResult = { stdout: string; exitCode: number | null; signal: NodeJS.Signals | null };

function successful(stdout: string): ShellResult {
  return { stdout, exitCode: 0, signal: null };
}

/** A scripted shell, recording what it was asked to run. */
function shell(answer: () => Promise<ShellResult | null>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  return {
    calls,
    runShell: async (file: string, args: readonly string[]): Promise<ShellResult | null> => {
      calls.push({ file, args });
      return answer();
    },
  };
}

describe("parseLoginShellPathOutput", () => {
  it("reports the PATH after the probe marker", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__/opt/homebrew/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("takes the PATH from after a profile's own greeting", () => {
    expect(
      parseLoginShellPathOutput("Welcome back!\n__VOLLI_PATH__/opt/homebrew/bin:/usr/bin"),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("uses the final usable marker after xtrace and newline-free profile chatter", () => {
    expect(
      parseLoginShellPathOutput(
        "Welcome back without a newline__VOLLI_PATH__; printenv PATH\n__VOLLI_PATH__/opt/homebrew/bin:/usr/bin",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps a PATH entry that merely contains a space", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__/Applications/Volli Code/bin:/usr/bin")).toBe(
      "/Applications/Volli Code/bin:/usr/bin",
    );
  });

  it("reports null for empty output", () => {
    expect(parseLoginShellPathOutput("")).toBeNull();
  });

  it("reports null when the profile talked but printed nothing after its last line", () => {
    expect(parseLoginShellPathOutput("Welcome back!\n")).toBeNull();
  });

  it("reports null for output that is only whitespace", () => {
    expect(parseLoginShellPathOutput("   \n  ")).toBeNull();
  });

  it("reports null when output has no marker", () => {
    expect(parseLoginShellPathOutput("/opt/homebrew/bin:/usr/bin")).toBeNull();
  });

  it("reports null when the marked PATH has an empty entry", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__/opt/homebrew/bin::/usr/bin")).toBeNull();
  });

  it("reports null when the marked PATH has a relative entry", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__bin:/usr/bin")).toBeNull();
  });

  it("reports null when the marked PATH has a non-absolute entry", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__~/bin:/usr/bin")).toBeNull();
  });
});

describe("resolveLoginShellPath", () => {
  it("asks the user's own login shell, non-interactively", async () => {
    const zsh = shell(async () => successful("__VOLLI_PATH__/opt/homebrew/bin:/usr/bin"));

    const path = await resolveLoginShellPath({
      env: { SHELL: "/bin/zsh" },
      runShell: zsh.runShell,
    });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin");
    expect(zsh.calls[0]?.file).toBe("/bin/zsh");
    // -l, never -i: an interactive flag is what can hang on a profile's prompt.
    expect(zsh.calls[0]?.args).toEqual(["-l", "-c", "printf __VOLLI_PATH__; printenv PATH"]);
  });

  it("falls back to /bin/zsh when SHELL is unset", async () => {
    const shellDouble = shell(async () => successful("__VOLLI_PATH__/usr/bin"));

    await resolveLoginShellPath({ env: {}, runShell: shellDouble.runShell });

    expect(shellDouble.calls[0]?.file).toBe("/bin/zsh");
  });

  it("reports null when the shell could not be run at all", async () => {
    const broken = shell(async () => null);

    expect(await resolveLoginShellPath({ env: {}, runShell: broken.runShell })).toBeNull();
  });

  it("reports null when the shell printed nothing usable", async () => {
    const quiet = shell(async () => successful(""));

    expect(await resolveLoginShellPath({ env: {}, runShell: quiet.runShell })).toBeNull();
  });

  it("reports null when spawning the shell rejects", async () => {
    await expect(
      resolveLoginShellPath({
        env: {},
        runShell: async () => Promise.reject(new Error("shell not found")),
      }),
    ).resolves.toBeNull();
  });

  it("reports null when the shell exits nonzero", async () => {
    const failed = shell(async () => ({
      stdout: "__VOLLI_PATH__/opt/homebrew/bin:/usr/bin",
      exitCode: 1,
      signal: null,
    }));

    expect(await resolveLoginShellPath({ env: {}, runShell: failed.runShell })).toBeNull();
  });

  it("reports null when the shell exits from a signal", async () => {
    const signaled = shell(async () => ({
      stdout: "__VOLLI_PATH__/opt/homebrew/bin:/usr/bin",
      exitCode: null,
      signal: "SIGTERM",
    }));

    expect(await resolveLoginShellPath({ env: {}, runShell: signaled.runShell })).toBeNull();
  });
});

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
  it("keeps the current PATH when the login shell could not answer", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, null)).toEqual({ kind: "kept" });
  });

  it("keeps the current PATH when the login shell answered with nothing", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "")).toEqual({ kind: "kept" });
  });

  it("unions a login PATH ahead of what launchd handed the app", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin:/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      entryCount: 5,
    });
  });

  it("keeps the current PATH when the login shell reports the identical PATH", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, BARE_LAUNCHD_PATH)).toEqual({ kind: "kept" });
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

  it("says kept when nothing changed", () => {
    expect(loginPathLogLine({ kind: "kept" })).toBe("[volli] PATH kept");
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

    await expect(bootstrap.apply()).resolves.toEqual({ kind: "kept" });
    await bootstrap.apply();

    expect(mutations).toEqual(["/profile/bin:/usr/bin:/bin"]);
    expect(logs).toEqual(["[volli] PATH kept"]);
  });
});
