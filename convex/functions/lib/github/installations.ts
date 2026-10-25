/**
 * Writing `githubInstallations` rows and the `projectRepos` access they
 * imply. Installations are global and unique by `installationId`; every
 * writer goes through {@link upsertInstallation}.
 */

import type { GenericDatabaseWriter } from "convex/server";
import { v } from "convex/values";

import {
  GITHUB_ACCOUNT_TYPES,
  GITHUB_REPOSITORY_SELECTIONS,
  newId,
  type GithubInstallationFacts,
  type GithubRepoAccess,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../../_generated/dataModel.js";
import { literals } from "../validators";

type Db = GenericDatabaseWriter<DataModel>;

/** `GithubInstallationFacts` as a function argument. */
export const installationFacts = v.object({
  installationId: v.string(),
  accountId: v.string(),
  accountLogin: v.string(),
  accountType: literals(GITHUB_ACCOUNT_TYPES),
  repositorySelection: literals(GITHUB_REPOSITORY_SELECTIONS),
  permissions: v.record(v.string(), v.string()),
  events: v.array(v.string()),
  suspended: v.boolean(),
});

export async function findInstallation(
  db: Db,
  installationId: string,
): Promise<Doc<"githubInstallations"> | null> {
  return db
    .query("githubInstallations")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .unique();
}

/**
 * Records an installation as GitHub describes it now: a live installation
 * (`deletedAt` cleared), suspended or not. The first Volli person to record
 * it stays its `installedByUserId`.
 */
export async function upsertInstallation(
  db: Db,
  facts: GithubInstallationFacts,
  options: { installedByUserId: string | null; now: number },
): Promise<Doc<"githubInstallations">> {
  const existing = await findInstallation(db, facts.installationId);
  const fields = {
    accountId: facts.accountId,
    accountLogin: facts.accountLogin,
    accountType: facts.accountType,
    repositorySelection: facts.repositorySelection,
    permissions: { ...facts.permissions },
    events: [...facts.events],
    suspendedAt: facts.suspended ? (existing?.suspendedAt ?? options.now) : null,
    deletedAt: null,
  };
  if (existing !== null) {
    await db.patch(existing._id, {
      ...fields,
      installedByUserId: existing.installedByUserId ?? options.installedByUserId,
    });
    return (await db.get(existing._id))!;
  }
  const id = await db.insert("githubInstallations", {
    id: newId("githubInstallation"),
    installationId: facts.installationId,
    installedByUserId: options.installedByUserId,
    reconciledAt: null,
    ...fields,
  });
  return (await db.get(id))!;
}

/** Sets `githubAccess` on every project repository the installation holds. */
export async function setInstallationRepoAccess(
  db: Db,
  installationId: string,
  access: GithubRepoAccess,
  now: number,
): Promise<number> {
  const rows = await db
    .query("projectRepos")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .collect();
  for (const row of rows) {
    await db.patch(row._id, { githubAccess: access, accessCheckedAt: now });
  }
  return rows.length;
}
