// @vitest-environment jsdom
/**
 * The rail roster on the PUSH path (VC-373).
 *
 * The panel used to re-read `listForTicket` whenever the set of open panes
 * changed — a create, a split, a close — because those transitions are what
 * changes the durable roster. They are also exactly what main announces on
 * `volli:session-activity`, so the roster is fed here instead: the baseline is
 * read once, and each transition below is applied through the store the way
 * `subscribeTicketSessionActivity` applies a real notice. What this file owns
 * is that the panel RENDERS the pushed change — the acceptance's "within a
 * frame or two" — for every transition the roster has to reflect.
 *
 * The harness-announce transition is not here: it is not a durable Session
 * fact, so it does not ride this channel. `subscribeSessionHarness` patches
 * the same cached record (`stores/sessions.test.ts`, "mirrors the announce
 * onto the ticket's cached durable record") and that store test is where it is
 * proved.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import { TicketSessionsPanel } from "./ticket-sessions-panel";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

let root: Root | null = null;
let container: HTMLElement | null = null;

const SCOPE = { kind: "ticket", projectId: "p1", ticketId: "t1" } as const;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "root",
    projectId: "p1",
    ticketId: "t1",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "shell",
    placement: "tab",
    title: "Root shell",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 1,
    bornTicketless: false,
    ...overrides,
  };
}

function terminalRow(overrides: Partial<SessionRecord> = {}): SessionListingRow {
  return {
    kind: "terminal",
    record: record(overrides),
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

function chatRow(overrides: Partial<ChatSessionRecord> = {}): SessionListingRow {
  return {
    kind: "chat",
    record: {
      sessionId: "chat-1",
      title: "Plan the migration",
      projectId: "p1",
      ticketId: "t1",
      createdAt: 1,
      adapterId: "pi",
      live: true,
      activity: "idle",
      waitingOn: null,
      outcome: null,
      lastActivityAt: 1,
      bornTicketless: false,
      role: "ticket",
      parentSessionId: null,
      ...overrides,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

/** Apply one pushed row inside act, the way the subscription does off the IPC event. */
async function push(ticketId: string | null, row: SessionListingRow): Promise<void> {
  await act(async () => {
    useTicketSessionRecordsStore.getState().applyActivity({ projectId: "p1", ticketId, row });
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

/** The panel's first section — the live "Sessions" list, before History. */
function currentSectionText(): string {
  return container?.querySelector("section")?.textContent ?? "";
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listForTicket = vi.fn(async () => ({
    ok: true as const,
    sessions: [terminalRow()],
  }));
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { sessions: { listForTicket } },
  });
  useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
  useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {} });
  // The rail is looking at a ticket with one live root shell, as a fresh open
  // would leave it: baseline read, live tab mounted.
  await act(async () => {
    useTicketSessionRecordsStore.getState().ensure("t1");
  });
  useSessionsStore.getState().addSession(SCOPE, "root", {
    title: "Root shell",
    harnessId: "claude-code",
    launchKind: "shell",
    createdAt: 1,
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TicketSessionsPanel
        projectId="p1"
        ticketId="t1"
        creating={false}
        onNewSession={() => {}}
        onNewChat={() => {}}
        onActivateSession={() => {}}
        onActivateChat={() => {}}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
  vi.unstubAllGlobals();
});

describe("the rail roster on the push path", () => {
  it("paints the baseline from the shared cache", () => {
    expect(text()).toContain("Root shell");
  });

  it("holds the rows' box while the baseline read is in flight, never claiming the roster is empty", async () => {
    // VC-383: a ticket opened for the first time this run paints before its
    // listing lands. That window used to say "No active sessions" about a
    // ticket whose agent may be mid-turn.
    await act(async () => {
      root?.unmount();
    });
    let answer: (() => void) | null = null;
    const listForTicket = vi.fn(
      () =>
        new Promise<{ ok: true; sessions: SessionListingRow[] }>((resolve) => {
          answer = () => resolve({ ok: true, sessions: [terminalRow()] });
        }),
    );
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { sessions: { listForTicket } },
    });
    useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
    root = createRoot(container!);
    await act(async () => {
      root?.render(
        <TicketSessionsPanel
          projectId="p1"
          ticketId="t1"
          creating={false}
          onNewSession={() => {}}
          onNewChat={() => {}}
          onActivateSession={() => {}}
          onActivateChat={() => {}}
        />,
      );
    });

    const loading = () => container?.querySelector('[data-testid="ticket-sessions-loading"]');
    expect(loading()).not.toBeNull();
    expect(currentSectionText()).not.toContain("No active sessions");
    // The heading's own control stays live: a pending list blocks nothing
    // about starting a Session.
    expect(container?.querySelector("section button")).not.toBeNull();

    await act(async () => {
      answer?.();
    });
    expect(loading()).toBeNull();
    expect(text()).toContain("Root shell");
  });

  it("says what is missing, once, only after the listing has answered with nothing", async () => {
    // An empty roster is one sentence in a dashed frame: the heading's own
    // control sits 20px above it, so a second copy inside the frame would be
    // the same offer twice in one glance. "Empty" is a listing that has
    // ANSWERED with no rows — an unread one holds its box instead.
    await act(async () => {
      useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {} });
      useTicketSessionRecordsStore.setState({
        byTicket: { t1: [] },
        listingState: { t1: "loaded" },
        listingError: { t1: null },
      });
    });

    expect(container?.querySelector('[data-testid="ticket-sessions-loading"]')).toBeNull();
    expect(currentSectionText()).toContain("No active sessions");
    expect(container?.querySelectorAll('[aria-label="New chat"]').length).toBe(1);
  });

  it("stands the skeleton down after a failed baseline without calling the roster empty", async () => {
    await act(async () => {
      root?.unmount();
    });
    useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {} });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        sessions: {
          listForTicket: vi.fn(async () => ({ ok: false as const, error: "db locked" })),
        },
      },
    });
    useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
    root = createRoot(container!);
    await act(async () => {
      root?.render(
        <TicketSessionsPanel
          projectId="p1"
          ticketId="t1"
          creating={false}
          onNewSession={() => {}}
          onNewChat={() => {}}
          onActivateSession={() => {}}
          onActivateChat={() => {}}
        />,
      );
    });

    expect(container?.querySelector('[data-testid="ticket-sessions-loading"]')).toBeNull();
    expect(currentSectionText()).not.toContain("No active sessions");
    expect(currentSectionText()).toContain("Couldn't load sessions.");
  });

  it("shows a Sessions row a create's push announces", async () => {
    await act(async () => {
      useSessionsStore.getState().addSession(SCOPE, "created", {
        title: "Created shell",
        harnessId: "claude-code",
        launchKind: "shell",
        createdAt: 2,
      });
    });

    await push("t1", terminalRow({ id: "created", title: "Created shell", createdAt: 2 }));

    expect(currentSectionText()).toContain("Created shell");
    // The baseline was read once; the transition itself spent no `listForTicket`.
    expect(window.api.sessions.listForTicket).toHaveBeenCalledTimes(1);
  });

  it("shows a split pane's row a terminal split announces", async () => {
    await act(async () => {
      useSessionsStore.getState().addSplit("t1", "root", "root", "leaf", "vertical");
    });

    await push(
      "t1",
      terminalRow({ id: "leaf", title: "Split shell", placement: "split", createdAt: 2 }),
    );

    expect(currentSectionText()).toContain("Split shell");
    expect(window.api.sessions.listForTicket).toHaveBeenCalledTimes(1);
  });

  it("moves a pane the exit push marks ended into History", async () => {
    // The exit has two halves and both arrive on their own channel: this is
    // the live one (`volli:terminal-exit` → `markExited`) ...
    await act(async () => {
      useSessionsStore.getState().markExited("root", 0);
    });
    // ... and the durable `endedAt`/`exitCode` row the activity push carries.
    await push("t1", terminalRow({ endedAt: 40, exitCode: 0 }));

    const history = document.querySelector('[data-testid="session-history"]');
    expect(history?.textContent).toContain("Root shell");
    // Out of Sessions and into History: the row's own section is the visible
    // half of the transition.
    expect(currentSectionText()).not.toContain("Root shell");
  });

  it("retitles the row a rename's push carries", async () => {
    // A non-root pane's title is read from its durable record (a root pane
    // prefers the live tab title, which the rename door moves optimistically);
    // this is the row the pushed rename has to reach.
    await act(async () => {
      useSessionsStore.getState().addSplit("t1", "root", "root", "leaf", "vertical");
    });
    await push("t1", terminalRow({ id: "leaf", placement: "split", title: "First name" }));

    await push("t1", terminalRow({ id: "leaf", placement: "split", title: "Renamed shell" }));

    expect(text()).toContain("Renamed shell");
    expect(text()).not.toContain("First name");
  });

  it("shows a chat Session opened by a CLI-started door, with no local create", async () => {
    // No store action here at all: this is a Session another process started,
    // and the push is the only thing that can tell this renderer about it.
    await push("t1", chatRow({ sessionId: "chat-cli", title: "CLI started the review" }));

    expect(currentSectionText()).toContain("CLI started the review");
    expect(window.api.sessions.listForTicket).toHaveBeenCalledTimes(1);
  });

  it("ignores a push for another ticket, and one for no ticket", async () => {
    await push("t2", terminalRow({ id: "elsewhere", title: "Other ticket's shell" }));
    await push(null, terminalRow({ id: "board", title: "Board shell" }));

    expect(text()).not.toContain("Other ticket's shell");
    expect(text()).not.toContain("Board shell");
  });
});
