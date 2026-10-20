/** The board's command receipts (VC-565): a repeat answers its record, another intent conflicts. */
import { isCommandIntentConflict } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  BOARD_RECEIPT_RETENTION_MS,
  BoardCommandIntentConflictError,
  recordBoardCommand,
  replayBoardCommand,
  replayOrphanedBoardCommand,
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

/** A replay's clock, inside every record's retention below. */
const NOW = 2_000;

const receiptCount = (): number =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM board_command_receipts").get() as { n: number }).n;

describe("board command receipts", () => {
  it("answers undefined for a command never recorded", () => {
    expect(replayBoardCommand(ctx.db, key(), NOW)).toBeUndefined();
  });

  it("replays the stored reply for the same id and intent", () => {
    const reply = { ticket: { id: "t", priority: "high" } };
    recordBoardCommand(ctx.db, key(), reply, 1_000);
    expect(replayBoardCommand(ctx.db, key(), NOW)).toEqual({ reply });
    // The intent is compared canonically: key order is not intent.
    expect(
      replayBoardCommand(ctx.db, key({ intent: { priority: "high", ticketId: "t" } }), NOW),
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
        replayBoardCommand(ctx.db, other, NOW);
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
    expect(replayBoardCommand(ctx.db, key({ intent: null }), NOW)).toEqual({ reply: "done" });
  });

  it("keys a receipt by Workspace: the same id in another Workspace is its own command", () => {
    recordBoardCommand(ctx.db, key(), "p's", 1_000);
    expect(replayBoardCommand(ctx.db, key({ workspaceId: "q" }), NOW)).toBeUndefined();
    recordBoardCommand(
      ctx.db,
      key({ workspaceId: "q", intent: { ticketId: "u", priority: "low" } }),
      "q's",
      1_000,
    );
    expect(replayBoardCommand(ctx.db, key(), NOW)).toEqual({ reply: "p's" });
    expect(
      replayBoardCommand(
        ctx.db,
        key({ workspaceId: "q", intent: { ticketId: "u", priority: "low" } }),
        NOW,
      ),
    ).toEqual({ reply: "q's" });
  });

  it("stores an undefined reply as null", () => {
    recordBoardCommand(ctx.db, key(), undefined, 1_000);
    expect(replayBoardCommand(ctx.db, key(), NOW)).toEqual({ reply: null });
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
    expect(replayBoardCommand(ctx.db, key({ commandId: "old" }), now)).toBeUndefined();
    expect(replayBoardCommand(ctx.db, key({ commandId: "edge" }), now)).toEqual({ reply: "edge" });
    expect(replayBoardCommand(ctx.db, key({ commandId: "new" }), now)).toEqual({ reply: "new" });
    expect(receiptCount()).toBe(2);
  });

  it("never replays an expired receipt, pruned or not: the next write records afresh", () => {
    recordBoardCommand(ctx.db, key(), "first", 1_000);
    const later = 1_000 + BOARD_RECEIPT_RETENTION_MS;
    // Inside retention to the millisecond, then past it with nothing written between.
    expect(replayBoardCommand(ctx.db, key(), later)).toEqual({ reply: "first" });
    expect(replayBoardCommand(ctx.db, key(), later + 1)).toBeUndefined();
    expect(replayOrphanedBoardCommand(ctx.db, key(), later + 1)).toBeUndefined();
    // Another intent under the expired id is no conflict either.
    expect(
      replayBoardCommand(ctx.db, key({ intent: { ticketId: "t", priority: "low" } }), later + 1),
    ).toBeUndefined();
    expect(receiptCount()).toBe(1);
    // The write it lets through prunes the expired row before recording its own.
    recordBoardCommand(ctx.db, key(), "second", later + 1);
    expect(replayBoardCommand(ctx.db, key(), later + 1)).toEqual({ reply: "second" });
    expect(receiptCount()).toBe(1);
  });

  it("holds receipts for a week", () => {
    expect(BOARD_RECEIPT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
