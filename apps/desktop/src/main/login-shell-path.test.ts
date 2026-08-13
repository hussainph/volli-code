import { describe, expect, it } from "vite-plus/test";

import {
  BARE_LAUNCHD_PATH,
  currentPathIsIncomplete,
  decideLoginPathAdoption,
  loginPathLogLine,
  parseLoginShellPathOutput,
  resolveLoginShellPath,
} from "./login-shell-path";

/** A scripted shell, recording what it was asked to run. */
function shell(answer: () => Promise<string | null>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  return {
    calls,
    runShell: async (file: string, args: readonly string[]): Promise<string | null> => {
      calls.push({ file, args });
      return answer();
    },
  };
}

describe("parseLoginShellPathOutput", () => {
  it("reports a clean, single-line PATH as-is", () => {
    expect(parseLoginShellPathOutput("/opt/homebrew/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("takes the PATH from after a profile's own greeting", () => {
    expect(parseLoginShellPathOutput("Welcome back!\n/opt/homebrew/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("takes the PATH from after multiple lines of profile chatter", () => {
    expect(
      parseLoginShellPathOutput("Welcome back!\nnvm: using v22\n/opt/homebrew/bin:/usr/bin"),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps a PATH entry that merely contains a space", () => {
    expect(parseLoginShellPathOutput("/Applications/Volli Code/bin:/usr/bin")).toBe(
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
});

describe("resolveLoginShellPath", () => {
  it("asks the user's own login shell, non-interactively", async () => {
    const zsh = shell(async () => "/opt/homebrew/bin:/usr/bin");

    const path = await resolveLoginShellPath({
      env: { SHELL: "/bin/zsh" },
      runShell: zsh.runShell,
    });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin");
    expect(zsh.calls[0]?.file).toBe("/bin/zsh");
    // -l, never -i: an interactive flag is what can hang on a profile's prompt.
    expect(zsh.calls[0]?.args).toEqual(["-l", "-c", "printf '%s' \"$PATH\""]);
  });

  it("falls back to /bin/zsh when SHELL is unset", async () => {
    const shellDouble = shell(async () => "/usr/bin");

    await resolveLoginShellPath({ env: {}, runShell: shellDouble.runShell });

    expect(shellDouble.calls[0]?.file).toBe("/bin/zsh");
  });

  it("reports null when the shell could not be run at all", async () => {
    const broken = shell(async () => null);

    expect(await resolveLoginShellPath({ env: {}, runShell: broken.runShell })).toBeNull();
  });

  it("reports null when the shell printed nothing usable", async () => {
    const quiet = shell(async () => "");

    expect(await resolveLoginShellPath({ env: {}, runShell: quiet.runShell })).toBeNull();
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

  it("adopts a login PATH that fills in what the bare launchd set is missing", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin:/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      entryCount: 3,
    });
  });

  it("keeps the current PATH when the login shell reports the identical PATH", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, BARE_LAUNCHD_PATH)).toEqual({ kind: "kept" });
  });

  it("keeps a dev boot's already-rich PATH rather than narrowing it to the login shell's", () => {
    const rich = "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin";
    expect(decideLoginPathAdoption(rich, "/opt/homebrew/bin:/usr/bin")).toEqual({ kind: "kept" });
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
