import { describe, expect, it } from "vite-plus/test";

import { launchApp, materializeFileArguments, requireLaunchSocketPath } from "./runtime";

const readFromFile = async () => "from file";

describe("requireLaunchSocketPath", () => {
  it("passes through a set socket path", () => {
    expect(requireLaunchSocketPath("/profiles/volli.sock")).toBe("/profiles/volli.sock");
  });

  it("reports app.launch outside a Volli shim as app-unreachable, not a generic failure", () => {
    let thrown: unknown;
    try {
      requireLaunchSocketPath(undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "APP_UNREACHABLE" });
  });
});

describe("materializeFileArguments", () => {
  it("reads file-backed bodies in the client before the socket round-trip", async () => {
    const invocation = {
      command: "ticket.update",
      args: { id: "VC-12", bodyFile: "/tmp/body.md", addLabels: [], removeLabels: [] },
      json: false,
    };

    await expect(
      materializeFileArguments(invocation, async (path) => {
        expect(path).toBe("/tmp/body.md");
        return "# New body";
      }),
    ).resolves.toEqual({
      ...invocation,
      args: {
        id: "VC-12",
        bodyMutation: { mode: "replace", body: "# New body" },
        addLabels: [],
        removeLabels: [],
      },
    });
  });

  it("materializes create and comment files and leaves ordinary arguments alone", async () => {
    await expect(
      materializeFileArguments(
        { command: "ticket.create", args: { bodyFile: "/body" }, json: false },
        readFromFile,
      ),
    ).resolves.toMatchObject({ args: { body: "from file" } });
    await expect(
      materializeFileArguments(
        { command: "ticket.comment", args: { file: "/comment" }, json: false },
        readFromFile,
      ),
    ).resolves.toMatchObject({ args: { message: "from file" } });
    const invocation = { command: "board", args: {}, json: false };
    await expect(materializeFileArguments(invocation, readFromFile)).resolves.toBe(invocation);
    await expect(
      materializeFileArguments(
        { command: "board", args: { file: "/unused" }, json: false },
        readFromFile,
      ),
    ).resolves.toMatchObject({ args: {} });
  });

  it("maps file read errors without leaking arbitrary thrown values", async () => {
    await expect(
      materializeFileArguments(
        { command: "ticket.create", args: { bodyFile: "/missing" }, json: false },
        async () => {
          throw new Error("gone");
        },
      ),
    ).rejects.toMatchObject({ code: "FILE_READ_FAILED", message: "Could not read /missing: gone" });
    await expect(
      materializeFileArguments(
        { command: "ticket.comment", args: { file: "/bad" }, json: false },
        async () => {
          throw "bad value";
        },
      ),
    ).rejects.toMatchObject({
      code: "FILE_READ_FAILED",
      message: "Could not read /bad: bad value",
    });
  });
});

describe("launchApp", () => {
  it("returns without spawning when the socket is already reachable", async () => {
    let spawned = false;
    await expect(
      launchApp(
        {
          socketPath: "/socket",
          executable: "/app",
          appEntry: undefined,
          timeoutMs: 100,
          env: {},
        },
        {
          probe: async () => undefined,
          spawnDetached: () => {
            spawned = true;
          },
          delay: async () => undefined,
          now: () => 0,
        },
      ),
    ).resolves.toEqual({ alreadyRunning: true });
    expect(spawned).toBe(false);
  });

  it("spawns explicitly, strips run-as-node, and waits until the app is reachable", async () => {
    let probes = 0;
    const spawns: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    const result = await launchApp(
      {
        socketPath: "/profiles/volli.sock",
        executable: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
        appEntry: undefined,
        timeoutMs: 1000,
        env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" },
      },
      {
        probe: async () => {
          probes += 1;
          if (probes < 3) throw new Error("not ready");
        },
        spawnDetached: (executable, args, env) => spawns.push({ executable, args, env }),
        delay: async () => undefined,
        now: (() => {
          let value = 0;
          return () => (value += 10);
        })(),
      },
    );

    expect(result).toEqual({ alreadyRunning: false });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      executable: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
      args: [],
      env: { PATH: "/bin", VOLLI_LAUNCHED_BY_CLI: "1" },
    });
    expect(spawns[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("does not forward CLI context, Node injection, or test-only overrides into the GUI app", async () => {
    const spawns: NodeJS.ProcessEnv[] = [];
    let probes = 0;
    await launchApp(
      {
        socketPath: "/profiles/volli.sock",
        executable: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
        appEntry: undefined,
        timeoutMs: 100,
        env: {
          PATH: "/bin",
          NODE_OPTIONS: "--require /tmp/inject.cjs",
          NODE_PATH: "/tmp/modules",
          DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
          LD_PRELOAD: "/tmp/inject.so",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_RENDERER_URL: "https://attacker.invalid",
          VOLLI_SOCKET: "/attacker.sock",
          VOLLI_SESSION: "spoofed-session",
          VOLLI_TICKET: "EVIL-1",
          VOLLI_ARTIFACTS_DIR: "/tmp/evil",
          VOLLI_APP_EXECUTABLE: "/tmp/evil-app",
          VOLLI_APP_ENTRY: "/tmp/evil-entry",
          VOLLI_DB_PATH: "/tmp/evil.db",
          VOLLI_AGENT_HOME: "/tmp/evil-home",
          VOLLI_AGENT_CONSENT_CHOICE: "install",
          VOLLI_SKIP_CLOSE_CONFIRM: "1",
        },
      },
      {
        probe: async () => {
          probes += 1;
          if (probes === 1) throw new Error("not running");
        },
        spawnDetached: (_executable, _args, env) => spawns.push(env),
        delay: async () => undefined,
        now: (() => {
          let value = 0;
          return () => (value += 10);
        })(),
      },
    );

    expect(spawns).toEqual([{ PATH: "/bin", VOLLI_LAUNCHED_BY_CLI: "1" }]);
  });

  it("passes an app entry and times out if the launched socket never appears", async () => {
    const spawns: string[][] = [];
    let now = 0;
    await expect(
      launchApp(
        {
          socketPath: "/socket",
          executable: "/electron",
          appEntry: "/app/main.cjs",
          userDataPath: "/profiles/volli-dev",
          timeoutMs: 40,
          env: {},
        } as Parameters<typeof launchApp>[0],
        {
          probe: async () => {
            throw new Error("down");
          },
          spawnDetached: (_executable, args) => spawns.push(args),
          delay: async () => undefined,
          now: () => (now += 20),
        },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(spawns).toEqual([["/app/main.cjs", "--user-data-dir=/profiles/volli-dev"]]);
  });
});
