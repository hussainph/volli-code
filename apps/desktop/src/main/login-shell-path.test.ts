import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ADOPTION_PROBE,
  DETECTION_PROBE,
  loginShellPath,
  parseLoginShellPathOutput,
  probeLoginShellPath,
  resetLoginShellPathCache,
  type LoginShellRun,
} from "./login-shell-path";

afterEach(() => {
  resetLoginShellPathCache();
});

/** What the shell prints for the PATH itself, marker included. */
function marked(path: string): string {
  return `__VOLLI_PATH__${path}\n`;
}

/**
 * This host's real login `PATH` as VC-94 measured it, unexpanded tilde and all:
 * `path_helper` appends the literal text of `/etc/paths.d/dotnet-cli-tools`,
 * written there by Microsoft's .NET CLI installer, to every login shell on the
 * machine.
 */
const MEASURED_HOST_PATH =
  "/Users/phalasiya/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:" +
  "/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:" +
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:" +
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:" +
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:" +
  "/pkg/env/global/bin:/Library/Apple/usr/bin:" +
  "/Applications/Wireshark.app/Contents/MacOS:/usr/local/share/dotnet:~/.dotnet/tools:" +
  "/Applications/quarto/bin:/Users/phalasiya/.vite-plus/bin:/Users/phalasiya/.cargo/bin:" +
  "/Users/phalasiya/Library/Application Support/Volli Code/bin";

/** A shell that printed this and exited on its own terms. */
function successful(stdout: string): LoginShellRun {
  return { stdout, exitCode: 0, signal: null };
}

/** A scripted shell, recording what it was asked to run and with what limits. */
function shell(answer: () => Promise<LoginShellRun | null>) {
  const calls: { file: string; args: readonly string[]; limits: unknown }[] = [];
  return {
    calls,
    runShell: async (
      file: string,
      args: readonly string[],
      limits: unknown,
    ): Promise<LoginShellRun | null> => {
      calls.push({ file, args, limits });
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

  // An interactive shell talks on BOTH sides of the command: a TRAPEXIT, a
  // "you have running jobs" warning. Reading the last non-empty line would
  // report that chatter as the user's PATH.
  it("ignores what a profile prints on its way out", () => {
    expect(parseLoginShellPathOutput(`${marked("/opt/homebrew/bin")}trailing-noise\n`)).toBe(
      "/opt/homebrew/bin",
    );
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

  it("drops an empty entry instead of discarding its neighbours", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__/opt/homebrew/bin::/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("drops a relative entry instead of discarding its neighbours", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__bin:/usr/bin")).toBe("/usr/bin");
  });

  it("drops a non-absolute entry instead of discarding its neighbours", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__~/bin:/usr/bin")).toBe("/usr/bin");
  });

  // Colour codes are what put a control character on this stream, and they
  // land on one entry, not on the list. Rejecting the whole PATH for them was
  // the detection parser's old rule and cost 20 good entries the same way the
  // all-or-nothing absolute rule did.
  it("drops an entry carrying an escape sequence instead of discarding its neighbours", () => {
    expect(parseLoginShellPathOutput(marked("\u001b[31m/opt/homebrew/bin:/usr/bin"))).toBe(
      "/usr/bin",
    );
    expect(parseLoginShellPathOutput(marked("/usr/\u0007bin:/usr/bin"))).toBe("/usr/bin");
  });

  it("reports null when no entry survives", () => {
    expect(parseLoginShellPathOutput("__VOLLI_PATH__~/bin:relative::")).toBeNull();
    expect(parseLoginShellPathOutput(marked("\u001b[31m/opt/homebrew/bin"))).toBeNull();
  });

  // A shell in xtrace echoes the command — marker and all — before running it,
  // and an rc file is free to print our own marker too. Ours runs last, so the
  // last marker that yields anything usable is the one that ran.
  it("prefers the marked value the shell ran to any marker printed ahead of it", () => {
    const traced = `+ printf __VOLLI_PATH__; printenv PATH\n${marked("/opt/homebrew/bin")}`;
    const decoy = `${marked("/decoy")}${marked("/opt/homebrew/bin")}`;
    const inline = "[__VOLLI_PATH__] __VOLLI_PATH__/opt/homebrew/bin\n";
    const emptyLast = `${marked("/opt/homebrew/bin")}${marked("")}`;

    for (const stdout of [traced, decoy, inline, emptyLast]) {
      expect(parseLoginShellPathOutput(stdout)).toBe("/opt/homebrew/bin");
    }
  });

  // VC-94's live bug, reproduced from this host: the all-or-nothing rule this
  // test guards against turned all 20 good entries into nothing because of the
  // one tilde entry, leaving structured sessions on launchd's bare four.
  it("keeps the rest of this host's measured login PATH when the dotnet tilde entry is present", () => {
    expect(parseLoginShellPathOutput(`__VOLLI_PATH__${MEASURED_HOST_PATH}`)).toBe(
      MEASURED_HOST_PATH.replace("~/.dotnet/tools:", ""),
    );
  });
});

describe("probeLoginShellPath", () => {
  it("asks the user's own login shell, the same one a PTY gets", async () => {
    const fish = shell(async () => successful(marked("/opt/homebrew/bin:/usr/bin:/bin")));

    const path = await probeLoginShellPath(DETECTION_PROBE, {
      env: { SHELL: "/bin/fish" },
      runShell: fish.runShell,
    });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(fish.calls[0]?.file).toBe("/bin/fish");
    expect(fish.calls[0]?.args[0]).toBe("-l");
  });

  it("falls back to /bin/zsh when SHELL is unset", async () => {
    const shellDouble = shell(async () => successful(marked("/usr/bin")));

    await probeLoginShellPath(ADOPTION_PROBE, { env: {}, runShell: shellDouble.runShell });

    expect(shellDouble.calls[0]?.file).toBe("/bin/zsh");
  });

  // The PTY is a login shell on a tty, which is an INTERACTIVE login shell —
  // and zsh reads .zshrc only when interactive. Asking without `-i` misses
  // every PATH entry a user installs there.
  it("asks detection's question interactively, because that is the shell the PTY runs", async () => {
    const zsh = shell(async () => successful(marked("/opt/homebrew/bin")));

    await probeLoginShellPath(DETECTION_PROBE, {
      env: { SHELL: "/bin/zsh" },
      runShell: zsh.runShell,
    });

    expect(zsh.calls[0]?.args).toEqual(["-l", "-i", "-c", "printf __VOLLI_PATH__; printenv PATH"]);
  });

  // -l, never -i: an interactive flag is what can hang on a profile's prompt,
  // and adoption runs at boot with no window to answer one.
  it("asks adoption's question non-interactively, because a boot cannot answer a prompt", async () => {
    const zsh = shell(async () => successful(marked("/opt/homebrew/bin")));

    await probeLoginShellPath(ADOPTION_PROBE, {
      env: { SHELL: "/bin/zsh" },
      runShell: zsh.runShell,
    });

    expect(zsh.calls[0]?.args).toEqual(["-l", "-c", "printf __VOLLI_PATH__; printenv PATH"]);
  });

  // The timeouts and output caps are the probes' own, not one converged pair:
  // detection is re-askable and can wait a shorter time, adoption is on the
  // boot path and gets one attempt.
  it("hands each probe's own limits to the spawn", async () => {
    const zsh = shell(async () => successful(marked("/usr/bin")));
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    await probeLoginShellPath(DETECTION_PROBE, deps);
    await probeLoginShellPath(ADOPTION_PROBE, deps);

    expect(zsh.calls[0]?.limits).toMatchObject({ timeoutMs: 3000, maxOutputBytes: 1 << 20 });
    expect(zsh.calls[1]?.limits).toMatchObject({ timeoutMs: 4000, maxOutputBytes: 1 << 16 });
  });

  it("reports null rather than a PATH when the shell cannot be run", async () => {
    const broken = shell(async () => {
      throw new Error("no such file");
    });
    const missing = shell(async () => null);

    for (const scripted of [broken, missing]) {
      expect(
        await probeLoginShellPath(DETECTION_PROBE, { env: {}, runShell: scripted.runShell }),
      ).toBeNull();
      expect(
        await probeLoginShellPath(ADOPTION_PROBE, { env: {}, runShell: scripted.runShell }),
      ).toBeNull();
    }
  });

  it("reports null for a shell that printed nothing usable", async () => {
    for (const output of ["  \n", "no marker here\n", marked("")]) {
      const quiet = shell(async () => successful(output));
      expect(
        await probeLoginShellPath(DETECTION_PROBE, { env: {}, runShell: quiet.runShell }),
      ).toBeNull();
    }
  });

  // The marker vouches for the value, and a login shell exiting nonzero is
  // ordinary — nothing detection does with the answer is worth losing a whole
  // launch's PATH over.
  it("believes a detection answer from a shell that left badly", async () => {
    const untidy = shell(async () => ({
      stdout: marked("/opt/homebrew/bin:/usr/bin"),
      exitCode: 1,
      signal: null,
    }));
    const signaled = shell(async () => ({
      stdout: marked("/opt/homebrew/bin:/usr/bin"),
      exitCode: null,
      signal: "SIGKILL" as NodeJS.Signals,
    }));

    for (const scripted of [untidy, signaled]) {
      expect(
        await probeLoginShellPath(DETECTION_PROBE, { env: {}, runShell: scripted.runShell }),
      ).toBe("/opt/homebrew/bin:/usr/bin");
    }
  });

  // Adoption's answer becomes process.env.PATH for the whole app, so the same
  // half-finished shell that detection believes is refused here.
  it("refuses an adoption answer from a shell that exited nonzero or on a signal", async () => {
    const nonzero = shell(async () => ({
      stdout: marked("/opt/homebrew/bin:/usr/bin"),
      exitCode: 1,
      signal: null,
    }));
    const signaled = shell(async () => ({
      stdout: marked("/opt/homebrew/bin:/usr/bin"),
      exitCode: null,
      signal: "SIGTERM" as NodeJS.Signals,
    }));

    for (const scripted of [nonzero, signaled]) {
      expect(
        await probeLoginShellPath(ADOPTION_PROBE, { env: {}, runShell: scripted.runShell }),
      ).toBeNull();
    }
  });

  // A2's one behaviour change: detection used to report this host's PATH with
  // the unexpanded `~/.dotnet/tools` still in it, so the Settings pane named a
  // directory no shell would ever search — and the two probes reported
  // different environments for the same host. One parser, one answer.
  it("drops a tilde entry from what detection reports, as adoption already did", async () => {
    const dotnet = shell(async () => successful(marked(MEASURED_HOST_PATH)));
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: dotnet.runShell };
    const expected = MEASURED_HOST_PATH.replace("~/.dotnet/tools:", "");

    expect(await probeLoginShellPath(DETECTION_PROBE, deps)).toBe(expected);
    expect(await probeLoginShellPath(ADOPTION_PROBE, deps)).toBe(expected);
  });
});

describe("loginShellPath", () => {
  it("spawns the shell once per launch, however many detections ask", async () => {
    const zsh = shell(async () => successful(marked("/opt/homebrew/bin")));
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");
    expect(await loginShellPath(deps)).toBe("/opt/homebrew/bin");

    expect(zsh.calls).toHaveLength(1);
  });

  it("caches the detection probe's answer, interactive flag and all", async () => {
    const zsh = shell(async () => successful(marked("/opt/homebrew/bin")));

    await loginShellPath({ env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell });

    expect(zsh.calls[0]?.args).toEqual(["-l", "-i", "-c", "printf __VOLLI_PATH__; printenv PATH"]);
  });

  // One timed-out profile at boot used to latch "detection could not run" for
  // the whole launch: no census, no reconciled wrappers, and `volli doctor
  // --fix` unable to repair it because repair re-asked the same latched answer.
  it("asks again after a failure, so one slow profile does not poison the launch", async () => {
    let wedged = true;
    const zsh = shell(async () => {
      if (wedged) throw new Error("timed out");
      return successful(marked("/opt/homebrew/bin"));
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
      return successful(marked("/opt/homebrew/bin"));
    });
    const deps = { env: { SHELL: "/bin/zsh" }, runShell: zsh.runShell };

    const both = Promise.all([loginShellPath(deps), loginShellPath(deps)]);
    release?.();

    expect(await both).toEqual(["/opt/homebrew/bin", "/opt/homebrew/bin"]);
    expect(zsh.calls).toHaveLength(1);
  });
});
