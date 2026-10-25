/**
 * What a person's first sign-in sets up, beyond their `users` row.
 *
 * `accounts.ensureViewer` calls {@link onFirstSignIn} inside its own
 * transaction on the first granted sign-in. The optional user setup marker
 * is committed with the Workspace, so retries never create a second one;
 * waitlisted accounts create no Workspace.
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
