/**
 * One `RuntimeCatalog` per resolved project directory, shared for the app's
 * lifetime. `runtimeCatalog.*` procedures carry an optional `projectId`; this
 * hub is what `SessionRouterContext.resolveRuntimeCatalog` becomes in
 * production, so a project's model discovery is scoped to ITS checkout
 * instead of whichever directory happened to construct the catalog first.
 *
 * An undefined `projectId` resolves to `fallbackDirectory` (the Session has
 * no project yet). An unknown `projectId` throws — the router maps that to
 * `NOT_FOUND` — rather than silently falling back to some other directory,
 * which is exactly the "probe the wrong checkout" failure this design exists
 * to prevent.
 *
 * Deliberately no dispose: every catalog instance wraps the SAME shared
 * adapter `main/index.ts` owns for the process's lifetime, and a per-catalog
 * teardown would tear down the server lease out from under every other
 * project's still-open sessions. The cache is unbounded by design too — this
 * is a single-user desktop app; a catalog per directory for the few dozen
 * projects it will ever see, held for the process's life, is cheap enough
 * that eviction would solve a problem that does not exist.
 */
import type Database from "better-sqlite3";
import type { RuntimeCatalog } from "@volli/session-engine";

import { getProjectById } from "./db/projects-repo";
import { createRuntimeCatalog, type RuntimeCatalogDiscoveryAdapter } from "./runtime-catalog";

export interface RuntimeCatalogHubOptions {
  db: Database.Database;
  adapters: readonly RuntimeCatalogDiscoveryAdapter[];
  fallbackDirectory: string;
  now?: () => number;
}

export function createRuntimeCatalogHub(
  options: RuntimeCatalogHubOptions,
): (projectId?: string) => RuntimeCatalog {
  const catalogs = new Map<string, RuntimeCatalog>();

  const catalogForDirectory = (directory: string): RuntimeCatalog => {
    const existing = catalogs.get(directory);
    if (existing) return existing;
    const catalog = createRuntimeCatalog({
      db: options.db,
      directory,
      adapters: options.adapters,
      now: options.now,
    });
    catalogs.set(directory, catalog);
    return catalog;
  };

  return (projectId?: string): RuntimeCatalog => {
    if (projectId === undefined) return catalogForDirectory(options.fallbackDirectory);
    const project = getProjectById(options.db, projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    return catalogForDirectory(project.path);
  };
}
