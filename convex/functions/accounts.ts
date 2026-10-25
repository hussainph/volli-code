/**
 * The signed-in person's account. The first thing a client calls after sign-in
 * is {@link ensureViewer}; every other function then resolves the caller with
 * the helpers in `lib/auth.ts`.
 */

import { mutation, query } from "./_generated/server";
import { ensureViewer as ensureViewerRow, findViewer } from "./lib/auth";
import { onFirstSignIn } from "./lib/firstSignIn";

export type ViewerSummary = {
  userId: string;
  displayName: string;
  primaryEmail: string | null;
};

/**
 * Creates the caller's `users` row on first sign-in (and runs the first
 * sign-in setup, `lib/firstSignIn.ts`, in the same transaction); afterwards
 * returns it. Idempotent.
 */
export const ensureViewer = mutation({
  args: {},
  handler: async (ctx): Promise<ViewerSummary & { created: boolean }> => {
    const viewer = await ensureViewerRow(ctx);
    const { userId, user, created } = viewer;
    if (created) await onFirstSignIn(ctx, viewer);
    return { userId, displayName: user.displayName, primaryEmail: user.primaryEmail, created };
  },
});

/** The caller's account, or `null` before {@link ensureViewer} has run for this identity. */
export const viewer = query({
  args: {},
  handler: async (ctx): Promise<ViewerSummary | null> => {
    const found = await findViewer(ctx);
    return found === null
      ? null
      : {
          userId: found.userId,
          displayName: found.user.displayName,
          primaryEmail: found.user.primaryEmail,
        };
  },
});
