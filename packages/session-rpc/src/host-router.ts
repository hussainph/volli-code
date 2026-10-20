/**
 * The routers a host serves, composed into one and checked as one set (HP §
 * Command catalog, "Where area routers live").
 *
 * Each area family builds its procedures with its own tRPC instance and its
 * own provenance (`createCatalogBuilders`), and its `catalogRouter` has
 * already refused anything its builders did not make. This module joins the
 * families' procedure records under one tRPC instance that answers with the
 * same error envelope ({@link catalogErrorFormatter}), so a door (hostd's
 * WebSocket) serves one router; the desktop's generic IPC bridge serves the
 * same families side by side (`DESKTOP_IPC_EXPOSURE`). It adds no
 * procedure and no middleware of its own.
 *
 * The assertions below are over the union of every family's paths: every
 * catalog key is some router's procedure, no path is two families', every
 * feature grants only served paths, and every family's resource kinds are its
 * own.
 */
import { initTRPC } from "@trpc/server";
import type { HostOperation, JsonUnsafeProcedures } from "@volli/host-protocol";

import type { BoardResourceKind } from "@volli/shared";

import { createBoardRouter, type BoardRouter, type BoardRouterContext } from "./board-router";
import {
  catalogErrorFormatter,
  type CatalogMismatch,
  type CatalogCallerContext,
  type ProcedurePaths,
  type PROJECT_RESOURCE,
} from "./catalog";
import type { DesktopRouter } from "./desktop-router";
import type { SESSION_RESOURCE } from "./session-catalog";
import { createSessionRouter, type AppRouter, type SessionRouterContext } from "./index";

import {
  createWorkspacesRouter,
  type WorkspacesRouter,
  type WorkspaceHandlers,
} from "./workspaces-router";

type AssertNever<Type extends never> = Type;

/** Every procedure path any router serves. */
export type HostRouterPaths =
  | ProcedurePaths<AppRouter["_def"]["record"]>
  | ProcedurePaths<BoardRouter["_def"]["record"]>
  | ProcedurePaths<WorkspacesRouter["_def"]["record"]>;

/**
 * Every catalog key is a procedure of some router, and every procedure a
 * catalog key: an entry no router serves fails `pnpm typecheck` here.
 */
export type HostRouterCatalogBinding = AssertNever<CatalogMismatch<HostRouterPaths>>;

/** No path is two families': a shadowed procedure would be silent once they compose. */
export type HostRouterPathsDisjoint = AssertNever<
  Extract<
    ProcedurePaths<AppRouter["_def"]["record"]>,
    ProcedurePaths<BoardRouter["_def"]["record"]>
  >
>;

/**
 * No resource kind is two families' (VC-565): a composition root answers one
 * `resourceWorkspace` port for every family, so a kind two families named
 * would be resolved by whichever answered first. `project` is the catalog's
 * own (a Workspace), and no family may name it as an area kind.
 */
export type HostRouterResourceKindsDisjoint = AssertNever<
  | Extract<typeof SESSION_RESOURCE, BoardResourceKind>
  | Extract<typeof PROJECT_RESOURCE, typeof SESSION_RESOURCE | BoardResourceKind>
>;

/**
 * Every operation a v1 feature grants is a procedure some router serves
 * (`HOST_FEATURE_OPERATIONS`, VC-663/VC-669): a feature naming a key no
 * router has fails `pnpm typecheck` here.
 */
export type HostRouterFeatureBinding = AssertNever<Exclude<HostOperation, HostRouterPaths>>;

/**
 * The context a composed router is called with: the catalog's ports, plus the
 * union of every family's slice of the host's one handler map (the router
 * policy's view, `admittedHandlers(map, ROUTER_POLICY)`).
 */
export interface HostRouterContext extends CatalogCallerContext {
  handlers: SessionRouterContext["handlers"] & BoardRouterContext["handlers"] & WorkspaceHandlers;
}

const t = initTRPC.context<HostRouterContext>().create({
  isDev: false,
  errorFormatter: catalogErrorFormatter,
});

/**
 * The one router a host serves: every family's procedures, each still behind
 * its own entry's policy. Top-level namespaces are disjoint by
 * {@link HostRouterPathsDisjoint}; this throws at construction if a family
 * ever reuses one, rather than letting a spread silently shadow it.
 */
export function createHostRouter() {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's router record door.
  const session = createSessionRouter()._def.record;
  // oxlint-disable-next-line no-underscore-dangle -- as above.
  const board = createBoardRouter()._def.record;
  for (const namespace of Object.keys(board)) {
    if (Object.hasOwn(session, namespace)) {
      throw new Error(`Router namespace ${namespace} belongs to two families`);
    }
  }
  // oxlint-disable-next-line no-underscore-dangle -- tRPC router composition.
  const workspaces = createWorkspacesRouter()._def.record;
  for (const namespace of Object.keys(workspaces)) {
    if (Object.hasOwn(session, namespace) || Object.hasOwn(board, namespace)) {
      throw new Error(`Router namespace ${namespace} belongs to two families`);
    }
  }
  return t.router({ ...session, ...board, ...workspaces } as typeof session &
    typeof board &
    typeof workspaces);
}

export type HostRouter = ReturnType<typeof createHostRouter>;

/** The composed seam, checked once more: every path survives JSON (BOUNDARIES rule 3). */
export type HostRouterJsonSafety = AssertNever<JsonUnsafeProcedures<HostRouter>>;

/**
 * The desktop-only tier's paths are no public router's (VC-608): a key is
 * public or desktop-only, never both, so promoting one moves its procedure.
 */
export type DesktopRouterPathsDisjoint = AssertNever<
  Extract<ProcedurePaths<DesktopRouter["_def"]["record"]>, HostRouterPaths>
>;
