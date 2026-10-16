// @vitest-environment jsdom
/**
 * VC-374 — what the Previous band's `statusEntries` read answers to.
 *
 * That read is a project-wide windowed scan over `status_changed` events run
 * on the main thread. It used to be keyed on `liveSignature` — the join of
 * every open terminal pane and chat tab in the project — so every pane open,
 * split, chat tab open or close re-ran it for a column history nothing had
 * moved. These cases pin the replacement trigger at the real seam: the stores
 * the sidebar subscribes to, not a stub of the component's inputs.
 *
 * A pane or a tab opening writes no `status_changed` event, so it must issue no
 * read; a column move is exactly what writes one, so it must issue exactly one.
 * A same-column reorder sits between the two: it permutes the board array but
 * changes no ticket's column, so it must issue no read either.
 *
 * The mount read is the baseline every case counts from.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type Project,
  type SessionListingRow,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { ActiveSessions } from "./active-sessions";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useRemoteSessionAvailabilityStore } from "@renderer/stores/remote-session-availability";
import { projectScope, useSessionsStore, type SessionLaunch } from "@renderer/stores/sessions";
import { useSessionOrderStore } from "@renderer/stores/session-order";
import { useWorkspaceStore } from "@renderer/stores/workspace";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

const PROJECT: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function ticket(id: string, status: TicketStatus, order: number): Ticket {
  return {
    id,
    projectId: PROJECT.id,
    ticketNumber: Number(id.slice(1)),
    title: `Ticket ${id}`,
    body: "",
    status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Two tickets in Todo, one in Doing — enough to reorder and to move across. */
const seedTickets = (): Ticket[] => [
  ticket("t1", "todo", 0),
  ticket("t2", "todo", 1),
  ticket("t3", "doing", 0),
];

/** A bare shell launch: no harness command line, so no expectation. */
const LAUNCH: SessionLaunch = {
  title: "Shell",
  harnessId: "claude-code",
  launchKind: "shell",
  createdAt: 0,
};

const statusEntries = vi.fn(async () => ({ ok: true as const, entries: [] }));
/**
 * The project listing door. Its return type is taken FROM the bridge rather
 * than written out here, because this mock has to answer the refusal arm too
 * (VC-383): a listing that fails must not read as a listing that is empty, and
 * a hand-mirrored success-only shape would not let a test say so.
 */
const listSessions = vi.fn(
  async (): Promise<Awaited<ReturnType<typeof window.api.sessions.list>>> => ({
    ok: true as const,
    sessions: [],
  }),
);
const latestSignals = vi.fn(async () => ({ ok: true as const, signals: [] }));
const setRead = vi.fn(async () => ({ ok: true as const }));
const peekContent = vi.fn(async () => ({
  ok: true as const,
  content: {
    sessionId: "c1",
    entries: [{ at: 1, role: "assistant" as const, text: "Ran the suite", tools: [] }],
    question: null,
    turns: 1,
    turnDepth: 0,
    unreadable: 0,
    lastActivityAt: 1,
  },
}));
/**
 * The board's move door. Answers with the slice as the store holds it AFTER the
 * optimistic move, which is what main would confirm — so the reconcile cannot
 * introduce a second signature change of its own.
 */
const move = vi.fn(async () => ({
  ok: true as const,
  tickets: [...(useBoardStore.getState().ticketsByProject[PROJECT.id] ?? [])],
}));

function installApi(): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      sessions: { list: listSessions, setRead, peekContent },
      tickets: { statusEntries, latestSignals, move },
      // Opening a chat row adopts its Session, and adoption builds the resident
      // client over this bridge. Absent, the activation throws before the row
      // is ever read — which is the one thing these cases are about.
      sessionRpc: {
        onEvent: () => () => {},
        request: vi.fn(async () => ({ ok: true })),
        subscribe: vi.fn(() => () => {}),
      },
    },
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SidebarProvider>
        <ActiveSessions project={PROJECT} visible />
      </SidebarProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  installApi();
  useBoardStore.getState().hydrate({ [PROJECT.id]: seedTickets() }, { [PROJECT.id]: [] });
  useSessionsStore.setState({
    byOwner: {},
    sessionOwner: {},
    lastOutputAt: {},
    parkState: {},
    harness: {},
    starting: {},
  });
  useChatSessionsStore.setState({
    sessions: {},
    openTabs: {},
    rehomedTicketBySession: {},
    starting: {},
  });
  useProjectSessionsStore.setState({ byProject: {}, listingState: {} });
  useSessionOrderStore.setState({ held: {}, holds: 0 });
  useWorkspaceStore.setState({ byProject: {} });
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("ActiveSessions ticket history (VC-374)", () => {
  it("reads the column history once when the band mounts", async () => {
    await mount();

    expect(statusEntries).toHaveBeenCalledTimes(1);
    expect(statusEntries).toHaveBeenCalledWith({ projectId: PROJECT.id });
  });

  it("issues no read when a terminal pane opens, splits, or closes", async () => {
    await mount();

    await act(async () => {
      useSessionsStore.getState().addSession(projectScope(PROJECT.id), "sess-1", LAUNCH);
    });
    expect(statusEntries).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSessionsStore.getState().addSplit(PROJECT.id, "sess-1", "sess-1", "sess-2", "vertical");
    });
    expect(statusEntries).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSessionsStore.getState().closeSession(PROJECT.id, "sess-1");
    });
    expect(statusEntries).toHaveBeenCalledTimes(1);
  });

  it("issues no read when a chat tab opens or closes", async () => {
    await mount();

    await act(async () => {
      useChatSessionsStore.getState().openChatTab(PROJECT.id, "chat-1");
    });
    expect(statusEntries).toHaveBeenCalledTimes(1);

    await act(async () => {
      useChatSessionsStore.getState().closeChatTab(PROJECT.id, "chat-1");
    });
    expect(statusEntries).toHaveBeenCalledTimes(1);
  });

  it("issues no read for a same-column reorder, which writes no status event", async () => {
    await mount();

    await act(async () => {
      await useBoardStore.getState().moveTicket(PROJECT.id, "t1", "todo", 1);
    });

    // The reorder did happen — the board array is permuted — and still no read.
    expect(
      useBoardStore
        .getState()
        .ticketsByProject[PROJECT.id]?.map((currentTicket) => currentTicket.id),
    ).toEqual(["t2", "t1", "t3"]);
    expect(statusEntries).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one read when a UI drag moves a ticket between columns", async () => {
    await mount();

    await act(async () => {
      await useBoardStore.getState().moveTicket(PROJECT.id, "t3", "done", 0);
    });

    expect(statusEntries).toHaveBeenCalledTimes(2);
  });

  it("issues exactly one read when a CLI move arrives as a wholesale hydrate", async () => {
    await mount();

    await act(async () => {
      useBoardStore.getState().hydrate(
        {
          [PROJECT.id]: [
            ticket("t1", "backlog", 0),
            ticket("t2", "todo", 0),
            ticket("t3", "doing", 0),
          ],
        },
        { [PROJECT.id]: [] },
      );
    });

    expect(statusEntries).toHaveBeenCalledTimes(2);
  });
});

describe("ActiveSessions bands while the listing is read (VC-383)", () => {
  const loading = () => container?.querySelectorAll('[aria-label="Loading sessions"]') ?? [];
  const bandText = (band: string) =>
    container?.querySelector(`[data-session-band="${band}"]`)?.textContent ?? "";

  it("holds the rows' box in both bands until the project's listing answers", async () => {
    // A listing that never answers: the bands must not claim the project is
    // empty for as long as the baseline read is in flight.
    let answer: (() => void) | null = null;
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true as const, sessions: [] });
        }),
    );
    await mount();

    expect(loading().length).toBe(2);
    expect(bandText("active")).not.toContain("No active sessions");
    expect(bandText("previous")).not.toContain("Nothing yet");

    await act(async () => {
      answer?.();
    });
    expect(loading().length).toBe(0);
    expect(bandText("active")).toContain("No active sessions");
    expect(bandText("previous")).toContain("Nothing yet");
  });

  it("says the bands are empty only once the listing has said so", async () => {
    await mount();

    expect(loading().length).toBe(0);
    expect(bandText("active")).toContain("No active sessions");
    expect(bandText("previous")).toContain("Nothing yet");
  });

  it("stands both skeletons down when the project listing fails, without either false empty", async () => {
    listSessions.mockResolvedValueOnce({ ok: false as const, error: "db locked" });

    await mount();

    expect(loading().length).toBe(0);
    expect(bandText("active")).not.toContain("No active sessions");
    expect(bandText("previous")).not.toContain("Nothing yet");
    expect(bandText("active")).toContain("Couldn't load sessions.");
    expect(bandText("previous")).toContain("Couldn't load sessions.");
  });

  it("names a host that grants no Sessions, once, instead of either empty (VC-713, B3)", async () => {
    const reason = "Sessions aren’t available on box — update it to use them here";
    useRemoteSessionAvailabilityStore.setState({ unavailable: { [PROJECT.id]: reason } });
    try {
      await mount();
      expect(bandText("active")).toContain(reason);
      expect(bandText("active")).not.toContain("No active sessions");
      expect(bandText("previous")).not.toContain(reason);
      expect(bandText("previous")).not.toContain("Nothing yet");
    } finally {
      useRemoteSessionAvailabilityStore.setState({ unavailable: {} });
    }
  });
});

/**
 * VC-30 — the bands as the peek's surface.
 *
 * These are the hook's first real exercise, and every one of them is a
 * statement about state over time rather than about markup: a card that opens
 * only after the pointer has come to REST, a press that dismisses without
 * cancelling the drag it may be starting, a band that keeps still while
 * somebody is aiming at it. Fake timers throughout, because the dwell is the
 * subject.
 */
const NOW = 1_700_000_000_000;

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "c1",
    title: "Session one",
    projectId: PROJECT.id,
    ticketId: "t3",
    createdAt: NOW - 60_000,
    adapterId: null,
    live: true,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: NOW - 60_000,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "medium" },
    ...overrides,
  };
}

function listingRow(
  record: ChatSessionRecord,
  unreadSince: number | null = null,
): SessionListingRow {
  return {
    kind: "chat",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
    ...(unreadSince === null ? {} : { read: { unreadSince } }),
  };
}

function seedSessions(rows: readonly SessionListingRow[]): void {
  listSessions.mockImplementation(async () => ({ ok: true as const, sessions: [...rows] }));
}

const rowElement = (rowId: string): HTMLElement => {
  const found = container?.querySelector<HTMLElement>(`[data-peek-row="${rowId}"]`);
  if (found === null || found === undefined) throw new Error(`no row ${rowId}`);
  return found;
};

/** The row's own activation target — a `<li>`'s button, or the folder button itself. */
const rowButton = (rowId: string): HTMLElement => {
  const row = rowElement(rowId);
  return row instanceof HTMLButtonElement ? row : row.querySelector<HTMLElement>("button")!;
};

const bands = (): HTMLElement => {
  const found = container?.querySelector<HTMLElement>("[data-session-bands]");
  if (found === null || found === undefined) throw new Error("no session bands");
  return found;
};

const textOfBand = (band: string): string =>
  container?.querySelector(`[data-session-band="${band}"]`)?.textContent ?? "";

/** The Active band's rows, in the order it is drawing them. */
const activeRowIds = (): string[] =>
  [
    ...(container?.querySelectorAll<HTMLElement>('[data-session-band="active"] [data-peek-row]') ??
      []),
  ].map((row) => row.dataset.peekRow ?? "");

const card = (): HTMLElement | null => document.body.querySelector("[data-peek-card]");

async function pointerOver(rowId: string): Promise<void> {
  await act(async () => {
    rowButton(rowId).dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  });
}

async function press(rowId: string, key: string): Promise<void> {
  await act(async () => {
    rowButton(rowId).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the peek on the left bands (VC-30)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a card only once the pointer has rested on a row (350ms), then switches warm (150ms)", async () => {
    seedSessions([
      listingRow(chatRecord()),
      listingRow(chatRecord({ sessionId: "c2", title: "Session two" })),
    ]);
    await mount();

    await pointerOver("chat:c1");
    await tick(300);
    // Passing through a row opens nothing: the dwell is the pointer AT REST.
    expect(card()).toBeNull();

    await tick(60);
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain("Session one");

    // Once a card is up, the neighbour opens after the shorter warm rest.
    await pointerOver("chat:c2");
    await tick(150);
    expect(card()?.textContent).toContain("Session two");
  });

  it("dismisses on pointerdown without cancelling the drag that press may start", async () => {
    seedSessions([listingRow(chatRecord())]);
    await mount();
    await pointerOver("chat:c1");
    await tick(350);
    expect(card()).not.toBeNull();

    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => {
      rowButton("chat:c1").dispatchEvent(down);
    });

    expect(card()).toBeNull();
    // The row is a drag source: a prevented default would refuse the gesture.
    expect(down.defaultPrevented).toBe(false);
    expect(rowButton("chat:c1").getAttribute("draggable")).toBe("true");
  });

  it("reads a Session when its row is opened", async () => {
    seedSessions([listingRow(chatRecord(), NOW - 1_000)]);
    await mount();

    await act(async () => {
      rowButton("chat:c1").click();
    });

    expect(setRead).toHaveBeenCalledWith({ sessionId: "c1", unread: false });
  });

  it("toggles read with U, in both directions", async () => {
    seedSessions([listingRow(chatRecord())]);
    await mount();

    await press("chat:c1", "u");
    expect(setRead).toHaveBeenLastCalledWith({ sessionId: "c1", unread: true });

    await press("chat:c1", "u");
    expect(setRead).toHaveBeenLastCalledWith({ sessionId: "c1", unread: false });
  });

  it("keeps an unread Session in Active however old it is", async () => {
    // Past the 30-minute quiet window: read, it belongs to Previous; unread, it
    // is not done with you (VC-108).
    const old = chatRecord({ lastActivityAt: NOW - 90 * 60_000, createdAt: NOW - 90 * 60_000 });
    seedSessions([listingRow(old)]);
    await mount();

    expect(textOfBand("active")).not.toContain("Session one");
    // It is in Previous, behind the folder its ticket collapses onto (VC-69):
    // the title itself is only drawn once that folder is disclosed.
    expect(rowElement("folder:t3")).not.toBeNull();
    expect(textOfBand("previous")).toContain("1 session");

    seedSessions([listingRow(old, NOW - 60_000)]);
    await act(async () => {
      await useProjectSessionsStore.getState().refresh(PROJECT.id);
    });

    expect(textOfBand("active")).toContain("Session one");
  });

  it("holds the Active order while the pointer is in the band, and lands it on leave", async () => {
    seedSessions([
      listingRow(chatRecord({ sessionId: "c1", title: "One", lastActivityAt: NOW - 1_000 })),
      listingRow(chatRecord({ sessionId: "c2", title: "Two", lastActivityAt: NOW - 2_000 })),
    ]);
    await mount();
    expect(activeRowIds()).toEqual(["chat:c1", "chat:c2"]);

    await pointerOver("chat:c1");
    // A new question on the second row: the rule floats it to the very top.
    seedSessions([
      listingRow(chatRecord({ sessionId: "c1", title: "One", lastActivityAt: NOW - 1_000 })),
      listingRow(
        chatRecord({
          sessionId: "c2",
          title: "Two",
          activity: "waiting",
          waitingOn: "question",
          lastActivityAt: NOW,
        }),
      ),
    ]);
    await act(async () => {
      await useProjectSessionsStore.getState().refresh(PROJECT.id);
    });

    // Nothing moves under the pointer, even though the listing would.
    expect(activeRowIds()).toEqual(["chat:c1", "chat:c2"]);

    // React derives `onPointerLeave` from `pointerout` at its root, so the
    // leave is dispatched as the event the browser actually sends.
    await act(async () => {
      bands().dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    // The bridge's grace: whatever the dwell may have opened closes, and the
    // hold the open card was taking goes with it.
    await tick(600);

    expect(activeRowIds()).toEqual(["chat:c2", "chat:c1"]);
  });

  it("steps folders and their open Sessions in one order, and opens them with the arrows", async () => {
    // Two Sessions on one ticket, both past the window: the Previous band files
    // them under a folder.
    const past = NOW - 90 * 60_000;
    seedSessions([
      listingRow(chatRecord({ sessionId: "c1", title: "One", lastActivityAt: past })),
      listingRow(chatRecord({ sessionId: "c2", title: "Two", lastActivityAt: past - 1_000 })),
    ]);
    await mount();

    const folder = "folder:t3";
    expect(rowElement(folder)).not.toBeNull();
    // Closed: its children are not in the walk at all.
    await press(folder, "ArrowDown");
    expect(document.activeElement).toBe(rowButton(folder));

    await press(folder, "ArrowRight");
    expect(rowButton(folder).getAttribute("aria-expanded")).toBe("true");

    await press(folder, "j");
    expect(document.activeElement).toBe(rowButton("chat:c1"));
    await press("chat:c1", "ArrowDown");
    expect(document.activeElement).toBe(rowButton("chat:c2"));
    await press("chat:c2", "k");
    expect(document.activeElement).toBe(rowButton("chat:c1"));

    // ← on a Session inside a folder returns to the folder that holds it.
    await press("chat:c1", "ArrowLeft");
    expect(document.activeElement).toBe(rowButton(folder));

    await press(folder, "ArrowLeft");
    expect(rowButton(folder).getAttribute("aria-expanded")).toBe("false");
  });

  it("peeks the focused row with Space, and pins it with a second", async () => {
    seedSessions([listingRow(chatRecord())]);
    await mount();

    await press("chat:c1", " ");
    expect(card()).not.toBeNull();
    // Hover leaves focus where it was; only a pin moves it.
    expect(document.activeElement).not.toBe(card());

    await press("chat:c1", " ");
    expect(document.activeElement).toBe(card());
  });
});
