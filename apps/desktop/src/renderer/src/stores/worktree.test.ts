import type { WorktreePhaseEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createWorktreeStore,
  phaseFor,
  subscribeWorktreePhases,
  useWorktreeStore,
} from "./worktree";

describe("setPhase", () => {
  it("records a ticket's first phase", () => {
    const store = createWorktreeStore();
    store.getState().setPhase("t1", "creating");

    expect(store.getState().phases).toEqual({ t1: "creating" });
  });

  it("overwrites a ticket's phase as it advances", () => {
    const store = createWorktreeStore();
    store.getState().setPhase("t1", "creating");
    store.getState().setPhase("t1", "copying");
    store.getState().setPhase("t1", "setting-up");
    store.getState().setPhase("t1", "ready");

    expect(store.getState().phases["t1"]).toBe("ready");
  });

  it("keeps a terminal phase (ready/failed) rather than clearing it", () => {
    const store = createWorktreeStore();
    store.getState().setPhase("t1", "failed");

    expect(store.getState().phases["t1"]).toBe("failed");
  });

  it("tracks multiple tickets independently", () => {
    const store = createWorktreeStore();
    store.getState().setPhase("t1", "ready");
    store.getState().setPhase("t2", "creating");

    expect(store.getState().phases).toEqual({ t1: "ready", t2: "creating" });
  });

  it("is a no-op (same reference) when the phase is unchanged", () => {
    const store = createWorktreeStore();
    store.getState().setPhase("t1", "creating");
    const before = store.getState().phases;
    store.getState().setPhase("t1", "creating");

    expect(store.getState().phases).toBe(before);
  });
});

describe("phaseFor", () => {
  it("returns the ticket's recorded phase", () => {
    expect(phaseFor({ t1: "setting-up" }, "t1")).toBe("setting-up");
  });

  it("returns null for a ticket with no recorded phase", () => {
    expect(phaseFor({ t1: "ready" }, "t2")).toBeNull();
  });
});

describe("subscribeWorktreePhases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useWorktreeStore.setState({ phases: {} });
  });

  it("wires api.worktree.onPhase into the singleton store's setPhase", () => {
    let pushed: ((event: WorktreePhaseEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", {
      api: {
        worktree: {
          onPhase: (callback: (event: WorktreePhaseEvent) => void) => {
            pushed = callback;
            return unsubscribe;
          },
        },
      },
    });

    const returnedUnsubscribe = subscribeWorktreePhases();
    pushed?.({ ticketId: "t1", phase: "setting-up" });

    expect(useWorktreeStore.getState().phases).toEqual({ t1: "setting-up" });
    expect(returnedUnsubscribe).toBe(unsubscribe);
  });
});
