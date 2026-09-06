// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundShellState } from "../../../../ipc/contract";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import {
  islandShellActions,
  projectIslandShells,
  shellTransitionFlashes,
  useIslandShells,
} from "./island-shells";

function shell(overrides: Partial<BackgroundShellState> = {}): BackgroundShellState {
  return {
    shellId: "sh-1",
    sessionId: "session-1",
    projectId: "project-1",
    ticketId: null,
    command: "pnpm dev",
    title: null,
    state: "running",
    code: null,
    signal: null,
    startedAt: 1_000,
    exitedAt: null,
    pid: 42,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useBackgroundShellsStore.setState({ byId: {}, hydrated: false });
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

/** The smallest hook harness: mount a component that reads the hook into a ref. */
function renderHook<T>(use: () => T): { current: T } {
  const result = { current: undefined as T };
  function Probe(): null {
    result.current = use();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(React.createElement(Probe)));
  return result;
}

describe("projectIslandShells", () => {
  it("projects one Session's shells in start order, commands cut to their first line", () => {
    const shells = projectIslandShells(
      [
        shell({ shellId: "later", startedAt: 3_000, command: "pnpm test --watch\n# more" }),
        shell({ shellId: "other", sessionId: "session-2" }),
        shell({ shellId: "first", startedAt: 1_000, state: "exited", code: 1, exitedAt: 2_000 }),
        shell({
          shellId: "killed",
          startedAt: 2_000,
          state: "exited",
          code: null,
          signal: "SIGTERM",
        }),
      ],
      "session-1",
    );

    expect(shells).toEqual([
      { id: "first", command: "pnpm dev", state: "exited", code: 1 },
      { id: "killed", command: "pnpm dev", state: "exited", code: null },
      { id: "later", command: "pnpm test --watch", state: "running", code: null },
    ]);
  });

  it("names a shell by its first non-blank line, then its title, then its id", () => {
    // The island's contract says `command`; the title is the model's own
    // label and only steps in when the command has no line to show.
    const named = (over: Partial<BackgroundShellState>) =>
      projectIslandShells([shell(over)], "session-1")[0]?.command;
    expect(named({ title: "dev", command: "\n\npnpm dev" })).toBe("pnpm dev");
    expect(named({ title: "dev", command: "  " })).toBe("dev");
    expect(named({ command: "  " })).toBe("sh-1");
  });
});

describe("shellTransitionFlashes", () => {
  const running = { id: "sh-1", command: "pnpm dev", state: "running" as const, code: null };

  it("announces a start, an exit with its code, and a kill — one flash per transition", () => {
    expect(shellTransitionFlashes([], [running])).toEqual([
      { id: "shell:sh-1:started", event: "Started", payload: "pnpm dev" },
    ]);
    expect(shellTransitionFlashes([running], [{ ...running, state: "exited", code: 0 }])).toEqual([
      { id: "shell:sh-1:exited", event: "Exited 0", payload: "pnpm dev" },
    ]);
    expect(shellTransitionFlashes([running], [{ ...running, state: "exited", code: 1 }])).toEqual([
      { id: "shell:sh-1:exited", event: "Exited 1", payload: "pnpm dev" },
    ]);
    expect(
      shellTransitionFlashes([running], [{ ...running, state: "exited", code: null }]),
    ).toEqual([{ id: "shell:sh-1:exited", event: "Killed", payload: "pnpm dev" }]);
  });

  it("is quiet for no change, for a re-projection, and for a shell that was forgotten", () => {
    expect(shellTransitionFlashes([running], [{ ...running }])).toEqual([]);
    expect(shellTransitionFlashes([running], [])).toEqual([]);
    const exited = { ...running, state: "exited" as const, code: 0 };
    expect(shellTransitionFlashes([exited], [exited])).toEqual([]);
  });

  it("announces a shell that arrived already exited as started then exited, in that order", () => {
    // A command that finished inside the settle window reaches the store as
    // one exited record; the person still saw it happen.
    expect(shellTransitionFlashes([], [{ ...running, state: "exited", code: 0 }])).toEqual([
      { id: "shell:sh-1:started", event: "Started", payload: "pnpm dev" },
      { id: "shell:sh-1:exited", event: "Exited 0", payload: "pnpm dev" },
    ]);
  });
});

describe("useIslandShells", () => {
  it("projects the store for one Session and flashes each transition once", () => {
    useBackgroundShellsStore.getState().receive(shell({ shellId: "pre", startedAt: 500 }));
    const result = renderHook(() => useIslandShells("session-1"));

    // What was already there on mount is state, not news: no flash for it.
    expect(result.current.shells.map((one) => one.id)).toEqual(["pre"]);
    expect(result.current.flash).toBeNull();

    act(() =>
      useBackgroundShellsStore.getState().receive(shell({ shellId: "sh-2", startedAt: 2_000 })),
    );
    expect(result.current.shells.map((one) => one.id)).toEqual(["pre", "sh-2"]);
    expect(result.current.flash).toEqual({
      id: "shell:sh-2:started",
      event: "Started",
      payload: "pnpm dev",
    });

    act(() =>
      useBackgroundShellsStore
        .getState()
        .receive(shell({ shellId: "sh-2", startedAt: 2_000, state: "exited", code: 0 })),
    );
    expect(result.current.flash).toEqual({
      id: "shell:sh-2:exited",
      event: "Exited 0",
      payload: "pnpm dev",
    });

    // Another Session's shell is neither listed nor announced.
    act(() =>
      useBackgroundShellsStore
        .getState()
        .receive(shell({ shellId: "theirs", sessionId: "session-2" })),
    );
    expect(result.current.shells.map((one) => one.id)).toEqual(["pre", "sh-2"]);
    expect(result.current.flash?.id).toBe("shell:sh-2:exited");

    // The attachment ended: the shells go, the last flash stays until the
    // island's own hold expires it.
    act(() => {
      useBackgroundShellsStore.getState().remove("pre");
      useBackgroundShellsStore.getState().remove("sh-2");
    });
    expect(result.current.shells).toEqual([]);
    expect(result.current.flash?.id).toBe("shell:sh-2:exited");
  });

  it("keeps the same array across unrelated store changes, so the island's spring does not restart", () => {
    useBackgroundShellsStore.getState().receive(shell());
    const result = renderHook(() => useIslandShells("session-1"));
    const first = result.current.shells;
    act(() =>
      useBackgroundShellsStore.getState().receive(shell({ shellId: "x", sessionId: "session-9" })),
    );
    expect(result.current.shells).toBe(first);
  });
});

describe("islandShellActions", () => {
  it("opens output through the injected door and kills through the bridge, toasting a refusal", async () => {
    const kill = vi.fn(async (input: { shellId: string }) =>
      input.shellId === "sh-1" ? { ok: true as const } : { ok: false as const, error: "gone" },
    );
    const openOutput = vi.fn();
    const onError = vi.fn();
    const actions = islandShellActions({ api: { kill }, openOutput, onError });

    actions.openShell("sh-1");
    expect(openOutput).toHaveBeenCalledWith("sh-1");

    actions.killShell("sh-1");
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith({ shellId: "sh-1" }));
    expect(onError).not.toHaveBeenCalled();

    actions.killShell("sh-9");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("gone"));
  });

  it("reports a bridge that threw, never swallowing it", async () => {
    const onError = vi.fn();
    const actions = islandShellActions({
      api: {
        kill: vi.fn(async () => {
          throw new Error("bridge down");
        }),
      },
      openOutput: vi.fn(),
      onError,
    });
    actions.killShell("sh-1");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("bridge down"));
  });
});
