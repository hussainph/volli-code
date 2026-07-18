import { describe, expect, it } from "vite-plus/test";

import { launchApp, materializeFileArguments } from "./runtime";

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
});

describe("launchApp", () => {
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
});
