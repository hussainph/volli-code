import { afterEach, describe, expect, it } from "vite-plus/test";

import { loginShellPath, readLoginShellPath, resetLoginShellPathCache } from "./login-path";

afterEach(() => {
  resetLoginShellPathCache();
});

/** A scripted shell, recording what it was asked to run. */
function shell(answer: () => Promise<string>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  return {
    calls,
    runShell: async (file: string, args: readonly string[]): Promise<string> => {
      calls.push({ file, args });
      return answer();
    },
  };
}

describe("readLoginShellPath", () => {
  it("asks the user's own login shell, the same one a PTY gets", async () => {
    const fish = shell(async () => "/opt/homebrew/bin:/usr/bin:/bin\n");

    const path = await readLoginShellPath({ env: { SHELL: "/bin/fish" }, runShell: fish.runShell });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(fish.calls[0]?.file).toBe("/bin/fish");
    expect(fish.calls[0]?.args[0]).toBe("-l");
  });

  it("reports null rather than a PATH when the shell cannot be run", async () => {
    const broken = shell(async () => {
      throw new Error("no such file");
    });

    expect(await readLoginShellPath({ env: {}, runShell: broken.runShell })).toBeNull();
  });

  it("reports null for a shell that printed nothing usable", async () => {
    const quiet = shell(async () => "  \n");

    expect(await readLoginShellPath({ env: {}, runShell: quiet.runShell })).toBeNull();
  });
});

describe("loginShellPath", () => {
  it("spawns the shell once per launch, however many detections ask", async () => {
    const zsh = shell(async () => "/opt/homebrew/bin\n");
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");
    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");

    expect(zsh.calls).toHaveLength(1);
  });
});
