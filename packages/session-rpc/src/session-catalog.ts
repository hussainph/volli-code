/**
 * The Session router's catalog builders: one family from
 * {@link createCatalogBuilders}, bound to the Session router's context and the
 * Verb Registry. Only `createSessionRouter` and its tests build from them;
 * an area router makes its own family with its own context.
 */
import { createCatalogBuilders, type WorkspaceResource } from "./catalog";
import type { SessionRouterContext } from "./index";

/** The kind a Session call's resource is: resolved by the context's `resourceWorkspace` port. */
export const SESSION_RESOURCE = "session";

/** A Session call's resource: the Session it names. */
export function sessionResource(input: { sessionId: string }): WorkspaceResource {
  return { kind: SESSION_RESOURCE, id: input.sessionId };
}

export const { hostProcedure, workspaceProcedure, catalogRouter, assertCatalogBound } =
  createCatalogBuilders<SessionRouterContext>({
    // The Session procedures that return runtime projections predate the
    // catalog; named here so the list can only shrink (HP § Command catalog).
    legacyUnvalidatedOutputs: [
      "sessions.create",
      "sessions.attach",
      "session.cancelInteraction",
      "session.reconcile",
      "labDiagnostics.list",
    ],
  });
