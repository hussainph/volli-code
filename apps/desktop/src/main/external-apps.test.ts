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
  const ALL_BUNDLE_IDS = [
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",
    "dev.zed.Zed",
    "com.apple.dt.Xcode",
    "com.google.android.studio",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.Warp-Stable",
  ];

  it("lists only the known apps whose bundle ids Launch Services finds, in one lookup", async () => {
    const lookups: (readonly string[])[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundles(bundleIds) {
        lookups.push(bundleIds);
        return new Set(["com.apple.Terminal", "com.microsoft.VSCode", "com.google.android.studio"]);
      },
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "android-studio", label: "Android Studio", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ]);
    // VC-716: one lookup for the whole catalogue, never one per app.
    expect(lookups).toEqual([ALL_BUNDLE_IDS]);
  });

  it("treats a non-macOS host as an empty menu state without probing", async () => {
    const findBundles = vi.fn(async () => new Set<string>());
    const gateway = createExternalAppGateway({
      platform: "linux",
      findBundles,
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([]);
    expect(findBundles).not.toHaveBeenCalled();
  });

  it("opens a known app through its fixed bundle id and resolved path", async () => {
    const opens: { bundleId: string; path: string }[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundles() {
        return new Set<string>();
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

  it("never reports an empty list for a scan that could not complete", async () => {
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundles() {
        throw new Error("Launch Services unavailable");
      },
      async openBundle() {},
    });

    // A partial or empty list would read as "nothing is installed" — the
    // failure has to stay a failure all the way to the IPC envelope.
    await expect(gateway.list()).rejects.toThrow(EXTERNAL_APP_DISCOVERY_FAILED);
  });

  it("reports an empty list only from a lookup that checked every allowlisted bundle", async () => {
    const checked: string[] = [];
    const gateway = createExternalAppGateway({
      platform: "darwin",
      async findBundles(bundleIds) {
        checked.push(...bundleIds);
        return new Set<string>();
      },
      async openBundle() {},
    });

    await expect(gateway.list()).resolves.toEqual([]);
    expect(checked).toEqual(ALL_BUNDLE_IDS);
  });

  it("queries Launch Services for every id in one osascript and launches through macOS open", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runtime = createMacOSExternalAppRuntime(async (command, args) => {
      calls.push({ command, args: [...args] });
      return { stdout: command === "/usr/bin/osascript" ? '["com.microsoft.VSCode"]\n' : "" };
    });

    await expect(runtime.findBundles(["com.microsoft.VSCode", "dev.zed.Zed"])).resolves.toEqual(
      new Set(["com.microsoft.VSCode"]),
    );
    await runtime.openBundle("com.microsoft.VSCode", "/ticket-worktree/src/main.ts");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("/usr/bin/osascript");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(calls[0]?.args[3]).toContain("ObjC['import']('AppKit');");
    expect(calls[0]?.args[3]).toContain('["com.microsoft.VSCode","dev.zed.Zed"]');
    expect(calls[1]).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.microsoft.VSCode", "/ticket-worktree/src/main.ts"],
    });
  });

  it("asks JXA for the answer as its completion value, never through console.log", async () => {
    let script = "";
    const runtime = createMacOSExternalAppRuntime(async (_command, args) => {
      script = args[3] ?? "";
      return { stdout: "[]" };
    });

    await runtime.findBundles(["com.apple.Terminal"]);

    // `console.log` under `osascript -l JavaScript` writes to STDERR, which
    // this runtime does not read — the defect this test exists to hold shut.
    expect(script).not.toContain("console.log");
    expect(script).toContain("URLForApplicationWithBundleIdentifier");
  });

  it("treats an empty array as no app installed", async () => {
    const runtime = createMacOSExternalAppRuntime(async () => ({ stdout: "[]\n" }));

    await expect(runtime.findBundles(["dev.volli.NotInstalled"])).resolves.toEqual(new Set());
  });

  it("refuses output the script cannot print rather than reading it as nothing installed", async () => {
    for (const stdout of [
      "",
      "\n",
      "/Applications/Terminal.app",
      "{}",
      '["dev.volli.NotAsked"]',
      "[1]",
    ]) {
      const runtime = createMacOSExternalAppRuntime(async () => ({ stdout }));
      await expect(runtime.findBundles(["com.apple.Terminal"])).rejects.toThrow(
        /Launch Services lookup returned/,
      );
    }
  });

  it("spawns nothing for an empty question", async () => {
    const run = vi.fn<NativeAppCommand>(async () => ({ stdout: "[]" }));
    const runtime = createMacOSExternalAppRuntime(run);

    await expect(runtime.findBundles([])).resolves.toEqual(new Set());
    expect(run).not.toHaveBeenCalled();
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

  onMacOS(
    "finds a built-in bundle and not an absent one in one process, launching nothing",
    async () => {
      spawned.length = 0;
      const runtime = createMacOSExternalAppRuntime(realCommand);

      await expect(
        runtime.findBundles(["com.apple.Terminal", "dev.volli.definitely-not-installed"]),
      ).resolves.toEqual(new Set(["com.apple.Terminal"]));

      // One lookup, and nothing was opened: a lookup only ever runs osascript.
      expect(spawned.map((call) => call.command)).toEqual(["/usr/bin/osascript"]);
    },
  );

  onMacOS("reports an absent bundle as not installed from a lookup that succeeded", async () => {
    const runtime = createMacOSExternalAppRuntime(realCommand);

    await expect(runtime.findBundles(["dev.volli.definitely-not-installed"])).resolves.toEqual(
      new Set(),
    );
  });

  onMacOS("lists real installed apps rather than an empty menu", async () => {
    spawned.length = 0;
    const gateway = createExternalAppGateway(createMacOSExternalAppRuntime(realCommand));

    const apps = await gateway.list();

    // Terminal ships with macOS, so a complete scan on any Mac must find it.
    expect(apps.map((app) => app.id)).toContain("terminal");
    expect(spawned).toHaveLength(1);
  });
});
