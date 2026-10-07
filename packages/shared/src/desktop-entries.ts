/**
 * The desktop-only tier of the host's command set (VC-608; HP § Command
 * catalog, D-A1 = (c) hybrid).
 *
 * A desktop-only entry is called only by the desktop's own window:
 * an IPC channel moved out of `data-ipc.ts` onto the router-generic bridge
 * without the public catalog's ceremony (frozen features, N−1 fixtures). It is
 * still one key in the host's ONE handler map (`@volli/host-core/handlers`),
 * still built from an entry by the catalog's builders, and still policed:
 *
 * - **Policy is the channel's VC-574 placement, nothing else.** A `workspace`
 *   entry is workspace-scoped: its procedure names the resources the input
 *   addresses and the router authorizes each one's Workspace before the
 *   handler runs. A `host` entry is host-scoped: device-as-user only. Both are
 *   the person's (`actor: "user"`) and have no access mode, so no network
 *   door serves them and no Session reaches them. Compatibility class is
 *   separate from placement: client-local entries still use this policy
 *   until their router moves out of the host map.
 *   `desktopCatalogEntry` is that derivation, and the only one.
 * - **Two compatibility classes.** Host commands only the window calls stay
 *   additive-only across supported skew: never renamed, removed or changed
 *   in meaning. Client-local entries ship with their renderer and main in one
 *   bundle, so they are not cross-version promises. Both publish schemas in
 *   the `desktop` tier; the gate reports client-local changes without failing.
 * - **Promotion** of a host command to the public tier moves it into the
 *   Verb Registry (with `hostApi`, schemas, features and fixtures) under the
 *   same key, and its procedure into the public area router. The handler
 *   does not move.
 *
 * Keys are router command names, never Electron channel names: the channel a
 * key replaced is recorded by the desktop, beside its placement table
 * (`apps/desktop/src/ipc/placement.ts`). This table lives in `@volli/shared`
 * for the reason the public key sets do: both the host's map (host-core) and
 * the router package build from it, and neither may import the other (D2).
 */
import type { CloudPlacement } from "./app-state-keys";
import type { VerbCatalogDeclaration, VerbEntry, VerbIdempotency } from "./verb-registry";

/** The placements a host command can have: never `client-local`, never `split` (name the half). */
export type DesktopEntryPlacement = Extract<CloudPlacement, "workspace" | "host">;

/** One desktop-only entry; compatibility class does not change runtime policy. */
export interface DesktopEntryDeclaration {
  /** Its identity on the bridge and in the map. */
  readonly key: string;
  /** Host commands are additive-only; client-local changes are report-only. */
  readonly compatibility: "host-command" | "client-local";
  /**
   * The VC-574 placement of the channel it replaced (a `split` channel's
   * non-client half names its `split.scope`). The whole of its policy.
   */
  readonly placement: DesktopEntryPlacement;
  readonly idempotency: VerbIdempotency;
  readonly summary: string;
}

/**
 * Every desktop-only entry, in the order it joined. Host-command keys are
 * additive-only promises to supported builds. Client-local keys ship with
 * their caller in one desktop bundle and may change or leave without a bump.
 */
export const DESKTOP_ENTRIES = [
  {
    key: "project.reorder",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Put the rail's projects in this order.",
  },
  {
    key: "worktree.trimSettings",
    compatibility: "host-command",
    placement: "host",
    idempotency: "read",
    summary: "The host's worktree trim settings: what a finished ticket's trim keeps.",
  },
  // Remote hosts this desktop added over SSH (VC-700 PR 2; wire types in
  // `./remote-hosts`). Host-placed: the registry, its tunnels and its add
  // flows are desktop main's, across every Workspace, and only the person's
  // own window drives them. Desktop main serves them through the map's
  // `RemoteHostsPort` (`@volli/host-core/handlers`); hostd has none, so every
  // one answers unavailable there.
  {
    key: "hosts.snapshot",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Every remote host this desktop added, and which serves each remote project.",
  },
  {
    key: "hosts.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The remote hosts snapshot now, then again on every change.",
  },
  {
    key: "hosts.retry",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Try a remote host's link again now.",
  },
  {
    key: "hosts.updateHost",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Update a remote host's Volli now, or when it is idle.",
  },
  {
    key: "hosts.cancelScheduledUpdate",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel a remote host's update scheduled for when it is idle.",
  },
  {
    key: "hosts.signIn",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Sign a remote host in to a model provider again.",
  },
  {
    key: "hosts.forget",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Forget a remote host: close its link and drop it from this desktop.",
  },
  {
    // `natural`, not `command-id`: the start input carries no caller-minted
    // key to answer a repeat with, and each start is its own flow (its id is
    // the answer). A repeat the window did not mean is a second flow the
    // person sees and cancels.
    key: "hostAdd.start",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Start adding a host over SSH: answers the new flow's id.",
  },
  {
    key: "hostAdd.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "An add flow's checklist now, then every change and log line.",
  },
  {
    key: "hostAdd.answer",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Answer the question an add flow stopped on.",
  },
  {
    // Write-only: the password is handed to the flow and never echoed,
    // logged or recorded in a diagnostic.
    key: "hostAdd.sudoPassword",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Give an add flow the sudo password it asked for; never echoed.",
  },
  {
    key: "hostAdd.retry",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Retry a failed add flow, from the step its failure names or the one given.",
  },
  {
    key: "hostAdd.cancel",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel an add flow.",
  },
  // Sign-ins on a remote host, from this desktop (VC-702 PR 2): desktop main
  // calls the host's `sign-ins` operations over its link, reads this Mac's
  // own key for "Send from this Mac", and relays a browser sign-in's redirect.
  {
    key: "hostSignIns.status",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "A remote host's sign-ins: availability only, never a value.",
  },
  {
    key: "hostSignIns.macKeys",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The providers this Mac holds an API key for: availability only, never a value.",
  },
  {
    // The key is read in main, at the person's request after the confirm,
    // and goes straight onto the host link: it never reaches the window.
    key: "hostSignIns.sendFromThisMac",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Send this Mac's API key for one provider to a remote host, after the confirm.",
  },
  {
    key: "hostSignIns.setApiKey",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Store a pasted API key on a remote host; never echoed.",
  },
  {
    key: "hostSignIns.setGitCredential",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Store a pasted git push token on a remote host; never echoed.",
  },
  {
    // The sign-in lives as long as this stream: ending it cancels the
    // sign-in on the host.
    key: "hostSignIns.run",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Sign a remote host in to a provider, and follow it to its end.",
  },
  {
    key: "hostSignIns.answer",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Answer the step a remote host's sign-in waits on, the pasted redirect included.",
  },
  {
    key: "hostSignIns.cancel",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel a remote host's sign-in.",
  },
  // Managing a host (VC-700 PR 3): host-placed like the rest of `hosts.*`.
  {
    // A label on this Mac only: the host's own name is untouched.
    key: "hosts.rename",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Rename a remote host on this desktop; the host's own name is untouched.",
  },
  {
    // Read over SSH (BatchMode) when asked, never cached.
    key: "hosts.devices",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The devices a remote host has enrolled, read from it over SSH.",
  },
  {
    // Beside `hostAdd.subscribe`, whose event union is closed: read on each view.
    key: "hostAdd.facts",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "What an add flow has found about its host so far: its login, system, version.",
  },
  // A host's projects (VC-710): host-placed like the rest of `hosts.*`.
  {
    // Read over SSH (BatchMode, as the login) when asked, never cached.
    key: "hosts.projects",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The projects a remote host has, read from it over SSH.",
  },
  {
    // The host's own `volli project add` over SSH; a clone first when given a URL.
    key: "hosts.createProject",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Make a folder on a remote host a project, cloning it first when given a git URL.",
  },
  {
    key: "hosts.openWorkspace",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Open one of a remote host's projects on this desktop, and link it.",
  },
  {
    // This desktop forgets it; the project on the host is untouched.
    key: "hosts.closeWorkspace",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Close one of a remote host's projects on this desktop; the host keeps it.",
  },
  // The Workspace link relay (VC-711; wire types in `./host-link-relay`): a
  // remote project's public operations, sent by desktop main over that
  // Workspace's link, which holds the device key. Host-placed: the Workspace
  // named is a remote host's, never one this host authorizes, and only the
  // person's own window reaches it. Bounded to what the link's welcome
  // granted; the operation's own idempotency is the host's.
  {
    key: "hostLink.query",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Send one query to a remote project over its Workspace link.",
  },
  {
    // Each relayed write carries its own `commandId` where its operation
    // takes one; the relay never resends.
    key: "hostLink.mutate",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Send one mutation to a remote project over its Workspace link; never resent.",
  },
  {
    // Ends, with what ended it, when the link is lost, the window goes or the
    // window cancels.
    key: "hostLink.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Follow one subscription of a remote project over its Workspace link.",
  },
  // The add flows main still owns (VC-720): a bounded, secret-free reference
  // to each, so a destroyed or reloaded window can rediscover an install that
  // outlived it and subscribe to it again. The whole view stays with
  // `hostAdd.subscribe`.
  {
    key: "hostAdd.active",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The add flows main still owns, newest first, without their views.",
  },
] as const satisfies readonly DesktopEntryDeclaration[];

export type DesktopEntry = (typeof DESKTOP_ENTRIES)[number];

/** Every desktop-only key. */
export type DesktopKey = DesktopEntry["key"];

/** A desktop entry as the catalog's builders read it: its policy, derived from its placement. */
export type DesktopCatalogEntry<Entry extends DesktopEntryDeclaration = DesktopEntry> =
  Entry extends DesktopEntryDeclaration
    ? {
        readonly key: Entry["key"];
        readonly accessModes: readonly [];
        readonly actor: "user";
        readonly handler: { readonly site: "main"; readonly id: Entry["key"] };
        readonly listed: false;
        readonly group: "App";
        readonly summary: Entry["summary"];
        readonly options: readonly [];
        readonly catalog: {
          readonly actor: "user";
          readonly scope: Entry["placement"];
          readonly idempotency: Entry["idempotency"];
        };
      }
    : never;

/**
 * The one derivation of a desktop entry's policy from its placement: the
 * person only, no network door, scoped as the channel was placed.
 */
export function desktopCatalogEntry<Entry extends DesktopEntryDeclaration>(
  entry: Entry,
): DesktopCatalogEntry<Entry> {
  const catalog: VerbCatalogDeclaration = {
    actor: "user",
    scope: entry.placement,
    idempotency: entry.idempotency,
  };
  const derived: VerbEntry = {
    key: entry.key,
    accessModes: [],
    actor: "user",
    handler: { site: "main", id: entry.key },
    listed: false,
    group: "App",
    summary: entry.summary,
    options: [],
    catalog,
  };
  return Object.freeze(derived) as DesktopCatalogEntry<Entry>;
}

/** Every desktop entry, catalog-shaped: what the desktop router family and the map's policy read. */
export const DESKTOP_CATALOG_ENTRIES: readonly DesktopCatalogEntry[] = Object.freeze(
  DESKTOP_ENTRIES.map((entry) => desktopCatalogEntry<DesktopEntry>(entry)),
);
