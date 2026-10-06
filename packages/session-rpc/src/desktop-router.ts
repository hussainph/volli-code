/**
 * The desktop-only tier's router (VC-608; HP § Command catalog, D-A1 = (c)):
 * host commands only the desktop's own window calls, moved off per-channel
 * IPC onto the router-generic bridge without the public catalog's ceremony.
 *
 * Built like any area router, from one family of catalog builders, but over
 * the desktop-only entries (`DESKTOP_CATALOG_ENTRIES`, `@volli/shared`),
 * whose policy is derived from each channel's VC-574 placement and nothing
 * else: a `workspace` entry is a `workspaceProcedure` that names every
 * resource its input addresses, a `host` entry a `hostProcedure`; both are the
 * person's, on no network door. Every procedure calls `ctx.handlers[key]`,
 * the host's one map, exactly as a public procedure does.
 *
 * Adding a desktop-only command, the template the area tickets copy:
 *
 * 1. append its declaration to `DESKTOP_ENTRIES` (key, the channel's
 *    placement, idempotency, summary);
 * 2. move the channel's handler body into host-core's map
 *    (`HostHandlerSignatures`, `createHostHandlers`), and declare its slice
 *    below in {@link DesktopRouterHandlers};
 * 3. build its procedure here with both zod validators and its resources;
 * 4. classify its path `ipc` in `DESKTOP_IPC_EXPOSURE`, give it a
 *    `SAMPLE_INPUTS` row, regenerate the protocol schema (its `desktop`
 *    tier), and move its renderer callers onto the Session RPC client;
 * 5. delete the channel from `contract.ts`, `ipc-descriptors.ts`,
 *    `preload/index.ts` and `data-ipc.ts`, and record it in placement.ts's
 *    `BRIDGED_CHANNELS`.
 *
 * Every step but the last is checked by `pnpm typecheck` or a test.
 */
import {
  DESKTOP_CATALOG_ENTRIES,
  type DesktopCatalogEntry,
  type DesktopKey,
  type HostHandler,
  type Label,
} from "@volli/shared";
import type { JsonUnsafeProcedures } from "@volli/host-protocol";
import { z } from "zod";

import { TICKET_RESOURCE } from "./board-router";
import {
  createCatalogBuilders,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterContextPorts,
} from "./catalog";
import { procedureSchemas } from "./procedure-schema";

/** The label resource kind: a label belongs to one project's board. */
export const LABEL_RESOURCE = "label";

/** The slice of the host's handler map the desktop router projects (D2: structural). */
export interface DesktopRouterHandlers {
  readonly "ticket.body": HostHandler<{ ticketId: string }, string | null>;
  readonly "label.setColor": HostHandler<{ labelId: string; color: string | null }, Label | null>;
}

type AssertNever<Type extends never> = Type;

/** The desktop tier's keys and the slice's keys are one set: a missing handler fails here. */
export type DesktopRouterHandlersCoverage = AssertNever<
  CatalogMismatch<keyof DesktopRouterHandlers & string, DesktopKey>
>;

/** The desktop router's context: the catalog's ports and the map, nothing else. */
export interface DesktopRouterContext extends CatalogCallerContext {
  handlers: DesktopRouterHandlers;
}

export type DesktopRouterContextPorts = AssertNever<RouterContextPorts<DesktopRouterContext>>;

const { workspaceProcedure, catalogRouter } = createCatalogBuilders<
  DesktopRouterContext,
  DesktopCatalogEntry
>({ entries: DESKTOP_CATALOG_ENTRIES });

const id = z.string().min(1);

const labelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

export function createDesktopRouter() {
  return catalogRouter({
    ticket: {
      /** Was `volli:ticket-body`: null for a ticket that is gone, as `{ ok: false }` was. */
      body: workspaceProcedure("ticket.body", z.object({ ticketId: id }), (input) => ({
        kind: TICKET_RESOURCE,
        id: input.ticketId,
      }))
        .output(z.string().nullable())
        .query(({ ctx, input }) => ctx.handlers["ticket.body"](input, ctx.call)),
    },
    label: {
      /** Was `volli:label-set-color`: null for a label that is gone. */
      setColor: workspaceProcedure(
        "label.setColor",
        z.object({ labelId: id, color: z.string().nullable() }),
        (input) => ({ kind: LABEL_RESOURCE, id: input.labelId }),
      )
        .output(labelSchema.nullable())
        .mutation(({ ctx, input }) => ctx.handlers["label.setColor"](input, ctx.call)),
    },
  });
}

export type DesktopRouter = ReturnType<typeof createDesktopRouter>;

/** Every desktop procedure has its entry, and every desktop entry its procedure. */
export type DesktopRouterCatalogBinding = AssertNever<
  CatalogMismatch<ProcedurePaths<DesktopRouter["_def"]["record"]>, DesktopKey>
>;

/** Every desktop procedure's input and output survive JSON (docs/BOUNDARIES.md, rule 3). */
export type DesktopRouterJsonSafety = AssertNever<JsonUnsafeProcedures<DesktopRouter>>;

/** The desktop tier's published grammar, from its actual validators: diffed additive-only. */
export function desktopProcedureSchemas(router: DesktopRouter = createDesktopRouter()) {
  return procedureSchemas(router);
}
