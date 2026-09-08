import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createExternalAppGateway,
  createMacOSExternalAppRuntime,
  EXTERNAL_APP_DISCOVERY_FAILED,
  type NativeAppCommand,
} from "./external-apps";

const execFileAsync = promisify(execFile);

/** The real macOS contract — skipped elsewhere rather than faked into a pass. */
const onMacOS = process.platform === "darwin" ? it : it.skip;

describe("ExternalAppGateway", () => {
  it("lists only the known apps whose bundle ids Launch Services finds", async () => {
    const lookedUp: string[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundle(bundleId) {
        lookedUp.push(bundleId);
        return (
          bundleId === "com.microsoft.VSCode" ||
          bundleId === "com.google.android.studio" ||
          bundleId === "com.apple.Terminal"
        );
      },
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "android-studio", label: "Android Studio", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ]);
    expect(lookedUp).toEqual([
      "com.microsoft.VSCode",
      "com.todesktop.230313mzl4w4u92",
      "dev.zed.Zed",
      "com.apple.dt.Xcode",
      "com.google.android.studio",
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.mitchellh.ghostty",
      "dev.warp.Warp-Stable",
    ]);
  });

  it("treats a non-macOS host as an empty menu state without probing", async () => {
    const findBundle = vi.fn(async () => true);
    const gateway = createExternalAppGateway({
      platform: "linux",
      findBundle,
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([]);
    expect(findBundle).not.toHaveBeenCalled();
  });

  it("opens a known app through its fixed bundle id and resolved path", async () => {
    const opens: { bundleId: string; path: string }[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundle() {
        return false;
      },
      async openBundle(bundleId, path) {
        opens.push({ bundleId, path });
      },
    });

    await expect(gateway.open("vscode", "/ticket-worktree/src/main.ts")).resolves.toEqual({
      ok: true,
    });
    expect(opens).toEqual([
      { bundleId: "com.microsoft.VSCode", path: "/ticket-worktree/src/main.ts" },
    ]);
  });

  it("fails the whole scan when one Launch Services lookup cannot run", async () => {
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundle(bundleId) {
        if (bundleId === "dev.zed.Zed") throw new Error("osascript exited with 1");
        return true;
      },
      async openBundle() {},
    });

    // A partial list would read as "Zed is not installed" — the failure has to
    // stay a failure all the way to the IPC envelope.
    await expect(gateway.list()).rejects.toThrow(EXTERNAL_APP_DISCOVERY_FAILED);
  });

  it("never reports an empty list for a scan that could not complete", async () => {
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundle() {
        throw new Error("Launch Services unavailable");
      },
      async openBundle() {},
    });

    await expect(gateway.list()).rejects.toThrow(EXTERNAL_APP_DISCOVERY_FAILED);
  });

  it("reports an empty list only when every allowlisted bundle was checked", async () => {
    const checked: string[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundle(bundleId) {
        checked.push(bundleId);
        return false;
      },
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([]);
    expect(checked).toHaveLength(9);
  });

  it("queries Launch Services by bundle id and launches through macOS open", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runtime = createMacOSExternalAppRuntime(async (command, args) => {
      calls.push({ command, args: [...args] });
      return { stdout: "/Applications/Visual Studio Code.app\n" };
    });

    await expect(runtime.findBundle("com.microsoft.VSCode")).resolves.toBe(true);
    await runtime.openBundle("com.microsoft.VSCode", "/ticket-worktree/src/main.ts");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("/usr/bin/osascript");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(calls[0]?.args[3]).toContain("ObjC['import']('AppKit');");
    expect(calls[0]?.args[3]).toContain('"com.microsoft.VSCode"');
    expect(calls[1]).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.microsoft.VSCode", "/ticket-worktree/src/main.ts"],
    });
  });

  it("asks JXA for the path as its completion value, never through console.log", async () => {
    let script = "";
    const runtime = createMacOSExternalAppRuntime(async (_command, args) => {
      script = args[3] ?? "";
      return { stdout: "" };
    });

    await runtime.findBundle("com.apple.Terminal");

    // `console.log` under `osascript -l JavaScript` writes to STDERR, which
    // this runtime does not read — the defect this test exists to hold shut.
    expect(script).not.toContain("console.log");
    expect(script).toContain("URLForApplicationWithBundleIdentifier");
  });

  it("treats an empty stdout as an app that is not installed", async () => {
    const runtime = createMacOSExternalAppRuntime(async () => ({ stdout: "\n" }));

    await expect(runtime.findBundle("dev.volli.NotInstalled")).resolves.toBe(false);
  });
});

/**
 * The one test that talks to the real `osascript`. The mocked contract above
 * cannot see which STREAM the JXA program writes to, and that mismatch is
 * exactly what shipped: a hand-written stdout fixture passed while every app
 * on every Mac reported as absent.
 */
describe("macOS Launch Services lookup (real process)", () => {
  const spawned: { command: string; args: readonly string[] }[] = [];
  const realCommand: NativeAppCommand = async (command, args) => {
    spawned.push({ command, args });
    const { stdout } = await execFileAsync(command, [...args]);
    return { stdout: stdout.toString() };
  };

  onMacOS("finds a built-in bundle on stdout without launching anything", async () => {
    spawned.length = 0;
    const runtime = createMacOSExternalAppRuntime(realCommand);

    await expect(runtime.findBundle("com.apple.Terminal")).resolves.toBe(true);

    // Nothing was opened: a lookup only ever runs osascript.
    expect(spawned.map((call) => call.command)).toEqual(["/usr/bin/osascript"]);
  });

  onMacOS("reports an absent bundle as false from a lookup that succeeded", async () => {
    const runtime = createMacOSExternalAppRuntime(realCommand);

    await expect(runtime.findBundle("dev.volli.definitely-not-installed")).resolves.toBe(false);
  });

  onMacOS("lists real installed apps rather than an empty menu", async () => {
    const gateway = createExternalAppGateway(createMacOSExternalAppRuntime(realCommand));

    const apps = await gateway.list();

    // Terminal ships with macOS, so a complete scan on any Mac must find it.
    expect(apps.map((app) => app.id)).toContain("terminal");
  });
});
