// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundShellState } from "../../../../ipc/contract";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import {
  SHELL_OUTPUT_POLL_MS,
  ShellOutputView,
  type ShellOutputViewProps,
} from "./shell-output-view";

function shell(overrides: Partial<BackgroundShellState> = {}): BackgroundShellState {
  return {
    shellId: "sh-1",
    sessionId: "session-1",
    projectId: "project-1",
    ticketId: null,
    command: "pnpm dev\n# watch",
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useBackgroundShellsStore.setState({ byId: {}, hydrated: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(api: ShellOutputViewProps["api"]) {
  await act(async () => {
    root?.render(React.createElement(ShellOutputView, { shellId: "sh-1", api }));
  });
}

const pre = (): string => container?.querySelector("pre")?.textContent ?? "";
const standing = (): string => container?.querySelector("[data-shell-standing]")?.textContent ?? "";

describe("ShellOutputView", () => {
  it("reads the tail on mount into a plain pre, and re-reads while the shell runs", async () => {
    useBackgroundShellsStore.getState().receive(shell());
    let output = "line 1\n";
    const tail = vi.fn(async () => ({ ok: true as const, output, shell: shell() }));
    await render({ tail });

    expect(tail).toHaveBeenCalledTimes(1);
    expect(pre()).toBe("line 1\n");
    expect(container?.querySelector("pre")?.className).toContain("font-mono");
    expect(standing()).toBe("running");
    // The header names the command's first line, never the whole script.
    expect(container?.textContent).toContain("pnpm dev");
    expect(container?.textContent).not.toContain("# watch");

    output = "line 1\nline 2\n";
    await act(async () => {
      vi.advanceTimersByTime(SHELL_OUTPUT_POLL_MS);
    });
    expect(tail).toHaveBeenCalledTimes(2);
    expect(pre()).toBe("line 1\nline 2\n");
  });

  it("stops polling once the shell exits, after one last read for the final lines", async () => {
    useBackgroundShellsStore.getState().receive(shell());
    let output = "building\n";
    const tail = vi.fn(async () => ({ ok: true as const, output, shell: shell() }));
    await render({ tail });
    expect(tail).toHaveBeenCalledTimes(1);

    output = "building\ndone\n";
    await act(async () => {
      useBackgroundShellsStore
        .getState()
        .receive(shell({ state: "exited", code: 0, exitedAt: 2_000 }));
    });
    // The transition itself triggers the final read.
    expect(tail).toHaveBeenCalledTimes(2);
    expect(pre()).toBe("building\ndone\n");
    expect(standing()).toBe("exited 0");

    await act(async () => {
      vi.advanceTimersByTime(SHELL_OUTPUT_POLL_MS * 5);
    });
    expect(tail).toHaveBeenCalledTimes(2);
  });

  it("says a forgotten shell is gone rather than showing an empty pane", async () => {
    const tail = vi.fn(async () => ({
      ok: false as const,
      error: "This background shell is gone.",
    }));
    await render({ tail });
    expect(standing()).toBe("gone");
    expect(pre()).toContain("attachment ended");
  });

  it("names the exit signal for a killed shell", async () => {
    useBackgroundShellsStore.getState().receive(shell({ state: "exited", signal: "SIGTERM" }));
    const tail = vi.fn(async () => ({ ok: true as const, output: "", shell: shell() }));
    await render({ tail });
    expect(standing()).toBe("exited by SIGTERM");
  });
});
