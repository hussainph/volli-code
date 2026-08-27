import { DEFAULT_TICKET_SORT, EMPTY_FILE_WORKSPACE } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { TICKET_BODY_TAB_ID, isTicketBodyTabId } from "@renderer/components/ticket/ticket-body-tab";
import { useBoardStore } from "./board";
import { ticketScope, useSessionsStore, type SessionLaunch } from "./sessions";

import {
  applyTicketFileTransition,
  createWorkspaceStore,
  DEFAULT_WORKSPACE_UI,
  resolvePersistedNav,
  type NavKey,
  type TicketTabsState,
} from "./workspace";

/** A bare shell launch: no harness command line was written, so no expectation. */
const shellLaunch = (title: string): SessionLaunch => ({
  title,
  harnessId: "claude-code",
  launchKind: "shell",
  createdAt: 0,
});

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

describe("setNav", () => {
  it("tracks nav independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");

    // project-b was never touched: if setNav leaked across projects instead of
    // scoping to the one it was called with, this would read "configure" too.
    expect(store.getState().byProject["project-a"]?.nav).toBe("configure");
    expect(store.getState().byProject["project-b"]?.nav ?? DEFAULT_WORKSPACE_UI.nav).toBe("home");
  });

  it("keeps a project's nav across changes to other projects", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");
    store.getState().setNav("project-b", "home");
    store.getState().setNav("project-b", "configure");

    expect(store.getState().byProject["project-a"]?.nav).toBe("configure");
  });

  it("shows the plain board when Home is selected from inside a ticket", () => {
    // Inside a ticket the nav is ALREADY "home", so clicking Home can only mean
    // one thing — show me Home, which is the board (VC-54 decision 1).
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    store.getState().setNav("project-a", "home");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      openTicketId: null,
    });
  });

  it("keeps the remembered ticket when Home is selected onto a Session tab", () => {
    // The clear belongs to the BOARD tab, not to the nav item. With a Session
    // tab in front the ticket is not on screen to be left, and the round trip
    // Home → Configure → Home must not quietly discard it.
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().setHomeActiveTab("project-a", "chat:c1");
    store.getState().setNav("project-a", "configure");

    store.getState().setNav("project-a", "home");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: "chat:c1",
      openTicketId: "ticket-1",
    });
  });

  it("switches to Configure without clearing the open ticket (only Home does)", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    store.getState().setNav("project-a", "configure");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "configure",
      openTicketId: "ticket-1",
    });
  });
});

/**
 * `nav` is session-only — no shipped build ever persisted one (see the
 * `NavKey` doc in workspace.ts) — so these are pure insurance against a foreign
 * or hand-edited blob, exercised directly rather than through a round trip
 * because nothing in this store's own `partialize` output could ever carry a
 * `nav` field to rehydrate. Deliberately NOT the whole of the tolerant-read
 * `ticket-rail-model.test.ts` gives `resolvePersistedRailMode`: that one keeps
 * a still-valid stored key, which is right for a persisted field and wrong for
 * this one.
 */
describe("resolvePersistedNav", () => {
  it('maps the retired "files" nav key onto "home"', () => {
    expect(resolvePersistedNav({ nav: "files" })).toBe("home");
  });

  it("never lets a stored value choose the landing page", () => {
    // The settled decision is that nav RESETS to Home on relaunch, so unlike
    // `resolvePersistedRailMode` (whose railMode really is persisted) there is
    // no "still-valid key stands" branch: honouring a stored "configure" would
    // reverse that decision for the one blob this read exists to survive.
    expect(resolvePersistedNav({ nav: "configure" })).toBe("home");
    expect(resolvePersistedNav({ nav: "home" })).toBe("home");
  });

  it("falls back to the default for anything absent, malformed, or unrecognized", () => {
    expect(resolvePersistedNav({})).toBe(DEFAULT_WORKSPACE_UI.nav);
    expect(resolvePersistedNav({ nav: "bogus" })).toBe(DEFAULT_WORKSPACE_UI.nav);
    expect(resolvePersistedNav({ nav: 7 })).toBe(DEFAULT_WORKSPACE_UI.nav);
    expect(resolvePersistedNav({ nav: null })).toBe(DEFAULT_WORKSPACE_UI.nav);
  });

  it('cannot be tricked by a persisted "toString" key', () => {
    // Why RETIRED_NAV_KEYS is a Map rather than an object literal: an object
    // would answer this lookup with a function off the prototype chain.
    expect(resolvePersistedNav({ nav: "toString" })).toBe(DEFAULT_WORKSPACE_UI.nav);
  });

  it("rehydrates a project record whose persisted JSON carries a retired nav key", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { nav: "files", boardView: "list" } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      boardView: "list",
    });
  });
});

/**
 * Which Previous-band ticket groups are open in the sidebar (VC-69).
 *
 * Per project for the reason the sidebar component cannot be: `ActiveSessions`
 * is render-hidden across nav switches rather than unmounted and is not keyed
 * by project, so component state would carry one project's open groups into the
 * next one's band.
 */
describe("setSessionGroupExpanded", () => {
  it("tracks open groups independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);
    store.getState().setSessionGroupExpanded("project-a", "ticket-2", true);
    store.getState().setSessionGroupExpanded("project-b", "ticket-9", true);

    expect(store.getState().byProject["project-a"]?.expandedSessionGroups).toEqual([
      "ticket-1",
      "ticket-2",
    ]);
    expect(store.getState().byProject["project-b"]?.expandedSessionGroups).toEqual(["ticket-9"]);
  });

  it("collapsing removes only that ticket", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);
    store.getState().setSessionGroupExpanded("project-a", "ticket-2", true);
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", false);

    expect(store.getState().byProject["project-a"]?.expandedSessionGroups).toEqual(["ticket-2"]);
  });

  it("is a no-op when the state already matches", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);

    // The band re-renders on every chat-activity refresh, so a `set` that
    // changes nothing would still notify every subscriber.
    const before = store.getState().byProject;
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);
    store.getState().setSessionGroupExpanded("project-a", "never-opened", false);
    expect(store.getState().byProject).toBe(before);
  });

  it("starts collapsed after a relaunch — open groups are this sitting's state only", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);
    store.getState().setBoardView("project-a", "list");

    const relaunched = createWorkspaceStore(storage);

    expect(relaunched.getState().byProject["project-a"]?.expandedSessionGroups).toEqual([]);
    // The persisted neighbour still survives, so this is the partialize rule
    // and not a storage that failed to write.
    expect(relaunched.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("setBoardView", () => {
  it("tracks the board/list view independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardView("project-b", "board");

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-b"]?.boardView).toBe("board");
  });

  it("leaves nav and sort untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");
    store.getState().setBoardView("project-a", "list");

    expect(store.getState().byProject["project-a"]?.nav).toBe("configure");
    expect(store.getState().byProject["project-a"]?.boardSort).toBe(DEFAULT_TICKET_SORT);
  });
});

// VC-156: "Ignore" is an answer, and an answer that has to be repeated after
// every relaunch is not one — which is exactly what the string-keyed,
// component-state dismissal this replaces did.
describe("dismissDependencyOffer", () => {
  it("waves the offer off for one project and leaves its neighbours offering", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    expect(
      store.getState().byProject["project-a"]?.dependencyOfferDismissed ??
        DEFAULT_WORKSPACE_UI.dependencyOfferDismissed,
    ).toBe(false);

    store.getState().dismissDependencyOffer("project-a");

    expect(store.getState().byProject["project-a"]?.dependencyOfferDismissed).toBe(true);
    expect(store.getState().byProject["project-b"]?.dependencyOfferDismissed).toBeUndefined();
  });

  it("is a no-op once dismissed, so a second click notifies nobody", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().dismissDependencyOffer("project-a");

    const before = store.getState().byProject;
    store.getState().dismissDependencyOffer("project-a");
    expect(store.getState().byProject).toBe(before);
  });

  it("survives relaunch", () => {
    const storage = createMemoryStorage();
    createWorkspaceStore(storage).getState().dismissDependencyOffer("project-a");

    expect(
      createWorkspaceStore(storage).getState().byProject["project-a"]?.dependencyOfferDismissed,
    ).toBe(true);
  });

  it("only an explicit true dismisses — anything else leaves the offer standing", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { dependencyOfferDismissed: "yes" } } },
        version: 0,
      }),
    );

    expect(
      createWorkspaceStore(storage).getState().byProject["project-a"]?.dependencyOfferDismissed ??
        DEFAULT_WORKSPACE_UI.dependencyOfferDismissed,
    ).toBe(false);
  });
});

describe("setBoardSort", () => {
  it("tracks the sort independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().setBoardSort("project-b", { key: "title", direction: "asc" });

    expect(store.getState().byProject["project-a"]?.boardSort).toEqual({
      key: "priority",
      direction: "desc",
    });
    expect(store.getState().byProject["project-b"]?.boardSort).toEqual({
      key: "title",
      direction: "asc",
    });
  });

  it("leaves the view untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "updated", direction: "desc" });

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("setHomeActiveTab", () => {
  it("defaults to the Board tab for an untouched project", () => {
    const store = createWorkspaceStore(createMemoryStorage());

    expect(
      store.getState().byProject["project-a"]?.homeActiveTab ?? DEFAULT_WORKSPACE_UI.homeActiveTab,
    ).toBe(HOME_BOARD_TAB_ID);
  });

  it("tracks the active tab independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "s1");
    store.getState().setHomeActiveTab("project-b", "chat:c1");

    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe("s1");
    expect(store.getState().byProject["project-b"]?.homeActiveTab).toBe("chat:c1");
  });

  it("returns to the Board tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "s1");

    store.getState().setHomeActiveTab("project-a", HOME_BOARD_TAB_ID);

    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe(HOME_BOARD_TAB_ID);
  });

  it("records the Board tab WITHOUT closing an open ticket \u2014 that is openHomeBoard's act", () => {
    // The write-back in `home-surface.tsx` records whatever it derived, and the
    // last Session tab closing derives the Board. If recording that also closed
    // the ticket remembered behind it, closing a chat would silently discard
    // the ticket the person was going back to.
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().setHomeActiveTab("project-a", "chat:c1");

    store.getState().setHomeActiveTab("project-a", HOME_BOARD_TAB_ID);

    expect(store.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
  });

  it("is a no-op (unchanged identity) when re-setting the same tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "s1");
    const before = store.getState();

    store.getState().setHomeActiveTab("project-a", "s1");

    expect(store.getState()).toBe(before);
  });

  it("is a no-op (unchanged identity) re-recording the Board on an untouched project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState();

    store.getState().setHomeActiveTab("project-a", HOME_BOARD_TAB_ID);

    expect(store.getState()).toBe(before);
  });

  it("survives a relaunch, so Home reopens the Session that was in front", () => {
    // The asymmetry this closes: a Ticket workspace kept its active Session
    // across a relaunch and Home forgot every one of them.
    const storage = createMemoryStorage();
    createWorkspaceStore(storage).getState().setHomeActiveTab("project-a", "chat:c1");

    const relaunched = createWorkspaceStore(storage);
    void relaunched.persist.rehydrate();

    expect(relaunched.getState().byProject["project-a"]?.homeActiveTab).toBe("chat:c1");
  });

  it("sanitizes a rehydrated tab id of the wrong shape back to the Board", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({ state: { byProject: { "project-a": { homeActiveTab: 7 } } }, version: 1 }),
    );
    const store = createWorkspaceStore(storage);
    void store.persist.rehydrate();

    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe(HOME_BOARD_TAB_ID);
  });

  it("earns a project no persisted record while it still names the Board", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list"); // earns project-a a spot in persisted output
    store.getState().setHomeActiveTab("project-b", HOME_BOARD_TAB_ID); // nothing worth persisting

    const raw = storage.getItem("volli:workspace");
    const parsed = JSON.parse(raw!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(Object.keys(parsed.state.byProject)).toEqual(["project-a"]);
  });
});

describe("openHome", () => {
  it("puts Home in front with a Session tab, leaving the remembered ticket alone", () => {
    // Decision 1: a Home Session tab is its own place, and the ticket stays
    // remembered behind it — the sidebar band, ⌘K and ⌘T all land here.
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().setNav("project-a", "configure");

    store.getState().openHome("project-a", "chat:c1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: "chat:c1",
      openTicketId: "ticket-1",
    });
  });

  it("puts Home in front without an opinion about the tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "chat:c1");
    store.getState().setNav("project-a", "configure");

    store.getState().openHome("project-a");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: "chat:c1",
    });
  });
});

describe("openHomeBoard", () => {
  it("means the plain board \u2014 exactly what the Board nav item meant", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().setHomeActiveTab("project-a", "chat:c1");
    store.getState().setNav("project-a", "configure");

    store.getState().openHomeBoard("project-a");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: HOME_BOARD_TAB_ID,
      openTicketId: null,
    });
  });

  it("creates the plain Board state for a project with no prior workspace record", () => {
    const store = createWorkspaceStore(createMemoryStorage());

    store.getState().openHomeBoard("project-a");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: HOME_BOARD_TAB_ID,
      homeTabHistory: [HOME_BOARD_TAB_ID],
      openTicketId: null,
    });
  });
});

describe("openTicket", () => {
  // openTicket also selects the ticket in the REAL board-store singleton (see
  // workspace.ts's module doc: cross-store orchestration lives in the action,
  // same precedent as projects.ts's removeProject) — reset it so a write here
  // never leaks into another test.
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
  });

  it("sets the project's openTicketId", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
  });

  it("selects the same ticket in the board store", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
  });

  it("tracks the open ticket independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().openTicket("project-b", "ticket-2");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
    expect(store.getState().byProject["project-b"]?.openTicketId).toBe("ticket-2");
  });

  it("leaves nav, boardView, and boardSort untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");
    store.getState().setBoardView("project-a", "list");
    store.getState().openTicket("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.nav).toBe("configure");
    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("openTicketWorkspace", () => {
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
  });

  it("switches nav to Home even when the project's nav was elsewhere (composer kickoff from Files regression)", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    // Simulate invoking Create-&-start (or any ticket-open action) while the
    // user is on another page — the app-wide "c" shortcut and the command
    // palette both allow this. `openTicket` alone never touched nav, so the
    // ticket detail it promises never rendered.
    store.getState().setNav("project-a", "configure");

    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      openTicketId: "ticket-1",
    });
  });

  it("switches to Home's BOARD TAB, so a ticket opened from a Home chat is actually shown", () => {
    // The VC-54 twin of the kickoff bug above: under Home, ticket detail renders
    // only from the Board tab, so landing nav alone would leave the promised
    // workspace behind the Session tab that was in front.
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openHome("project-a", "chat:c1");

    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: HOME_BOARD_TAB_ID,
      openTicketId: "ticket-1",
    });
  });

  it("selects the same ticket in the board store", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
  });

  it("activates the given tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1", { tabId: "doc" });

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [],
      diffs: [],
      diffMeta: {},
      active: "doc",
    });
  });

  it("leaves the ticket's existing tab untouched when no tabId is given", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md"); // active: file:a.md
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.active).toBe(
      "file:a.md",
    );
  });

  it("creates no ticketTabs record when no tabId is given and none existed", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });
});

describe("openTicketSession", () => {
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
    useSessionsStore.getState().forgetOwner("ticket-1");
  });

  it("opens the ticket detail and focuses the exact tab and split pane", () => {
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-1", shellLaunch("Agent"));
    useSessionsStore
      .getState()
      .addSplit("ticket-1", "session-1", "session-1", "session-2", "vertical");
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-3", shellLaunch("Checks"));
    useSessionsStore.getState().setActivePane("ticket-1", "session-1", "session-1");

    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");
    store.getState().openTicketSession("project-a", "ticket-1", "session-1", "session-2");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      openTicketId: "ticket-1",
      ticketTabs: { "ticket-1": { files: [], active: "session-1" } },
    });
    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.activeSessionId).toBe("session-1");
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.tabs[0]?.activePaneId).toBe(
      "session-2",
    );
  });

  it("creates missing workspace state and preserves the active pane when none is requested", () => {
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-1", shellLaunch("Agent"));

    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketSession("project-a", "ticket-1", "session-1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      openTicketId: "ticket-1",
      ticketTabs: { "ticket-1": { files: [], active: "session-1" } },
    });
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.tabs[0]?.activePaneId).toBe(
      "session-1",
    );
  });
});

describe("closeTicket", () => {
  it("clears the project's openTicketId", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().closeTicket("project-a");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
  });

  it("is safe to call on a project with no record yet", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().closeTicket("never-opened");

    expect(store.getState().byProject["never-opened"]?.openTicketId ?? null).toBeNull();
  });
});

describe("ticket diff tabs", () => {
  it("openTicketDiff appends a persistent diff and makes it active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "src/app.ts", {
      previousPath: "src/old.ts",
      status: "renamed",
    });

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [],
      diffs: ["src/app.ts"],
      diffMeta: { "src/app.ts": { previousPath: "src/old.ts", status: "renamed" } },
      active: "diff:src/app.ts",
    });

    // Re-open focuses without duplicating.
    store.getState().openTicketDiff("project-a", "ticket-1", "src/other.ts");
    store.getState().openTicketDiff("project-a", "ticket-1", "src/app.ts");
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [],
      diffs: ["src/app.ts", "src/other.ts"],
      diffMeta: { "src/app.ts": { previousPath: "src/old.ts", status: "renamed" } },
      active: "diff:src/app.ts",
    });
  });

  it("openTicketDiff persists the Change Set binary flag on diffMeta", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "logo.png", {
      status: "added",
      binary: true,
    });

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta).toEqual({
      "logo.png": { status: "added", binary: true },
    });
  });

  it("openTicketDiff accepts binary-only metadata without inventing a status", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "logo.png", {
      binary: true,
    });

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta).toEqual({
      "logo.png": { binary: true },
    });
  });

  it("openTicketDiff keeps runtime diffMeta on a null prototype", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "__proto__", {
      status: "modified",
    });

    const diffMeta = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta;
    expect(Object.getPrototypeOf(diffMeta)).toBeNull();
    expect(Object.keys(diffMeta ?? {})).toEqual(["__proto__"]);
    expect(diffMeta?.["__proto__"]).toEqual({ status: "modified" });

    store.getState().openTicketDiff("project-a", "ticket-1", "src/a.ts", {
      status: "added",
    });
    store.getState().closeTicketDiff("project-a", "ticket-1", "src/a.ts");
    const afterClose = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta;
    expect(Object.getPrototypeOf(afterClose)).toBeNull();
    expect(Object.keys(afterClose ?? {})).toEqual(["__proto__"]);
  });

  it("closeTicketDiff removes the diff and falls back to Doc when it was active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "notes.md");
    store.getState().openTicketDiff("project-a", "ticket-1", "src/app.ts", {
      status: "modified",
    });
    store.getState().closeTicketDiff("project-a", "ticket-1", "src/app.ts");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "notes.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "doc",
    });
  });

  it("closeTicketDiff is a no-op for a ticket with no record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().byProject;

    store.getState().closeTicketDiff("project-a", "ticket-1", "src/app.ts");

    expect(store.getState().byProject).toBe(before);
  });

  it("keeps files and diffs as independent ordered lists with a shared active id", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketDiff("project-a", "ticket-1", "b.ts");
    store.getState().openTicketFile("project-a", "ticket-1", "c.md");
    store.getState().setTicketActiveTab("project-a", "ticket-1", "diff:b.ts");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [
        { relPath: "a.md", pinned: true },
        { relPath: "c.md", pinned: true },
      ],
      diffs: ["b.ts"],
      diffMeta: {},
      active: "diff:b.ts",
    });
  });
});

describe("ticket file tabs", () => {
  it("maps a transition that clears file focus back to Ticket Body", () => {
    const existing: TicketTabsState = {
      files: [{ relPath: "a.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "file:a.md",
    };

    expect(
      applyTicketFileTransition(existing, () => ({
        tabs: [],
        activeRelPath: null,
      })),
    ).toEqual({
      files: [],
      diffs: [],
      diffMeta: {},
      active: "doc",
    });
  });

  it("openTicketFile appends a pinned file and makes it active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "docs/plan.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "docs/plan.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "file:docs/plan.md",
    });
  });

  it("opening the same file twice keeps one entry but re-activates it", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md");
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [
        { relPath: "a.md", pinned: true },
        { relPath: "b.md", pinned: true },
      ],
      diffs: [],
      diffMeta: {},
      active: "file:a.md",
    });

    const before = store.getState().byProject;
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    expect(store.getState().byProject).toBe(before);
  });

  it("tracks open files independently per ticket and per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-2", "b.md");
    store.getState().openTicketFile("project-b", "ticket-1", "c.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.files).toEqual([
      { relPath: "a.md", pinned: true },
    ]);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-2"]?.files).toEqual([
      { relPath: "b.md", pinned: true },
    ]);
    expect(store.getState().byProject["project-b"]?.ticketTabs["ticket-1"]?.files).toEqual([
      { relPath: "c.md", pinned: true },
    ]);
  });

  it("closeTicketFile removes the file and falls back to Doc when it was active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md");
    store.getState().closeTicketFile("project-a", "ticket-1", "b.md"); // b was active

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "a.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "doc",
    });
  });

  it("closeTicketFile keeps the active tab when a non-active file closes", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md"); // b active
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "b.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "file:b.md",
    });
  });

  it("closing the last file with Doc active prunes the ticket record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });

  it("closeTicketFile is a no-op for a ticket with no record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().byProject;
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");
    expect(store.getState().byProject).toBe(before);
  });

  it("closeTicketFile is a no-op when the ticket exists but the path is not open", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    const before = store.getState().byProject;

    store.getState().closeTicketFile("project-a", "ticket-1", "missing.md");

    expect(store.getState().byProject).toBe(before);
  });

  it("setTicketActiveTab switches the active tab, including to a session id", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().setTicketActiveTab("project-a", "ticket-1", "session-9");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "a.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "session-9",
    });
  });

  it("setTicketActiveTab to Doc on an empty ticket creates no record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setTicketActiveTab("project-a", "ticket-1", "doc");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });

  it("leaves board view/sort/open ticket untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-a"]?.boardSort).toBe(DEFAULT_TICKET_SORT);
  });
});

describe("ticket file preview/pin (decision #56)", () => {
  it("pinTicketFile opens a pinned tab while markTicketFileEdited ignores an unknown ticket", () => {
    const pinStore = createWorkspaceStore(createMemoryStorage());
    pinStore.getState().pinTicketFile("missing-project", "missing-ticket", "src/app.ts");
    expect(
      pinStore.getState().byProject["missing-project"]?.ticketTabs["missing-ticket"],
    ).toMatchObject({
      files: [{ relPath: "src/app.ts", pinned: true }],
      active: "file:src/app.ts",
    });

    const markStore = createWorkspaceStore(createMemoryStorage());
    const before = markStore.getState().byProject;
    markStore.getState().markTicketFileEdited("missing-project", "missing-ticket", "src/app.ts");
    expect(markStore.getState().byProject).toBe(before);
  });

  it("previewTicketFile opens a replaceable preview tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewTicketFile("project-a", "ticket-1", "src/app.ts");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "src/app.ts", pinned: false }],
      diffs: [],
      diffMeta: {},
      active: "file:src/app.ts",
    });

    const before = store.getState().byProject;
    store.getState().previewTicketFile("project-a", "ticket-1", "src/app.ts");
    expect(store.getState().byProject).toBe(before);
  });

  it("a second preview replaces the preview slot in place", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "pinned.md");
    store.getState().previewTicketFile("project-a", "ticket-1", "one.ts");
    store.getState().previewTicketFile("project-a", "ticket-1", "two.ts");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.files).toEqual([
      { relPath: "pinned.md", pinned: true },
      { relPath: "two.ts", pinned: false },
    ]);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.active).toBe(
      "file:two.ts",
    );
  });

  it("pinTicketFile / markTicketFileEdited promote the preview so the next glance appends", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewTicketFile("project-a", "ticket-1", "one.ts");
    store.getState().markTicketFileEdited("project-a", "ticket-1", "one.ts");
    store.getState().previewTicketFile("project-a", "ticket-1", "two.ts");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.files).toEqual([
      { relPath: "one.ts", pinned: true },
      { relPath: "two.ts", pinned: false },
    ]);

    store.getState().pinTicketFile("project-a", "ticket-1", "two.ts");
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.files).toEqual([
      { relPath: "one.ts", pinned: true },
      { relPath: "two.ts", pinned: true },
    ]);

    const before = store.getState().byProject;
    store.getState().pinTicketFile("project-a", "ticket-1", "two.ts");
    store.getState().markTicketFileEdited("project-a", "ticket-1", "two.ts");
    expect(store.getState().byProject).toBe(before);
  });

  it("openTicketDiff stays always-persistent and does not use the File preview slot", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewTicketFile("project-a", "ticket-1", "glance.ts");
    store.getState().openTicketDiff("project-a", "ticket-1", "changed.ts");
    store.getState().previewTicketFile("project-a", "ticket-1", "other.ts");

    const tabs = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"];
    expect(tabs?.files).toEqual([{ relPath: "other.ts", pinned: false }]);
    expect(tabs?.diffs).toEqual(["changed.ts"]);
    expect(tabs?.active).toBe("file:other.ts");
  });

  it("rehydrates legacy string[] files as pinned tabs and object files with preview", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-legacy": { files: ["old.md", "also.ts"], active: "file:old.md" },
                "ticket-new": {
                  files: [
                    { relPath: "pinned.ts", pinned: true },
                    { relPath: "preview.ts", pinned: false },
                    { relPath: 7, pinned: true },
                    { relPath: "bad.ts", pinned: "yes" },
                  ],
                  active: "file:preview.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-legacy"]?.files).toEqual([
      { relPath: "old.md", pinned: true },
      { relPath: "also.ts", pinned: true },
    ]);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-new"]?.files).toEqual([
      { relPath: "pinned.ts", pinned: true },
      { relPath: "preview.ts", pinned: false },
    ]);
  });
});

describe("ticket file tab persistence", () => {
  it('rehydrates a legacy active:"doc" value as the Ticket Body tab', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                // Real users still have this literal on disk from pre-rename builds.
                "ticket-1": { files: ["notes.md"], active: "doc" },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const tabs = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"];
    expect(tabs).toEqual({
      files: [{ relPath: "notes.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: TICKET_BODY_TAB_ID,
    });
    expect(isTicketBodyTabId(tabs!.active)).toBe(true);
  });

  it("persists ticketTabs and rehydrates them", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicketFile("project-a", "ticket-1", "docs/plan.md");
    store.getState().setTicketActiveTab("project-a", "ticket-1", "session-9");

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "docs/plan.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "session-9",
    });
  });

  it("persists a record that carries only open files (default board view)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    const parsed = JSON.parse(storage.getItem("volli:workspace")!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(Object.keys(parsed.state.byProject)).toEqual(["project-a"]);
    expect(parsed.state.byProject["project-a"]).toHaveProperty("ticketTabs");
  });

  it("sanitizes non-string files and prunes empty ticket records on rehydrate", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": { files: ["ok.md", 42, null], active: "file:ok.md" },
                "ticket-2": { files: [], active: "doc" }, // nothing worth keeping
                "ticket-3": { files: "bad", active: 7 }, // wrong types
                "ticket-4": null, // corrupt write: record is not an object at all
                "ticket-5": "junk",
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const tabs = store.getState().byProject["project-a"]?.ticketTabs;
    expect(tabs?.["ticket-1"]).toEqual({
      files: [{ relPath: "ok.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "file:ok.md",
    });
    expect(tabs?.["ticket-2"]).toBeUndefined();
    expect(tabs?.["ticket-3"]).toBeUndefined();
    expect(tabs?.["ticket-4"]).toBeUndefined();
    expect(tabs?.["ticket-5"]).toBeUndefined();
  });

  it("rehydrates a pre-#109 {files, active} shape with diffs: [] and empty diffMeta", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              // Pre-#109 writes had no diffs / diffMeta fields at all.
              ticketTabs: {
                "ticket-1": { files: ["notes.md"], active: "file:notes.md" },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [{ relPath: "notes.md", pinned: true }],
      diffs: [],
      diffMeta: {},
      active: "file:notes.md",
    });
  });

  it("drops non-string and empty-string diff paths on rehydrate", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["ok.ts", 99, "", null, "also.ts"],
                  active: "diff:ok.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffs).toEqual([
      "ok.ts",
      "also.ts",
    ]);
  });

  it("prunes orphan and corrupt diffMeta entries on rehydrate", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["ok.ts", "bare.ts"],
                  diffMeta: {
                    "ok.ts": { previousPath: "was.ts", status: "renamed" },
                    "bare.ts": "not-an-object", // open path, corrupt value — drop
                    "gone.ts": { status: "deleted" }, // closed path — drop
                    "also-closed.ts": null,
                  },
                  active: "diff:ok.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta).toEqual({
      "ok.ts": { previousPath: "was.ts", status: "renamed" },
    });
  });

  it("keeps a persisted __proto__ diffMeta path as an own property, not a prototype", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["__proto__"],
                  diffMeta: {
                    ["__proto__"]: { status: "modified" },
                  },
                  active: "diff:__proto__",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const diffMeta = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta;
    expect(Object.keys(diffMeta ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(diffMeta)).toBeNull();
    expect(diffMeta?.["__proto__"]).toEqual({ status: "modified" });
    // Corruption check: Object.prototype must not gain a `status` from the map.
    expect(Object.prototype).not.toHaveProperty("status");
  });

  it("rehydrates a boolean binary flag on diffMeta and drops non-booleans", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["logo.png", "notes.md", "binary-only.bin", "empty.ts"],
                  diffMeta: {
                    "logo.png": { status: "added", binary: true },
                    "notes.md": { status: "modified", binary: "yes" },
                    "binary-only.bin": { binary: true },
                    "empty.ts": {},
                  },
                  active: "diff:logo.png",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffMeta).toEqual({
      "logo.png": { status: "added", binary: true },
      "notes.md": { status: "modified" },
      "binary-only.bin": { binary: true },
    });
  });

  it("falls active diff:missing.ts back to Doc when the path is not open", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: ["keep.md"],
                  diffs: ["ok.ts"],
                  diffMeta: {},
                  active: "diff:missing.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.active).toBe("doc");
  });

  it("falls active file:missing.ts back to Doc when the path is not open", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: ["keep.md"],
                  diffs: ["ok.ts"],
                  diffMeta: {},
                  active: "file:missing.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.active).toBe("doc");
  });

  it("preserves diffs ordering through sanitize on rehydrate", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["z.ts", "a.ts", "m.ts"],
                  active: "diff:a.ts",
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.diffs).toEqual([
      "z.ts",
      "a.ts",
      "m.ts",
    ]);
  });

  it("defaults ticketTabs to an empty map for a record without one", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { boardView: "list" } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs).toEqual({});
  });
});

describe("ticket diff view-state persistence", () => {
  it("setTicketDiffViewState keeps opaque Monaco state keyed by ticketId + relPath", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "src/a.ts");
    store.getState().openTicketDiff("project-a", "ticket-1", "src/b.ts");
    store.getState().openTicketDiff("project-a", "ticket-2", "src/a.ts");
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      scrollTop: 12,
    });
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/b.ts", {
      scrollTop: 40,
    });
    store.getState().setTicketDiffViewState("project-a", "ticket-2", "src/a.ts", {
      scrollTop: 7,
    });
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      scrollTop: 99,
    });

    expect(store.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({
      "ticket-1": { "src/a.ts": { scrollTop: 99 }, "src/b.ts": { scrollTop: 40 } },
      "ticket-2": { "src/a.ts": { scrollTop: 7 } },
    });
  });

  it("closeTicketDiff drops the path's view state with the tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "src/a.ts");
    store.getState().openTicketDiff("project-a", "ticket-1", "src/b.ts");
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      scrollTop: 12,
    });
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/b.ts", {
      scrollTop: 40,
    });

    store.getState().closeTicketDiff("project-a", "ticket-1", "src/a.ts");

    expect(store.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({
      "ticket-1": { "src/b.ts": { scrollTop: 40 } },
    });
  });

  it("setTicketDiffViewState ignores a path with no open diff tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketDiff("project-a", "ticket-1", "src/a.ts");
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      scrollTop: 12,
    });
    store.getState().closeTicketDiff("project-a", "ticket-1", "src/a.ts");

    const before = store.getState().byProject["project-a"];
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      scrollTop: 12,
    });
    expect(store.getState().byProject["project-a"]).toBe(before);
    expect(store.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({});

    store.getState().setTicketDiffViewState("project-a", "ticket-1", "never.ts", {
      scrollTop: 1,
    });
    expect(store.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({});
  });

  it("round-trips ticket diff view state through persistence without storing contents", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicketDiff("project-a", "ticket-1", "src/a.ts");
    store.getState().setTicketDiffViewState("project-a", "ticket-1", "src/a.ts", {
      cursorState: [{ position: { lineNumber: 4, column: 1 } }],
      viewState: { scrollTop: 80 },
    });

    const raw = storage.getItem("volli:workspace")!;
    for (const contentKey of ["content", "contents", "text", "body", "source"]) {
      expect(raw).not.toContain(`"${contentKey}"`);
    }

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({
      "ticket-1": {
        "src/a.ts": {
          cursorState: [{ position: { lineNumber: 4, column: 1 } }],
          viewState: { scrollTop: 80 },
        },
      },
    });
  });

  it("sanitizes ticketDiffViewStates: junk entries and closed-diff orphans are dropped", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": {
                  files: [],
                  diffs: ["src/open.ts", "src/junk.ts", "src/null.ts", "src/array.ts"],
                  active: "diff:src/open.ts",
                },
                "ticket-2": {
                  files: [],
                  diffs: ["src/invalid.ts"],
                  active: "diff:src/invalid.ts",
                },
                "ticket-3": {
                  files: [],
                  diffs: ["src/unreadable.ts"],
                  active: "diff:src/unreadable.ts",
                },
              },
              ticketDiffViewStates: {
                "ticket-1": {
                  "src/open.ts": { scrollTop: 10 },
                  "src/closed.ts": { scrollTop: 90 },
                  "src/junk.ts": "not-a-view-state",
                  "src/null.ts": null,
                  "src/array.ts": [],
                },
                "ticket-gone": {
                  "src/x.ts": { scrollTop: 1 },
                },
                "ticket-2": {
                  "src/invalid.ts": "not-a-view-state",
                },
                "ticket-3": "not-a-ticket-map",
              },
            },
            "project-b": { ticketDiffViewStates: "junk" },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketDiffViewStates).toEqual({
      "ticket-1": { "src/open.ts": { scrollTop: 10 } },
    });
    expect(store.getState().byProject["project-b"]?.ticketDiffViewStates).toEqual({});
  });

  it("setTicketDiffViewState is a no-op when the project has no workspace record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().byProject;

    store
      .getState()
      .setTicketDiffViewState("missing-project", "ticket-1", "src/app.ts", { scrollTop: 1 });

    expect(store.getState().byProject).toBe(before);
  });
});

describe("Home file workspace", () => {
  it("previews a file as an active Home tab and records the tab it came from", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "chat:one");
    store.getState().setNav("project-a", "configure");

    store.getState().previewHomeFile("project-a", "src/app.ts");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "home",
      homeActiveTab: "file:src/app.ts",
      homeTabHistory: [HOME_BOARD_TAB_ID, "chat:one", "file:src/app.ts"],
      projectFiles: {
        tabs: [{ relPath: "src/app.ts", pinned: false }],
        activeRelPath: "src/app.ts",
      },
    });
  });

  it("pins and activates Home files without duplicating their tabs", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewHomeFile("project-a", "one.ts");
    store.getState().previewHomeFile("project-a", "two.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().previewHomeFile("project-a", "three.ts");

    store.getState().activateHomeFile("project-a", "two.ts");

    expect(store.getState().byProject["project-a"]?.projectFiles).toEqual({
      tabs: [
        { relPath: "two.ts", pinned: true },
        { relPath: "three.ts", pinned: false },
      ],
      activeRelPath: "two.ts",
    });
    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe("file:two.ts");
  });

  it("closes active files back through surviving MRU tabs", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setHomeActiveTab("project-a", "chat:one");
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });

    store.getState().closeHomeFile("project-a", "two.ts", ["chat:one"]);
    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe("file:one.ts");
    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({});

    store.getState().closeHomeFile("project-a", "one.ts", ["chat:one"]);
    expect(store.getState().byProject["project-a"]).toMatchObject({
      homeActiveTab: "chat:one",
      homeTabHistory: [HOME_BOARD_TAB_ID, "chat:one"],
      projectFiles: EMPTY_FILE_WORKSPACE,
    });
  });

  it("closes an inactive file without moving the Home tab in front", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().activateHomeFile("project-a", "one.ts");
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });

    store.getState().closeHomeFile("project-a", "two.ts", []);

    expect(store.getState().byProject["project-a"]).toMatchObject({
      homeActiveTab: "file:one.ts",
      homeTabHistory: [HOME_BOARD_TAB_ID, "file:one.ts"],
      projectFiles: {
        tabs: [{ relPath: "one.ts", pinned: true }],
        activeRelPath: "one.ts",
      },
      projectFileViewStates: {},
    });
  });

  it("ignores activation and close requests for files that are not open", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    const before = store.getState().byProject;

    store.getState().activateHomeFile("project-a", "missing.ts");
    store.getState().closeHomeFile("project-a", "missing.ts", []);
    store.getState().activateHomeFile("project-never-seen", "missing.ts");
    store.getState().closeHomeFile("project-never-seen", "missing.ts", []);

    expect(store.getState().byProject).toBe(before);
    expect(store.getState().byProject["project-never-seen"]).toBeUndefined();
  });

  it("restores the active Home File tab but not session-local visit history", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setHomeActiveTab("project-a", "chat:one");
    store.getState().previewHomeFile("project-a", "src/app.ts");

    const restored = createWorkspaceStore(storage).getState().byProject["project-a"];

    expect(restored).toMatchObject({
      homeActiveTab: "file:src/app.ts",
      homeTabHistory: [],
      projectFiles: {
        tabs: [{ relPath: "src/app.ts", pinned: false }],
        activeRelPath: "src/app.ts",
      },
    });
    const persisted = JSON.parse(storage.getItem("volli:workspace")!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(persisted.state.byProject["project-a"]).not.toHaveProperty("homeTabHistory");
  });

  it("falls back to Board when a restored file has no surviving visit history", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewHomeFile("project-a", "one.ts");
    store.getState().setHomeActiveTab("project-a", "file:one.ts");
    // Model the session-only history being absent after a relaunch.
    store.setState((state) => ({
      byProject: {
        ...state.byProject,
        "project-a": { ...state.byProject["project-a"]!, homeTabHistory: [] },
      },
    }));

    store.getState().closeHomeFile("project-a", "one.ts", []);

    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe(HOME_BOARD_TAB_ID);
  });
});

describe("Home file workspace (browse/pin/activate)", () => {
  it("previewHomeFile opens a preview tab for that project only", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewHomeFile("project-a", "src/app.ts");

    expect(store.getState().byProject["project-a"]?.projectFiles).toEqual({
      tabs: [{ relPath: "src/app.ts", pinned: false }],
      activeRelPath: "src/app.ts",
    });
    expect(store.getState().byProject["project-b"]?.projectFiles).toBeUndefined();
  });

  it("preview replaces the preview slot in place while a pinned tab is appended past", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().previewHomeFile("project-a", "two.ts");
    store.getState().previewHomeFile("project-a", "three.ts");

    expect(store.getState().byProject["project-a"]?.projectFiles).toEqual({
      tabs: [
        { relPath: "one.ts", pinned: true },
        { relPath: "three.ts", pinned: false },
      ],
      activeRelPath: "three.ts",
    });
  });

  it("markProjectFileEdited promotes the preview tab so the next preview appends", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().previewHomeFile("project-a", "one.ts");
    store.getState().markProjectFileEdited("project-a", "one.ts");
    store.getState().previewHomeFile("project-a", "two.ts");

    expect(store.getState().byProject["project-a"]?.projectFiles.tabs).toEqual([
      { relPath: "one.ts", pinned: true },
      { relPath: "two.ts", pinned: false },
    ]);
  });

  it("markProjectFileEdited is a no-op once the tab is already pinned (safe on every keystroke)", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    const before = store.getState().byProject["project-a"];

    store.getState().markProjectFileEdited("project-a", "one.ts");

    expect(store.getState().byProject["project-a"]).toBe(before);
  });

  it("markProjectFileEdited does nothing for a project with no workspace record and no open tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());

    store.getState().markProjectFileEdited("project-never-seen", "one.ts");

    // No open tab to attach a dirty flag to, so this must not conjure a
    // record into existence for a project nothing has touched yet.
    expect(store.getState().byProject["project-never-seen"]).toBeUndefined();
  });

  it("activateHomeFile focuses an open tab and ignores a path that is not open", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");

    store.getState().activateHomeFile("project-a", "one.ts");
    expect(store.getState().byProject["project-a"]?.projectFiles.activeRelPath).toBe("one.ts");

    store.getState().activateHomeFile("project-a", "never-opened.ts");
    expect(store.getState().byProject["project-a"]?.projectFiles.activeRelPath).toBe("one.ts");
  });

  it("setProjectFileViewState keeps one opaque view state per relPath, per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().pinHomeFile("project-b", "one.ts");
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 3 });
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });
    store.getState().setProjectFileViewState("project-b", "one.ts", { cursor: 1 });
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 4 });

    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({
      "one.ts": { cursor: 4 },
      "two.ts": { cursor: 9 },
    });
    expect(store.getState().byProject["project-b"]?.projectFileViewStates).toEqual({
      "one.ts": { cursor: 1 },
    });
  });

  it("closeHomeFile closes the tab and drops its persisted view state", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 3 });
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });

    store.getState().closeHomeFile("project-a", "one.ts", []);

    expect(store.getState().byProject["project-a"]?.projectFiles).toEqual({
      tabs: [{ relPath: "two.ts", pinned: true }],
      activeRelPath: "two.ts",
    });
    // View state must die with the tab, or the map grows without bound as the
    // user churns through files.
    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({
      "two.ts": { cursor: 9 },
    });
  });

  it("setProjectFileViewState ignores a path with no open tab, so a close cannot be undone", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 3 });
    store.getState().closeHomeFile("project-a", "one.ts", []);

    // The closing tab's editor unmounts AFTER the close and emits one last view
    // state for the path it was showing. Accepting it would re-insert the entry
    // the close just pruned, and it would then survive all session (only the
    // rehydrate sanitizer prunes orphans) — the unbounded growth closeHomeFile
    // exists to prevent.
    const before = store.getState().byProject["project-a"];
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 3 });
    expect(store.getState().byProject["project-a"]).toBe(before);
    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({});

    // A path that was never open is refused for the same reason.
    store.getState().setProjectFileViewState("project-a", "never-opened.ts", { cursor: 1 });
    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({});

    // And a project with no workspace record at all: there is no open tab to
    // attach to, so this must not conjure the record into existence.
    store.getState().setProjectFileViewState("unknown-project", "one.ts", { cursor: 1 });
    expect(store.getState().byProject["unknown-project"]).toBeUndefined();
  });

  it("closeHomeFile leaves the record untouched for a file that is not open", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().setProjectFileViewState("project-a", "one.ts", { cursor: 3 });
    const before = store.getState().byProject["project-a"];

    store.getState().closeHomeFile("project-a", "never-opened.ts", []);

    // Identity, not just equality: closing something that was never open must
    // not churn the record, or every stray close would notify subscribers and
    // rewrite persisted state for nothing.
    expect(store.getState().byProject["project-a"]).toBe(before);

    // Same for a project with no record at all — a close racing a project
    // removal must not conjure one back into the map.
    store.getState().closeHomeFile("project-never-seen", "one.ts", []);
    expect(store.getState().byProject["project-never-seen"]).toBeUndefined();
  });
});

describe("renaming a file the navigator just renamed (VC-191)", () => {
  it("moves the Home tab, its pin, its focus and its remembered cursor onto the new path", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });

    store.getState().renameHomeFile("project-a", "two.ts", "renamed.ts");

    const record = store.getState().byProject["project-a"];
    expect(record?.projectFiles).toEqual({
      tabs: [
        { relPath: "one.ts", pinned: true },
        { relPath: "renamed.ts", pinned: true },
      ],
      activeRelPath: "renamed.ts",
    });
    expect(record?.projectFileViewStates).toEqual({ "renamed.ts": { cursor: 9 } });
    expect(record?.homeActiveTab).toBe("file:renamed.ts");
  });

  it("keeps the renamed tab's place in the close-return history", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");

    store.getState().renameHomeFile("project-a", "one.ts", "renamed.ts");
    store.getState().closeHomeFile("project-a", "two.ts", []);

    // Closing the tab in front returns to the renamed one, not to the board:
    // the tab never went anywhere, only its name changed.
    expect(store.getState().byProject["project-a"]?.homeActiveTab).toBe("file:renamed.ts");
  });

  it("drops a stale view state left under the destination path", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    store.getState().pinHomeFile("project-a", "two.ts");
    store.getState().setProjectFileViewState("project-a", "two.ts", { cursor: 9 });

    // `one.ts` has no remembered cursor; renaming it onto `two.ts`'s path must
    // not inherit `two.ts`'s, which belonged to different bytes.
    store.getState().renameHomeFile("project-a", "one.ts", "two.ts");

    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({});
    expect(store.getState().byProject["project-a"]?.projectFiles.tabs).toEqual([
      { relPath: "two.ts", pinned: true },
    ]);
  });

  it("leaves everything alone for a Home file that is not open", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().pinHomeFile("project-a", "one.ts");
    const before = store.getState().byProject["project-a"];

    store.getState().renameHomeFile("project-a", "never-opened.ts", "renamed.ts");

    expect(store.getState().byProject["project-a"]).toBe(before);
    store.getState().renameHomeFile("project-never-seen", "a.ts", "b.ts");
    expect(store.getState().byProject["project-never-seen"]).toBeUndefined();
  });

  it("moves a ticket File tab and follows it with the ticket's active tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "src/one.ts");
    store.getState().previewTicketFile("project-a", "ticket-1", "src/two.ts");

    store.getState().renameTicketFile("project-a", "ticket-1", "src/two.ts", "src/renamed.ts");

    const tabs = store.getState().byProject["project-a"]?.ticketTabs["ticket-1"];
    expect(tabs?.files).toEqual([
      { relPath: "src/one.ts", pinned: true },
      { relPath: "src/renamed.ts", pinned: false },
    ]);
    expect(tabs?.active).toBe("file:src/renamed.ts");
  });

  it("leaves a ticket alone when the file is not open, or the ticket has no tabs at all", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "src/one.ts");
    const before = store.getState().byProject["project-a"];

    store.getState().renameTicketFile("project-a", "ticket-1", "src/other.ts", "src/renamed.ts");
    expect(store.getState().byProject["project-a"]).toBe(before);

    store.getState().renameTicketFile("project-a", "ticket-none", "a.ts", "b.ts");
    expect(store.getState().byProject["project-a"]).toBe(before);

    // And a project with no record at all: a rename racing a project removal
    // must not conjure one back into the map.
    store.getState().renameTicketFile("project-never-seen", "ticket-1", "a.ts", "b.ts");
    expect(store.getState().byProject["project-never-seen"]).toBeUndefined();
  });
});

describe("Home file workspace persistence", () => {
  it("rehydrates tabs, order, pinned flags, and the active tab across a relaunch", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().pinHomeFile("project-a", "src/one.ts");
    store.getState().previewHomeFile("project-a", "src/two.ts");
    store.getState().activateHomeFile("project-a", "src/one.ts");

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.projectFiles).toEqual({
      tabs: [
        { relPath: "src/one.ts", pinned: true },
        { relPath: "src/two.ts", pinned: false },
      ],
      activeRelPath: "src/one.ts",
    });
  });

  it("round-trips a tab's Monaco view state through persistence", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().pinHomeFile("project-a", "src/one.ts");
    store.getState().setProjectFileViewState("project-a", "src/one.ts", {
      cursorState: [{ position: { lineNumber: 12, column: 3 } }],
      viewState: { scrollTop: 240 },
    });

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.projectFileViewStates).toEqual({
      "src/one.ts": {
        cursorState: [{ position: { lineNumber: 12, column: 3 } }],
        viewState: { scrollTop: 240 },
      },
    });
  });

  it("persists tab identities and view state only — never file contents", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().pinHomeFile("project-a", "src/one.ts");
    store.getState().previewHomeFile("project-a", "src/two.ts");
    store.getState().setProjectFileViewState("project-a", "src/one.ts", { scrollTop: 40 });

    const raw = storage.getItem("volli:workspace")!;
    const parsed = JSON.parse(raw) as {
      state: {
        byProject: Record<
          string,
          { projectFiles: { tabs: Record<string, unknown>[]; activeRelPath: string } }
        >;
      };
    };
    // A tab record carries identity + the preview flag and nothing else; the
    // document text reloads lazily from the checkout on return (decision #55).
    for (const tab of parsed.state.byProject["project-a"]!.projectFiles.tabs) {
      expect(Object.keys(tab).toSorted()).toEqual(["pinned", "relPath"]);
    }
    for (const contentKey of ["content", "contents", "text", "body", "source"]) {
      expect(raw).not.toContain(`"${contentKey}"`);
    }
  });

  it("drops the project's record again once its last file tab is closed", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().previewHomeFile("project-a", "src/one.ts");
    store.getState().setProjectFileViewState("project-a", "src/one.ts", { scrollTop: 40 });
    store.getState().closeHomeFile("project-a", "src/one.ts", []);

    const parsed = JSON.parse(storage.getItem("volli:workspace")!) as {
      state: { byProject: Record<string, unknown> };
    };
    // Back to all-default values → the persisted map must not keep a record
    // for a merely-visited project.
    expect(parsed.state.byProject).toEqual({});
  });

  it("falls back to an empty workspace for malformed persisted projectFiles without throwing", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { projectFiles: null },
            "project-b": { projectFiles: "junk" },
            "project-c": { projectFiles: { tabs: "nope", activeRelPath: 7 } },
            "project-d": { projectFiles: { tabs: [{ relPath: 42 }, null, { pinned: true }] } },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    for (const projectId of ["project-a", "project-b", "project-c", "project-d"]) {
      expect(store.getState().byProject[projectId]?.projectFiles).toEqual(EMPTY_FILE_WORKSPACE);
    }
  });

  it("sanitizes the persisted view-state map: non-object raw, junk entries, and orphans are dropped", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              projectFiles: {
                tabs: [
                  { relPath: "src/one.ts", pinned: true },
                  { relPath: "src/two.ts", pinned: false },
                ],
                activeRelPath: "src/one.ts",
              },
              projectFileViewStates: {
                "src/one.ts": { scrollTop: 40 },
                "src/two.ts": "not-a-view-state",
                "src/three.ts": { scrollTop: 90 }, // no surviving tab
                "src/four.ts": [1, 2, 3],
                "src/five.ts": null,
              },
            },
            "project-b": { projectFileViewStates: "junk" },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.projectFileViewStates).toEqual({
      "src/one.ts": { scrollTop: 40 },
    });
    expect(store.getState().byProject["project-b"]?.projectFileViewStates).toEqual({});
  });

  it("keeps a persisted __proto__ key an own property instead of a prototype", () => {
    const storage = createMemoryStorage();
    // Computed keys (like JSON.parse) create OWN `__proto__` properties, so the
    // key reaches the sanitizers' `Object.entries` loops and is assigned like
    // any other. Onto an object literal that assignment hits Object.prototype's
    // `__proto__` setter instead: the entry silently vanishes and the map's own
    // prototype becomes whatever the persisted JSON said.
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            ["__proto__"]: { boardView: "list" },
            "project-a": {
              projectFiles: { tabs: [{ relPath: "__proto__", pinned: true }] },
              projectFileViewStates: { ["__proto__"]: { scrollTop: 40 } },
              ticketTabs: { ["__proto__"]: { files: ["a.ts"], active: "doc" } },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const { byProject } = store.getState();
    expect(Object.keys(byProject)).toContain("__proto__");
    expect(Object.getPrototypeOf(byProject)).toBeNull();

    const ui = byProject["project-a"];
    expect(Object.keys(ui?.projectFileViewStates ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(ui?.projectFileViewStates)).toBeNull();
    expect(Object.keys(ui?.ticketTabs ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(ui?.ticketTabs)).toBeNull();
  });
});

describe("forget", () => {
  it("drops the project's record so a re-add starts at the defaults", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");
    store.getState().setSessionGroupExpanded("project-a", "ticket-1", true);
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().previewHomeFile("project-a", "src/app.ts");
    store.getState().setProjectFileViewState("project-a", "src/app.ts", { cursor: 3 });
    store.getState().dismissDependencyOffer("project-a");
    store.getState().forget("project-a");

    expect(store.getState().byProject["project-a"]).toBeUndefined();
    expect(store.getState().byProject["project-a"] ?? DEFAULT_WORKSPACE_UI).toEqual({
      nav: "home",
      expandedSessionGroups: [],
      boardView: "board",
      boardSort: DEFAULT_TICKET_SORT,
      openTicketId: null,
      ticketTabs: {},
      ticketDiffViewStates: {},
      projectFiles: EMPTY_FILE_WORKSPACE,
      projectFileViewStates: {},
      homeActiveTab: HOME_BOARD_TAB_ID,
      homeTabHistory: [],
      dependencyOfferDismissed: false,
    });
  });

  it("leaves other projects untouched and is a no-op for unknown ids", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "configure");

    const before = store.getState().byProject;
    store.getState().forget("never-added");
    expect(store.getState().byProject).toBe(before);

    store.getState().forget("project-b");
    expect(store.getState().byProject["project-a"]?.nav).toBe("configure");
  });
});

describe("persistence", () => {
  it("persists only non-default boardView/boardSort/openTicketId records under 'volli:workspace'", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().setNav("project-b", "configure"); // session-only change → record stays default-valued

    const raw = storage.getItem("volli:workspace");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(Object.keys(parsed.state.byProject)).toEqual(["project-a"]);
    expect(Object.keys(parsed.state.byProject["project-a"]!).toSorted()).toEqual([
      "boardSort",
      "boardView",
      "dependencyOfferDismissed",
      "homeActiveTab",
      "openTicketId",
      "projectFileViewStates",
      "projectFiles",
      "ticketDiffViewStates",
      "ticketTabs",
    ]);
  });

  it("rehydrates view + sort + open ticket while nav resets to the default", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().setNav("project-a", "configure");
    useBoardStore.setState({ selectedByProject: {} }); // openTicket's board-store side effect, reset afterward
    store.getState().openTicket("project-a", "ticket-1");
    useBoardStore.setState({ selectedByProject: {} });

    const rehydrated = createWorkspaceStore(storage);
    const ui = rehydrated.getState().byProject["project-a"];
    expect(ui?.boardView).toBe("list");
    expect(ui?.boardSort).toEqual({ key: "priority", direction: "desc" });
    expect(ui?.openTicketId).toBe("ticket-1");
    expect(ui?.nav).toBe("home");
  });

  it("restores the open ticket across a restart (openTicket → reload)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicket("project-a", "ticket-1");
    useBoardStore.setState({ selectedByProject: {} });

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
  });

  it("sanitizes stale persisted values back to the defaults", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardView: "spreadsheet", boardSort: { key: "gone", direction: "up" } },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const ui = store.getState().byProject["project-a"];
    expect(ui?.boardView).toBe("board");
    expect(ui?.boardSort).toEqual(DEFAULT_TICKET_SORT);
  });

  it("sanitizes a wrong-type persisted openTicketId back to null", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { openTicketId: 42 } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
  });

  it("a forgotten project's persisted prefs do not survive the next write", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().forget("project-a");

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]).toBeUndefined();
  });
});

describe("rehydration sanitization (corrupt JSON)", () => {
  it("survives a persisted null boardSort and a null record without crashing", () => {
    // `null !== undefined` used to pass the guard and throw on `.key` during
    // store creation — a corrupt write bricked the renderer on every launch.
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardView: "list", boardSort: null },
            "project-b": null,
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual(DEFAULT_TICKET_SORT);
    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
    expect(store.getState().byProject["project-b"]).toEqual(DEFAULT_WORKSPACE_UI);
  });

  it("falls back to the default sort when only the direction is invalid", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { boardSort: { key: "priority", direction: "up" } } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual(DEFAULT_TICKET_SORT);
  });

  it("strips stray keys from a persisted sort instead of spreading them into state", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardSort: { key: "title", direction: "asc", stray: true } },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual({
      key: "title",
      direction: "asc",
    });
  });
});

const snap = (
  projectId: string | null,
  nav: NavKey = "home",
  openTicketId: string | null = null,
) => ({
  projectId,
  nav,
  openTicketId,
});

describe("navHistory", () => {
  it("starts empty", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    expect(store.getState().navHistory).toEqual({ back: [], current: null, forward: [] });
  });

  it("records organic navigations and steps back/forward over them", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().recordNav(snap("a"));
    store.getState().recordNav(snap("a", "configure"));
    store.getState().recordNav(snap("b"));

    expect(store.getState().stepNavBack()).toEqual(snap("a", "configure"));
    expect(store.getState().stepNavBack()).toEqual(snap("a"));
    expect(store.getState().stepNavBack()).toBeNull();
    expect(store.getState().stepNavForward()).toEqual(snap("a", "configure"));
  });

  it("stepNavForward returns null and leaves history unchanged when the forward stack is empty", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().navHistory;

    expect(store.getState().stepNavForward()).toBeNull();
    expect(store.getState().navHistory).toBe(before);
  });

  it("dedupes a consecutive identical snapshot without notifying", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().recordNav(snap("a"));
    const before = store.getState().navHistory;
    store.getState().recordNav(snap("a"));
    expect(store.getState().navHistory).toBe(before);
  });

  it("is never persisted (in-memory only)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().recordNav(snap("a"));
    store.getState().recordNav(snap("b"));

    const parsed = JSON.parse(storage.getItem("volli:workspace") ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(parsed.state?.navHistory).toBeUndefined();

    // And a fresh (rehydrated) store starts with empty history.
    expect(createWorkspaceStore(storage).getState().navHistory).toEqual({
      back: [],
      current: null,
      forward: [],
    });
  });
});
