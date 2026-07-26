import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TICKET_RECENCY_OWNER_STATE,
  reduceTicketRecencyOwner,
} from "./ticket-change-recency-owner";

describe("reduceTicketRecencyOwner", () => {
  it("marks only a later event with the deliberately inspected complete identity", () => {
    const inspected = reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
      type: "inspect",
      identity: {
        projectId: "project-1",
        ticketId: "ticket-1",
        relPath: "src/app.ts",
        source: "worktree",
      },
      revision: 1,
    });

    const wrongTicket = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: "ticket-2",
        relPath: "src/app.ts",
        source: "worktree",
        revision: 2,
      },
    });
    const wrongMain = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: null,
        relPath: "src/app.ts",
        source: "main",
        revision: 2,
      },
    });
    const updated = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: "ticket-1",
        relPath: "src/app.ts",
        source: "worktree",
        revision: 2,
      },
    });

    expect(wrongTicket).toBe(inspected);
    expect(wrongMain).toBe(inspected);
    expect(updated.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "1",
      updatedRevision: "2",
    });
  });
});
