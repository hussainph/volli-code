// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useProjectsStore } from "@renderer/stores/projects";

import { useUiStore } from "@renderer/stores/ui";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { registryHost } from "@renderer/stores/remote-hosts.test-support";

import { remoteHost } from "@renderer/stores/host-sources";

import { HostIsland, ISLAND_BOTTOM_PX, islandBottom } from "./host-island";
import { hostSurface, type HostSurface } from "./host-surface-model";
import { useGrace } from "./use-hosts";
import { click, HETZNER_ID, hostWorld, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const NOW = new Date(2026, 9, 7, 16, 30).getTime();
let world: HostWorld | null = null;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  useProjectsStore.setState({ pendingRemoteSelection: null });
  toast.mockClear();
});

function GraceProbe({ surface }: { surface: HostSurface | null }) {
  return <>{useGrace(surface)?.line ?? ""}</>;
}

function island(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="host-island"] [role="status"]');
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTime(ms));
}

describe("connection Island, flag off", () => {
  it("renders nothing, whatever the host is doing", async () => {
    world = hostWorld({
      cloud: false,
      hetzner: { link: { status: "offline", since: NOW, retryAt: NOW + 8_000 } },
    });
    const container = await world.render(<HostIsland />);
    expect(container.innerHTML).toBe("");
  });
});

describe("connection Island", () => {
  it("says nothing while the host serves, or for This Mac", async () => {
    world = hostWorld({
      hetzner: { link: { status: "version-skewed", availableVersion: "0.3.0" } },
    });
    await world.render(<HostIsland />);
    expect(document.querySelector('[data-slot="host-island"]')).not.toBeNull();
    expect(island()).toBeNull();
  });

  it("counts an offline host down to its retry, read-only, with Retry now", async () => {
    world = hostWorld({
      hetzner: { link: { status: "offline", since: NOW, retryAt: NOW + 8_000 } },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("Can’t reach hetzner-1 · Read-only");
    expect(island()?.textContent).toContain("Retrying in 8s");

    await advance(1_000);
    expect(island()?.textContent).toContain("Retrying in 7s");
    await advance(7_000);
    expect(island()?.textContent).toContain("· Retrying");

    await click(island() as HTMLElement, "Retry now");
    expect(world.remote.calls).toEqual([{ kind: "retry", hostId: HETZNER_ID }]);
  });

  it("waits out the 1.5 s grace before saying Reconnecting, so a blip says nothing", async () => {
    world = hostWorld();
    await world.render(<HostIsland />);

    world.setHetzner({ link: { status: "reconnecting" } });
    await advance(1_000);
    expect(island()).toBeNull();
    world.setHetzner({ link: { status: "open" } });
    await advance(1_000);
    expect(island()).toBeNull();

    world.setHetzner({ link: { status: "reconnecting" } });
    await advance(1_499);
    expect(island()).toBeNull();
    await advance(1);
    expect(island()?.textContent).toContain("Reconnecting to hetzner-1");
    expect(island()?.querySelector("button")).toBeNull();
  });

  it("restarts the grace for the next drop, and shows an ungraced line at once", async () => {
    // The hook alone: the Island's own exit animation keeps its last words
    // on screen while it leaves, which jsdom never finishes.
    world = hostWorld();
    const reconnecting = hostSurface(
      remoteHost("h", "hetzner-1", { link: { status: "reconnecting" } }),
      NOW,
    );
    const offline = hostSurface(
      remoteHost("h", "hetzner-1", { link: { status: "offline", since: NOW, retryAt: null } }),
      NOW,
    );
    const container = await world.render(<GraceProbe surface={reconnecting} />);
    await advance(1_500);
    expect(container.textContent).toBe("Reconnecting to hetzner-1");

    await world.rerender(<GraceProbe surface={offline} />);
    expect(container.textContent).toBe("Can’t reach hetzner-1 · Read-only");
    await world.rerender(<GraceProbe surface={reconnecting} />);
    expect(container.textContent).toBe("");
    await advance(1_499);
    expect(container.textContent).toBe("");
    await advance(1);
    expect(container.textContent).toBe("Reconnecting to hetzner-1");

    await world.rerender(<GraceProbe surface={null} />);
    expect(container.textContent).toBe("");
  });

  it("says an update in flight, quietly and at once", async () => {
    world = hostWorld({
      hetzner: { update: { status: "running", progress: 0.2, targetVersion: "0.3.0" } },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("Updating hetzner-1");
    expect(island()?.querySelector("button")).toBeNull();
  });

  it("offers Re-add to update for a host too old, or with a newer database", async () => {
    world = hostWorld({
      hetzner: {
        link: { status: "incompatible", reason: "host-too-old", requiredVersion: "0.3.0" },
      },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("hetzner-1 needs Volli host 0.3.0 · Read-only");
    useRemoteHostsStore.getState().setHosts([registryHost({ id: HETZNER_ID })]);
    await click(island() as HTMLElement, "Re-add to update");
    expect(world.remote.calls).toEqual([]);
    expect(useRemoteHostsStore.getState().addHost).toEqual({ open: true, target: "deploy@box" });
  });

  it("says a newer database in its own line", async () => {
    world = hostWorld({
      hetzner: { link: { status: "incompatible", reason: "database-too-new" } },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain(
      "hetzner-1’s database is from a newer Volli · Read-only",
    );
    expect(island()?.textContent).toContain("Re-add to update");
  });

  it("offers Update Volli for a host newer than the app", async () => {
    world = hostWorld({
      hetzner: { version: "0.4.0", link: { status: "incompatible", reason: "host-too-new" } },
    });
    const settings = vi
      .spyOn(useUiStore.getState(), "setSettingsOpen")
      .mockImplementation(() => {});
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("hetzner-1 runs Volli 0.4.0 · Read-only");
    await click(island() as HTMLElement, "Update Volli");
    expect(settings).toHaveBeenCalledWith(true, "updates");
  });

  it("sends a refused or fenced host to Manage hosts…", async () => {
    world = hostWorld({ hetzner: { link: { status: "incompatible", reason: "refused" } } });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("hetzner-1 no longer accepts this Mac · Read-only");
    await click(island() as HTMLElement, "Manage hosts…");
    expect(toast).toHaveBeenCalledWith("Managing hosts isn’t in this build yet");
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

describe("connection Island, per project and on chat pages", () => {
  it("speaks for the current project's own link, not a fenced neighbour on the same box", async () => {
    world = hostWorld();
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
    await world.render(<HostIsland />);
    expect(island()).toBeNull();
    act(() => useProjectsStore.setState({ selectedProjectId: "spare" }));
    expect(island()?.textContent).toContain("hetzner-1 no longer serves this project");
  });

  it("rests 88px above the card's foot, and rises above a chat composer under it", async () => {
    world = hostWorld({
      hetzner: { link: { status: "offline", since: NOW, retryAt: null } },
    });
    const card = document.createElement("div");
    document.body.append(card);
    const dock = document.createElement("div");
    dock.dataset.slot = "chat-composer-dock";
    card.append(dock);
    const boxes = new Map<Element, DOMRect>([
      [card, rect(0, 0, 1000, 800)],
      [dock, rect(200, 600, 600, 200)],
    ]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return boxes.get(this) ?? rect(0, 0, 0, 0);
      },
    );
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(card);
    await act(async () => root.render(<HostIsland />));
    card.append(dock);
    await advance(500);
    const lane = card.querySelector<HTMLElement>('[data-slot="host-island"]')!;
    // The dock's top is 200px above the card's foot: the Island floats 12px over it.
    expect(lane.style.bottom).toBe("212px");

    boxes.set(dock, rect(0, 0, 0, 0));
    await advance(500);
    expect(lane.style.bottom).toBe("88px");
    await act(async () => root.unmount());
    card.remove();
  });
});

describe("islandBottom", () => {
  const card = rect(0, 100, 1000, 800);

  it("rests at the lab's 88px with no composer, or one beside the lane", () => {
    expect(islandBottom(card, [])).toBe(ISLAND_BOTTOM_PX);
    expect(islandBottom(card, [rect(0, 700, 200, 200)])).toBe(88);
    expect(islandBottom(card, [rect(800, 700, 200, 200)])).toBe(88);
  });

  it("rises above the tallest composer under its lane, and ignores one outside the card", () => {
    expect(islandBottom(card, [rect(300, 800, 400, 100)])).toBe(112);
    expect(islandBottom(card, [rect(300, 800, 400, 100), rect(0, 600, 1000, 300)])).toBe(312);
    expect(islandBottom(card, [rect(300, 50, 400, 100)])).toBe(88);
    expect(islandBottom(card, [rect(300, 880, 400, 100)])).toBe(88);
    // A short composer low in the card stays under the 88px resting place.
    expect(islandBottom(card, [rect(300, 860, 400, 40)])).toBe(88);
  });
});

it("pending reopen uses the saved host's connecting state, even while its host health is ready", async () => {
  world = hostWorld({ selected: "local" });
  act(() =>
    useProjectsStore.setState({
      selectedProjectId: null,
      pendingRemoteSelection: { hostId: HETZNER_ID, projectId: "remote", hostName: "hetzner-1" },
    }),
  );
  await world.render(<HostIsland />);
  await advance(1_500);
  expect(island()?.textContent).toContain("Connecting to hetzner-1");
  expect(useProjectsStore.getState().selectedProjectId).toBeNull();
});
