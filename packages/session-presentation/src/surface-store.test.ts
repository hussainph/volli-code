/**
 * The framework-free store's own contract: synchronous notification, no-op
 * writes that publish nothing, and writes addressed to a Session that is gone
 * landing nowhere. The client suite drives it end-to-end; these pin the store
 * shell itself.
 */
import type { SessionPresentationProjection } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createSurfaceStore } from "./surface-store";

const projection: SessionPresentationProjection = {
  session: { id: "s1", projectId: "p1", ticketId: null, title: "Plan", createdAt: 0 },
  status: "open",
  liveExecutor: null,
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: null,
  turnActive: false,
  lastActivityAt: 0,
  bornTicketless: true,
};

describe("createSurfaceStore", () => {
  it("seeds a slice once and drops it on remove", () => {
    const store = createSurfaceStore();

    store.getState().seed("s1", "starting");
    const seeded = store.getState().sessions["s1"];
    expect(seeded).toMatchObject({ lifecycle: "starting", projection: null, queue: [] });

    // A second seed leaves the resident slice alone — re-adopting a Session
    // must not wipe the state a client already folded into it.
    store.getState().seed("s1", "ready");
    expect(store.getState().sessions["s1"]).toBe(seeded);

    store.getState().remove("s1");
    expect(store.getState().sessions).toEqual({});
    store.getState().remove("s1");
    expect(store.getState().sessions).toEqual({});
  });

  it("notifies synchronously, with the new state already readable", () => {
    // The client's queue-release loop hangs off subscribe from its
    // constructor; a store that deferred this callback would strand a queued
    // message behind the very write that made it releasable.
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");
    let queueAtNotify = -1;
    store.subscribe(() => {
      queueAtNotify = store.getState().sessions["s1"]?.queue.length ?? -1;
    });

    store.getState().enqueue("s1", { id: "q1", text: "hello" });

    expect(queueAtNotify).toBe(1);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });

    store.getState().settle("s1", "broke");
    stop();
    store.getState().settle("s1", null);

    expect(calls).toBe(1);
  });

  it("walks a snapshot, so a listener unsubscribing itself cannot skip its neighbour", () => {
    const store = createSurfaceStore();
    let neighbour = 0;
    const stopFirst = store.subscribe(() => {
      stopFirst();
    });
    store.subscribe(() => {
      neighbour += 1;
    });

    store.getState().seed("s1", "ready");

    expect(neighbour).toBe(1);
  });

  it("lands writes to a Session that is gone nowhere, and publishes nothing for them", () => {
    const store = createSurfaceStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.getState().applyStream("ghost", [], []);
    store.getState().setProjection("ghost", projection);
    store.getState().attaching("ghost");
    store.getState().delivered("ghost", 0);
    store.getState().settle("ghost", "gone");
    store.getState().enqueue("ghost", { id: "q1", text: "hello" });
    store.getState().dequeue("ghost", "q1");

    expect(store.getState().sessions).toEqual({});
    expect(notified).toBe(0);
  });

  it("publishes nothing for a write the transitions returned unchanged", () => {
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");
    const before = store.getState().sessions["s1"];
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.getState().applyStream("s1", [], []);
    store.getState().enqueue("s1", { id: "q1", text: "   " });
    store.getState().dequeue("s1", "never-queued");

    expect(store.getState().sessions["s1"]).toBe(before);
    expect(notified).toBe(0);
  });
});
