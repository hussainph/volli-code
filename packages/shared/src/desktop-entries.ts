/**
 * The desktop-only tier of the host's command set (VC-608; HP § Command
 * catalog, D-A1 = (c) hybrid).
 *
 * A desktop-only entry is a host command only the desktop's own window calls:
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
 *   door serves them and no Session reaches them. A `client-local` channel
 *   never enters the host map; its row stays desktop IPC.
 *   `desktopCatalogEntry` is that derivation, and the only one.
 * - **Additive only** across supported skew: never renamed, removed or
 *   changed in meaning. Its schemas are published in the committed protocol
 *   schema's `desktop` tier and diffed by the same compatibility gate.
 * - **Promotion** to the public tier moves the entry into the Verb Registry
 *   (with `hostApi`, schemas, features and fixtures) under the same key, and
 *   its procedure into the public area router. The handler does not move.
 *
 * Keys are host command names, never Electron channel names: the channel a
 * key replaced is recorded by the desktop, beside its placement table
 * (`apps/desktop/src/ipc/placement.ts`). This table lives in `@volli/shared`
 * for the reason the public key sets do: both the host's map (host-core) and
 * the router package build from it, and neither may import the other (D2).
 */
import type { CloudPlacement } from "./app-state-keys";
import type { VerbCatalogDeclaration, VerbEntry, VerbIdempotency } from "./verb-registry";

/** The placements a host command can have: never `client-local`, never `split` (name the half). */
export type DesktopEntryPlacement = Extract<CloudPlacement, "workspace" | "host">;

/** One desktop-only host command. */
export interface DesktopEntryDeclaration {
  /** Its identity on the bridge and in the map, chosen once (additive only). */
  readonly key: string;
  /**
   * The VC-574 placement of the channel it replaced (a `split` channel's
   * non-client half names its `split.scope`). The whole of its policy.
   */
  readonly placement: DesktopEntryPlacement;
  readonly idempotency: VerbIdempotency;
  readonly summary: string;
}

/**
 * Every desktop-only command, in the order they joined. Append only: a key
 * here is a promise to every supported desktop build.
 */
export const DESKTOP_ENTRIES = [
  {
    key: "project.reorder",
    placement: "host",
    idempotency: "natural",
    summary: "Put the rail's projects in this order.",
  },
  {
    key: "worktree.trimSettings",
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
    placement: "host",
    idempotency: "read",
    summary: "Every remote host this desktop added, and which serves each remote project.",
  },
  {
    key: "hosts.subscribe",
    placement: "host",
    idempotency: "read",
    summary: "The remote hosts snapshot now, then again on every change.",
  },
  {
    key: "hosts.retry",
    placement: "host",
    idempotency: "natural",
    summary: "Try a remote host's link again now.",
  },
  {
    key: "hosts.updateHost",
    placement: "host",
    idempotency: "natural",
    summary: "Update a remote host's Volli now, or when it is idle.",
  },
  {
    key: "hosts.cancelScheduledUpdate",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel a remote host's update scheduled for when it is idle.",
  },
  {
    key: "hosts.signIn",
    placement: "host",
    idempotency: "natural",
    summary: "Sign a remote host in to a model provider again.",
  },
  {
    key: "hosts.forget",
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
    placement: "host",
    idempotency: "natural",
    summary: "Start adding a host over SSH: answers the new flow's id.",
  },
  {
    key: "hostAdd.subscribe",
    placement: "host",
    idempotency: "read",
    summary: "An add flow's checklist now, then every change and log line.",
  },
  {
    key: "hostAdd.answer",
    placement: "host",
    idempotency: "natural",
    summary: "Answer the question an add flow stopped on.",
  },
  {
    // Write-only: the password is handed to the flow and never echoed,
    // logged or recorded in a diagnostic.
    key: "hostAdd.sudoPassword",
    placement: "host",
    idempotency: "natural",
    summary: "Give an add flow the sudo password it asked for; never echoed.",
  },
  {
    key: "hostAdd.retry",
    placement: "host",
    idempotency: "natural",
    summary: "Retry a failed add flow, from the step its failure names or the one given.",
  },
  {
    key: "hostAdd.cancel",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel an add flow.",
  },
  // Sign-ins on a remote host, from this desktop (VC-702 PR 2): desktop main
  // calls the host's `sign-ins` operations over its link, reads this Mac's
  // own key for "Send from this Mac", and relays a browser sign-in's redirect.
  {
    key: "hostSignIns.status",
    placement: "host",
    idempotency: "read",
    summary: "A remote host's sign-ins: availability only, never a value.",
  },
  {
    key: "hostSignIns.macKeys",
    placement: "host",
    idempotency: "read",
    summary: "The providers this Mac holds an API key for: availability only, never a value.",
  },
  {
    // The key is read in main, at the person's request after the confirm,
    // and goes straight onto the host link: it never reaches the window.
    key: "hostSignIns.sendFromThisMac",
    placement: "host",
    idempotency: "natural",
    summary: "Send this Mac's API key for one provider to a remote host, after the confirm.",
  },
  {
    key: "hostSignIns.setApiKey",
    placement: "host",
    idempotency: "natural",
    summary: "Store a pasted API key on a remote host; never echoed.",
  },
  {
    key: "hostSignIns.setGitCredential",
    placement: "host",
    idempotency: "natural",
    summary: "Store a pasted git push token on a remote host; never echoed.",
  },
  {
    // The sign-in lives as long as this stream: ending it cancels the
    // sign-in on the host.
    key: "hostSignIns.run",
    placement: "host",
    idempotency: "read",
    summary: "Sign a remote host in to a provider, and follow it to its end.",
  },
  {
    key: "hostSignIns.answer",
    placement: "host",
    idempotency: "natural",
    summary: "Answer the step a remote host's sign-in waits on, the pasted redirect included.",
  },
  {
    key: "hostSignIns.cancel",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel a remote host's sign-in.",
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
