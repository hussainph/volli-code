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
    key: "moves.snapshot",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "This Mac's durable moves to Volli Cloud, without row contents or credentials.",
  },
  {
    key: "moves.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Invalidate the move projection when the journal changes.",
  },
  {
    key: "moves.preflight",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Check selected local projects without moving them.",
  },
  {
    key: "moves.start",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Start the checked project moves, with a verified backup first.",
  },
  {
    key: "moves.command",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Control a move under the person's sign-in and its current safety checks.",
  },
  {
    key: "moves.report",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Read a content-free move report.",
  },
  {
    key: "backups.status",
    compatibility: "host-command",
    placement: "host",
    idempotency: "read",
    summary: "Last verified local profile backup and any skipped or failed attempt.",
  },
  {
    key: "backups.run",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Attempt a verified local profile backup if the Storage revision still matches.",
  },
  {
    key: "backups.reveal",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Show the local profile backups folder in Finder.",
  },
  {
    key: "backups.restoreRevealPrevious",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Reveal the previous local profile preserved by restore.",
  },
  {
    key: "backups.restoreStatus",
    compatibility: "host-command",
    placement: "host",
    idempotency: "read",
    summary: "Read the local backup inventory and restore progress.",
  },
  {
    key: "backups.restoreChoose",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Choose and verify a local backup bundle.",
  },
  {
    key: "backups.restoreDirectory",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Choose a local project directory for restore.",
  },
  {
    key: "backups.restoreStart",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Stage a verified backup for activation on restart.",
  },
  {
    key: "backups.restoreCancel",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Cancel a prepared or running restore without changing the live profile.",
  },
  {
    key: "backups.restoreRestart",
    compatibility: "host-command",
    placement: "host",
    idempotency: "natural",
    summary: "Restart to activate a verified staged profile.",
  },
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
  // HOST relay (VC-722): client-local like the Workspace relay, but addressed
  // by host id so the window can act before opening any project.
  {
    key: "hostScope.query",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Send one HOST query over desktop main's host link.",
  },
  {
    key: "hostScope.mutate",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Send one HOST mutation over desktop main's host link; never resent.",
  },
  {
    key: "hostScope.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Follow one HOST subscription over desktop main's host link.",
  },
  // Person-only intent on one Session; no agent tool or public network operation.
  {
    key: "shells.moveToBackground",
    compatibility: "client-local",
    placement: "workspace",
    idempotency: "natural",
    summary: "Move a running foreground command into its Session's background shells.",
  },
  // App shortcuts out of a focused Browser page (VC-301). Host-placed like
  // `hosts.*`: the Browser Tab host and its native views are desktop main's,
  // across every Workspace, and only the person's own window follows them.
  // Desktop main serves them through the map's `BrowserShortcutsPort`
  // (`@volli/host-core/handlers`); hostd has none, so both answer unavailable.
  {
    key: "browserShortcuts.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Every app shortcut a focused Browser page hands back to the window.",
  },
  {
    key: "browserShortcuts.focusPage",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Give keyboard focus back to a shown Browser page whose shortcut did nothing.",
  },
  // VC-796: the host's removal, which `volli:project-remove` projects. It
  // stops the project's live work, then detaches the project (VC-822): its
  // tickets and Sessions are kept, and adding the folder again restores them.
  {
    key: "project.remove",
    compatibility: "host-command",
    placement: "workspace",
    idempotency: "natural",
    summary: "Remove a project from Volli: stop its Sessions' live work, then detach it.",
  },
  // A working copy's environment setup (VC-584, behind the `cloud` flag):
  // where it stands, and a person's answer to a failed one. Workspace-placed
  // on the ticket whose working copy it is; client-local while the recipe's
  // config has not moved to the backend.
  {
    key: "worktree.setupStatus",
    compatibility: "client-local",
    placement: "workspace",
    idempotency: "read",
    summary: "Where a ticket's working copy's environment setup stands on this runner.",
  },
  {
    key: "worktree.answerSetup",
    compatibility: "client-local",
    placement: "workspace",
    idempotency: "natural",
    summary: "Answer a failed environment setup: retry it, or start without it.",
  },
  // The Volli Cloud account on this Mac (VC-884; wire types in `./account`).
  // Host-placed: the sign-in is the person's on this device, across every
  // Workspace, and only their own window drives it. Desktop main serves them
  // through the map's `AccountPort` (`@volli/host-core/handlers`), and only
  // with `cloud` on; hostd has none, so every one answers unavailable there.
  {
    key: "account.snapshot",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Where the Volli account on this Mac stands: profile only, never a token.",
  },
  {
    key: "account.subscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The account snapshot now, then again on every change.",
  },
  {
    // `natural`: a second start while one is in flight replaces it.
    key: "account.signIn",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Start signing in with GitHub or Google in the browser.",
  },
  {
    key: "account.cancelSignIn",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Stop waiting for the browser sign-in.",
  },
  {
    key: "account.signOut",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Sign out of Volli on this Mac and forget the saved sign-in.",
  },
  {
    key: "account.requestDeletion",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Schedule the account for deletion in 30 days.",
  },
  {
    key: "account.cancelDeletion",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Restore an account whose deletion is scheduled.",
  },
  // The window's own Volli Cloud client (VC-889): it reads the board from the
  // backend itself, so it asks main for a short-lived access token whenever it
  // connects. Never the refresh token, and only the person's own window: a
  // desktop entry has no network door and no Session reaches it.
  {
    key: "account.accessToken",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "A short-lived access token for this window's Volli Cloud client.",
  },
  // Which product store this launch uses, chosen by main before the window
  // opened and fixed for the process (VC-889): this Mac's database, or the
  // signed-in person's Workspaces on Volli Cloud.
  {
    key: "cloud.launch",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Whether this launch shows this Mac's projects or Volli Cloud's.",
  },
  {
    // `natural`: a second request while one is waiting on the quit gates is the same request.
    key: "cloud.relaunch",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Restart Volli into the product store the account now chooses.",
  },
  {
    // `natural`: the window reports its whole count each time; the last one stands.
    key: "cloud.reportUnsavedWrites",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "How many board changes this window has sent Volli Cloud and not had answered.",
  },
  // The last-seen board, kept on this Mac for a launch that cannot reach
  // Volli Cloud (VC-889, D3): the window's own account only, read-only.
  {
    // `natural`: the whole snapshot each time; the last one stands.
    key: "cloud.saveSnapshot",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Keep the last-seen Volli Cloud board on this Mac for an offline launch.",
  },
  {
    key: "cloud.readSnapshot",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The last-seen Volli Cloud board kept on this Mac, if any.",
  },
  // The account's GitHub connection and the GitHub App's installations
  // (VC-897; wire types in `./account`). Host-placed for the reason the
  // account is: the connection is the person's, and desktop main follows its
  // browser round trips. Served through `AccountPort.github`, `cloud` only.
  {
    key: "account.githubSubscribe",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "The account's GitHub connection and installations now, then on every change.",
  },
  {
    // `natural`: a second start while a flow is in flight replaces it.
    key: "account.githubConnect",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Connect (or reconnect) GitHub in the browser.",
  },
  {
    key: "account.githubInstall",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Install the Volli GitHub App on a GitHub account in the browser.",
  },
  {
    key: "account.githubCancel",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Stop waiting for the GitHub browser round trip.",
  },
  {
    key: "account.githubDisconnect",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Disconnect GitHub: revoke the App's authorization and forget the connection.",
  },
  // This Mac as one of the person's runners (VC-895; wire types in
  // `./this-mac-runner`). Host-placed: the registration is this device's, and
  // only its own window drives it. Desktop main serves them through the map's
  // `RunnerAccountPort` (`@volli/host-core/handlers`), and only with `cloud`
  // on; hostd has none, so every one answers unavailable there. The person's
  // other runners the window reads and writes through its own Volli Cloud client.
  {
    key: "runners.thisMac",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Where this Mac stands as one of the person's runners: never a credential.",
  },
  {
    key: "runners.subscribeThisMac",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "This Mac's runner snapshot now, then again on every change.",
  },
  {
    // `natural`: a second request while one registration is in flight is the same request.
    key: "runners.addThisMac",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Register this Mac as a runner again, or retry a failed registration.",
  },
  {
    key: "runners.removeThisMac",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Remove this Mac from the person's runners until it is added again.",
  },
  // A cloud project's folder on this Mac (VC-895 N2-3; wire types in
  // `./cloud-checkout`). Host-placed: the folder is this device's, held only in
  // its runner's local path registry, and only its own window picks it.
  // Desktop main serves them through the map's `CloudCheckoutPort`
  // (`@volli/host-core/handlers`), only with `cloud` on; hostd has none.
  {
    key: "checkouts.status",
    compatibility: "client-local",
    placement: "host",
    idempotency: "read",
    summary: "Whether this Mac knows a Volli Cloud project's folder: never the path.",
  },
  {
    // `natural`: choosing the same folder again registers the same checkout.
    key: "checkouts.chooseFolder",
    compatibility: "client-local",
    placement: "host",
    idempotency: "natural",
    summary: "Pick a Volli Cloud project's folder on this Mac with the system folder picker.",
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
