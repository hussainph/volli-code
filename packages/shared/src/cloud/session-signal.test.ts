import { describe, expect, test } from "vite-plus/test";

import type { TicketId } from "./ids";
import { sessionSignalBoardEffects, sessionSignalCommentId } from "./session-signal";

const TICKET = "00000000-0000-4000-8000-000000000001" as TicketId;

describe("sessionSignalBoardEffects", () => {
  test("pins the durable signal comment id across refolds", () => {
    expect(sessionSignalCommentId("session", "event")).toBe("abaa25a4-d2cb-8fd2-a5af-5cdf5292ac5f");
    expect(sessionSignalCommentId("session", "another-event")).not.toBe(
      sessionSignalCommentId("session", "event"),
    );
  });
  test("leaves the last todo list on the ticket as a comment, in the model's order", () => {
    expect(
      sessionSignalBoardEffects({
        signal: "blocked",
        ticketId: TICKET,
        todoList: [
          { content: "Write it", status: "completed" },
          { content: "Ship it", status: "in_progress" },
        ],
      }),
    ).toEqual([
      {
        kind: "comment",
        ticketId: TICKET,
        body: "Todo list at session blocked:\n\n- [x] Write it\n- [ ] Ship it (in progress)",
      },
    ]);
  });

  test("says nothing without a ticket, without a list, or with a cleared list", () => {
    const list = [{ content: "A", status: "pending" as const }];
    expect(sessionSignalBoardEffects({ signal: "done", ticketId: null, todoList: list })).toEqual(
      [],
    );
    expect(sessionSignalBoardEffects({ signal: "done", ticketId: TICKET, todoList: null })).toEqual(
      [],
    );
    expect(sessionSignalBoardEffects({ signal: "done", ticketId: TICKET, todoList: [] })).toEqual(
      [],
    );
  });
});
