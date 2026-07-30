import { afterEach, describe, expect, it } from "vite-plus/test";

import { loginShellPath, readLoginShellPath, resetLoginShellPathCache } from "./login-path";

afterEach(() => {
  resetLoginShellPathCache();
});

/** What the shell prints for the PATH itself, marker included. */
function marked(path: string): string {
  return `__VOLLI_PATH__${path}\n`;
}

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
    const fish = shell(async () => marked("/opt/homebrew/bin:/usr/bin:/bin"));

    const path = await readLoginShellPath({ env: { SHELL: "/bin/fish" }, runShell: fish.runShell });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(fish.calls[0]?.file).toBe("/bin/fish");
    expect(fish.calls[0]?.args[0]).toBe("-l");
  });

  // The PTY is a login shell on a tty, which is an INTERACTIVE login shell —
  // and zsh reads .zshrc only when interactive. Asking without `-i` misses
  // every PATH entry a user installs there.
  it("asks interactively, because that is the shell the PTY actually runs", async () => {
    const zsh = shell(async () => marked("/opt/homebrew/bin"));

    await readLoginShellPath({ env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell });

    expect(zsh.calls[0]?.args).toEqual(["-l", "-i", "-c", "printf __VOLLI_PATH__; printenv PATH"]);
  });

  it("reports null rather than a PATH when the shell cannot be run", async () => {
    const broken = shell(async () => {
      throw new Error("no such file");
    });

    expect(await readLoginShellPath({ env: {}, runShell: broken.runShell })).toBeNull();
  });

  it("takes the PATH out from under a profile that greets the user", async () => {
    const chatty = shell(
      async () => `Welcome back!\nnvm: using v22\n${marked("/opt/homebrew/bin:/usr/bin")}`,
    );

    expect(await readLoginShellPath({ env: {}, runShell: chatty.runShell })).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  // An interactive shell talks on BOTH sides of the command: a TRAPEXIT, a
  // "you have running jobs" warning. Reading the last non-empty line would
  // report that chatter as the user's PATH.
  it("takes the PATH out from under a profile that talks on its way out", async () => {
    const noisy = shell(async () => `${marked("/opt/homebrew/bin")}trailing-noise\n`);

    expect(await readLoginShellPath({ env: {}, runShell: noisy.runShell })).toBe(
      "/opt/homebrew/bin",
    );
  });

  // A shell in xtrace echoes the command — marker and all — before running it,
  // and an rc file is free to print anything, our own marker included. Ours
  // runs last, so the last marked line is the one that ran.
  it("prefers the marked line the shell ran to any marker printed ahead of it", async () => {
    const traced = shell(
      async () => `+ printf __VOLLI_PATH__; printenv PATH\n${marked("/opt/homebrew/bin")}`,
    );
    const decoy = shell(async () => `${marked("/decoy")}${marked("/opt/homebrew/bin")}`);
    const inline = shell(async () => `[__VOLLI_PATH__] __VOLLI_PATH__/opt/homebrew/bin\n`);

    for (const scripted of [traced, decoy, inline]) {
      expect(await readLoginShellPath({ env: {}, runShell: scripted.runShell })).toBe(
        "/opt/homebrew/bin",
      );
    }
  });

  it("reports null for a shell that printed nothing usable", async () => {
    for (const output of ["  \n", "no marker here\n", `${marked("")}`]) {
      const quiet = shell(async () => output);
      expect(await readLoginShellPath({ env: {}, runShell: quiet.runShell })).toBeNull();
    }
  });

  it("reports null rather than a PATH carrying an escape sequence", async () => {
    const colored = shell(async () => marked("\u001b[31m/opt/homebrew/bin"));

    expect(await readLoginShellPath({ env: {}, runShell: colored.runShell })).toBeNull();
  });

  it("keeps a PATH entry that merely contains a space", async () => {
    const spaced = shell(async () => marked("/Applications/Volli Code/bin:/usr/bin"));

    expect(await readLoginShellPath({ env: {}, runShell: spaced.runShell })).toBe(
      "/Applications/Volli Code/bin:/usr/bin",
    );
  });
});

describe("loginShellPath", () => {
  it("spawns the shell once per launch, however many detections ask", async () => {
    const zsh = shell(async () => marked("/opt/homebrew/bin"));
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");
    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");

    expect(zsh.calls).toHaveLength(1);
  });

  // One timed-out profile at boot used to latch "detection could not run" for
  // the whole launch: no census, no reconciled wrappers, and `volli doctor
  // --fix` unable to repair it because repair re-asked the same latched answer.
  it("asks again after a failure, so one slow profile does not poison the launch", async () => {
    let wedged = true;
    const zsh = shell(async () => {
      if (wedged) throw new Error("timed out");
      return marked("/opt/homebrew/bin");
    });
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    expect(await loginShellPath(deps)).toBeNull();
    wedged = false;

    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");
    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");
    expect(zsh.calls).toHaveLength(2);
  });

  it("shares one in-flight attempt, so the boot fan-out spawns one shell", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const zsh = shell(async () => {
      await gate;
      return marked("/opt/homebrew/bin");
    });
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    const both = Promise.all([loginShellPath(deps), loginShellPath(deps)]);
    release?.();

    expect(await both).toEqual(["/opt/homebrew/bin", "/opt/homebrew/bin"]);
    expect(zsh.calls).toHaveLength(1);
  });
});
