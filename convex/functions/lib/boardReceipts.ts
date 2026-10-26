/**
 * Board receipts: every board mutation is idempotent by its caller-minted
 * `commandId`.
 *
 * {@link withBoardReceipt} wraps a board write. A live receipt for the same
 * operation and intent answers its recorded reply and changes nothing; the
 * same id with another intent is `command_conflict`; otherwise the write runs
 * and its reply is recorded in the same transaction, for seven days. Two
 * concurrent first attempts both read the receipt's index range, so the
 * backend's concurrency control retries the later one, which then replays.
 *
 * Board commands have this one receipt: the backend is their issuer, so
 * acceptance and completion are the same event.
 */

import {
  boardIntentDigest,
  boardReceiptExpiry,
  boardReceiptVerdict,
  parseId,
} from "@volli/shared/cloud";

import type { MutationCtx } from "../_generated/server.js";
import { PERSON_ONLY, requireActor, type Caller, type CallerKind } from "./actorAuth";
import { requireProject } from "./auth";
import { asBoardErrors, boardError } from "./board";

export interface BoardReceipt {
  commandId: string;
  status: "completed";
  /** `true` when this answer is the recorded one of an earlier, identical command. */
  replayed: boolean;
}

/** A recorded reply: plain JSON, small (ids and outcomes; clients read rows by query). */
export type BoardReply = Record<string, unknown>;

/**
 * Runs `write` once per `commandId`. `write` returns the project the command
 * belongs to (the receipt's scope) and the reply to record.
 *
 * The caller is part of the command: the same id sent by another person (or
 * by an agent, or by its owner directly) is a conflict, never their replay. A
 * replay is answered only to a caller who can still see the project it was for.
 *
 * `allow` says who may run the command (`lib/actorAuth.ts`): people only
 * unless the function admits agents too.
 */
export async function withBoardReceipt<R extends BoardReply>(
  ctx: MutationCtx,
  command: {
    commandId: string;
    operation: string;
    intent: unknown;
    allow?: readonly CallerKind[];
  },
  write: (caller: Caller) => Promise<{ projectId: string; reply: R }>,
): Promise<R & { receipt: BoardReceipt }> {
  const caller = await requireActor(ctx, command.allow ?? PERSON_ONLY);
  const commandId = await asBoardErrors(() => parseId("command", command.commandId));
  const now = Date.now();
  const stored = await ctx.db
    .query("boardReceipts")
    .withIndex("by_command", (q) => q.eq("commandId", commandId))
    .unique();
  const keyed = {
    operation: command.operation,
    intent: { intent: command.intent, actor: caller.actor },
  };
  const verdict = boardReceiptVerdict(stored, { ...keyed, now });
  if (verdict.kind === "conflict") {
    throw boardError(
      "command_conflict",
      `Command ${commandId} was already used for a different board command.`,
    );
  }
  if (verdict.kind === "replay") {
    await requireProject(ctx, stored!.projectId, caller.viewer);
    return { ...(verdict.reply as R), receipt: { commandId, status: "completed", replayed: true } };
  }
  // An expired receipt still holds the id until the sweep removes it.
  if (stored !== null) await ctx.db.delete(stored._id);
  const { projectId, reply } = await asBoardErrors(() => write(caller));
  await ctx.db.insert("boardReceipts", {
    commandId,
    projectId,
    operation: command.operation,
    intentDigest: boardIntentDigest(keyed.operation, keyed.intent),
    reply,
    createdAt: now,
    expiresAt: boardReceiptExpiry(now),
  });
  return { ...reply, receipt: { commandId, status: "completed", replayed: false } };
}
