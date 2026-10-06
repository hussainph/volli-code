/**
 * The routers a host serves, checked as one set (HP § Command catalog, "Where
 * area routers live"). The second router, the board's, landed with VC-668, so
 * the binding assertion over the union of every router's paths lives here.
 * Composing the families into one served router (each has its own tRPC
 * instance) is VC-565's, when the board router gains its other commands.
 */
import type { CatalogMismatch, ProcedurePaths } from "./catalog";
import type { BoardRouter } from "./board-router";
import type { AppRouter } from "./index";

type AssertNever<Type extends never> = Type;

/** Every procedure path any router serves. */
export type HostRouterPaths =
  | ProcedurePaths<AppRouter["_def"]["record"]>
  | ProcedurePaths<BoardRouter["_def"]["record"]>;

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
