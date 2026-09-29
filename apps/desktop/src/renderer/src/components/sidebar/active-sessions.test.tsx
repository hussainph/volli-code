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
import type { Project, Ticket, TicketStatus } from "@volli/shared";

import { ActiveSessions } from "./active-sessions";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { projectScope, useSessionsStore, type SessionLaunch } from "@renderer/stores/sessions";
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
      sessions: { list: listSessions },
      tickets: { statusEntries, latestSignals, move },
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
});
