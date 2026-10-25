/**
 * The board's per-surface door in a cloud launch (VC-889): reads through the
 * window's Volli Cloud client, in the legacy envelopes; writes refused.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { api } from "@volli/convex/api";

import type { CloudSession } from "./cloud-client";
import { KNOWN_COMMENTS_MAX, cloudBoardApi } from "./cloud-board-api";

let session: CloudSession | null = null;
vi.mock("./cloud-client", () => ({ cloudSession: () => session }));

const source = {
  createComment: vi.fn(),
  updateComment: vi.fn(),
  removeComment: vi.fn(),
};
let installed: typeof source | null = null;
vi.mock("../stores/board-source", () => ({ cloudBoardSource: () => installed }));

afterEach(() => {
  session = null;
  installed = null;
  vi.clearAllMocks();
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

  it("refuses the project settings Volli Cloud does not hold yet", async () => {
    const door = cloudBoardApi();
    const refused = { ok: false, error: "Not available for Volli Cloud projects yet" };
    expect(
      await Promise.all([
        door.projects.update({ id: "p", baseBranch: null }),
        door.projects.setSkillModes({ id: "p", modes: {} }),
        door.projects.setSessionDefaults({ id: "p", model: null }),
      ]),
    ).toEqual([refused, refused, refused]);
  });

  it("writes comments through the board source, placing an edit by the comment's ticket", async () => {
    const door = cloudBoardApi();
    const notConnected = { ok: false, error: "Volli Cloud isn’t connected yet." };
    expect(await door.comments.create({ ticketId: "t", body: "b" })).toEqual(notConnected);
    expect(await door.comments.update({ commentId: "c1", body: "b" })).toEqual(notConnected);
    expect(await door.comments.remove({ commentId: "c1" })).toEqual(notConnected);

    installed = source;
    const comment = {
      id: "c1",
      ticketId: "t",
      sessionId: null,
      actor: "user",
      body: "hi",
      createdAt: 1,
      updatedAt: 1,
    };
    source.createComment.mockResolvedValueOnce({ ok: true, comment });
    expect(await door.comments.create({ ticketId: "t", body: "hi" })).toEqual({
      ok: true,
      comment,
    });
    // One it never saw cannot be placed.
    expect(await door.comments.update({ commentId: "unknown", body: "b" })).toEqual(notConnected);
    source.updateComment.mockResolvedValueOnce({ ok: true });
    expect(await door.comments.update({ commentId: "c1", body: "edit" })).toMatchObject({
      ok: true,
      comment: { id: "c1", body: "edit" },
    });
    expect(source.updateComment).toHaveBeenCalledWith("t", "c1", "edit");
    source.updateComment.mockResolvedValueOnce({ ok: false, error: "Not yours." });
    expect(await door.comments.update({ commentId: "c1", body: "x" })).toEqual({
      ok: false,
      error: "Not yours.",
    });
    source.createComment.mockResolvedValueOnce({ ok: false, error: "Read-only" });
    expect(await door.comments.create({ ticketId: "t", body: "x" })).toEqual({
      ok: false,
      error: "Read-only",
    });
    source.removeComment.mockResolvedValueOnce({ ok: false, error: "down" });
    expect(await door.comments.remove({ commentId: "c1" })).toEqual({ ok: false, error: "down" });
    source.removeComment.mockResolvedValueOnce({ ok: true });
    expect(await door.comments.remove({ commentId: "c1" })).toEqual({ ok: true });
    expect(await door.comments.remove({ commentId: "c1" })).toEqual(notConnected);
  });

  it("remembers a bounded number of comments, the oldest first out", async () => {
    const rows = Array.from({ length: KNOWN_COMMENTS_MAX + 1 }, (_, index) => ({
      id: `k${index}`,
      ticketId: "t",
      sessionId: null,
      author: { kind: "person" },
      body: "b",
      createdAt: index,
      editedAt: null,
    }));
    connect({ "board:comments": () => rows });
    installed = source;
    await cloudBoardApi().comments.list({ ticketId: "t" });
    source.updateComment.mockResolvedValue({ ok: true });
    expect(await cloudBoardApi().comments.update({ commentId: "k0", body: "x" })).toMatchObject({
      ok: false,
    });
    expect(
      await cloudBoardApi().comments.update({ commentId: `k${KNOWN_COMMENTS_MAX}`, body: "x" }),
    ).toMatchObject({ ok: true });
  });
});
