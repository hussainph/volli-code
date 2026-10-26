import { describe, expect, it, vi } from "vite-plus/test";

import type { BackendLink, LinkStatus } from "../cloud-runner/backend-link";
import { createCloudRestartRecovery } from "./recovery";

function fakeLink(initial: LinkStatus = { state: "connecting" }, query?: BackendLink["query"]) {
  const listeners = new Set<(status: LinkStatus) => void>();
  let status = initial;
  const link = {
    get status() {
      return status;
    },
    onStatus(listener: (next: LinkStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(query === undefined ? {} : { query }),
  } as unknown as BackendLink;
  return {
    link,
    listeners,
    set(next: LinkStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

const never = () => new AbortController().signal;

describe("createCloudRestartRecovery (N2-3)", () => {
  it("resolves the first-connect wait when an observed link connects, and stays connected", async () => {
    const recovery = createCloudRestartRecovery({ currentLink: () => null });
    const first = fakeLink();
    recovery.observe(first.link);
    const waiting = recovery.firstConnect({ timeoutMs: 60_000, signal: never() });
    first.set({ state: "offline", since: 1 });
    first.set({ state: "connected" });
    await expect(waiting).resolves.toBe(true);
    // The listener detached itself.
    expect(first.listeners.size).toBe(0);
    // Once connected this launch, later waits and observes are immediate.
    first.set({ state: "offline", since: 2 });
    await expect(recovery.firstConnect({ timeoutMs: 0, signal: never() })).resolves.toBe(true);
    const second = fakeLink();
    recovery.observe(second.link);
    expect(second.listeners.size).toBe(0);
  });

  it("counts a link that is already connected when observed", async () => {
    const recovery = createCloudRestartRecovery({ currentLink: () => null });
    recovery.observe(fakeLink({ state: "connected" }).link);
    await expect(recovery.firstConnect({ timeoutMs: 0, signal: never() })).resolves.toBe(true);
  });

  it("gives up past its bound, or when the host closes", async () => {
    vi.useFakeTimers();
    try {
      const recovery = createCloudRestartRecovery({ currentLink: () => null });
      recovery.observe(fakeLink().link);
      const bounded = recovery.firstConnect({ timeoutMs: 30_000, signal: never() });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(bounded).resolves.toBe(false);

      const closing = new AbortController();
      const aborted = recovery.firstConnect({ timeoutMs: 30_000, signal: closing.signal });
      closing.abort();
      await expect(aborted).resolves.toBe(false);
      await expect(
        recovery.firstConnect({ timeoutMs: 30_000, signal: closing.signal }),
      ).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads siblings over the live link only, and refuses without one", async () => {
    const query = vi.fn(async () => ({
      siblings: [{ sessionId: "s2", movedOn: false }],
      complete: true,
    }));
    let current: BackendLink | null = null;
    const recovery = createCloudRestartRecovery({ currentLink: () => current });
    const input = { sessionId: "s1", projectId: "p", ticketId: "t", since: 5 };
    await expect(recovery.ticketSiblings(input)).rejects.toThrow("unreachable");
    current = fakeLink({ state: "connected" }).link;
    await expect(recovery.ticketSiblings(input)).rejects.toThrow("unavailable");
    current = fakeLink({ state: "connected" }, query).link;
    await expect(recovery.ticketSiblings(input)).resolves.toEqual({
      siblings: [{ sessionId: "s2", movedOn: false }],
      complete: true,
    });
    expect(query).toHaveBeenCalledWith("runnerRecovery:ticketSiblings", input);
  });
});

describe("the sibling answer", () => {
  function over(reply: unknown) {
    const link = fakeLink({ state: "connected" }, async () => reply).link;
    return createCloudRestartRecovery({ currentLink: () => link }).ticketSiblings({
      sessionId: "s1",
      projectId: "p",
      ticketId: "t",
      since: 5,
    });
  }

  it("reads the backend's shape and nothing else", async () => {
    await expect(
      over({
        siblings: [
          { sessionId: "a", movedOn: true },
          { sessionId: "b", movedOn: null },
        ],
        complete: false,
        extra: 1,
      }),
    ).resolves.toEqual({
      siblings: [
        { sessionId: "a", movedOn: true },
        { sessionId: "b", movedOn: null },
      ],
      complete: false,
    });
    for (const bad of [
      null,
      "x",
      { siblings: [], complete: "yes" },
      { siblings: {}, complete: true },
      { siblings: [null], complete: true },
      { siblings: [{ sessionId: 1, movedOn: true }], complete: true },
      { siblings: [{ sessionId: "a", movedOn: "no" }], complete: true },
      { siblings: [{ sessionId: "a" }], complete: true },
    ]) {
      await expect(over(bad)).rejects.toThrow("unreadable");
    }
  });
});
