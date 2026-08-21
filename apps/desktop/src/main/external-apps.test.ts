import { describe, expect, it, vi } from "vite-plus/test";

import { createExternalAppGateway, createMacOSExternalAppRuntime } from "./external-apps";

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
});
