import { describe, expect, it } from "vite-plus/test";

import { defaultRunnerPaths, pathsFor, runnerSocketPath, stringOption } from "./paths";

describe("the runner's paths", () => {
  it("are the system ones for root", () => {
    expect(defaultRunnerPaths({ uid: 0, home: "/root", env: {} })).toEqual({
      mode: "system",
      dataDir: "/var/lib/volli-runner",
      configDir: "/etc/volli-runner",
    });
  });

  it("are system paths for the unprivileged service uid, even with XDG variables", () => {
    const env = {
      VOLLI_RUNNER_INSTALL_MODE: "system",
      XDG_STATE_HOME: "/state",
      XDG_CONFIG_HOME: "/config",
    };
    expect(defaultRunnerPaths({ uid: 997, home: "/var/lib/volli-runner", env })).toEqual({
      mode: "system",
      dataDir: "/var/lib/volli-runner",
      configDir: "/etc/volli-runner",
    });
    expect(
      pathsFor(
        { "data-dir": "/custom/state", "config-dir": "/custom/config" },
        { uid: 997, home: "/var/lib/volli-runner", env, cwd: "/" },
      ),
    ).toEqual({ mode: "system", dataDir: "/custom/state", configDir: "/custom/config" });
    // A user-mode env value cannot make root run a user instance.
    expect(
      defaultRunnerPaths({ uid: 0, home: "/root", env: { VOLLI_RUNNER_INSTALL_MODE: "user" } })
        .mode,
    ).toBe("system");
  });

  it("keeps user XDG paths unchanged for explicit user or unknown mode values", () => {
    for (const mode of ["user", "unknown", ""]) {
      expect(
        defaultRunnerPaths({
          uid: 1000,
          home: "/home/ada",
          env: {
            VOLLI_RUNNER_INSTALL_MODE: mode,
            XDG_STATE_HOME: "/state",
            XDG_CONFIG_HOME: "/config",
          },
        }),
      ).toEqual({
        mode: "user",
        dataDir: "/state/volli-runner",
        configDir: "/config/volli-runner",
      });
    }
  });

  it("are under the person's XDG directories otherwise", () => {
    expect(defaultRunnerPaths({ uid: 1000, home: "/home/ada", env: {} })).toEqual({
      mode: "user",
      dataDir: "/home/ada/.local/state/volli-runner",
      configDir: "/home/ada/.config/volli-runner",
    });
    expect(
      defaultRunnerPaths({
        uid: 1000,
        home: "/home/ada",
        env: { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "relative/config" },
      }),
    ).toEqual({
      mode: "user",
      dataDir: "/state/volli-runner",
      configDir: "/home/ada/.config/volli-runner",
    });
  });

  it("put the socket in the data directory", () => {
    expect(runnerSocketPath("/var/lib/volli-runner")).toBe("/var/lib/volli-runner/volli.sock");
  });
});

describe("the paths a command uses", () => {
  const inputs = { uid: 1000, home: "/home/ada", env: {}, cwd: "/work" };

  it("are the defaults, overridden by --data-dir and --config-dir against the cwd", () => {
    expect(pathsFor({}, inputs)).toEqual(defaultRunnerPaths(inputs));
    expect(pathsFor({ "data-dir": "state", "config-dir": "/etc/r" }, inputs)).toEqual({
      mode: "user",
      dataDir: "/work/state",
      configDir: "/etc/r",
    });
  });

  it("read only string options", () => {
    expect(stringOption({ yes: true, name: "box" }, "yes")).toBeUndefined();
    expect(stringOption({ yes: true, name: "box" }, "name")).toBe("box");
  });
});
