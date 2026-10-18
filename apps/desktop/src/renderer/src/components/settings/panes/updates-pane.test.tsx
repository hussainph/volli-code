// @vitest-environment jsdom
/**
 * Settings → Updates as a person reads it after the toast is gone (VC-294):
 * what the last check found stays on the page with a retry, and a channel the
 * pane could not read is a fault on screen — not a disabled "Stable".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Result, UpdateChannelResult, UpdateUiState } from "../../../../../ipc/contract";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";
import { useUpdateStore } from "@renderer/stores/update";

import { UpdatesPane } from "./updates-pane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDLE: UpdateUiState = {
  supported: true,
  phase: "idle",
  currentVersion: "0.2.0",
  targetVersion: null,
  percent: null,
  error: null,
  lastCheck: null,
};

let container: HTMLDivElement;
let root: Root;
let channel: () => Promise<UpdateChannelResult>;
let check: () => Promise<Result>;
let channelReads: number;
let checks: number;

function stubApi(): void {
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { api: unknown }).api = {
    updates: {
      channel: () => {
        channelReads += 1;
        return channel();
      },
      check: () => {
        checks += 1;
        return check();
      },
      setChannel: () => Promise.resolve({ ok: true, channel: "stable" }),
    },
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<UpdatesPane />);
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

beforeEach(() => {
  channelReads = 0;
  checks = 0;
  channel = () => Promise.resolve({ ok: true, channel: "canary" });
  check = () => Promise.resolve({ ok: true });
  stubApi();
  useUpdateStore.setState({ state: IDLE, dialogOpen: false, promptedVersions: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(toastError).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("UpdatesPane", () => {
  it("shows the channel it read", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>("#update-channel");
    expect(trigger?.textContent).toContain("Canary");
    expect(trigger?.disabled).toBe(false);
  });

  it("says a refused channel read is a fault, and retries it", async () => {
    channel = () => Promise.resolve({ ok: false, error: "The release channel isn't readable." });
    await render();

    // No select pretending to be "Stable" — the fault, with its cause on hover.
    expect(container.querySelector("#update-channel")).toBeNull();
    expect(container.textContent).toContain("Couldn’t read the channel");
    expect(
      container.querySelector('[title="The release channel isn\'t readable."]'),
    ).not.toBeNull();

    channel = () => Promise.resolve({ ok: true, channel: "stable" });
    await act(async () => button("Retry").click());

    expect(channelReads).toBe(2);
    expect(container.textContent).not.toContain("Couldn’t read the channel");
    expect(container.querySelector("#update-channel")?.textContent).toContain("Stable");
  });

  it("treats a rejected channel read the same way", async () => {
    channel = () => Promise.reject(new Error("bridge gone"));
    await render();
    expect(container.textContent).toContain("Couldn’t read the channel");
    expect(container.querySelector('[title="bridge gone"]')).not.toBeNull();
  });

  it("keeps the last check's failure on the page with a retry that checks again", async () => {
    useUpdateStore.setState({
      state: {
        ...IDLE,
        lastCheck: { at: Date.now(), result: "error", version: null, error: "feed unreachable" },
      },
    });
    await render();

    expect(container.textContent).toContain("Check failed · just now");
    expect(container.textContent).toContain("feed unreachable");

    await act(async () => button("Retry").click());
    expect(checks).toBe(1);
  });

  it("says up to date after a relaunch, from the stored check", async () => {
    useUpdateStore.setState({
      state: {
        ...IDLE,
        lastCheck: { at: Date.now(), result: "up-to-date", version: null, error: null },
      },
    });
    await render();
    expect(container.textContent).toContain("Up to date · just now");
    expect(button("Check now").disabled).toBe(false);
  });

  it("surfaces a check that could not even be asked", async () => {
    check = () => Promise.resolve({ ok: false, error: "no updater" });
    await render();
    await act(async () => button("Check now").click());
    expect(toastError).toHaveBeenCalledWith("Couldn't check for updates: no updater");

    check = () => Promise.reject(new Error("bridge gone"));
    await act(async () => button("Check now").click());
    expect(toastError).toHaveBeenCalledWith("Couldn't check for updates: bridge gone");
  });

  it("keeps the Status row and a disabled check before the store has a snapshot", async () => {
    useUpdateStore.setState({ state: null });
    await render();
    expect(container.textContent).toContain("Status");
    expect(button("Check now").disabled).toBe(true);
  });

  it("holds the button while a check runs", async () => {
    useUpdateStore.setState({ state: { ...IDLE, phase: "checking" } });
    await render();
    expect(button("Checking…").disabled).toBe(true);
  });
});
