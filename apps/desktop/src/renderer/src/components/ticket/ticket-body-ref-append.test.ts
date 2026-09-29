import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { useBoardStore } from "@renderer/stores/board";
import {
  appendRefToTicketBody,
  type TicketBodyRefGateway,
} from "@renderer/components/ticket/ticket-body-ref-append";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    projectId: "p1",
    ticketNumber: 1,
    title: "A ticket",
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function rosterRow(overrides: Partial<Ticket> = {}) {
  const { body: _body, ...rest } = ticket(overrides);
  return rest;
}

function fakeGateway(overrides: Partial<TicketBodyRefGateway> = {}): TicketBodyRefGateway {
  return {
    readBody: vi.fn<TicketBodyRefGateway["readBody"]>(async () => ({ ok: true, body: "" })),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

let updateTicket: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateTicket = vi.fn(async () => undefined);
  useBoardStore.setState({ updateTicket: updateTicket as never });
  useBoardStore.getState().hydrate({}, {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendRefToTicketBody", () => {
  it("appends to the body it already holds, without paying for a read", async () => {
    useBoardStore.getState().hydrate({ p1: [ticket({ body: "# Scope" })] }, { p1: [] });
    const gateway = fakeGateway();

    await appendRefToTicketBody({ id: "t1", projectId: "p1" }, "@src/a.ts", gateway);

    expect(gateway.readBody).not.toHaveBeenCalled();
    expect(updateTicket).toHaveBeenCalledWith({ ticketId: "t1", body: "# Scope\n@src/a.ts" });
  });

  it("reads the canonical body BEFORE appending to a placeholder", async () => {
    // The ticket an agent created after this window booted: the roster gave it a
    // `""` placeholder, and SQLite holds the real body.
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    useBoardStore.getState().hydrateProjectRoster("p1", [rosterRow()], []);
    const gateway = fakeGateway({
      readBody: vi.fn<TicketBodyRefGateway["readBody"]>(async () => ({
        ok: true,
        body: "# The real body",
      })),
    });

    await appendRefToTicketBody({ id: "t1", projectId: "p1" }, "@src/a.ts", gateway);

    // The defect this guards: appending to the placeholder would have written
    // "@src/a.ts" OVER "# The real body".
    expect(gateway.readBody).toHaveBeenCalledWith({ ticketId: "t1" });
    expect(updateTicket).toHaveBeenCalledWith({
      ticketId: "t1",
      body: "# The real body\n@src/a.ts",
    });
  });

  it("adopts the body it read, so a second file in the same drop reads nothing", async () => {
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    useBoardStore.getState().hydrateProjectRoster("p1", [rosterRow()], []);
    const gateway = fakeGateway({
      readBody: vi.fn<TicketBodyRefGateway["readBody"]>(async () => ({
        ok: true,
        body: "# The real body",
      })),
    });

    await appendRefToTicketBody({ id: "t1", projectId: "p1" }, "@src/a.ts", gateway);
    await appendRefToTicketBody({ id: "t1", projectId: "p1" }, "@src/b.ts", gateway);

    expect(gateway.readBody).toHaveBeenCalledTimes(1);
    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.body).toBe("# The real body");
  });

  it("writes nothing and reports when the body it needs will not load", async () => {
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    useBoardStore.getState().hydrateProjectRoster("p1", [rosterRow()], []);
    const gateway = fakeGateway({
      readBody: vi.fn<TicketBodyRefGateway["readBody"]>(async () => ({ ok: false })),
    });

    await appendRefToTicketBody({ id: "t1", projectId: "p1" }, "@src/a.ts", gateway);

    // Losing the body is worse than losing the ref: write nothing, and say so —
    // a person dragged this file in and is waiting for it.
    expect(updateTicket).not.toHaveBeenCalled();
    expect(gateway.reportFailure).toHaveBeenCalledWith(expect.stringContaining("body didn't load"));
  });

  it("does nothing for a ticket this board does not hold", async () => {
    const gateway = fakeGateway();

    await appendRefToTicketBody({ id: "ghost", projectId: "p1" }, "@src/a.ts", gateway);

    expect(gateway.readBody).not.toHaveBeenCalled();
    expect(updateTicket).not.toHaveBeenCalled();
  });
});
