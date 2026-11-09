import { describe, expect, it } from "vite-plus/test";

import {
  launchedIntoMenuBar,
  RUNNER_LOGIN_ITEM_ARG,
  runnerLoginItemSettings,
  runnerLoginItemState,
  syncRunnerLoginItem,
  type RunnerLoginItemPort,
  type RunnerLoginItemSettings,
  type RunnerLoginItemState,
} from "./login-item";

const CLOUD_MAC = { cloud: true, platform: "darwin", packaged: true } as const;

function fakePort(state: RunnerLoginItemState): {
  port: RunnerLoginItemPort;
  applied: RunnerLoginItemSettings[];
  reads: () => number;
} {
  const applied: RunnerLoginItemSettings[] = [];
  let reads = 0;
  return {
    applied,
    reads: () => reads,
    port: {
      read: () => {
        reads += 1;
        return state;
      },
      apply: (settings) => {
        applied.push(settings);
        state = settings.openAtLogin ? "registered" : "not-registered";
      },
    },
  };
}

describe("the login item behind the switch", () => {
  it("registers a packaged Mac's cloud launch, on by default", () => {
    for (const preference of [undefined, "true"]) {
      expect(runnerLoginItemSettings(CLOUD_MAC, preference)).toEqual({
        openAtLogin: true,
      });
    }
    expect(runnerLoginItemSettings(CLOUD_MAC, "false")).toEqual({ openAtLogin: false });
  });

  it("touches no other machine: a dev build or another platform never writes the OS", () => {
    expect(runnerLoginItemSettings({ ...CLOUD_MAC, platform: "linux" }, "true")).toBeNull();
    expect(runnerLoginItemSettings({ ...CLOUD_MAC, packaged: false }, "true")).toBeNull();
  });

  it("leaves every login item untouched in a non-cloud launch", () => {
    const local = { ...CLOUD_MAC, cloud: false };
    expect(runnerLoginItemSettings(local, "true")).toBeNull();
    expect(runnerLoginItemSettings(local, undefined)).toBeNull();
  });
});

describe("the OS answer", () => {
  it("maps every macOS status, including an item a person turned off", () => {
    expect(runnerLoginItemState({ openAtLogin: true, status: "enabled" })).toBe("registered");
    expect(runnerLoginItemState({ openAtLogin: false, status: "requires-approval" })).toBe(
      "needs-approval",
    );
    expect(runnerLoginItemState({ openAtLogin: false, status: "not-registered" })).toBe(
      "not-registered",
    );
    expect(runnerLoginItemState({ openAtLogin: false, status: "not-found" })).toBe(
      "not-registered",
    );
  });

  it("falls back to openAtLogin where the OS reports no status", () => {
    expect(runnerLoginItemState({ openAtLogin: true })).toBe("registered");
    expect(runnerLoginItemState({ openAtLogin: false })).toBe("not-registered");
  });
});

describe("a login launch", () => {
  const launch = {
    cloud: true,
    platform: "darwin",
    argv: ["/Applications/Volli.app/Contents/MacOS/Volli"],
    openedAtLogin: false,
  } as const;

  it("comes up in the menu bar from the argument or from the OS's own answer", () => {
    expect(launchedIntoMenuBar({ ...launch, argv: [...launch.argv, RUNNER_LOGIN_ITEM_ARG] })).toBe(
      true,
    );
    expect(launchedIntoMenuBar({ ...launch, openedAtLogin: true })).toBe(true);
    expect(launchedIntoMenuBar(launch)).toBe(false);
  });

  it("never comes up windowless outside a cloud launch, or off a Mac", () => {
    expect(
      launchedIntoMenuBar({
        ...launch,
        cloud: false,
        argv: [...launch.argv, RUNNER_LOGIN_ITEM_ARG],
      }),
    ).toBe(false);
    expect(
      launchedIntoMenuBar({
        ...launch,
        platform: "linux",
        argv: [...launch.argv, RUNNER_LOGIN_ITEM_ARG],
        openedAtLogin: true,
      }),
    ).toBe(false);
  });
});

describe("bringing the OS in line", () => {
  const on = runnerLoginItemSettings(CLOUD_MAC, "true")!;
  const off = runnerLoginItemSettings(CLOUD_MAC, "false")!;

  it("writes only on a real change", () => {
    const missing = fakePort("not-registered");
    expect(syncRunnerLoginItem(missing.port, on)).toBe("applied");
    expect(missing.applied).toEqual([on]);

    const present = fakePort("registered");
    expect(syncRunnerLoginItem(present.port, on)).toBe("unchanged");
    expect(present.applied).toEqual([]);

    expect(syncRunnerLoginItem(present.port, off)).toBe("applied");
    expect(present.applied).toEqual([off]);

    const absent = fakePort("not-registered");
    expect(syncRunnerLoginItem(absent.port, off)).toBe("unchanged");
    expect(absent.applied).toEqual([]);
  });

  it("never overturns the person's Login Items setting, and never writes what it was not asked to", () => {
    const approval = fakePort("needs-approval");
    expect(() => syncRunnerLoginItem(approval.port, on)).toThrow("Allow Volli in System Settings");
    expect(approval.applied).toEqual([]);
    expect(syncRunnerLoginItem(approval.port, off)).toBe("applied");
    expect(approval.applied).toEqual([off]);

    const untouched = fakePort("registered");
    expect(syncRunnerLoginItem(untouched.port, null)).toBe("skipped");
    expect(untouched.reads()).toBe(0);
    expect(untouched.applied).toEqual([]);
  });

  it("refuses a silently failed OS write, including one that now needs approval", () => {
    expect(() =>
      syncRunnerLoginItem({ read: () => "not-registered", apply: () => {} }, on),
    ).toThrow("Couldn’t change the login item");
    let applied = false;
    expect(() =>
      syncRunnerLoginItem(
        {
          read: () => (applied ? "needs-approval" : "not-registered"),
          apply: () => {
            applied = true;
          },
        },
        on,
      ),
    ).toThrow("Allow Volli in System Settings");
  });
});
