/**
 * The Chromium launch without a browser (VC-619): the command line's security
 * shape, and what a launch does when the browser never answers.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { chromiumLaunchArgs, ChromiumLaunchError, launchChromium } from "./chromium-launch";

describe("chromiumLaunchArgs", () => {
  const args = chromiumLaunchArgs({
    userDataDir: "/private/profile",
    noSandbox: false,
    deviceScaleFactor: 1,
  });

  it("speaks CDP over the pipe and never opens a debugging port or address (VC-110)", () => {
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args.some((arg) => arg.startsWith("--remote-debugging-address"))).toBe(false);
  });

  it("runs the full browser's new headless with the sandbox on", () => {
    expect(args).toContain("--headless");
    expect(args.some((arg) => arg.startsWith("--headless="))).toBe(false);
    expect(args).not.toContain("--no-sandbox");
    expect(args).toContain("--user-data-dir=/private/profile");
    expect(args.at(-1)).toBe("about:blank");
  });

  it("draws at the scale the host states", () => {
    expect(args).toContain("--force-device-scale-factor=1");
    expect(
      chromiumLaunchArgs({ userDataDir: "/p", noSandbox: false, deviceScaleFactor: 2 }),
    ).toContain("--force-device-scale-factor=2");
  });

  it("drops the sandbox only when the host says so", () => {
    expect(
      chromiumLaunchArgs({ userDataDir: "/p", noSandbox: true, deviceScaleFactor: 1 }),
    ).toContain("--no-sandbox");
  });
});

/** A child that never answers on its pipe, and exits when killed. */
function silentChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: 4242,
    stderr,
    stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    }),
  });
  return child;
}

describe("launchChromium", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const root = (): string => {
    const made = mkdtempSync(join(tmpdir(), "volli-launch-test-"));
    roots.push(made);
    return made;
  };

  it("hands the browser fds 3 and 4 and a private profile, and removes the profile when it fails", async () => {
    const profileRoot = root();
    let seen: { args: readonly string[]; stdio: unknown } | null = null;
    let profileMode = 0;
    const launch = launchChromium(
      { executablePath: "/bin/chromium", profileRoot, noSandbox: false, deviceScaleFactor: 1 },
      (_command, args, options) => {
        seen = { args, stdio: options.stdio };
        const dir = args
          .find((arg) => arg.startsWith("--user-data-dir="))!
          .slice("--user-data-dir=".length);
        profileMode = statSync(dir).mode & 0o777;
        const child = silentChild();
        // Chromium exits before answering, as a sandbox it cannot use makes it.
        queueMicrotask(() => {
          child.stderr!.emit("data", Buffer.from("FATAL: No usable sandbox!"));
          child.emit("exit", 1, null);
        });
        return child;
      },
    );
    await expect(launch).rejects.toThrow(ChromiumLaunchError);
    await expect(launch).rejects.toThrow(/No usable sandbox!/);
    expect(seen!.stdio).toEqual(["ignore", "ignore", "pipe", "pipe", "pipe"]);
    expect(profileMode).toBe(0o700);
    expect(readdirSync(profileRoot)).toEqual([]);
  });

  it("warns, every time, when it starts without the sandbox", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launch = launchChromium(
      {
        executablePath: "/bin/chromium",
        profileRoot: root(),
        noSandbox: true,
        deviceScaleFactor: 1,
      },
      () => {
        const child = silentChild();
        queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
        return child;
      },
    );
    await expect(launch).rejects.toThrow(/could not start: spawn ENOENT/);
    expect(warn.mock.calls.some(([line]) => String(line).includes("without its sandbox"))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it("refuses a child spawned without its pipe", async () => {
    const profileRoot = root();
    const launch = launchChromium(
      { executablePath: "/bin/chromium", profileRoot, noSandbox: false, deviceScaleFactor: 1 },
      () => {
        const child = silentChild();
        (child as unknown as { stdio: unknown[] }).stdio = [null, null, null];
        return child;
      },
    );
    await expect(launch).rejects.toThrow(/without its CDP pipe/);
    expect(existsSync(profileRoot)).toBe(true);
    expect(readdirSync(profileRoot)).toEqual([]);
  });
});
