// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { ChromeBar } from "@renderer/components/chrome-bar";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

import { HostChip } from "./host-chip";
import { click, HETZNER_ID, hostWorld, MINI_ID, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  toast.mockClear();
  toast.success.mockClear();
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
    expect(rows.slice(3)).toEqual(["Add a host…", "Manage hosts…"]);
    expect(list.querySelector('[aria-current="true"]')?.textContent).toContain("hetzner-1");
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

  it("cannot open a host that serves no project", async () => {
    world = hostWorld();
    act(() =>
      world?.remote.set({ ...world.remote.getSnapshot(), projects: { remote: HETZNER_ID } }),
    );
    await world.render(<HostChip />);
    const list = await openSwitcher();
    const mini = [...list.querySelectorAll("button")].find((row) =>
      row.textContent?.includes("mac-mini"),
    );
    expect(mini?.disabled).toBe(true);
    expect(mini?.textContent).toContain("Offline");
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
