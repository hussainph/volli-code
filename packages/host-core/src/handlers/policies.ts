/**
 * The catalog's door policies at the handler map (VC-668; HP § Command
 * catalog, "One handler map").
 *
 * The catalog's doors (the routers, over IPC and WebSocket, and the desktop
 * window's legacy channels that still serve a catalog command) judge a call
 * by its entry: the router actor (`catalog.actor`, else `actor`), the access
 * modes, and who the door authenticated. These policies are that judgement
 * on what reaches the map, transport-independent: a key and a
 * {@link HandlerCall}, never a tRPC context.
 *
 * A router judges the same rule first, in its own middleware, together with
 * what only it can read (a credential that is still current, the Workspace a
 * resource lives in, a Session's per-subject authority). The map judges it
 * again, so a router context handed a raw handler is not a way around it.
 *
 * The agent socket is not a catalog door: its coordination policy reads the
 * Verb Registry's `actor` and per-project authority, and lives with it in
 * `agent-dispatch/admission.ts`.
 */
import {
  CATALOG_ENTRIES,
  catalogActorAdmits,
  catalogActorOf,
  catalogLookup,
  type HandlerCall,
  type HostHandlerKey,
} from "@volli/shared";

import { ADMITTED, refused, type AdmissionVerdict, type HandlerPolicy } from "./handler-map";

const entryOf = catalogLookup(CATALOG_ENTRIES);

/** The policy actor a call's attributed actor is, or null for one no catalog entry admits. */
function policyActorOf(call: HandlerCall): "user" | "session" | null {
  switch (call.actor.kind) {
    case "user":
      return "user";
    case "session":
      return "session";
    default:
      return null;
  }
}

/**
 * The catalog entry's admission, as a router's middleware judges it: the
 * desktop's own window reaches every declared entry, any other caller only
 * the entries the WebSocket projects (`hostApi`), and only an actor the
 * entry's router actor admits. A `session-own` entry admits a Session here;
 * the router has already judged each subject.
 */
export function catalogVerdict(key: HostHandlerKey, call: HandlerCall): AdmissionVerdict {
  const entry = entryOf(key);
  const actor = policyActorOf(call);
  const desktopWindow = call.origin === "desktop-window";
  const admitted =
    actor !== null &&
    // Only the person's own window is the desktop window.
    (!desktopWindow || actor === "user") &&
    (desktopWindow || entry.accessModes.includes("hostApi")) &&
    catalogActorAdmits(catalogActorOf(entry), actor) !== "refused";
  return admitted ? ADMITTED : refused(`${key} is not open to this caller.`);
}

/** A router's policy at the map, over IPC or WebSocket. */
export const ROUTER_POLICY: HandlerPolicy = Object.freeze({
  door: "router",
  admit: (key: HostHandlerKey, _input: unknown, call: HandlerCall) => catalogVerdict(key, call),
});

/**
 * The desktop window's legacy IPC channels that still serve a catalog
 * command (`volli:ticket-move`, until VC-565): only the trusted desktop
 * identity, then the catalog's rule for it. Synchronous, so the channel's
 * reply stays synchronous where its handler's is.
 */
export const DESKTOP_WINDOW_POLICY: HandlerPolicy = Object.freeze({
  door: "desktop-ipc",
  admit: (key: HostHandlerKey, _input: unknown, call: HandlerCall) =>
    call.origin === "desktop-window"
      ? catalogVerdict(key, call)
      : refused(`${key} is open on this channel only to the desktop's own window.`),
});
