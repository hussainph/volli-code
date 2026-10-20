/**
 * The Session router's catalog builders: one family from
 * {@link createCatalogBuilders}, bound to the Session router's context and the
 * Verb Registry. Only `createSessionRouter` and its tests build from them;
 * an area router makes its own family with its own context.
 */
import {
  BOARD_ENTRIES,
  HOST_WORKSPACE_ENTRIES,
  type HostWorkspaceEntry,
  VERB_REGISTRY,
  type BoardEntry,
  type VerbRegistryEntry,
} from "@volli/shared";

import { createCatalogBuilders, type WorkspaceResource } from "./catalog";
import type { SessionRouterContext } from "./index";

/**
 * The Session family's rows: every registry row but another area's. Typed and
 * filtered so the family can build no other area's key, at the type or at
 * runtime (HP § Command catalog, "Adding a command").
 */
export type SessionRouterEntry = Exclude<VerbRegistryEntry, BoardEntry | HostWorkspaceEntry>;

const OTHER_AREAS: ReadonlySet<string> = new Set(
  [...BOARD_ENTRIES, ...HOST_WORKSPACE_ENTRIES].map(({ key }) => key),
);

function isSessionRouterEntry(entry: VerbRegistryEntry): entry is SessionRouterEntry {
  return !OTHER_AREAS.has(entry.key);
}

/** The kind a Session call's resource is: resolved by the context's `resourceWorkspace` port. */
export const SESSION_RESOURCE = "session";

/** A Session call's resource: the Session it names. */
export function sessionResource(input: { sessionId: string }): WorkspaceResource {
  return { kind: SESSION_RESOURCE, id: input.sessionId };
}

export const { hostProcedure, workspaceProcedure, catalogRouter, assertCatalogBound } =
  createCatalogBuilders<SessionRouterContext, SessionRouterEntry>({
    entries: VERB_REGISTRY.filter(isSessionRouterEntry),
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
