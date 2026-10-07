// @vitest-environment jsdom
import { act } from "react";
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

  it("cancels an unfinished flow when the sheet is closed", async () => {
    await startFlow();
    await emit({ kind: "view", view: flowView({ at: "connect" }) });
    await click(sheet(), "Close");
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
  });
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

  it("cancels a flow whose start answers after Close", async () => {
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
    expect(api.calls).toContainEqual(["cancelAdd", "flow-1"]);
    expect(api.following("flow-1")).toBe(false);
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

  it("cancels an unfinished flow when cloud turns off and the sheet unmounts", async () => {
    await startFlow();
    await act(async () => useExperimentsStore.setState({ snapshot: null }));
    expect(api.following("flow-1")).toBe(false);
    expect(api.calls).toContainEqual(["cancelAdd", "flow-1"]);
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
    // A read answered after the sheet let the flow go is dropped.
    api.addFacts = () => new Promise((resolve) => reads.push(resolve));
    await emit({ kind: "view", view: flowView({ done: 1, at: "probe" }) });
    await act(async () => useRemoteHostsStore.getState().closeAddHost());
    await act(async () => reads.at(-1)!({ ...found, user: "late" }));
    expect(api.calls.at(-1)).toEqual(["cancelAdd", "flow-1"]);
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
