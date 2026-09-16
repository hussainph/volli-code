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

import { useBoardStore } from "@renderer/stores/board";

import { useTicketBody, type TicketBodyStatus } from "./use-ticket-body";

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

/** The hook's last reported status, so a test can assert what the Body tab draws. */
let lastStatus: TicketBodyStatus | null = null;
/** The hook's retry action, so a test can drive the fault surface's one button. */
let lastRetry: (() => void) | null = null;

function Probe({ ticket }: { ticket: TicketKey }): null {
  const state = useTicketBody(ticket);
  lastStatus = state.status;
  lastRetry = state.retry;
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
  lastStatus = null;
  lastRetry = null;
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { tickets: { body } },
  });
  useBoardStore.setState({
    ticketsByProject: { p1: [TICKET] },
    labelsByProject: { p1: [] },
    unloadedTicketBodies: {},
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

  it("keeps the body already on screen when a refresh read fails, and stays ready", async () => {
    body.mockResolvedValue({ ok: false, error: "Unknown ticket" });

    await mount();

    // This ticket's body came from the boot payload, so a failed re-read is
    // refinement over something already rendered: no fault surface, no noise.
    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("stale body");
    expect(lastStatus).toBe("ready");
  });

  it("keeps the body already on screen when a refresh read rejects, and stays ready", async () => {
    body.mockRejectedValue(new Error("IPC unavailable"));

    await mount();

    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("stale body");
    expect(lastStatus).toBe("ready");
  });

  describe("a ticket whose body this renderer has never held", () => {
    beforeEach(() => {
      // What the steady-state roster leaves behind for a ticket an agent created
      // after this window booted: a `""` PLACEHOLDER, not an empty body.
      useBoardStore.setState({
        ticketsByProject: { p1: [{ ...TICKET, body: "" }] },
        unloadedTicketBodies: { t1: true },
      });
    });

    it("reports loading until the read lands, so no editor is mounted over the placeholder", async () => {
      const read = deferred<TicketBodyResult>();
      body.mockReturnValue(read.promise);

      await mount();
      expect(lastStatus).toBe("loading");

      await act(async () => {
        read.resolve({ ok: true, body: "# The real body" });
      });
      expect(lastStatus).toBe("ready");
    });

    it("reports the failure, because a person opened this ticket and is waiting", async () => {
      body.mockResolvedValue({ ok: false, error: "Unknown ticket" });

      await mount();

      // The one place this read is NOT background refinement: there is no
      // fallback body on screen, so silence would be a blank tab and no reason.
      expect(lastStatus).toBe("failed");
    });

    it("reports the failure when the read rejects outright", async () => {
      body.mockRejectedValue(new Error("IPC unavailable"));

      await mount();

      expect(lastStatus).toBe("failed");
    });

    it("recovers through retry, which is the one action the fault surface offers", async () => {
      body.mockResolvedValue({ ok: false, error: "Unknown ticket" });
      await mount();
      expect(lastStatus).toBe("failed");

      body.mockResolvedValue({ ok: true, body: "# The real body" });
      await act(async () => {
        lastRetry?.();
      });

      expect(lastStatus).toBe("ready");
      expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("# The real body");
    });

    it("becomes ready when the canonical body turns out to be empty", async () => {
      body.mockResolvedValue({ ok: true, body: "" });

      await mount();

      // The read landed and the answer was "". Only the mark can tell that from
      // the placeholder, and a ticket left marked is one nobody can ever edit.
      expect(lastStatus).toBe("ready");
    });
  });
});
