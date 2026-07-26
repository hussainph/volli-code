import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TICKET_RECENCY_OWNER_STATE,
  readTicketInspection,
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

  it("keeps a known local-save revision quiet and consumes its watcher echo", () => {
    const identity = {
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/app.ts",
      source: "worktree",
    } as const;
    const inspected = reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
      type: "inspect",
      identity,
      revision: 1,
    });
    const saved = reduceTicketRecencyOwner(inspected, {
      type: "local-save",
      identity,
      revision: 2,
    });
    const echoed = reduceTicketRecencyOwner(saved, {
      type: "file-changed",
      event: { ...identity, revision: 2 },
    });

    expect(saved.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "2",
      updatedRevision: null,
    });
    expect(saved.localSaveEchoes["src/app.ts"]).toBe("2");
    expect(echoed.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "2",
      updatedRevision: null,
    });
    expect(echoed.localSaveEchoes["src/app.ts"]).toBeUndefined();
  });
});

describe("readTicketInspection", () => {
  it("records the exact revision and resolved Main identity from a deliberate open", async () => {
    const read = async () =>
      ({
        ok: true,
        source: "main",
        mtime: 42,
        content: { type: "text", text: "hello\n", truncated: false },
      }) as const;

    await expect(
      readTicketInspection(read, {
        projectId: "project-1",
        ticketId: "ticket-1",
        relPath: ".volli/artifacts/notes.md",
      }),
    ).resolves.toEqual({
      type: "inspect",
      identity: {
        projectId: "project-1",
        ticketId: null,
        relPath: ".volli/artifacts/notes.md",
        source: "main",
      },
      revision: 42,
    });
  });
});
