// @vitest-environment jsdom
/**
 * The Doc tab's activity cache (VC-373): a Doc → file/chat → Doc flip must
 * paint the feed it left behind, not spend `tickets.events` + `comments.list`
 * to redraw the same list; a planning change that provably targets another
 * ticket must not force a refetch either; and one that could have touched this
 * ticket must.
 *
 * Mounted through `react-dom/client` rather than a static render because the
 * promise here is a REMOUNT — the cache's whole job happens across the gap
 * between two mounts, which no single render can show.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { TicketActivityFeed } from "./ticket-activity-feed";
import { useBoardStore } from "@renderer/stores/board";
import { useTicketActivityStore } from "@renderer/stores/ticket-activity";

let root: Root | null = null;
let container: HTMLElement | null = null;

const TICKET = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "A ticket",
  body: "",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: false,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  createdAt: 1,
  updatedAt: 1,
} as unknown as Ticket;

const doors = {
  events: vi.fn(async () => ({ ok: true as const, events: [] })),
  comments: vi.fn(async () => ({ ok: true as const, comments: [] })),
};

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TicketActivityFeed ticket={TICKET} />);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

/** One planning refresh at `version`, scoped as the board would publish it. */
async function planningChange(version: number, ticketId: string | null): Promise<void> {
  await act(async () => {
    useBoardStore.setState({ lastPlanningChange: { version, ticketId, projectId: null } });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  doors.events.mockClear();
  doors.comments.mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { tickets: { events: doors.events }, comments: { list: doors.comments } },
  });
  useBoardStore.setState({ lastPlanningChange: { version: 1, ticketId: null, projectId: null } });
  useTicketActivityStore.setState({ byTicket: {} });
});

afterEach(async () => {
  if (root !== null) await unmount();
  vi.unstubAllGlobals();
});

describe("the Doc tab's activity cache", () => {
  it("reads the feed on the first mount", async () => {
    await mount();

    expect(doors.events).toHaveBeenCalledTimes(1);
    expect(doors.comments).toHaveBeenCalledTimes(1);
  });

  it("paints a Doc-tab return from cache, with no refetch", async () => {
    await mount();
    await unmount();

    await mount();

    // The whole point: the flip is two mounts and zero reads.
    expect(doors.events).toHaveBeenCalledTimes(1);
    expect(doors.comments).toHaveBeenCalledTimes(1);
  });

  it("refetches when a planning change could have touched this ticket", async () => {
    await mount();

    await planningChange(2, "t1");

    expect(doors.events).toHaveBeenCalledTimes(2);
    expect(doors.comments).toHaveBeenCalledTimes(2);
  });

  it("skips a change that provably targeted another ticket — and keeps the cache warm for it", async () => {
    await mount();

    await planningChange(2, "t2");

    // Nothing refetched while mounted...
    expect(doors.events).toHaveBeenCalledTimes(1);
    // ...and the watermark moved with the change, so the flip after it does
    // not refetch either.
    await unmount();
    await mount();
    expect(doors.events).toHaveBeenCalledTimes(1);
    expect(doors.comments).toHaveBeenCalledTimes(1);
  });

  it("refetches on the next mount when a change landed while the feed was gone", async () => {
    await mount();
    await unmount();

    // Untargeted: anything may have changed, and only the feed's own mount can
    // act on it.
    await planningChange(2, null);

    await mount();

    expect(doors.events).toHaveBeenCalledTimes(2);
    expect(doors.comments).toHaveBeenCalledTimes(2);
  });
});
