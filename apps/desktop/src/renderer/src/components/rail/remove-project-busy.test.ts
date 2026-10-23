import { describe, expect, it } from "vite-plus/test";
import type { BackgroundShellState, ChatSessionRecord } from "@volli/shared";

import { openTurnCount, removeProjectBusyLines, runningShellCount } from "./remove-project-busy";

function chat(activity: ChatSessionRecord["activity"]): ChatSessionRecord {
  return { activity } as ChatSessionRecord;
}

function shell(shellId: string, projectId: string, state: "running" | "exited") {
  return { shellId, projectId, state } as BackgroundShellState;
}

// VC-796: the host stops structured Sessions and background shells along with
// terminals, so the confirm names each kind it would end.
describe("removeProjectBusyLines", () => {
  it("names nothing when removing ends nothing", () => {
    expect(removeProjectBusyLines({ busyProcesses: [], openTurns: 0, runningShells: 0 })).toEqual(
      [],
    );
  });

  it("names a busy terminal, an open turn and a running shell, each on its own line", () => {
    expect(
      removeProjectBusyLines({ busyProcesses: ["vite"], openTurns: 1, runningShells: 1 }),
    ).toEqual([
      "“vite” is still running. Removing the project will end it.",
      "1 agent Session has a turn open. Removing the project will end it.",
      "1 background shell is running. Removing the project will end it.",
    ]);
  });

  it("counts several of each", () => {
    expect(
      removeProjectBusyLines({ busyProcesses: ["vite", "vite"], openTurns: 3, runningShells: 2 }),
    ).toEqual([
      "2 terminals are still running (vite). Removing the project will end them.",
      "3 agent Sessions have turns open. Removing the project will end them.",
      "2 background shells are running. Removing the project will end them.",
    ]);
  });
});

describe("openTurnCount", () => {
  it("counts working and waiting Sessions, and nothing before the listing loads", () => {
    expect(openTurnCount(undefined)).toBe(0);
    expect(
      openTurnCount([
        chat("working"),
        chat("waiting"),
        chat("idle"),
        chat("stopped"),
        chat("interrupted"),
      ]),
    ).toBe(2);
  });
});

describe("runningShellCount", () => {
  it("counts only this project's running shells", () => {
    expect(
      runningShellCount(
        {
          a: shell("a", "p", "running"),
          b: shell("b", "p", "exited"),
          c: shell("c", "q", "running"),
        },
        "p",
      ),
    ).toBe(1);
  });
});
