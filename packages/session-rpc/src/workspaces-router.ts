import {
  HOST_WORKSPACE_BOUNDS,
  HOST_WORKSPACE_ENTRIES,
  HOST_WORKSPACE_FAILURE_CODES,
  type CatalogKeyOf,
  type HostHandler,
  type HostWorkspaceCreateInput,
  type HostWorkspaceCreateResult,
  type HostWorkspaceEntry,
  type HostWorkspaceList,
} from "@volli/shared";
import type { JsonUnsafeProcedures } from "@volli/host-protocol";
import { z } from "zod";

import {
  createCatalogBuilders,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
} from "./catalog";
import { procedureSchemas } from "./procedure-schema";

export interface WorkspaceHandlers {
  readonly "workspaces.list": HostHandler<void, HostWorkspaceList>;
  readonly "workspaces.create": HostHandler<HostWorkspaceCreateInput, HostWorkspaceCreateResult>;
}
interface WorkspacesContext extends CatalogCallerContext {
  handlers: WorkspaceHandlers;
}
const { hostProcedure, catalogRouter } = createCatalogBuilders<
  WorkspacesContext,
  HostWorkspaceEntry
>({
  entries: HOST_WORKSPACE_ENTRIES,
});
const bounds = HOST_WORKSPACE_BOUNDS;
const workspace = z.object({
  id: z.uuidv4(),
  name: z.string().min(1).max(bounds.name),
  path: z.string().min(1).max(bounds.path),
  gitRemoteUrl: z.string().max(bounds.gitUrl).nullable(),
});
// All enums (ok and failure.code) and the result union are explicitly closed.
const createResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), workspace }),
  z.object({
    ok: z.literal(false),
    failure: z.object({
      code: z.enum(HOST_WORKSPACE_FAILURE_CODES),
      message: z.string().max(bounds.message),
    }),
  }),
]);

/** Thin projection of the host's own project registration service. */
export function createWorkspacesRouter() {
  return catalogRouter({
    workspaces: {
      list: hostProcedure("workspaces.list")
        .output(
          z.object({
            workspaces: z.array(workspace).max(bounds.rows).readonly(),
            omitted: z.number().int().nonnegative().safe(),
          }),
        )
        .query(({ ctx }) => ctx.handlers["workspaces.list"](undefined, ctx.call)),
      create: hostProcedure("workspaces.create")
        .input(
          z.object({
            commandId: z.uuidv4(),
            source: z.union([
              z.strictObject({ path: z.string().min(1).max(bounds.path) }),
              z.strictObject({ gitUrl: z.string().min(1).max(bounds.gitUrl) }),
            ]),
            name: z
              .string()
              .refine(
                (name) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name),
                "Name contains control characters.",
              )
              .transform((name) => name.trim())
              .pipe(z.string().min(1).max(bounds.name))
              .optional(),
          }),
        )
        .output(createResult)
        .mutation(({ ctx, input }) => ctx.handlers["workspaces.create"](input, ctx.call)),
    },
  });
}
export type WorkspacesRouter = ReturnType<typeof createWorkspacesRouter>;
type AssertNever<T extends never> = T;
export type WorkspacesCatalogBinding = AssertNever<
  CatalogMismatch<
    ProcedurePaths<WorkspacesRouter["_def"]["record"]>,
    CatalogKeyOf<HostWorkspaceEntry>
  >
>;
export type WorkspacesJsonSafety = AssertNever<JsonUnsafeProcedures<WorkspacesRouter>>;
/** Schemas come from the actual validators, never a handwritten artifact. */
export function workspacesProcedureSchemas() {
  return procedureSchemas(createWorkspacesRouter(), {});
}
