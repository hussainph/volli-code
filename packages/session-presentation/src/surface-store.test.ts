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
  session: {
    id: "s1",
    projectId: "p1",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Plan",
    createdAt: 0,
  },
  status: "open",
  liveExecutor: null,
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: null,
  modelTier: null,
  turnActive: false,
  lastActivityAt: 0,
  bornTicketless: true,
  scheduledResume: null,
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

    store.getState().setQueue(
      "s1",
      [
        {
          id: "q1",
          commandId: "q1",
          state: "queued",
          message: { id: "q1", role: "user", parts: [{ type: "text", text: "hello" }] },
        },
      ],
      1,
    );

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
    store.getState().setQueue("ghost", [], 1);

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
    store.getState().setQueue("s1", [], -1);

    expect(store.getState().sessions["s1"]).toBe(before);
    expect(notified).toBe(0);
  });
});

describe("createSurfaceStore batch (VC-515)", () => {
  it("publishes every slice written inside one batch as one announcement", () => {
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");
    store.getState().seed("s2", "ready");
    let announcements = 0;
    store.subscribe(() => {
      announcements += 1;
    });

    store.getState().batch?.(() => {
      store.getState().setProjection("s1", projection);
      store
        .getState()
        .setProjection("s2", { ...projection, session: { ...projection.session, id: "s2" } });
      // A later write in the same batch builds on the staged one, not the published one.
      store.getState().settle("s1", "lost");
      expect(announcements).toBe(0);
    });

    expect(announcements).toBe(1);
    expect(store.getState().sessions["s1"]).toMatchObject({ projection, sessionError: "lost" });
    expect(store.getState().sessions["s2"]?.projection?.session.id).toBe("s2");
  });

  it("drops a staged write whose Session was removed before the batch published", () => {
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");

    store.getState().batch?.(() => {
      store.getState().setProjection("s1", projection);
      store.getState().remove("s1");
    });

    expect(store.getState().sessions).toEqual({});
  });

  it("publishes nothing for a batch that changed nothing", () => {
    const store = createSurfaceStore();
    store.getState().seed("s1", "ready");
    const before = store.getState();
    let announcements = 0;
    store.subscribe(() => {
      announcements += 1;
    });

    store.getState().batch?.(() => {
      store.getState().applyStream("s1", [], []);
      store.getState().applyStream("ghost", [], []);
      // A batch inside a batch joins it rather than publishing on its own.
      store.getState().batch?.(() => store.getState().setQueue("s1", [], -1));
    });

    expect(announcements).toBe(0);
    expect(store.getState()).toBe(before);
  });
});
