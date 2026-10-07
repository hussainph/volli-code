// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { ChromeBar } from "@renderer/components/chrome-bar";
import { useHostSignInSheet } from "@renderer/components/hosts/sign-ins/remote-host-sign-in-source";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { useRemoteHostsStore, setRemoteHostsApi } from "@renderer/stores/remote-hosts";
import { createFakeRemoteHostsApi } from "@renderer/stores/remote-hosts.test-support";
import { useUiStore } from "@renderer/stores/ui";

import { HostChip } from "./host-chip";
import { click, HETZNER_ID, hostWorld, MINI_ID, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  setRemoteHostsApi(null);
  vi.restoreAllMocks();
});

/**
 * The title bar as static markup: its effects (window bridges) never run, and
 * every store reads its initial state — which for the flag is off, the state a
 * person without `cloud` is in.
 */
function titleBar(): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <ChromeBar />
    </SidebarProvider>,
  );
}

function chip(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>('[data-slot="host-chip"]');
  if (found === null) throw new Error("no host chip");
  return found;
}

function switcher(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  if (found === null) throw new Error("switcher closed");
  return found;
}

async function openSwitcher(): Promise<HTMLElement> {
  await act(async () => chip().click());
  return switcher();
}

describe("host chip, flag off", () => {
  it("renders nothing, alone or in the title bar", async () => {
    world = hostWorld({ cloud: false });
    const container = await world.render(<HostChip />);
    expect(container.innerHTML).toBe("");

    expect(titleBar()).not.toContain('data-slot="host-chip"');
    expect(titleBar()).not.toContain("hetzner-1");
  });
});

describe("host chip", () => {
  it("shows an SSH failure reason even on a non-current host with no projects", async () => {
    world = hostWorld({ selected: "local" });
    act(() => {
      const before = world!.remote.getSnapshot();
      world!.remote.set({
        ...before,
        projects: {},
        // Fixture snapshots use copy-on-write, just like the real source.
        // oxlint-disable-next-line no-map-spread
        hosts: before.hosts.map((host) => ({
          ...host,
          link: {
            status: "offline",
            since: 0,
            retryAt: null,
            detail: "Load an SSH key for hetzner-1.",
          },
        })),
      });
    });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Can’t reach hetzner-1 · Load an SSH key for hetzner-1.");
  });

  it("shows the missing-project refusal with Forget, wired to hosts.closeWorkspace", async () => {
    const api = createFakeRemoteHostsApi();
    setRemoteHostsApi(api);
    world = hostWorld();
    act(() =>
      world!.remote.setProjectLink("remote", {
        status: "incompatible",
        reason: "refused",
        refusalCode: "workspace-unknown",
        workspaceId: "remote",
      }),
    );
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("This project isn’t on hetzner-1 any more");
    await click(list, "Forget");
    expect(api.calls).toEqual([["closeWorkspace", HETZNER_ID, "remote"]]);
    api.refuseNext("closeWorkspace", "Registry cannot be written");
    await click(list, "Forget");
    expect(toast.error).toHaveBeenCalledWith("Registry cannot be written");
  });

  it("shows a subscription error before any remote host was read, with Retry now", async () => {
    world = hostWorld({ selected: "local" });
    const retrySubscription = vi.fn();
    const detach = useHostConnectionStore.getState().attach({
      getSnapshot: () => ({
        hosts: [],
        projects: {},
        error: "Couldn’t read host state: stream lost",
      }),
      subscribe: () => () => {},
      retry: vi.fn(),
      updateHost: vi.fn(),
      cancelScheduledUpdate: vi.fn(),
      signIn: vi.fn(),
      retrySubscription,
    });
    try {
      await world.render(<HostChip />);
      const list = await openSwitcher();
      const error = list.querySelector('[role="status"]')!;
      expect(error.textContent).toContain("Couldn’t read host state: stream lost");
      await click(error, "Retry now");
      expect(retrySubscription).toHaveBeenCalledOnce();
    } finally {
      act(() => detach());
    }
  });

  it("names the current project's host", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    expect(chip().getAttribute("aria-label")).toBe("Host: hetzner-1");
    expect(chip().textContent).toContain("hetzner-1");

    act(() => useProjectsStore.setState({ selectedProjectId: "local" }));
    expect(chip().textContent).toContain("This Mac");
  });

  it("badges the tile for each state, and greys the name while unreachable", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    const badge = () =>
      chip().querySelector('[data-slot="host-glyph"]')?.getAttribute("data-badge");
    expect(badge()).toBeNull();

    world.setHetzner({ link: { status: "version-skewed", availableVersion: "0.3.0" } });
    expect(badge()).toBe("attention");

    world.setHetzner({
      link: { status: "open" },
      expiredSignIns: [{ providerId: "anthropic", name: "Claude" }],
    });
    expect(badge()).toBe("attention");

    world.setHetzner({ expiredSignIns: [], link: { status: "offline", since: 0, retryAt: null } });
    expect(badge()).toBe("offline");
    expect(chip().querySelector(".text-muted-foreground")?.textContent).toBe("hetzner-1");

    world.setHetzner({ link: { status: "incompatible", reason: "database-too-new" } });
    expect(badge()).toBe("fail");
  });

  it("lists This Mac and every host, then Add a host… and Manage hosts…", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    const list = await openSwitcher();
    const rows = [...list.querySelectorAll("button, [aria-current]")].map((row) =>
      row.textContent?.trim(),
    );
    expect(rows[0]).toContain("This Mac");
    expect(rows[0]).toContain("1 project");
    expect(rows[1]).toContain("hetzner-1");
    expect(rows[2]).toContain("mac-mini");
    expect(rows[2]).toContain("Offline · since");
    expect(rows.slice(3)).toEqual([
      "Retry now",
      "Sign-ins on hetzner-1…",
      "Add a host…",
      "Manage hosts…",
    ]);
    expect(list.querySelector('[aria-current="true"]')?.textContent).toContain("hetzner-1");
  });

  it("withholds Add a host… once VC-700 registered and a read-only hosts file withheld it", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    await act(async () =>
      useHostConnectionStore.getState().setEntryPoints({ addHost: null, manageHosts: () => {} }),
    );
    const list = await openSwitcher();
    const rows = [...list.querySelectorAll("button")].map((row) => row.textContent?.trim());
    expect(rows).not.toContain("Add a host…");
    expect(rows).toContain("Manage hosts…");
    await act(async () =>
      useHostConnectionStore.getState().setEntryPoints({ addHost: null, manageHosts: null }),
    );
  });

  it("opens another host's first project, in rail order", async () => {
    world = hostWorld();
    const select = vi.spyOn(useProjectsStore.getState(), "select").mockImplementation(() => {});
    await world.render(<HostChip />);
    const list = await openSwitcher();
    await click(list, findRow("This Mac"));
    expect(select).toHaveBeenCalledWith("local");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("offers to open a project on a remote host that serves none here (VC-710)", async () => {
    world = hostWorld();
    act(() =>
      world?.remote.set({
        ...world.remote.getSnapshot(),
        projects: { remote: world.remote.getSnapshot().projects.remote! },
      }),
    );
    await world.render(<HostChip />);
    const list = await openSwitcher();
    const mini = [...list.querySelectorAll("button")].find((row) =>
      row.textContent?.includes("mac-mini"),
    );
    expect(mini?.disabled).toBe(false);
    // A host serving no project still reports its own health.
    expect(mini?.textContent).toContain("Offline");
    const select = vi.spyOn(useProjectsStore.getState(), "select").mockImplementation(() => {});
    await act(async () => mini!.click());
    expect(select).not.toHaveBeenCalled();
    expect(useRemoteHostsStore.getState().openProject).toMatchObject({
      open: true,
      hostId: MINI_ID,
      start: "list",
    });
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    act(() => useRemoteHostsStore.getState().closeProjectSheet());
  });

  it("sends Add a host… and Manage hosts… to VC-700's entry points, or says they are not here yet", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    await click(await openSwitcher(), "Add a host…");
    expect(toast).toHaveBeenCalledWith("Adding a host isn’t in this build yet");
    await click(await openSwitcher(), "Manage hosts…");
    expect(toast).toHaveBeenCalledWith("Managing hosts isn’t in this build yet");

    const addHost = vi.fn();
    const manageHosts = vi.fn();
    act(() => useHostConnectionStore.getState().setEntryPoints({ addHost, manageHosts }));
    await click(await openSwitcher(), "Add a host…");
    await click(await openSwitcher(), "Manage hosts…");
    expect(addHost).toHaveBeenCalledTimes(1);
    expect(manageHosts).toHaveBeenCalledTimes(1);
  });

  it("offers Retry now under an unreachable current host", async () => {
    world = hostWorld({ hetzner: { link: { status: "offline", since: 0, retryAt: null } } });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Sessions there keep running");
    await click(list, "Retry now");
    expect(world.remote.calls).toEqual([{ kind: "retry", hostId: HETZNER_ID }]);
  });

  it("asks before updating a host with Sessions running, now or when they finish", async () => {
    world = hostWorld({
      hetzner: {
        version: "0.2.4",
        liveSessions: 2,
        link: { status: "version-skewed", availableVersion: "0.3.0" },
      },
    });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Volli host 0.2.4");
    expect(list.textContent).toContain("Volli host 0.3.0 is available");
    await click(list, "Update");
    expect(list.textContent).toContain("2 Sessions are running on hetzner-1.");
    await click(list, "When they finish");
    await click(list, "Update now");
    expect(world.remote.calls).toEqual([
      { kind: "updateHost", hostId: HETZNER_ID, when: "when-idle" },
      { kind: "updateHost", hostId: HETZNER_ID, when: "now" },
    ]);

    world.setHetzner({ liveSessions: 1 });
    expect(list.textContent).toContain("1 Session is running on hetzner-1.");
  });

  it("updates a host with nothing running at once", async () => {
    world = hostWorld({
      hetzner: { link: { status: "version-skewed", availableVersion: "0.3.0" } },
    });
    await world.render(<HostChip />);
    await click(await openSwitcher(), "Update");
    expect(world.remote.calls).toEqual([{ kind: "updateHost", hostId: HETZNER_ID, when: "now" }]);
  });

  it("shows a scheduled update with Cancel, and a running one with its progress", async () => {
    world = hostWorld({
      hetzner: {
        link: { status: "version-skewed", availableVersion: "0.3.0" },
        update: { status: "scheduled" },
      },
    });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Updates when Sessions finish");
    await click(list, "Cancel");
    expect(world.remote.calls).toEqual([{ kind: "cancelScheduledUpdate", hostId: HETZNER_ID }]);

    world.setHetzner({ update: { status: "running", progress: 0.4, targetVersion: "0.3.0" } });
    expect(list.textContent).toContain("Updating to 0.3.0");
    expect(list.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    world.setHetzner({ update: { status: "running", progress: 1, targetVersion: "0.3.0" } });
    expect(list.textContent).toContain("Restarting");
  });

  it("offers Sign in for an expired sign-in (VC-702's slot)", async () => {
    world = hostWorld({
      hetzner: { expiredSignIns: [{ providerId: "anthropic", name: "Claude" }] },
    });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Claude sign-in expired");
    await click(list, "Sign in");
    expect(world.remote.calls).toEqual([
      { kind: "signIn", hostId: HETZNER_ID, providerId: "anthropic" },
    ]);
  });

  it("opens any reachable remote host's sign-ins from the switcher, This Mac's project current too (VC-702, AM2)", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    await click(await openSwitcher(), "Sign-ins on hetzner-1…");
    expect(useHostSignInSheet.getState().target).toEqual({
      hostId: HETZNER_ID,
      hostName: "hetzner-1",
      providerId: null,
    });
    act(() => useHostSignInSheet.getState().close());
    await world.cleanup();
    world = hostWorld({ selected: "local" });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    // This Mac has none; an offline host's would only fail.
    expect(list.textContent).not.toContain("Sign-ins on This Mac");
    expect(list.textContent).not.toContain("Sign-ins on mac-mini");
    await click(list, "Sign-ins on hetzner-1…");
    expect(useHostSignInSheet.getState().target?.hostId).toBe(HETZNER_ID);
    act(() => useHostSignInSheet.getState().close());
  });

  it("offers each incompatibility's one recovery", async () => {
    world = hostWorld({ hetzner: { link: { status: "incompatible", reason: "host-too-new" } } });
    await world.render(<HostChip />);
    const list = await openSwitcher();
    expect(list.textContent).toContain("Newer than this app");
    const settings = vi
      .spyOn(useUiStore.getState(), "setSettingsOpen")
      .mockImplementation(() => {});
    await click(list, "Update Volli");
    expect(settings).toHaveBeenCalledWith(true, "updates");

    world.setHetzner({ link: { status: "incompatible", reason: "host-too-old" } });
    await click(list, "Update host");
    world.setHetzner({ link: { status: "incompatible", reason: "fenced" } });
    expect(list.textContent).toContain("No longer serves this project");
    await click(list, findDetailAction(list));
    expect(world.remote.calls).toEqual([{ kind: "updateHost", hostId: HETZNER_ID, when: "now" }]);
    expect(toast).toHaveBeenCalledWith("Managing hosts isn’t in this build yet");
  });

  it("announces a host coming back, and an update landing", async () => {
    world = hostWorld({
      hetzner: { liveSessions: 2, link: { status: "offline", since: 0, retryAt: null } },
    });
    await world.render(<HostChip />);
    world.setHetzner({ link: { status: "open" } });
    expect(toast.success).toHaveBeenCalledWith("Back on hetzner-1", {
      description: "2 Sessions kept running while you were away",
    });

    world.setHetzner({ update: { status: "running", progress: 1, targetVersion: "0.3.0" } });
    world.setHetzner({ update: null, version: "0.3.0" });
    expect(toast.success).toHaveBeenLastCalledWith("hetzner-1 is on Volli host 0.3.0", {
      description: "Sessions picked up where they paused",
    });

    // mac-mini is not current, and its recovery is announced all the same.
    act(() => world?.remote.setHost(MINI_ID, { link: { status: "open" } }));
    expect(toast.success).toHaveBeenLastCalledWith("Back on mac-mini", undefined);
  });
});

describe("host chip, accessibility and per-project links", () => {
  it("names the chip's state, the switcher dialog and the update's progress bar", async () => {
    world = hostWorld({ hetzner: { link: { status: "offline", since: 0, retryAt: null } } });
    await world.render(<HostChip />);
    expect(chip().getAttribute("aria-label")).toBe("Host: hetzner-1, offline");
    world.setHetzner({ link: { status: "incompatible", reason: "refused" } });
    expect(chip().getAttribute("aria-label")).toBe("Host: hetzner-1, can’t serve");
    world.setHetzner({
      link: { status: "version-skewed", availableVersion: "0.3.0" },
      update: { status: "running", progress: 0.5, targetVersion: "0.3.0" },
    });
    expect(chip().getAttribute("aria-label")).toBe("Host: hetzner-1, needs attention");

    const list = await openSwitcher();
    expect(list.getAttribute("role")).toBe("dialog");
    expect(list.getAttribute("aria-label")).toBe("Switch host");
    expect(list.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
      "Updating hetzner-1",
    );
  });

  it("moves focus into the switcher on open, and Escape hands it back to the chip", async () => {
    world = hostWorld();
    await world.render(<HostChip />);
    chip().focus();
    await act(async () => chip().click());
    expect(switcher().contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain("This Mac");
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("draws source-owned host health on the tile, and the current project's refusal under it", async () => {
    world = hostWorld();
    // `spare` joins `remote` on hetzner-1 and is fenced; `remote` (current) serves.
    act(() => {
      const snapshot = world!.remote.getSnapshot();
      world!.remote.set({
        ...snapshot,
        projects: {
          ...snapshot.projects,
          spare: { hostId: HETZNER_ID, link: { status: "incompatible", reason: "fenced" } },
        },
      });
    });
    await world.render(<HostChip />);
    expect(chip().querySelector('[data-slot="host-glyph"]')?.getAttribute("data-badge")).toBeNull();
    const list = await openSwitcher();
    // The current project serves, so its detail line has nothing to say.
    expect(list.textContent).not.toContain("No longer serves this project");

    act(() => useProjectsStore.setState({ selectedProjectId: "spare" }));
    expect(switcher().textContent).toContain("No longer serves this project");
  });
});

/** The non-current row button whose text starts with the host's name. */
function findRow(name: string): string {
  const row = [...switcher().querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
  if (row === undefined) throw new Error(`No row ${name}`);
  row.setAttribute("aria-label", `row:${name}`);
  return `row:${name}`;
}

/** The current host's detail button (the one inside the highlighted block). */
function findDetailAction(list: HTMLElement): string {
  const button = list.querySelector<HTMLButtonElement>(".bg-accent\\/50 button");
  if (button === null) throw new Error("no detail action");
  button.setAttribute("aria-label", "detail-action");
  return "detail-action";
}
