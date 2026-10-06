/** The board's command receipts (VC-565): a repeat answers its record, another intent conflicts. */
import { isCommandIntentConflict } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  BOARD_RECEIPT_RETENTION_MS,
  BoardCommandIntentConflictError,
  recordBoardCommand,
  replayBoardCommand,
  type BoardCommandKey,
} from "./receipts";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

const key = (overrides: Partial<BoardCommandKey> = {}): BoardCommandKey => ({
  workspaceId: "p",
  commandId: "c-1",
  operation: "board.setPriority",
  intent: { ticketId: "t", priority: "high" },
  ...overrides,
});

const receiptCount = (): number =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM board_command_receipts").get() as { n: number }).n;

describe("board command receipts", () => {
  it("answers undefined for a command never recorded", () => {
    expect(replayBoardCommand(ctx.db, key())).toBeUndefined();
  });

  it("replays the stored reply for the same id and intent", () => {
    const reply = { ticket: { id: "t", priority: "high" } };
    recordBoardCommand(ctx.db, key(), reply, 1_000);
    expect(replayBoardCommand(ctx.db, key())).toEqual({ reply });
    // The intent is compared canonically: key order is not intent.
    expect(
      replayBoardCommand(ctx.db, key({ intent: { priority: "high", ticketId: "t" } })),
    ).toEqual({ reply });
  });

  it("refuses the same id under another intent with the branded conflict", () => {
    recordBoardCommand(ctx.db, key(), null, 1_000);
    for (const other of [
      key({ intent: { ticketId: "t", priority: "low" } }),
      key({ operation: "board.archiveTicket" }),
    ]) {
      let thrown: unknown;
      try {
        replayBoardCommand(ctx.db, other);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BoardCommandIntentConflictError);
      expect(isCommandIntentConflict(thrown)).toBe(true);
      expect((thrown as Error).name).toBe("BoardCommandIntentConflictError");
      expect((thrown as Error).message).toBe(
        "Command c-1 was already used for a different board command.",
      );
    }
  });

  it("treats an absent intent as null", () => {
    recordBoardCommand(ctx.db, key({ intent: undefined }), "done", 1_000);
    expect(replayBoardCommand(ctx.db, key({ intent: null }))).toEqual({ reply: "done" });
  });

  it("keys a receipt by Workspace: the same id in another Workspace is its own command", () => {
    recordBoardCommand(ctx.db, key(), "p's", 1_000);
    expect(replayBoardCommand(ctx.db, key({ workspaceId: "q" }))).toBeUndefined();
    recordBoardCommand(
      ctx.db,
      key({ workspaceId: "q", intent: { ticketId: "u", priority: "low" } }),
      "q's",
      1_000,
    );
    expect(replayBoardCommand(ctx.db, key())).toEqual({ reply: "p's" });
    expect(
      replayBoardCommand(
        ctx.db,
        key({ workspaceId: "q", intent: { ticketId: "u", priority: "low" } }),
      ),
    ).toEqual({ reply: "q's" });
  });

  it("stores an undefined reply as null", () => {
    recordBoardCommand(ctx.db, key(), undefined, 1_000);
    expect(replayBoardCommand(ctx.db, key())).toEqual({ reply: null });
    const row = ctx.db
      .prepare("SELECT reply, operation, created_at FROM board_command_receipts")
      .get();
    expect(row).toEqual({ reply: "null", operation: "board.setPriority", created_at: 1_000 });
  });

  it("prunes receipts past retention on the next record, and keeps the ones inside it", () => {
    recordBoardCommand(ctx.db, key({ commandId: "old" }), "old", 1_000);
    recordBoardCommand(ctx.db, key({ commandId: "edge" }), "edge", 2_000);
    const now = 2_000 + BOARD_RECEIPT_RETENTION_MS;
    recordBoardCommand(ctx.db, key({ commandId: "new" }), "new", now);
    // Strictly older than the window: "edge" sits exactly on its boundary.
    expect(replayBoardCommand(ctx.db, key({ commandId: "old" }))).toBeUndefined();
    expect(replayBoardCommand(ctx.db, key({ commandId: "edge" }))).toEqual({ reply: "edge" });
    expect(replayBoardCommand(ctx.db, key({ commandId: "new" }))).toEqual({ reply: "new" });
    expect(receiptCount()).toBe(2);
  });

  it("holds receipts for a week", () => {
    expect(BOARD_RECEIPT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
