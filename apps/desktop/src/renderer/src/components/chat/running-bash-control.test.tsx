// @vitest-environment jsdom
import { ACTIVITY_METADATA_KEY, type BackgroundShellState } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { ToolRow } from "./activity-ui";
import { RunningBashControl, RunningBashProvider } from "./running-bash-control";

const fixture = vi.hoisted(() => ({ move: vi.fn(), remote: vi.fn(), toast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: fixture.toast } }));
vi.mock("@renderer/lib/session-project", () => ({ remoteHostOfSession: fixture.remote }));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({ shells: { moveToBackground: { mutate: fixture.move } } }),
}));

const SESSION = "00000000-0000-4000-8000-000000000001";
const part: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "volli.activity",
  toolCallId: "bash-1",
  state: "output-available",
  preliminary: true,
  input: { command: "pnpm dev" },
  output: { content: [{ type: "text", text: "Listening" }], details: { backgroundable: true } },
  toolMetadata: {
    [ACTIVITY_METADATA_KEY]: {
      kind: "run-command",
      nativeToolName: "bash",
      subject: { label: "pnpm dev", path: null, lineRange: null },
      outcome: null,
      startedAt: 1,
      endedAt: null,
    },
  } as DynamicToolUIPart["toolMetadata"],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.move.mockReset().mockResolvedValue({ shellId: "shell-1" });
  fixture.remote.mockReset().mockReturnValue(null);
  fixture.toast.mockClear();
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function mount(next = part, active = true, provider = true) {
  await act(async () =>
    root.render(
      provider ? (
        <RunningBashProvider sessionId={SESSION} active={active}>
          <ToolRow part={next} />
        </RunningBashProvider>
      ) : (
        <RunningBashControl part={next} />
      ),
    ),
  );
}
function shortcut() {
  return new KeyboardEvent("keydown", {
    key: "B",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
}
function button() {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === "Move to background",
  );
}
function shell(
  shellId: string,
  sessionId = SESSION,
  state: BackgroundShellState["state"] = "running",
): BackgroundShellState {
  return {
    shellId,
    sessionId,
    projectId: "p",
    ticketId: null,
    command: "pnpm dev",
    title: null,
    state,
    code: null,
    signal: null,
    startedAt: 1,
    exitedAt: null,
    pid: 1,
  };
}

describe("running bash control", () => {
  it("moves the addressed call without disclosing the command and disappears on success", async () => {
    await mount();
    const disclosure = container.querySelector("[aria-expanded]");
    await act(async () => button()?.click());
    expect(fixture.move).toHaveBeenCalledWith({ sessionId: SESSION, toolCallId: "bash-1" });
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(button()).toBeUndefined();
  });
  it("offers Ctrl+Shift+B inside the focused Session, and ignores other chords", async () => {
    await mount();
    const control = button()!;
    control.focus();
    for (const options of [
      {},
      { ctrlKey: true },
      { ctrlKey: true, shiftKey: true, metaKey: true },
      { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true, repeat: true },
    ]) {
      await act(async () =>
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: "b", bubbles: true, ...options }),
        ),
      );
    }
    expect(fixture.move).not.toHaveBeenCalled();
    await act(async () =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true, bubbles: true }),
      ),
    );
    expect(fixture.move).toHaveBeenCalledTimes(1);
  });
  it("works from the composer but never another Session or outside the app pane", async () => {
    await mount();
    container.setAttribute("data-running-bash-session", SESSION);
    const composer = document.createElement("textarea");
    container.append(composer);
    const outside = document.createElement("textarea");
    document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(shortcut());
      document.dispatchEvent(shortcut());
      container.setAttribute("data-running-bash-session", "another-session");
      composer.dispatchEvent(shortcut());
      container.setAttribute("data-running-bash-session", SESSION);
      const prevented = shortcut();
      prevented.preventDefault();
      composer.dispatchEvent(prevented);
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(fixture.move).not.toHaveBeenCalled();
    composer.focus();
    await act(async () => composer.dispatchEvent(shortcut()));
    expect(fixture.move).toHaveBeenCalledOnce();
    outside.remove();
  });
  it("counts running shells of this Session only and recovers after one stops", async () => {
    useBackgroundShellsStore
      .getState()
      .receiveAll([
        shell("1"),
        shell("2"),
        shell("3"),
        shell("4"),
        shell("5", "other"),
        shell("6", SESSION, "exited"),
      ]);
    await mount();
    expect(button()?.disabled).toBe(true);
    expect(button()?.getAttribute("aria-description")).toContain("Stop one first");
    await act(async () =>
      button()?.parentElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", ctrlKey: true, shiftKey: true, bubbles: true }),
      ),
    );
    expect(fixture.move).not.toHaveBeenCalled();
    await act(async () => useBackgroundShellsStore.getState().remove("1"));
    expect(button()?.disabled).toBe(false);
  });
  it("disables remote Sessions and rechecks remote ownership before calling the local host", async () => {
    fixture.remote.mockReturnValue("box");
    await mount();
    expect(button()?.disabled).toBe(true);
    expect(button()?.getAttribute("aria-description")).toContain("remote hosts");
    fixture.remote.mockReturnValue(null);
    await mount({ ...part });
    fixture.remote.mockReturnValue("box");
    await act(async () => button()?.click());
    expect(fixture.move).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith(expect.stringContaining("remote hosts"));
  });
  it("shows mutation errors, allows retry, and prevents concurrent duplicate intent", async () => {
    const pending = Promise.withResolvers<{ shellId: string }>();
    fixture.move.mockReturnValue(pending.promise);
    await mount();
    const control = button()!;
    await act(async () => {
      control.click();
      control.click();
    });
    expect(fixture.move).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Moving…");
    await act(async () => pending.reject(new Error("This command already exited")));
    expect(fixture.toast).toHaveBeenCalledWith("This command already exited");
    expect(button()?.disabled).toBe(false);
    fixture.move.mockRejectedValue("unknown");
    await act(async () => button()?.click());
    expect(fixture.toast).toHaveBeenCalledWith("Couldn’t move command to the background.");
  });
  it("hides settled, pending, nested/unsupported, unaddressed and inactive rows", async () => {
    await mount(part, true, false);
    expect(button()).toBeUndefined();
    await mount(part, false);
    expect(button()).toBeUndefined();
    const cases: DynamicToolUIPart[] = [
      { ...part, preliminary: false },
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "pending",
        state: "input-available",
        input: {},
      },
      { ...part, output: null },
      { ...part, output: { details: null } },
      { ...part, output: { details: {} } },
      { ...part, output: { details: { backgroundable: false } } },
      // Code Mode's nested shell has no supported foreground-host hint.
      { ...part, toolCallId: "program/nested/bash", output: { content: [] } },
      { ...part, toolMetadata: undefined },
    ];
    for (const next of cases) {
      await mount(next);
      expect(button()).toBeUndefined();
      await act(async () =>
        root.render(
          <RunningBashProvider sessionId={SESSION} active>
            <RunningBashControl part={next} />
          </RunningBashProvider>,
        ),
      );
      expect(button()).toBeUndefined();
    }
    expect(fixture.move).not.toHaveBeenCalled();
  });
});
