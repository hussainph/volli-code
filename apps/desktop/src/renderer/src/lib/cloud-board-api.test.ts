/**
 * The board's per-surface door in a cloud launch (VC-889): reads through the
 * window's Volli Cloud client, in the legacy envelopes; writes refused.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { api } from "@volli/convex/api";

import type { CloudSession } from "./cloud-client";
import { cloudBoardApi } from "./cloud-board-api";

let session: CloudSession | null = null;
vi.mock("./cloud-client", () => ({ cloudSession: () => session }));

afterEach(() => {
  session = null;
});

function connect(answers: Record<string, (args: unknown) => unknown>) {
  const query = vi.fn(async (reference: unknown, args: unknown) => {
    const answer = answers[getFunctionName(reference as never)];
    if (answer === undefined) throw new Error("unexpected query");
    return answer(args);
  });
  session = { client: { query } as never, api };
  return query;
}

describe("Volli Cloud's board door", () => {
  it("says it is not connected before the client runs", async () => {
    const door = cloudBoardApi();
    expect(await door.tickets.events({ ticketId: "t" })).toEqual({
      ok: false,
      error: "Volli Cloud isn’t connected yet.",
    });
  });

  it("reads a ticket's history, body and comments in their legacy envelopes", async () => {
    const query = connect({
      "board:ticketEvents": () => [
        {
          id: "e1",
          ticketId: "t",
          actor: { kind: "person" },
          occurredAt: 1,
          payload: { kind: "body_edited" },
        },
      ],
      "board:getTicket": () => ({ ticket: {}, body: "# Body", bodyRevision: 2 }),
      "board:comments": () => [
        {
          id: "c1",
          ticketId: "t",
          sessionId: null,
          author: { kind: "person" },
          body: "hi",
          createdAt: 1,
          editedAt: null,
        },
      ],
    });
    const door = cloudBoardApi();
    expect(await door.tickets.events({ ticketId: "t" })).toMatchObject({
      ok: true,
      events: [{ id: "e1", payload: { kind: "body_edited" } }],
    });
    expect(await door.tickets.body({ ticketId: "t" })).toEqual({ ok: true, body: "# Body" });
    expect(await door.comments.list({ ticketId: "t" })).toMatchObject({
      ok: true,
      comments: [{ id: "c1", actor: "user" }],
    });
    expect(query.mock.calls.map(([, args]) => args)).toEqual([
      { ticketId: "t" },
      { ticketId: "t" },
      { ticketId: "t" },
    ]);
  });

  it("answers a refused read with the backend's sentence", async () => {
    session = {
      client: {
        query: async () => {
          throw Object.assign(new Error("[Request ID] Server Error"), {
            data: { code: "not_found", message: "No such ticket." },
          });
        },
      } as never,
      api,
    };
    const door = cloudBoardApi();
    expect(await door.tickets.body({ ticketId: "t" })).toEqual({
      ok: false,
      error: "No such ticket.",
    });
    expect(await door.comments.list({ ticketId: "t" })).toEqual({
      ok: false,
      error: "No such ticket.",
    });
    expect(await door.tickets.events({ ticketId: "t" })).toEqual({
      ok: false,
      error: "No such ticket.",
    });
  });

  it("has nothing of Sessions to say yet, and no folder to go missing", async () => {
    const door = cloudBoardApi();
    expect(await door.tickets.latestSignals({ projectId: "p" })).toEqual({ ok: true, signals: [] });
    expect(await door.tickets.statusEntries({ projectId: "p" })).toEqual({ ok: true, entries: [] });
    expect(await door.projects.checkFolder("p")).toEqual({ ok: true, path: "", state: "present" });
  });

  it("refuses every write in this release", async () => {
    const door = cloudBoardApi();
    const refused = { ok: false, error: "Not available for Volli Cloud projects yet" };
    expect(
      await Promise.all([
        door.comments.create({ ticketId: "t", body: "b" }),
        door.comments.update({ commentId: "c", body: "b" }),
        door.comments.remove({ commentId: "c" }),
        door.projects.update({ id: "p", baseBranch: null }),
        door.projects.setSkillModes({ id: "p", modes: {} }),
        door.projects.setSessionDefaults({ id: "p", model: null }),
      ]),
    ).toEqual([refused, refused, refused, refused, refused, refused]);
  });
});
