/**
 * Who a runner is: the check every runner-called function starts with.
 *
 * A runner calls with a runner token: a short-lived JWT this deployment
 * issues at `/runner/token` (`runnerHttp.ts`) for a rotated refresh
 * credential. Its issuer is {@link RUNNER_TOKEN_ISSUER}, its subject
 * `runner:<uuid>`. Authority comes from the `runners` row, never from the
 * token's claims: the row says who owns the runner, and a removed or cut-off
 * runner (`revokedAt`) stops at once, without waiting for its token to expire.
 *
 * A runner token is never a person: `ensureViewer` refuses it, so a runner
 * cannot mint itself a `users` row, and person-facing functions see no
 * viewer for it.
 *
 * A runner serves its owner only, so a runner whose owner's account is no
 * longer active (deletion pending or deleted), whose preview grant expired or
 * was revoked, or who needs to accept the current agreement is refused as
 * `revoked` too. Existing tokens never outlive that authorization.
 *
 * Every runner MUTATION starts with {@link requireRunnerForWrite}: the first
 * write with a token of the current credential generation is what ends the
 * previous credential's grace (see `runners.rotateCredential`). Queries use
 * {@link requireRunner}, which writes nothing.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter, UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";

import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  runnerIdFromSubject,
  type RunnerId,
  type UserId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { hasPreviewAgreement, previewAccess } from "./previewAccess";

export type RunnerAuthErrorCode = "unauthenticated" | "not_a_runner" | "revoked";

export type RunnerAuthErrorData = { code: RunnerAuthErrorCode; message: string };

export function runnerAuthError(
  code: RunnerAuthErrorCode,
  message: string,
): ConvexError<RunnerAuthErrorData> {
  return new ConvexError({ code, message });
}

/** Whether `identity` came from the Agent-token issuer (and so is neither a person nor a runner). */
export function isAgentIdentity(identity: Pick<UserIdentity, "issuer">): boolean {
  return identity.issuer === AGENT_TOKEN_ISSUER;
}

/** Whether `identity` came from the runner-token issuer (and so is not a person). */
export function isRunnerIdentity(identity: Pick<UserIdentity, "issuer">): boolean {
  return identity.issuer === RUNNER_TOKEN_ISSUER;
}

/** The calling runner, resolved to its live row. */
export interface CallingRunner {
  runnerId: RunnerId;
  ownerUserId: UserId;
  runner: Doc<"runners">;
  /** The credential generation the token was minted for, or `null` if it carries none. */
  tokenGeneration: number | null;
}

type RunnerCtx = {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  db: GenericDatabaseReader<DataModel>;
};

/**
 * The runner calling, or `unauthenticated` / `not_a_runner` / `revoked`.
 * A token for a runner row that no longer exists reads as `revoked`: either
 * way the box must be linked again.
 */
export async function requireRunner(ctx: RunnerCtx): Promise<CallingRunner> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw runnerAuthError("unauthenticated", "Link this runner to continue.");
  const runnerId = isRunnerIdentity(identity) ? runnerIdFromSubject(identity.subject) : null;
  if (runnerId === null) throw runnerAuthError("not_a_runner", "Only a runner can call this.");
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", runnerId))
    .unique();
  if (runner === null || runner.revokedAt !== null) {
    throw runnerAuthError("revoked", "This runner was removed from its account.");
  }
  const owner = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", runner.ownerUserId))
    .unique();
  if (owner === null || owner.status !== "active") {
    throw runnerAuthError("revoked", "This runner's account is closing or closed.");
  }
  if (
    !hasPreviewAgreement(owner) ||
    (await previewAccess(ctx, { userId: owner.id as UserId, user: owner })) !== "granted"
  ) {
    throw runnerAuthError("revoked", "This runner's account no longer has preview access.");
  }
  const gen = identity.gen;
  return {
    runnerId,
    ownerUserId: runner.ownerUserId as UserId,
    runner,
    tokenGeneration: typeof gen === "number" ? gen : null,
  };
}

/**
 * {@link requireRunner} for a mutation. The first call carrying a token of
 * the current generation proves the box persisted that credential (it saves
 * the credential before using the token), so the previous one's grace ends
 * here, whichever runner mutation comes first.
 */
export async function requireRunnerForWrite(ctx: {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  db: GenericDatabaseWriter<DataModel>;
}): Promise<CallingRunner> {
  const caller = await requireRunner(ctx);
  if (caller.tokenGeneration !== null) {
    const credentials = await ctx.db
      .query("runnerCredentials")
      .withIndex("by_runner", (q) => q.eq("runnerId", caller.runnerId))
      .unique();
    if (
      credentials !== null &&
      credentials.generation === caller.tokenGeneration &&
      credentials.currentFirstUsedAt === null
    ) {
      await ctx.db.patch(credentials._id, { currentFirstUsedAt: Date.now() });
    }
  }
  return caller;
}
