import { describe, expect, it } from "vite-plus/test";

import { installLayout } from "./layout";

describe("the managed install's layout", () => {
  it("puts a system install where the runbook did", () => {
    expect(installLayout("system", { home: "/home/alice", env: {} })).toEqual({
      mode: "system",
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
});
