// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { setRemoteHostsApi, useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import {
  createFakeRemoteHostsApi,
  flowView,
  registryHost,
  type FakeRemoteHostsApi,
} from "@renderer/stores/remote-hosts.test-support";
import { useUiStore } from "@renderer/stores/ui";

import { HostsChrome } from "./hosts-chrome";
import { click, hostWorld, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

let world: HostWorld | null = null;
let api: FakeRemoteHostsApi;

beforeEach(() => {
  api = createFakeRemoteHostsApi();
  setRemoteHostsApi(api);
});

afterEach(async () => {
  await act(async () => useRemoteHostsStore.getState().closeAddHost());
  await world?.cleanup();
  world = null;
  setRemoteHostsApi(null);
  useRemoteHostsStore.setState({ hosts: [], addHost: { open: false, target: "" } });
  useUiStore.getState().setSettingsOpen(false);
  toast.mockClear();
  toast.error.mockClear();
});

function sheet(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (found === null) throw new Error("sheet closed");
  return found;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(label: string): HTMLInputElement {
  const found = sheet().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`No field "${label}"`);
  return found;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...sheet().querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
}

async function openSheet(target = ""): Promise<void> {
  world = hostWorld();
  await world.render(<HostsChrome />);
  await act(async () => useRemoteHostsStore.getState().openAddHost(target));
}

async function startFlow(target = "deploy@box"): Promise<void> {
  await openSheet();
  await type(input("SSH destination"), target);
  await click(sheet(), "Connect");
}

async function emit(event: Parameters<FakeRemoteHostsApi["emit"]>[1]): Promise<void> {
  await act(async () => api.emit("flow-1", event));
}

function rows(): string[] {
  return [...sheet().querySelectorAll("li[data-step]")].map(
    (row) => `${row.getAttribute("data-step")}:${row.querySelector('[data-slot="step-mark"]')?.getAttribute("data-status")}:${row.textContent}`,
  );
}

describe("Add a host, flag off", () => {
  it("mounts nothing and registers no entry points", async () => {
    world = hostWorld({ cloud: false });
    const root = await world.render(<HostsChrome />);
    expect(root.innerHTML).toBe("");
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(useHostConnectionStore.getState().entryPoints).toEqual({ addHost: null, manageHosts: null });
  });
});

describe("Add a host", () => {
  it("is where the switcher's two entries go while cloud is on, and stops being when it goes off", async () => {
    world = hostWorld();
    await world.render(<HostsChrome />);
    const { addHost, manageHosts } = useHostConnectionStore.getState().entryPoints;
    await act(async () => addHost?.());
    expect(useRemoteHostsStore.getState().addHost.open).toBe(true);
    expect(sheet().textContent).toContain("Add a host");
    act(() => manageHosts?.());
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsCategory).toBe("hosts");
    await act(async () =>
      (await import("@renderer/stores/experiments")).useExperimentsStore.setState({ snapshot: null }),
    );
    expect(useHostConnectionStore.getState().entryPoints).toEqual({ addHost: null, manageHosts: null });
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("starts with the address, refusing until it reads as one", async () => {
    await openSheet("box");
    expect(input("SSH destination").value).toBe("box");
    await type(input("SSH destination"), "two words");
    expect(button("Connect")?.disabled).toBe(true);
    await type(input("SSH destination"), " deploy@box ");
    expect(button("Connect")?.disabled).toBe(false);
    await click(sheet(), "Connect");
    expect(api.calls).toEqual([["startAdd", "deploy@box"]]);
    expect(api.following("flow-1")).toBe(true);
  });

  it("says why a start was refused, keeping what was typed", async () => {
    await openSheet();
    api.nextStart = new Error("Not an SSH destination");
    await type(input("SSH destination"), "box");
    await click(sheet(), "Connect");
    expect(sheet().textContent).toContain("Not an SSH destination");
    expect(input("SSH destination").value).toBe("box");
    expect(input("SSH destination").getAttribute("aria-invalid")).toBe("true");
  });

  it("follows the flow step by step, with its log under Details", async () => {
    await startFlow();
    expect(rows()).toEqual([]);
    await emit({ kind: "view", view: flowView({ done: 2, at: "deliver" }) });
    expect(rows()).toEqual([
      "connect:done:Connect",
      "probe:done:Check the system",
      "deliver:active:Uploading Volli host…",
      "install:pending:Install",
      "start:pending:Start",
      "enroll:pending:Pair this Mac",
      "link:pending:Open the connection",
    ]);
    await emit({
      kind: "log",
      flowId: "flow-1",
      line: { at: "t", level: "info", message: "step started", fields: { step: "deliver", flowId: "flow-1", component: "host-install" } },
    });
    expect(sheet().querySelector('[role="log"]')).toBeNull();
    await click(sheet(), "Details");
    const log = sheet().querySelector('[role="log"]');
    expect(log?.textContent).toBe("step started step=deliver");
    await click(sheet(), "Details");
    // Cancel leaves the flow (main discards it) and closes the sheet.
    await click(sheet(), "Cancel");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("asks to trust an unknown host key, showing what to compare", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "connect",
        question: {
          kind: "host-key",
          step: "connect",
          offer: { entries: ["box ssh-ed25519 AAAA"], fingerprints: [{ type: "ED25519", fingerprint: "SHA256:abc" }] },
        },
      }),
    });
    expect(rows()[0]).toBe("connect:attention:Connect");
    expect(sheet().textContent).toContain("This Mac hasn’t seen deploy@box’s key before");
    expect(sheet().querySelector('[aria-label="Host key fingerprints"]')?.textContent).toBe("ED25519SHA256:abc");
    await click(sheet(), "Trust and continue");
    expect(api.calls.at(-1)).toEqual(["answerAdd", "flow-1", "accept-host-key"]);
  });

  it("sends a sudo password straight to main, and offers an install for this account only", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        done: 3,
        at: "install",
        question: { kind: "sudo-password", step: "install", reason: "install", command: "sudo volli-hostd install --system", retry: false },
      }),
    });
    expect(sheet().textContent).toContain("Installing for every account needs sudo");
    expect(sheet().textContent).toContain("sudo volli-hostd install --system");
    expect(sheet().textContent).toContain("Agents on deploy@box will share your account.");
    await type(input("sudo password"), "hunter2");
    await click(sheet(), "Run it");
    expect(api.calls.at(-1)).toEqual(["sudoPassword", "flow-1", "hunter2"]);
    // Never kept: the field is empty again, and nothing else holds it.
    expect(input("sudo password").value).toBe("");
    expect(JSON.stringify(useRemoteHostsStore.getState())).not.toContain("hunter2");
    await click(sheet(), "Install for my account only");
    expect(api.calls.at(-1)).toEqual(["answerAdd", "flow-1", "user-install"]);
  });

  it("says a refused call in a toast and lets the buttons work again", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({ status: "question", at: "probe", done: 1, question: { kind: "already-paired", step: "probe", hostId: "h" } }),
    });
    api.refuseNext("answerAdd", "The flow is not waiting");
    await click(sheet(), "Open deploy@box");
    expect(toast.error).toHaveBeenCalled();
    expect(button("Open deploy@box")?.disabled).toBe(false);
  });

  it("answers an older host, a restored host and a password retry each their own way", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "probe",
        done: 1,
        question: { kind: "existing-hostd", step: "probe", version: "0.2.4", mode: "system", adoptable: true },
      }),
    });
    await click(sheet(), "Use 0.2.4");
    await click(sheet(), "Update and pair");
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "probe",
        done: 1,
        question: { kind: "existing-hostd", step: "probe", version: "0.2.4", mode: "system", adoptable: false },
      }),
    });
    expect(button("Use 0.2.4")).toBeUndefined();
    expect(button("Back")).toBeDefined();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "enroll",
        done: 5,
        question: { kind: "identity-changed", step: "enroll", pinned: "a", hostId: "b" },
      }),
    });
    expect(sheet().textContent).toContain("It was restored or reinstalled.");
    await click(sheet(), "Pair again");
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "start",
        done: 4,
        question: { kind: "sudo-password", step: "start", reason: "linger", command: "sudo loginctl enable-linger deploy", retry: true },
      }),
    });
    expect(sheet().textContent).toContain("That password didn’t work");
    expect(button("Install for my account only")).toBeUndefined();
    await emit({
      kind: "view",
      view: flowView({ status: "question", at: "link", done: 6, question: { kind: "brand-new", step: "link" } }),
    });
    expect(sheet().textContent).toContain("asked something this build can’t answer");
    expect(api.calls.slice(1)).toEqual([
      ["answerAdd", "flow-1", "adopt"],
      ["answerAdd", "flow-1", "update"],
      ["answerAdd", "flow-1", "repair"],
    ]);
  });

  it("shows a failure's line and its recovery, with ssh's words under Details", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: {
        ...flowView({ status: "failed", done: 0 }),
        steps: flowView({ done: 0 }).steps.map((step) => (step.id === "connect" ? { ...step, status: "failed" } : step)),
        failure: {
          code: "unreachable",
          step: "connect",
          line: "Can’t reach deploy@box",
          recovery: { action: "retry", label: "Try again", from: "connect" },
          detail: "ssh: connect to host box port 22: Connection refused",
        },
      },
    });
    expect(rows()[0]).toBe("connect:failed:Connect");
    expect(sheet().querySelector('[role="alert"]')?.textContent).toBe("Can’t reach deploy@box");
    await click(sheet(), "Details");
    expect(sheet().querySelector('[role="log"]')?.textContent).toContain("Connection refused");
    await click(sheet(), "Try again");
    expect(api.calls.at(-1)).toEqual(["retryAdd", "flow-1", "connect"]);
  });

  it("goes back to the address when a failure can only go back", async () => {
    await startFlow("pi@raspberry");
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        target: "pi@raspberry",
        name: "pi@raspberry",
        failure: {
          code: "unsupported-platform",
          step: "probe",
          line: "Volli hosts run on x86-64 Linux or a Mac",
          recovery: { action: "back", label: "Choose another host" },
          detail: null,
        },
      }),
    });
    await click(sheet(), "Choose another host");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(input("SSH destination").value).toBe("pi@raspberry");
  });

  it("says when it lost track of the flow", async () => {
    await startFlow();
    await act(async () => api.fail("flow-1"));
    expect(sheet().textContent).toContain("Lost track of this add.");
    await click(sheet(), "Close");
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("ends on the host's facts: when it starts and whose account its agents share", async () => {
    const host = registryHost({ name: "studio", os: "macos", mode: "user", agentsShareAccount: true });
    useRemoteHostsStore.getState().setHosts([host]);
    await startFlow("me@studio");
    await emit({
      kind: "view",
      view: flowView({
        name: "studio",
        status: "done",
        done: 7,
        hostId: host.id,
        startup: "Starts when you log in to studio",
      }),
    });
    expect(sheet().textContent).toContain("studio is ready");
    expect(sheet().textContent).toContain("macOS · Volli host 1.1.0");
    expect(sheet().querySelector('[aria-label="About this host"]')?.textContent).toBe(
      "Starts when you log in to studioAgents on studio share your account",
    );
    await click(sheet(), "Done");
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    // A finished flow is left alone.
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
  });

  it("cancels an unfinished flow when the sheet is closed", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ at: "connect" }) });
    await click(sheet(), "Close");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });
});
