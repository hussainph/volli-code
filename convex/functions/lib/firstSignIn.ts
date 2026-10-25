/**
 * What a person's first sign-in sets up, beyond their `users` row.
 *
 * `accounts.ensureViewer` calls {@link onFirstSignIn} inside its own
 * transaction, exactly once per person: when it has just created the row. So
 * whatever this writes commits with the account or not at all, and a retried
 * first call (which finds the row) never runs it twice.
 *
 * Today that is the person's own Workspace, named after them, with them as
 * its one owner (there are no Workspace types: inviting someone just adds a
 * Member).
 */

import type { GenericDatabaseWriter } from "convex/server";

import type { DataModel } from "../_generated/dataModel.js";
import type { Viewer } from "./auth";
import { createPersonalWorkspace } from "./workspaces";

export type FirstSignInCtx = { db: GenericDatabaseWriter<DataModel> };

export async function onFirstSignIn(ctx: FirstSignInCtx, viewer: Viewer): Promise<void> {
  await createPersonalWorkspace(ctx, viewer);
}
