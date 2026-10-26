/**
 * Preview enrollment for fixture accounts.
 *
 * Every product call rechecks, per call, a LIVE deployment grant and an
 * explicitly accepted current Preview Agreement (`requirePreviewAccess`, from
 * `requireViewer`, from a runner token's owner and from an Agent token's
 * Session owner). A signed-in fixture that is not enrolled reads
 * `preview_waitlisted` — or `preview_agreement_required` once granted —
 * instead of the behavior under test.
 *
 * The receipt is patched rather than accepted through `ensureViewer`, so setup
 * never runs first-sign-in Workspace setup: tests that count Workspaces, seats,
 * audit rows or board events see exactly what they seeded. `previewWorkspaceCreated`
 * is set so a later `ensureViewer` cannot create one either. A test whose
 * SUBJECT is the gate or the first sign-in accepts for real instead (see
 * `previewAccess.test.ts`).
 */

import type { ConvexHttpClient } from "convex/browser";
import type { GenericMutationCtx } from "convex/server";

import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import type { connectBackend } from "../fixture/testing";

type Db = Pick<GenericMutationCtx<DataModel>, "db">;
type TestRunner = { run<R>(fn: (ctx: GenericMutationCtx<DataModel>) => Promise<R>): Promise<R> };

/** A live user-UUID grant plus the accepted current agreement, for an account that already exists. */
export async function enrollUser(ctx: Db, userId: string): Promise<void> {
  const grant = await ctx.db
    .query("previewAccess")
    .withIndex("by_kind_key", (q) => q.eq("kind", "user").eq("key", userId))
    .unique();
  if (grant === null) {
    await ctx.db.insert("previewAccess", {
      kind: "user",
      key: userId,
      redeemedByUserId: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: Date.now(),
    });
  } else if (grant.revokedAt !== null) {
    await ctx.db.patch(grant._id, { revokedAt: null });
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", userId))
    .unique();
  if (user === null) throw new Error(`enrollUser: no user ${userId}`);
  await ctx.db.patch(user._id, {
    previewAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    previewAgreementAcceptedAt: Date.now(),
    previewWorkspaceCreated: true,
  });
}

/** {@link enrollUser} for one or more accounts on a `convex-test` instance. Idempotent. */
export async function enrollPreview(
  t: TestRunner,
  userIds: string | readonly string[],
): Promise<void> {
  const ids = typeof userIds === "string" ? [userIds] : userIds;
  await t.run(async (ctx) => {
    for (const userId of ids) await enrollUser(ctx, userId);
  });
}

/**
 * {@link enrollUser} on the pinned local backend, where the account's agreement
 * is a real acceptance (the receipt is written by the product, never patched).
 */
export async function enrollBackendPreview(
  backend: Pick<ReturnType<typeof connectBackend>, "admin">,
  person: Pick<ConvexHttpClient, "mutation">,
  userId: string,
): Promise<void> {
  await backend.admin(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
  await person.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
}
