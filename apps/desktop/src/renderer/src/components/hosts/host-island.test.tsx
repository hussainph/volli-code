// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUiStore } from "@renderer/stores/ui";

import { remoteHost } from "@renderer/stores/host-sources";

import { HostIsland } from "./host-island";
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

  it("offers Update host for a host too old, or with a newer database", async () => {
    world = hostWorld({
      hetzner: {
        link: { status: "incompatible", reason: "host-too-old", requiredVersion: "0.3.0" },
      },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain("hetzner-1 needs Volli host 0.3.0 · Read-only");
    await click(island() as HTMLElement, "Update host");
    expect(world.remote.calls).toEqual([{ kind: "updateHost", hostId: HETZNER_ID, when: "now" }]);
  });

  it("says a newer database in its own line", async () => {
    world = hostWorld({
      hetzner: { link: { status: "incompatible", reason: "database-too-new" } },
    });
    await world.render(<HostIsland />);
    expect(island()?.textContent).toContain(
      "hetzner-1’s database is from a newer Volli · Read-only",
    );
    expect(island()?.textContent).toContain("Update host");
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
