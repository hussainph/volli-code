// @vitest-environment jsdom
import { act } from "react";
import { PROBE_SCRIPT } from "@volli/host-install";
import { harness, probeOutput, watch } from "@volli/host-install/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { setRemoteHostsApi, useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import {
  createFakeRemoteHostsApi,
  flowView,
  NO_FACTS,
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
  useRemoteHostsStore.setState({ hosts: [], readOnly: null, addHost: { open: false, target: "" } });
  useUiStore.getState().setSettingsOpen(false);
  toast.mockClear();
  toast.error.mockClear();
});

function sheet(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (found === null) throw new Error("sheet closed");
  return found;
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(label: string): HTMLInputElement {
  const found = sheet().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`No field "${label}"`);
  return found;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...sheet().querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
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

/** One plain log line, as main would stream it. */
function line(message: string) {
  return { at: "t", level: "info" as const, message, fields: {} };
}

function rows(): string[] {
  return [...sheet().querySelectorAll("li[data-step]")].map(
    (row) =>
      `${row.getAttribute("data-step")}:${row.querySelector('[data-slot="step-mark"]')?.getAttribute("data-status")}:${row.textContent}`,
  );
}

describe("Add a host, flag off", () => {
  it("mounts nothing and registers no entry points", async () => {
    world = hostWorld({ cloud: false });
    const root = await world.render(<HostsChrome />);
    expect(root.innerHTML).toBe("");
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(useHostConnectionStore.getState().entryPoints).toEqual({
      addHost: null,
      manageHosts: null,
    });
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
      (await import("@renderer/stores/experiments")).useExperimentsStore.setState({
        snapshot: null,
      }),
    );
    expect(useHostConnectionStore.getState().entryPoints).toEqual({
      addHost: null,
      manageHosts: null,
    });
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
      "check:done:Check the system",
      "install:active:Installing Volli host…",
      "start:pending:Start",
      "pair:pending:Pair",
    ]);
    await emit({
      kind: "log",
      flowId: "flow-1",
      line: {
        at: "t",
        level: "info",
        message: "step started",
        fields: { step: "deliver", flowId: "flow-1", component: "host-install" },
      },
    });
    expect(sheet().querySelector('[role="log"]')).toBeNull();
    // Its caret turns, except under reduced motion.
    expect(button("Details")?.querySelector("svg")?.getAttribute("class")).toContain(
      "motion-reduce:transition-none",
    );
    await click(sheet(), "Details");
    const log = sheet().querySelector('[role="log"]');
    expect(log?.textContent).toBe("step started step=deliver");
    await click(sheet(), "Details");
    // Cancel leaves the flow (main discards it) and closes the sheet.
    await click(sheet(), "Cancel");
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    await click(sheet(), "Cancel add");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("opens on main's replay: the view, the newest log, and how much came before", async () => {
    await startFlow();
    await emit({
      kind: "replay",
      view: flowView({ done: 6, at: "link" }),
      log: [line("tunnel retrying"), line("tunnel up")],
      omitted: 412,
    });
    expect(rows().at(-1)).toBe("pair:active:Pairing…");
    await click(sheet(), "Details");
    expect(sheet().querySelector('[role="log"]')?.textContent).toBe(
      "412 earlier lines omittedtunnel retryingtunnel up",
    );
    // A resubscription's replay replaces what was shown, never doubles it.
    await emit({
      kind: "replay",
      view: flowView({ done: 6, at: "link" }),
      log: [line("again")],
      omitted: 1,
    });
    expect(sheet().querySelector('[role="log"]')?.textContent).toBe("1 earlier line omittedagain");
    await emit({ kind: "log", flowId: "flow-1", line: line("next") });
    expect(sheet().querySelector('[role="log"]')?.textContent).toBe(
      "1 earlier line omittedagainnext",
    );
  });

  it("names the question on screen when it answers, so main refuses a stale one", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        question: { id: "q3", kind: "identity-changed", step: "enroll", pinned: "a", hostId: "b" },
      }),
    });
    await click(sheet(), "Pair again");
    expect(api.calls.at(-1)).toEqual(["answerAdd", "flow-1", "repair", "q3"]);
  });

  it("asks to trust an unknown host key, showing what to compare", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "connect",
        question: {
          id: "q1",
          kind: "host-key",
          step: "connect",
          offer: {
            entries: ["box ssh-ed25519 AAAA"],
            fingerprints: [{ type: "ED25519", fingerprint: "SHA256:abc" }],
          },
        },
      }),
    });
    expect(rows()[0]).toBe("connect:attention:Connect");
    expect(sheet().textContent).toContain("This Mac hasn’t seen deploy@box’s key before");
    expect(sheet().querySelector('[aria-label="Host key fingerprints"]')?.textContent).toBe(
      "ED25519SHA256:abc",
    );
    await click(sheet(), "Trust and continue");
    expect(api.calls.at(-1)).toEqual(["answerAdd", "flow-1", "accept-host-key", "q1"]);
  });

  it("sends a sudo password straight to main, and offers an install for this account only", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        done: 3,
        at: "install",
        question: {
          id: "q1",
          kind: "sudo-password",
          step: "install",
          reason: "install",
          command: "sudo volli-hostd install --system",
          retry: false,
        },
      }),
    });
    expect(sheet().textContent).toContain("Installing for every account needs sudo");
    expect(sheet().textContent).toContain("sudo volli-hostd install --system");
    expect(sheet().textContent).toContain("Agents on deploy@box will share your account.");
    await type(input("sudo password"), "hunter2");
    await click(sheet(), "Run it");
    expect(api.calls.at(-1)).toEqual(["sudoPassword", "flow-1", "hunter2", "q1"]);
    // Never kept: the field is empty again, and nothing else holds it.
    expect(input("sudo password").value).toBe("");
    expect(JSON.stringify(useRemoteHostsStore.getState())).not.toContain("hunter2");
    await click(sheet(), "Install for my account only");
    expect(api.calls.at(-1)).toEqual(["answerAdd", "flow-1", "user-install", "q1"]);
  });

  it("says a refused call in a toast and lets the buttons work again", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "probe",
        done: 1,
        question: { id: "q1", kind: "already-paired", step: "probe", hostId: "h" },
      }),
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
        question: {
          id: "q1",
          kind: "existing-hostd",
          step: "probe",
          version: "0.2.4",
          mode: "system",
          adoptable: true,
        },
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
        question: {
          id: "q1",
          kind: "existing-hostd",
          step: "probe",
          version: "0.2.4",
          mode: "system",
          adoptable: false,
        },
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
        question: { id: "q1", kind: "identity-changed", step: "enroll", pinned: "a", hostId: "b" },
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
        question: {
          id: "q1",
          kind: "sudo-password",
          step: "start",
          reason: "linger",
          command: "sudo loginctl enable-linger deploy",
          retry: true,
        },
      }),
    });
    expect(sheet().textContent).toContain("That password didn’t work");
    expect(button("Install for my account only")).toBeUndefined();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "link",
        done: 6,
        question: { id: "q1", kind: "brand-new", step: "link" },
      }),
    });
    expect(sheet().textContent).toContain("asked something this build can’t answer");
    expect(api.calls.slice(1)).toEqual([
      ["answerAdd", "flow-1", "adopt", "q1"],
      ["answerAdd", "flow-1", "update", "q1"],
      ["answerAdd", "flow-1", "repair", "q1"],
    ]);
  });

  it("shows a failure's line and its recovery, with ssh's words under Details", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: {
        ...flowView({ status: "failed", done: 0 }),
        // The first step failed; the rest wait.
        steps: flowView({ done: 0 }).steps.with(0, { id: "connect", status: "failed" }),
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
    const host = registryHost({
      name: "studio",
      os: "macos",
      mode: "user",
      agentsShareAccount: true,
    });
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

  it("offers the next step once the host is added: a project on it (AM2, VC-710)", async () => {
    const host = registryHost({ name: "studio" });
    useRemoteHostsStore.getState().setHosts([host]);
    await startFlow("me@studio");
    await emit({
      kind: "view",
      view: flowView({ name: "studio", status: "done", done: 7, hostId: host.id }),
    });
    await click(sheet(), "Open a project on studio…");
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    expect(useRemoteHostsStore.getState().openProject).toMatchObject({
      open: true,
      hostId: host.id,
      start: "list",
    });
    await act(async () => useRemoteHostsStore.getState().closeProjectSheet());
  });

  it("detaches an unfinished flow when the sheet is closed", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ at: "connect" }) });
    await click(sheet(), "Close");
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    expect(api.following("flow-1")).toBe(true);
  });
});

describe("Add a host: detach and re-attach", () => {
  it.each(["escape", "outside"])(
    "%s during install keeps the flow running and re-attachable",
    async (dismiss) => {
      await startFlow();
      await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
      await act(async () => {
        if (dismiss === "escape")
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else {
          document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
          document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        }
      });
      expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
      expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
      expect(api.following("flow-1")).toBe(true);
      expect(useRemoteHostsStore.getState().addHostActivity).toMatchObject({ status: "running" });
      await emit({ kind: "view", view: flowView({ done: 4, at: "start" }) });
      await act(async () => useRemoteHostsStore.getState().openAddHost());
      expect(rows()[3]).toContain("Starting…");
      expect(api.calls.filter(([method]) => method === "startAdd")).toHaveLength(1);
    },
  );

  it("lets Cancel before upload cancel directly", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    await click(sheet(), "Cancel");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("lets Keep going reject cancellation, and confirms Back after upload too", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
    await click(sheet(), "Cancel");
    expect(sheet().textContent).toContain("Files already uploaded or installed stay on the host.");
    await click(sheet(), "Keep going");
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        done: 3,
        at: "install",
        failure: {
          code: "hostd-refused",
          step: "install",
          line: "Install failed",
          detail: null,
          recovery: { action: "retry", label: "Try again", from: "install" },
        },
      }),
    });
    await click(sheet(), "Back");
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    await click(sheet(), "Cancel add");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(input("SSH destination").value).toBe("deploy@box");
  });

  it("re-observes a lost stream on reopen without starting or cancelling an install", async () => {
    await startFlow();
    await act(async () => api.fail("flow-1"));
    expect(api.following("flow-1")).toBe(false);
    expect(useRemoteHostsStore.getState().addHostActivity?.status).toBe("failed");
    await click(sheet(), "Close");
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(api.following("flow-1")).toBe(true);
    await emit({ kind: "replay", view: flowView({ done: 3, at: "install" }), log: [], omitted: 0 });
    expect(rows()[2]).toContain("Installing Volli host…");
    expect(api.calls).toEqual([["startAdd", "deploy@box"]]);
  });

  it("surfaces a refused Cancel instead of closing or discarding the flow", async () => {
    await startFlow();
    api.cancelAdd = () => Promise.reject(new Error("Could not cancel"));
    await click(sheet(), "Cancel");
    expect(toast.error).toHaveBeenCalled();
    expect(useRemoteHostsStore.getState().addHost.open).toBe(true);
    expect(button("Cancel")?.disabled).toBe(false);
  });

  it.each(["unavailable", "refused"])(
    "does not claim a command was copied when clipboard is %s",
    async (state) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          state === "unavailable"
            ? undefined
            : { writeText: () => Promise.reject(new Error("denied")) },
      });
      await startFlow();
      await emit({
        kind: "view",
        view: flowView({
          status: "failed",
          failure: {
            code: "host-key-changed",
            step: "connect",
            line: "box’s identity changed",
            detail: null,
            recovery: { action: "retry", label: "Try again", from: "connect" },
          },
        }),
      });
      await click(sheet(), "Copy command");
      expect(toast.error).toHaveBeenCalled();
      expect(button("Copied")).toBeUndefined();
      expect(sheet().textContent).toContain("ssh-keygen -R box");
    },
  );

  it("can explicitly cancel even when observation keeps failing, without a silent exit loop", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
    await act(async () => api.fail("flow-1"));
    await click(sheet(), "Close");
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    await act(async () => api.fail("flow-1"));
    await click(sheet(), "Cancel");
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    await click(sheet(), "Cancel add");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });

  it("blocks sudo submission behind a cancellation confirmation, and resets it for a new question", async () => {
    await startFlow();
    const sudo = {
      id: "q1",
      kind: "sudo-password",
      step: "start",
      reason: "linger",
      command: "sudo loginctl enable-linger deploy",
      retry: false,
    } as const;
    await emit({
      kind: "view",
      view: flowView({ status: "question", done: 4, at: "start", question: sudo }),
    });
    await type(input("sudo password"), "synthetic-password");
    await click(sheet(), "Back");
    expect(input("sudo password").disabled).toBe(true);
    await act(async () =>
      sheet()
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.calls.some(([method]) => method === "sudoPassword")).toBe(false);
    await emit({
      kind: "view",
      view: flowView({ status: "question", done: 4, at: "start", question: { ...sudo, id: "q2" } }),
    });
    expect(button("Cancel add")).toBeUndefined();
    expect(input("sudo password").disabled).toBe(false);
  });

  it("uses SSH's resolved known_hosts key rather than a configured alias or friendly name", async () => {
    await startFlow("my-alias");
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        target: "my-alias",
        name: "Friendly box",
        failure: {
          code: "host-key-changed",
          step: "connect",
          line: "The host's identity changed",
          detail:
            "Host key for [actual.example]:2222 has changed and you have requested strict checking. Host key verification failed.",
          recovery: { action: "retry", label: "Try again", from: "connect" },
        },
      }),
    });
    expect(sheet().textContent).toContain("ssh-keygen -R '[actual.example]:2222'");
    expect(sheet().textContent).not.toContain("ssh-keygen -R my-alias");
  });

  it("renders a changed key's exact port command with Copy and Try again", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await startFlow("deploy@box:2222");
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        target: "deploy@box:2222",
        name: "Friendly box",
        failure: {
          code: "host-key-changed",
          step: "connect",
          line: "box’s identity changed since you last connected. If you rebuilt it, remove the old key, then try again.",
          recovery: { action: "retry", label: "Try again", from: "connect" },
          detail: null,
        },
      }),
    });
    expect(sheet().textContent).toContain("ssh-keygen -R '[box]:2222'");
    await click(sheet(), "Copy command");
    expect(writeText).toHaveBeenCalledWith("ssh-keygen -R '[box]:2222'");
    await click(sheet(), "Try again");
    expect(api.calls.at(-1)).toEqual(["retryAdd", "flow-1", "connect"]);
  });
});

describe("Add a host: pending calls and owner replacement", () => {
  it("Cancel preempts a retry RPC held for the entire resumed install (B1)", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        done: 3,
        at: "install",
        failure: {
          code: "hostd-refused",
          step: "install",
          line: "Install failed",
          detail: null,
          recovery: { action: "retry", label: "Try again", from: "install" },
        },
      }),
    });
    let rejectRetry!: (error: Error) => void;
    const retry = api.retryAdd;
    api.retryAdd = (...args) => {
      void retry(...args);
      return new Promise((_, reject) => {
        rejectRetry = reject;
      });
    };
    await click(sheet(), "Try again");
    await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
    expect(button("Cancel")?.disabled).toBe(false);
    await click(sheet(), "Cancel");
    expect(button("Keep going")?.disabled).toBe(false);
    expect(button("Cancel add")?.disabled).toBe(false);
    await click(sheet(), "Cancel add");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    expect(api.following("flow-1")).toBe(false);
    await act(async () => rejectRetry(new Error("cancelled retry")));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not overwrite queued flow events with a click's older snapshot", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "failed",
        done: 3,
        at: "install",
        failure: {
          code: "hostd-refused",
          step: "install",
          line: "Install failed",
          detail: null,
          recovery: { action: "retry", label: "Try again", from: "install" },
        },
      }),
    });
    let finish!: () => void;
    api.retryAdd = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await act(async () => {
      // Both main events are queued before React renders, then a click uses
      // the still-rendered failed screen. Busy must update the latest phase.
      api.emit("flow-1", { kind: "view", view: flowView({ done: 3, at: "install" }) });
      api.emit("flow-1", {
        kind: "log",
        flowId: "flow-1",
        line: { at: "t", level: "info", message: "Newest event", fields: {} },
      });
      button("Try again")!.click();
    });
    expect(rows()[2]).toContain("Installing Volli host…");
    await click(sheet(), "Details");
    expect(sheet().querySelector('[role="log"]')?.textContent).toContain("Newest event");
    await act(async () => finish());
  });

  it.each(["answer", "sudo"])(
    "Cancel remains usable during a pending %s, even before its next view and after stream loss (B1)",
    async (method) => {
      await startFlow();
      await emit({
        kind: "view",
        view: flowView({
          status: "question",
          done: 3,
          at: "install",
          question: {
            id: "q1",
            kind: "sudo-password",
            step: "install",
            reason: "install",
            command: "sudo volli-hostd install --system",
            retry: false,
          },
        }),
      });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (method === "answer") {
        const answer = api.answerAdd;
        api.answerAdd = (...args) => {
          void answer(...args);
          return held;
        };
        await click(sheet(), "Install for my account only");
      } else {
        const sudo = api.sudoPassword;
        api.sudoPassword = (...args) => {
          void sudo(...args);
          return held;
        };
        await type(input("sudo password"), "secret");
        await click(sheet(), "Run it");
      }
      expect(button("Cancel")?.disabled).toBe(false);
      await act(async () => api.fail("flow-1"));
      expect(button("Cancel")?.disabled).toBe(false);
      await click(sheet(), "Cancel");
      await click(sheet(), "Keep going");
      await click(sheet(), "Cancel");
      await click(sheet(), "Cancel add");
      expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
      await act(async () => finish());
      expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
      expect(api.following("flow-1")).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("restores main's running reference and replay after cloud off/on without retyping (B2)", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
    await act(async () => useExperimentsStore.setState({ snapshot: null }));
    expect(api.following("flow-1")).toBe(false);
    expect(useRemoteHostsStore.getState().addHostActivity).toBeNull();
    await act(async () =>
      useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } }),
    );
    expect(api.following("flow-1")).toBe(true);
    expect(useRemoteHostsStore.getState().addHostActivity).toMatchObject({
      name: "deploy@box",
      status: "running",
    });
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(rows()[2]).toContain("Installing Volli host…");
    expect(api.calls.filter(([method]) => method === "startAdd")).toHaveLength(1);
  });

  it.each(["running", "question"])(
    "a %s flow held by real main survives destroying and recreating its React owner (B2)",
    async (status) => {
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const main = harness({
        overrides: [
          async (script) => {
            if (status === "question" && script === PROBE_SCRIPT)
              return { stdout: probeOutput({ sudo: null }) };
            if (status === "running" && script === PROBE_SCRIPT) {
              enter();
              await held;
            }
            return undefined;
          },
        ],
      });
      const following = new Set<string>();
      let starts = 0;
      const { flowId } = await main.engine.startAdd({ target: "deploy@held-box" });
      if (status === "running") await entered;
      else {
        const observation = watch(main.engine, flowId);
        await observation.until((view) => view.status === "question");
        observation.stop();
      }
      setRemoteHostsApi({
        ...api,
        activeAdds: async () => main.engine.activeAdds(),
        startAdd: async (request) => {
          ++starts;
          return main.engine.startAdd(request);
        },
        addFacts: async (id) => main.engine.addFacts(id),
        subscribeAdd(id, handlers) {
          following.add(id);
          const unsubscribe = main.engine.subscribeAdd(id, handlers.onEvent);
          return () => {
            following.delete(id);
            unsubscribe();
          };
        },
      });
      try {
        await openSheet();
        expect(following.has(flowId)).toBe(true);
        await world!.rerender(null); // macOS window destroy / renderer reload.
        expect(following.has(flowId)).toBe(false);
        expect(main.engine.activeAdds()[0]?.flowId).toBe(flowId);
        expect(useRemoteHostsStore.getState().addHostActivity).toBeNull();
        await world!.rerender(<HostsChrome />);
        expect(following.has(flowId)).toBe(true);
        expect(useRemoteHostsStore.getState().addHostActivity).toMatchObject({
          name: "deploy@held-box",
          status,
        });
        await act(async () => useRemoteHostsStore.getState().openAddHost());
        if (status === "running") expect(rows()[1]).toContain("Checking the system…");
        else expect(sheet().textContent).toContain("account only");
        expect(starts).toBe(0);
      } finally {
        await world!.rerender(null);
        release();
        await main.engine.close();
      }
    },
  );

  it("ignores a stale discovery response after Connect starts a different flow", async () => {
    let resolve!: (flows: Awaited<ReturnType<FakeRemoteHostsApi["activeAdds"]>>) => void;
    api.activeAdds = () =>
      new Promise((done) => {
        resolve = done;
      });
    await openSheet("deploy@new");
    await click(sheet(), "Connect");
    await act(async () =>
      resolve([{ flowId: "old-flow", target: "deploy@old", name: "old", status: "question" }]),
    );
    expect(api.following("old-flow")).toBe(false);
    expect(api.following("flow-1")).toBe(true);
  });

  it("shows a failed discovery read and can restore it on reopening", async () => {
    api.activeAdds = () => Promise.reject(new Error("Could not find active adds"));
    await openSheet();
    expect(sheet().textContent).toContain("Could not find active adds");
    await click(sheet(), "Close");
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "probe",
        question: { id: "q", kind: "already-paired", step: "probe", hostId: "h" },
      }),
    });
    api.activeAdds = async () => [
      { flowId: "flow-1", target: "deploy@box", name: "box", status: "question" },
    ];
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(api.following("flow-1")).toBe(true);
    expect(useRemoteHostsStore.getState().addHostActivity?.status).toBe("question");
  });

  it.each(["success", "failure"])(
    "a late cancel %s cannot overwrite or close a replacement flow (B3)",
    async (outcome) => {
      await startFlow();
      await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const cancel = api.cancelAdd;
      api.cancelAdd = (id) => {
        void cancel(id); // Main publishes cancelled before awaiting cleanup.
        return new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        });
      };
      await click(sheet(), "Cancel");
      await click(sheet(), "Cancel add");
      await click(sheet(), "Close");
      api.nextStart = { flowId: "flow-2" };
      await act(async () => useRemoteHostsStore.getState().openAddHost("deploy@new-box"));
      await click(sheet(), "Connect");
      await act(async () =>
        api.emit("flow-2", {
          kind: "view",
          view: flowView({
            flowId: "flow-2",
            target: "deploy@new-box",
            name: "new-box",
            done: 3,
            at: "install",
          }),
        }),
      );
      expect(api.following("flow-2")).toBe(true);
      await act(async () =>
        outcome === "success" ? resolve() : reject(new Error("old cleanup failed")),
      );
      expect(useRemoteHostsStore.getState().addHost.open).toBe(true);
      expect(api.following("flow-2")).toBe(true);
      expect(useRemoteHostsStore.getState().addHostActivity?.name).toBe("new-box");
      expect(rows()[2]).toContain("Installing Volli host…");
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});

describe("Add a host: the review's probes", () => {
  const SUDO = {
    id: "q1",
    kind: "sudo-password",
    step: "install",
    reason: "install",
    command: "sudo example",
    retry: false,
  } as const;

  it("never renders the sudo password into the field's value attribute", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({ status: "question", at: "install", question: SUDO }),
    });
    const field = sheet().querySelector<HTMLInputElement>('input[type="password"]')!;
    await type(field, "synthetic-probe-secret");
    expect(field.getAttribute("value")).not.toBe("synthetic-probe-secret");
    expect(sheet().innerHTML).not.toContain("synthetic-probe-secret");
  });

  it("holds the password in no React state while the RPC is pending", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({ status: "question", at: "install", question: SUDO }),
    });
    const field = sheet().querySelector<HTMLInputElement>('input[type="password"]')!;
    await type(field, "synthetic-probe-secret");
    const send = api.sudoPassword;
    let resolve!: (value: null) => void;
    api.sudoPassword = (...args) => {
      void send(...args);
      return new Promise((done) => {
        resolve = done;
      });
    };
    await click(sheet(), "Run it");
    expect(field.value).toBe("");
    expect(api.calls.at(-1)).toEqual(["sudoPassword", "flow-1", "synthetic-probe-secret", "q1"]);
    // Every hook state of the field's component and its alternate fiber.
    const key = Object.keys(field).find((name) => name.startsWith("__reactFiber$"))!;
    let fiber = (
      field as unknown as Record<string, { type?: { name?: string }; return?: unknown }>
    )[key] as
      | {
          type?: { name?: string };
          return?: unknown;
          memoizedState?: unknown;
          alternate?: { memoizedState?: unknown };
        }
      | undefined;
    while (fiber !== undefined && fiber !== null && fiber.type?.name !== "SudoBody") {
      fiber = fiber.return as typeof fiber;
    }
    expect(fiber?.type?.name).toBe("SudoBody");
    const states: unknown[] = [];
    for (
      let hook = fiber?.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
      hook;
      hook = hook.next as typeof hook
    ) {
      states.push(hook.memoizedState);
    }
    for (
      let hook = fiber?.alternate?.memoizedState as
        | { memoizedState?: unknown; next?: unknown }
        | null
        | undefined;
      hook;
      hook = hook.next as typeof hook
    ) {
      states.push(hook.memoizedState);
    }
    expect(
      JSON.stringify(states, (_, value: unknown) =>
        value instanceof HTMLElement ? "<element>" : value,
      ),
    ).not.toContain("synthetic-probe-secret");
    await act(async () => resolve(null));
  });

  it("keeps a flow whose start answers after Close, and re-attaches on reopen", async () => {
    let resolve!: (answer: { flowId: string }) => void;
    const start = api.startAdd;
    api.startAdd = (request) => {
      void start(request);
      return new Promise((done) => {
        resolve = done;
      });
    };
    await openSheet("deploy@box");
    await click(sheet(), "Connect");
    await click(sheet(), "Close");
    await act(async () => resolve({ flowId: "flow-1" }));
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
    expect(api.following("flow-1")).toBe(true);
    await emit({ kind: "view", view: flowView({ done: 3, at: "install" }) });
    await act(async () => useRemoteHostsStore.getState().openAddHost());
    expect(rows()[2]).toContain("Installing Volli host…");
  });

  it("says nothing of a start refused after Close", async () => {
    let reject!: (error: Error) => void;
    api.startAdd = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    await openSheet("deploy@box");
    await click(sheet(), "Connect");
    await click(sheet(), "Close");
    await act(async () => reject(new Error("No host named box")));
    expect(api.calls.filter(([method]) => method === "cancelAdd")).toEqual([]);
  });

  it("releases observation, not the install, when cloud turns off", async () => {
    await startFlow();
    await act(async () => useExperimentsStore.setState({ snapshot: null }));
    expect(api.following("flow-1")).toBe(false);
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
  });

  it("offers no Add through the switcher, the opener or ⌘K's builder on a read-only hosts file", async () => {
    await openSheet();
    await click(sheet(), "Close");
    await act(async () =>
      useRemoteHostsStore.getState().setHosts([registryHost()], "A newer Volli saved this file."),
    );
    expect(useHostConnectionStore.getState().entryPoints.addHost).toBeNull();
    expect(useHostConnectionStore.getState().entryPoints.manageHosts).not.toBeNull();
    const { openAddHostSheet } = await import("./host-entry");
    await act(async () => openAddHostSheet());
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    // Writable again: Add comes back.
    await act(async () => useRemoteHostsStore.getState().setHosts([registryHost()], null));
    expect(useHostConnectionStore.getState().entryPoints.addHost).not.toBeNull();
  });
});

describe("Add a host: the visual review", () => {
  const FULL_FINGERPRINT = "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s";

  it("says what each done row found, and badges the ready tile with a check", async () => {
    await startFlow();
    const facts = {
      user: "deploy",
      os: "linux" as const,
      system: "Ubuntu 24.04.1 LTS",
      arch: "x86-64",
      memoryBytes: 8 * 1024 ** 3,
      version: "1.1.0",
      keepsRunning: true,
      alreadyPaired: false,
    };
    await emit({ kind: "view", view: flowView({ done: 4, at: "start", facts }) });
    expect(rows()).toEqual([
      "connect:done:Connected as deploy",
      "check:done:Ubuntu 24.04.1 LTS · x86-64 · 8 GB",
      "install:done:Volli host 1.1.0",
      "start:active:Starting…",
      "pair:pending:Pair",
    ]);
    // The OS shows as soon as the check found it.
    expect(sheet().querySelector('[data-slot="host-glyph"] svg')).not.toBeNull();
    await emit({ kind: "view", view: flowView({ status: "done", done: 7, facts, hostId: null }) });
    expect(sheet().querySelector('[data-slot="host-glyph"]')?.getAttribute("data-badge")).toBe(
      "ready",
    );
    expect(sheet().textContent).toContain("Ubuntu 24.04.1 LTS · x86-64 · Volli host 1.1.0");
  });

  it("reads the facts beside each view: the newest read wins, a refused one changes nothing", async () => {
    await startFlow();
    const found = { ...NO_FACTS, user: "deploy" };
    // Main's views carry no facts: the sheet reads them (`hostAdd.facts`).
    const reads: ((facts: typeof found) => void)[] = [];
    api.addFacts = () => new Promise((resolve) => reads.push(resolve));
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    expect(reads).toHaveLength(2);
    // The second read answers first; the first, older, is left behind.
    await act(async () => reads[1]!(found));
    await act(async () => reads[0]!({ ...found, user: "stale" }));
    // (The noun it replaces lingers while it crosses out.)
    expect(rows()[0]).toMatch(/^connect:done:.*Connected as deploy$/u);
    expect(rows()[0]).not.toContain("stale");
    // A finished flow let go: its read is refused, and what was found stays.
    api.addFacts = () => Promise.reject(new Error("unknown-flow"));
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    expect(rows()[0]).toMatch(/Connected as deploy$/u);
    // A read answered after the owner unmounts is dropped.
    api.addFacts = () => new Promise((resolve) => reads.push(resolve));
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    await act(async () => useExperimentsStore.setState({ snapshot: null }));
    await act(async () => reads.at(-1)!({ ...found, user: "late" }));
    expect(api.calls.some(([method]) => method === "cancelAdd")).toBe(false);
  });

  it("waits to Run it until the sudo field has text", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "install",
        question: {
          id: "q1",
          kind: "sudo-password",
          step: "install",
          reason: "install",
          command: "sudo example",
          retry: false,
        },
      }),
    });
    expect(button("Run it")?.disabled).toBe(true);
    await type(input("sudo password"), "x");
    expect(button("Run it")?.disabled).toBe(false);
    await type(input("sudo password"), "");
    expect(button("Run it")?.disabled).toBe(true);
  });

  it("shows a whole, real-length fingerprint, selectable, never cut", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "connect",
        question: {
          id: "q1",
          kind: "host-key",
          step: "connect",
          offer: {
            entries: ["box ssh-ed25519 AAAA"],
            fingerprints: [{ type: "ED25519", fingerprint: FULL_FINGERPRINT }],
          },
        },
      }),
    });
    const shown = [...sheet().querySelectorAll('[aria-label="Host key fingerprints"] li span')].at(
      -1,
    )!;
    expect(shown.textContent).toBe(FULL_FINGERPRINT);
    expect(shown.className).toContain("break-all");
    expect(shown.className).not.toContain("truncate");
  });

  it("keeps the footer outside the scrolling body, the longest question with Details open", async () => {
    await startFlow();
    await emit({
      kind: "view",
      view: flowView({
        status: "question",
        at: "install",
        question: {
          id: "q1",
          kind: "sudo-password",
          step: "install",
          reason: "install",
          command: "sudo volli-hostd install --system --data-dir /var/lib/volli-hostd",
          retry: true,
        },
      }),
    });
    for (let index = 0; index < 40; index += 1) {
      await emit({ kind: "log", flowId: "flow-1", line: line(`line ${index}`) });
    }
    await click(sheet(), "Details");
    const body = sheet().querySelector<HTMLElement>('[data-slot="add-host-body"]')!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("min-h-0");
    // Details, the account-only answer and Run it sit in the footer, past the scroller.
    for (const name of ["Details", "Install for my account only", "Run it"]) {
      const control = button(name)!;
      expect(body.contains(control)).toBe(false);
    }
    expect(body.querySelector('[role="log"]')).not.toBeNull();
    // The sheet itself is capped to the window, its middle the part that gives.
    expect(sheet().className).toContain("max-h-[80vh]");
  });
});
