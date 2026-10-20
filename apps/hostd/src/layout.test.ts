import { describe, expect, it } from "vite-plus/test";

import { installLayout } from "./layout";

describe("the managed install's layout", () => {
  it("puts a system install where the runbook did", () => {
    expect(installLayout("system", { home: "/home/alice", env: {} })).toEqual({
      mode: "system",
      manager: "systemd",
      root: "/opt/volli-hostd",
      releasesDir: "/opt/volli-hostd/releases",
      currentLink: "/opt/volli-hostd/current",
      managedFile: "/opt/volli-hostd/managed.json",
      binLinkDir: "/usr/local/bin",
      dataDir: "/var/lib/volli-hostd",
      unitDir: "/etc/systemd/system",
      dropInDir: "/etc/systemd/system/volli-hostd.service.d",
      keyFile: "/etc/volli-hostd/session-secrets.key",
      // Root's, beside the operators file: never the data directory `volli` owns.
      devicesFile: "/etc/volli-hostd-devices",
      socketPath: "/run/volli-hostd.sock",
      serviceUser: "volli",
      agentPlist: null,
      logFile: null,
    });
  });

  it("puts a user install under the XDG directories, ignoring relative ones", () => {
    const layout = installLayout("user", {
      home: "/home/alice",
      env: { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "relative", XDG_STATE_HOME: "/state" },
    });
    expect(layout).toMatchObject({
      root: "/data/volli-hostd",
      dataDir: "/state/volli-hostd",
      unitDir: "/home/alice/.config/systemd/user",
      keyFile: "/home/alice/.config/volli-hostd/session-secrets.key",
      devicesFile: "/state/volli-hostd/enrolled-devices.json",
      binLinkDir: "/home/alice/.local/bin",
      socketPath: "/state/volli-hostd/volli.sock",
      serviceUser: null,
    });
  });

  // VC-700 PR 1c: a Mac's host is the person's launchd agent.
  it("puts a Mac's install under launchd, its data where the plist template did", () => {
    const layout = installLayout("user", { home: "/Users/alice", env: {}, platform: "darwin" });
    expect(layout).toMatchObject({
      manager: "launchd",
      root: "/Users/alice/.local/share/volli-hostd",
      dataDir: "/Users/alice/Library/Application Support/volli-hostd",
      unitDir: "/Users/alice/Library/LaunchAgents",
      agentPlist: "/Users/alice/Library/LaunchAgents/com.volli.hostd.plist",
      logFile: "/Users/alice/Library/Logs/volli-hostd.log",
      keyFile: "/Users/alice/.config/volli-hostd/session-secrets.key",
      devicesFile: "/Users/alice/Library/Application Support/volli-hostd/enrolled-devices.json",
      socketPath: "/Users/alice/Library/Application Support/volli-hostd/volli.sock",
      serviceUser: null,
    });
    expect(
      installLayout("system", { home: "/Users/alice", env: {}, platform: "darwin" }).manager,
    ).toBe("launchd");
  });
});
