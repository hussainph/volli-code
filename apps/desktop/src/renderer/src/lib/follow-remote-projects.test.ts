/**
 * Following a window's remote projects (VC-711): each claim's board is
 * opened; an outage is the board's to retry quietly; a host that offers no
 * board is said once in its name and asked again only when its link changes,
 * its claim comes back, or the person tries again; a claim that goes is let go.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import type { HostLinkView } from "../stores/host-connection";
import { createRemoteBoardAvailabilityStore } from "../stores/remote-board-availability";
import { followRemoteClaims, type FollowedHostStore } from "./follow-remote-projects";

const OPEN: HostLinkView = { status: "open" };
const refusal = {
  data: { hostError: { code: "FORBIDDEN", message: "no", reason: "verb-refused" } },
};
const outage = { data: { hostError: { code: "SERVICE_UNAVAILABLE", message: "away" } } };

function world() {
  const listeners = new Set<(state: ReturnType<FollowedHostStore["getState"]>) => void>();
  let state: ReturnType<FollowedHostStore["getState"]> = { hosts: [], projects: {} };
  const store: FollowedHostStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const set = (projects: Record<string, HostLinkView>) => {
    state = {
      hosts: [
        {
          id: "box",
          name: "old-host",
          local: false,
          os: "linux",
          version: null,
          link: OPEN,
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
      ],
      projects: Object.fromEntries(
        Object.entries(projects).map(([id, link]) => [id, { hostId: "box", link }]),
      ),
    };
    for (const listener of Array.from(listeners)) listener(state);
  };
  return { store, set, listeners };
}

afterEach(() => toast.warning.mockClear());

describe("followRemoteClaims", () => {
  it("says a host's missing board once, and asks again only when something changed", async () => {
    const { store, set } = world();
    const availability = createRemoteBoardAvailabilityStore();
    const open = vi.fn(async (_projectId: string) => {
      throw refusal;
    });
    const sync = { open, close: vi.fn() };
    set({ r1: OPEN });
    const stop = followRemoteClaims({
      sync,
      store,
      alive: () => true,
      availability: availability.getState(),
      drop: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(availability.getState().unavailable.r1).toBe(
        "The board isn’t available on old-host — update it to use it here",
      ),
    );
    expect(toast.warning).toHaveBeenCalledOnce();
    // The same link again: nothing asked.
    set({ r1: store.getState().projects.r1!.link });
    // A new link that is not ready: still nothing.
    set({ r1: { status: "reconnecting" } });
    expect(open).toHaveBeenCalledTimes(1);
    // A new ready link (a new welcome): asked again.
    set({ r1: { status: "open" } });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    // The person's Try again.
    await vi.waitFor(() => expect(availability.getState().unavailable.r1).toBeDefined());
    availability.getState().retry!("r1");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    // A project that was never refused is not retried by hand.
    availability.getState().retry!("unknown");
    expect(open).toHaveBeenCalledTimes(3);
    stop();
    expect(availability.getState().retry).toBeNull();
  });

  it("stays quiet through an outage, and lets go of a claim that went", async () => {
    const { store, set } = world();
    const availability = createRemoteBoardAvailabilityStore();
    let fail: unknown = outage;
    const open = vi.fn(async (_projectId: string) => {
      throw fail;
    });
    const sync = { open, close: vi.fn() };
    const drop = vi.fn();
    set({ r1: OPEN });
    followRemoteClaims({
      sync,
      store,
      alive: () => true,
      availability: availability.getState(),
      drop,
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(availability.getState().unavailable).toEqual({});
    expect(toast.warning).not.toHaveBeenCalled();
    // A refusal that lands after its claim went says nothing.
    fail = refusal;
    set({ r1: OPEN, r2: OPEN });
    set({ r1: OPEN });
    await vi.waitFor(() => expect(sync.close).toHaveBeenCalledWith("r2"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drop).toHaveBeenCalledWith("r2");
    expect(availability.getState().unavailable.r2).toBeUndefined();
  });

  it("lets go of the store, and of its Try again, once the path it served is gone", () => {
    const { store, set, listeners } = world();
    const availability = createRemoteBoardAvailabilityStore();
    const sync = { open: vi.fn(async () => {}), close: vi.fn() };
    let alive = true;
    followRemoteClaims({
      sync,
      store,
      alive: () => alive,
      availability: availability.getState(),
      drop: vi.fn(),
    });
    set({ r1: OPEN });
    expect(sync.open).toHaveBeenCalledOnce();
    alive = false;
    availability.getState().retry!("r1");
    set({});
    expect(listeners.size).toBe(0);
    expect(availability.getState().retry).toBeNull();
    expect(sync.close).not.toHaveBeenCalled();
  });
});
