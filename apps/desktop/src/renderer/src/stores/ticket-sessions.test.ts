import { describe, expect, it } from "vite-plus/test";
import { createTicketSessionsStore, sessionActivityState } from "./ticket-sessions";

describe("sessionActivityState", () => {
  it("is exited whenever the shell has exited, regardless of recency", () => {
    expect(sessionActivityState(1000, true, 1000)).toBe("exited");
    expect(sessionActivityState(null, true, 5000)).toBe("exited");
  });

  it("is working when output landed within the 10s window", () => {
    expect(sessionActivityState(1000, false, 1000)).toBe("working");
    expect(sessionActivityState(1000, false, 11_000)).toBe("working"); // exactly 10s
  });

  it("is idle when live but quiet past the window", () => {
    expect(sessionActivityState(1000, false, 11_001)).toBe("idle");
  });

  it("is idle when there has been no output at all", () => {
    expect(sessionActivityState(null, false, 50_000)).toBe("idle");
  });
});

describe("addSession", () => {
  it("appends a single-pane tab with the main-supplied title and activates it", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");

    expect(store.getState().byTicket["t1"]).toEqual({
      tabs: [
        {
          sessionId: "s1",
          title: "Session 1",
          layout: { kind: "pane", sessionId: "s1", exitCode: null },
          activePaneId: "s1",
        },
      ],
      activeSessionId: "s1",
    });
  });

  it("appends further sessions to the same ticket in order and activates each", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");

    expect(store.getState().byTicket["t1"]?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s2"]);
    expect(store.getState().byTicket["t1"]?.activeSessionId).toBe("s2");
  });

  it("ignores a duplicate sessionId in the same ticket", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    const before = store.getState().byTicket;
    store.getState().addSession("t1", "s1", "Session 1 again");

    expect(store.getState().byTicket).toBe(before);
  });

  it("scopes sessions per ticket", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("a", "a1", "Session 1");
    store.getState().addSession("b", "b1", "Session 1");

    expect(store.getState().byTicket["a"]?.tabs.map((t) => t.sessionId)).toEqual(["a1"]);
    expect(store.getState().byTicket["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
  });
});

describe("setActiveSession", () => {
  it("activates an existing session", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");
    store.getState().setActiveSession("t1", "s1");

    expect(store.getState().byTicket["t1"]?.activeSessionId).toBe("s1");
  });

  it("is a no-op for an unknown ticket", () => {
    const store = createTicketSessionsStore();
    const before = store.getState().byTicket;
    store.getState().setActiveSession("nope", "s1");
    expect(store.getState().byTicket).toBe(before);
  });

  it("is a no-op for an unknown session in a known ticket", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    const before = store.getState().byTicket;
    store.getState().setActiveSession("t1", "ghost");
    expect(store.getState().byTicket).toBe(before);
  });
});

describe("closeSession", () => {
  it("removes the tab and clears its output timestamp", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().bumpOutput("s1", 1000);
    store.getState().closeSession("t1", "s1");

    expect(store.getState().byTicket["t1"]?.tabs).toEqual([]);
    expect(store.getState().byTicket["t1"]?.activeSessionId).toBeNull();
    expect(store.getState().lastOutputAt["s1"]).toBeUndefined();
  });

  it("reselects the neighbor when the active tab is closed", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");
    store.getState().addSession("t1", "s3", "Session 3");
    store.getState().setActiveSession("t1", "s2");
    store.getState().closeSession("t1", "s2");

    expect(store.getState().byTicket["t1"]?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s3"]);
    expect(store.getState().byTicket["t1"]?.activeSessionId).toBe("s3");
  });

  it("leaves the active selection alone when a non-active tab is closed", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");
    store.getState().closeSession("t1", "s1");

    expect(store.getState().byTicket["t1"]?.activeSessionId).toBe("s2");
  });

  it("is a no-op for an unknown ticket", () => {
    const store = createTicketSessionsStore();
    const before = store.getState().byTicket;
    store.getState().closeSession("nope", "s1");
    expect(store.getState().byTicket).toBe(before);
  });

  it("is a no-op for an unknown session in a known ticket", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    const before = store.getState().byTicket;
    store.getState().closeSession("t1", "ghost");
    expect(store.getState().byTicket).toBe(before);
  });
});

describe("markExited", () => {
  it("stamps the pane's exit code on whichever ticket owns the session", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().markExited("s1", 137);

    expect(store.getState().byTicket["t1"]?.tabs[0]?.layout).toEqual({
      kind: "pane",
      sessionId: "s1",
      exitCode: 137,
    });
  });

  it("is a no-op for a session no ticket owns (e.g. a scratch PTY)", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    const before = store.getState().byTicket;
    store.getState().markExited("scratch", 0);
    expect(store.getState().byTicket).toBe(before);
  });
});

describe("bumpOutput", () => {
  it("records the timestamp for a ticket-owned session", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().bumpOutput("s1", 5000);
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
  });

  it("throttles to one write per second", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().bumpOutput("s1", 5000);
    store.getState().bumpOutput("s1", 5500); // within 1s — ignored
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
    store.getState().bumpOutput("s1", 6000); // exactly 1s later — recorded
    expect(store.getState().lastOutputAt["s1"]).toBe(6000);
  });

  it("ignores sessions no ticket owns", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().bumpOutput("scratch", 5000);
    expect(store.getState().lastOutputAt["scratch"]).toBeUndefined();
  });

  it("indexes a session on create and drops it on close, so post-close chunks are free", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    expect(store.getState().sessionTicket["s1"]).toBe("t1");

    store.getState().closeSession("t1", "s1");
    expect(store.getState().sessionTicket["s1"]).toBeUndefined();

    // A chunk arriving after close is no longer owned — an untracked no-op.
    store.getState().bumpOutput("s1", 9999);
    expect(store.getState().lastOutputAt["s1"]).toBeUndefined();
  });

  it("drops every session from the index on forgetTicket", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");
    store.getState().forgetTicket("t1");
    expect(store.getState().sessionTicket).toEqual({});
  });
});

describe("setStarting", () => {
  it("toggles a ticket's in-flight flag and no-ops on a repeat", () => {
    const store = createTicketSessionsStore();
    store.getState().setStarting("t1", true);
    expect(store.getState().startingTickets["t1"]).toBe(true);

    const before = store.getState().startingTickets;
    store.getState().setStarting("t1", true); // already starting — no-op
    expect(store.getState().startingTickets).toBe(before);

    store.getState().setStarting("t1", false);
    expect(store.getState().startingTickets["t1"]).toBeUndefined();
  });
});

describe("forgetTicket", () => {
  it("drops a ticket and every one of its sessions' output timestamps", () => {
    const store = createTicketSessionsStore();
    store.getState().addSession("t1", "s1", "Session 1");
    store.getState().addSession("t1", "s2", "Session 2");
    store.getState().bumpOutput("s1", 1000);
    store.getState().bumpOutput("s2", 1000);
    store.getState().forgetTicket("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
    expect(store.getState().lastOutputAt).toEqual({});
  });

  it("is a no-op for an unknown ticket", () => {
    const store = createTicketSessionsStore();
    const before = store.getState();
    store.getState().forgetTicket("never-added");
    expect(store.getState()).toBe(before);
  });
});
