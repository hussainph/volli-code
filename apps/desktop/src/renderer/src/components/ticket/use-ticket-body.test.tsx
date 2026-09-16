// @vitest-environment jsdom
/**
 * The open ticket owns the otherwise-cold Markdown body read: board refreshes
 * carry only the lightweight roster, so mounting this reader must fill that
 * one ticket without making body freshness part of every board update.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Ticket } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TicketBodyResult } from "../../../../ipc/contract";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";

import { useTicketBody } from "./use-ticket-body";

const TICKET: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "A ticket",
  body: "stale body",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: false,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

const TICKET_TWO = { ...TICKET, id: "t2", body: "second stale body" };

type TicketKey = Pick<Ticket, "id" | "projectId">;

let root: Root | null = null;
let container: HTMLElement | null = null;
const body = vi.fn<(input: { ticketId: string }) => Promise<TicketBodyResult>>();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function Probe({ ticket }: { ticket: TicketKey }): null {
  useTicketBody(ticket);
  return null;
}

async function mount(ticket: TicketKey = TICKET): Promise<void> {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe ticket={ticket} />);
  });
}

async function switchTo(ticket: TicketKey): Promise<void> {
  await act(async () => {
    root?.render(<Probe ticket={ticket} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  body.mockReset();
  body.mockResolvedValue({ ok: true, body: "fresh body" });
  vi.mocked(toastError).mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { tickets: { body } },
  });
  useBoardStore.setState({
    ticketsByProject: { p1: [TICKET] },
    labelsByProject: { p1: [] },
    lastPlanningChange: { version: 0, ticketId: null, projectId: null },
  });
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("useTicketBody", () => {
  it("reads and adopts the open ticket's body on mount", async () => {
    await mount();

    expect(body).toHaveBeenCalledWith({ ticketId: "t1" });
    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("fresh body");
  });

  it("re-reads after targeted and untargeted planning changes that affect the open ticket", async () => {
    await mount();

    await act(async () => {
      useBoardStore.setState({
        lastPlanningChange: { version: 1, ticketId: "t1", projectId: "p1" },
      });
    });
    await act(async () => {
      useBoardStore.setState({
        lastPlanningChange: { version: 2, ticketId: null, projectId: null },
      });
    });

    expect(body).toHaveBeenCalledTimes(3);
  });

  it("does not re-read for a planning change provably scoped to another ticket", async () => {
    await mount();

    await act(async () => {
      useBoardStore.setState({
        lastPlanningChange: { version: 1, ticketId: "t2", projectId: "p1" },
      });
    });

    expect(body).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the ticket changes and drops the previous ticket's late body", async () => {
    const firstRead = deferred<TicketBodyResult>();
    body.mockImplementation(({ ticketId }) =>
      ticketId === "t1"
        ? firstRead.promise
        : Promise.resolve({ ok: true, body: "second fresh body" }),
    );
    useBoardStore.setState({ ticketsByProject: { p1: [TICKET, TICKET_TWO] } });

    await mount();
    await switchTo(TICKET_TWO);
    await act(async () => {
      firstRead.resolve({ ok: true, body: "late first body" });
    });

    expect(body.mock.calls.map(([input]) => input.ticketId)).toEqual(["t1", "t2"]);
    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("stale body");
    expect(useBoardStore.getState().ticketsByProject.p1?.[1]?.body).toBe("second fresh body");
  });

  it("keeps the existing body and stays silent when the read returns a failure", async () => {
    body.mockResolvedValue({ ok: false, error: "Unknown ticket" });

    await mount();

    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("stale body");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps the existing body and stays silent when the read rejects", async () => {
    body.mockRejectedValue(new Error("IPC unavailable"));

    await mount();

    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("stale body");
    expect(toastError).not.toHaveBeenCalled();
  });
});
