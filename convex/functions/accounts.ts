/**
 * The signed-in person's account. The first thing a client calls after sign-in
 * is {@link ensureViewer}; every other function then resolves the caller with
 * the helpers in `lib/auth.ts`.
 */

import { mutation, query } from "./_generated/server";
import { ensureViewer as ensureViewerRow, findViewer } from "./lib/auth";
import { createPersonalWorkspace } from "./lib/workspaces";

export type ViewerSummary = {
  userId: string;
  displayName: string;
  primaryEmail: string | null;
};

/**
 * Creates the caller's `users` row and personal Workspace on first sign-in;
 * afterwards returns the row. Idempotent.
 */
export const ensureViewer = mutation({
  args: {},
  handler: async (ctx): Promise<ViewerSummary & { created: boolean }> => {
    const viewer = await ensureViewerRow(ctx);
    const { userId, user, created } = viewer;
    // Every account gets a Workspace of its own at sign-up, in the same transaction.
    if (created) await createPersonalWorkspace(ctx, viewer);
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
