/**
 * Where every desktop IPC channel belongs once the desktop is a host-protocol
 * client (VC-574). This table is the inventory `docs/plans/host-protocol.md`
 * (§Host operations vs client-local) asks for, and the area tickets
 * (VC-565–573) copy their channel lists from it rather than re-deriving them.
 *
 * The classification test is host-protocol.md's: durable workspace state or a
 * worker-owned resource is a host operation, even when it runs beside Electron
 * today; a presentation or native integration on the viewing device is
 * client-local and never needs a remote host's path. A mixed operation is
 * split into host data/intent plus a local action, never a generic
 * "execute on client" RPC. `host` vs `workspace` follows host-identity.md's
 * file boundary: `host` is host-level state shared by every workspace on that
 * host (the host-level file after VC-588), `workspace` is one workspace's state
 * or resource.
 *
 * Exhaustive by type, in both directions: a channel added to `contract.ts` or
 * `cursor-contract.ts` without an entry here, or an entry left behind for a
 * removed one, fails `pnpm typecheck` — the same mapped-type pattern as the
 * descriptor tables in `main/ipc-descriptors.ts`. `placement.test.ts` adds
 * the runtime half: the descriptor tables, a source read of the catalog, and
 * the invariants a type cannot say. Counts are not pinned anywhere; they
 * shrink as areas move, and this table is their source of truth.
 *
 * Desktop-owned, like the catalog it classifies (`docs/BOUNDARIES.md`,
 * corollary 2): host packages never import it. The `app_state` key registry
 * is its sibling in `@volli/shared` (`app-state-keys.ts`).
 */
import type {
  CloudPlacement,
  CloudPlacementOwner,
  CloudPlacementSplit,
  DesktopEntry,
  DesktopKey,
} from "@volli/shared";
import type { VolliIpcChannel, VolliIpcEvent } from "./contract";
import type { CursorOverlayChannel } from "./cursor-contract";

/**
 * The closed placement vocabulary for channels. `retired` belongs to the
 * `app_state` key registry only: a channel that is gone is deleted from the
 * catalog, and with it from this table.
 */
export type ChannelPlacementClass = CloudPlacement;

/** The M2 tickets that move a channel's host side, or change a client-local row. */
export type AreaOwner = Exclude<CloudPlacementOwner, "stays">;

/** `stays`: remains desktop IPC on the viewing device; no ticket moves or changes it. */
export type PlacementOwner = CloudPlacementOwner;

/** The two halves of a split channel, each named, with the non-client scope. */
export type SplitHalves = CloudPlacementSplit;

/**
 * One channel's placement. A `host`, `workspace` or `split` row always names
 * the area ticket that moves it; a `client-local` row is `stays` unless a
 * ticket changes how it behaves (the native browser view becoming a viewer,
 * for example).
 */
export type ChannelPlacement =
  | {
      readonly placement: "client-local";
      readonly owner: PlacementOwner;
      readonly reason: string;
    }
  | {
      readonly placement: "host" | "workspace";
      readonly owner: AreaOwner;
      readonly reason: string;
    }
  | {
      readonly placement: "split";
      readonly owner: AreaOwner;
      readonly reason: string;
      readonly split: SplitHalves;
    };

/** Every channel the desktop speaks: invoke + send, push events, and the cursor overlay's wire. */
export type PlacedChannel = VolliIpcChannel | VolliIpcEvent | CursorOverlayChannel;

/** Owner ruling 2026-10-05: a project's theme follows it to every device. */
export const THEME_OWNER_RULING =
  "Owner ruling 2026-10-05: a project's theme follows the project to every device.";

/**
 * VC-574 E2 / VC-564 D8: a read or write that spans workspaces has no single
 * workspace connection to ride, so it is a host-scoped catalog entry.
 */
const HOST_SCOPED =
  "Host-scoped (VC-564 D8): rides any authorized workspace connection with a device-as-user actor only, and answers only for the workspaces that actor's grant covers.";

/**
 * F2 Reveal (host-protocol.md): a host sends a resolved path only to a
 * same-machine connection granted `client.reveal`; other clients get no Reveal.
 */
const SAME_MACHINE_ONLY =
  "Acted on only for a same-machine connection granted client.reveal (F2); other clients get no local act.";

export const CHANNEL_PLACEMENT: { readonly [C in PlacedChannel]: ChannelPlacement } = {
  // ---- VolliDataIpcContract ----------------------------------------------
  "volli:data-bootstrap": {
    placement: "split",
    owner: "VC-565",
    reason:
      "Ships every project, ticket and label AND every app_state row in one read. VC-362's planning-only snapshot is the board half's edge.",
    split: {
      scope: "workspace",
      host: "The board snapshot (projects, tickets, labels) becomes VC-565's per-workspace planning snapshot; host-class app_state rows are read through their own host-area doors.",
      client:
        "Client-local app_state rows become the client store's own boot read (VC-577), never a host read.",
    },
  },
  "volli:data-project-roster": {
    placement: "workspace",
    owner: "VC-565",
    reason: "One project's live tickets and labels.",
  },
  "volli:database": {
    placement: "split",
    owner: "VC-573",
    reason:
      "Size and export of the host's database file, plus a Finder reveal of that file's path.",
    split: {
      scope: "host",
      host: "Size and export of the host's database file.",
      client: `Revealing the file in Finder. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:legacy-import": {
    placement: "host",
    owner: "VC-573",
    reason:
      "One-time import of pre-SQLite localStorage into the host database, writing profile-wide app_state and volli:legacy-backup. A remote hostd never receives a client's localStorage; VC-573 decides whether it survives the cloud flag at all.",
  },
  "volli:project-create": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "Creates a workspace (host-core createProject). Its folder is a host path, chosen by the client-local picker on the same machine or a host listing for a remote host.",
  },
  "volli:project-update": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Project base branch and setup command columns.",
  },
  "volli:project-skill-modes": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Per-project skill rules on the projects row.",
  },
  "volli:project-session-defaults": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Per-project chat model default.",
  },
  "volli:project-authority-policy": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "App-only control-tier write on the project: a device actor as user only, never an agent door.",
  },
  "volli:mcp-list": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Per-project MCP configuration.",
  },
  "volli:mcp-test": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Connects to the server from the host that will run it.",
  },
  "volli:mcp-save": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Per-project MCP configuration write.",
  },
  "volli:mcp-refresh": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Re-reads the server catalog on the host.",
  },
  "volli:mcp-set-enabled": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Per-project MCP configuration write.",
  },
  "volli:mcp-set-tools": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Per-project MCP configuration write.",
  },
  "volli:mcp-remove": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Per-project MCP configuration write plus its audit row.",
  },
  "volli:mcp-sign-in": {
    placement: "workspace",
    owner: "VC-570",
    reason:
      "OAuth listener on the host's loopback; the authorization page opens on the asking connection (F2 open-external) and the callback needs VC-570's auth-callback relay.",
  },
  "volli:mcp-cancel-sign-in": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Cancels the host-side sign-in flow.",
  },
  "volli:mcp-sign-out": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Deletes host-held tokens.",
  },
  "volli:mcp-discard-draft": {
    placement: "workspace",
    owner: "VC-570",
    reason: "Forgets host-held draft credentials.",
  },
  "volli:project-relink": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Re-points a project at a folder on the host, validated on the host.",
  },
  "volli:project-folder-check": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Stats the project folder on the host.",
  },
  "volli:project-remove": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Deletes the workspace and everything that cascades from it.",
  },
  "volli:ticket-create": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-move": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Board write; VC-565 makes the Done trim identical on every door.",
  },
  "volli:ticket-set-priority": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-update": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-set-labels": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-archive": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-unarchive": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-delete": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:ticket-list-archived": { placement: "workspace", owner: "VC-565", reason: "Board read." },
  "volli:ticket-events": { placement: "workspace", owner: "VC-565", reason: "Board read." },
  "volli:ticket-body": { placement: "workspace", owner: "VC-565", reason: "Board read." },
  "volli:ticket-latest-signals": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Board read over Session outcomes.",
  },
  "volli:ticket-status-entries": { placement: "workspace", owner: "VC-565", reason: "Board read." },
  "volli:comment-list": { placement: "workspace", owner: "VC-565", reason: "Board read." },
  "volli:comment-create": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Board write plus its event.",
  },
  "volli:comment-update": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:comment-remove": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:blob-attach": {
    placement: "split",
    owner: "VC-567",
    reason:
      "The blob store is workspace data, but the input carries client bytes or a client-side sourcePath/refRoot; a remote host needs uploaded bytes, never a client path.",
    split: {
      scope: "workspace",
      host: "Stores uploaded bytes in the workspace blob store and links them.",
      client: "Picking the file and reading its bytes on the viewing device, then uploading them.",
    },
  },
  "volli:blob-list": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Blob links of a ticket or Session.",
  },
  "volli:blob-materialized": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Blob links in materialize order.",
  },
  "volli:blob-remove": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Detaches a blob link.",
  },
  "volli:blob-link-drafts": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Links draft blobs to a new ticket.",
  },
  // VC-574 E5: the Session data reads are board and Session data, VC-565's;
  // VC-564 owns only the Session tRPC router.
  "volli:session-list": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Session listing read (VC-574 E5: Session data reads move with the board).",
  },
  "volli:session-list-for-ticket": {
    placement: "workspace",
    owner: "VC-565",
    reason: "One ticket's Session listing (VC-574 E5).",
  },
  "volli:session-rename": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Session ledger command submitted through the engine (VC-574 E5).",
  },
  "volli:session-read-set": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "Read receipt: per-person read state is host data so it agrees across devices (VC-574 E5).",
  },
  "volli:session-peek-content": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Read-only Session tail fold (VC-574 E5).",
  },
  "volli:session-starts": {
    placement: "host",
    owner: "VC-565",
    reason: `Reads Session starts across every project (VC-574 E5). ${HOST_SCOPED}`,
  },
  "volli:usage-report": {
    placement: "host",
    owner: "VC-573",
    reason: `Its scope includes {kind:"all"}, a read across every workspace. ${HOST_SCOPED}`,
  },
  "volli:venue-snapshot": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Measures a ticket or board checkout on the host.",
  },
  "volli:label-set-color": { placement: "workspace", owner: "VC-565", reason: "Board write." },
  "volli:app-state-set": {
    placement: "split",
    owner: "VC-577",
    reason:
      "Generic string-to-string writer for any registered key except the reader floor; each key's own placement (shared app-state-keys.ts) decides which half carries it.",
    split: {
      scope: "host",
      host: "Host-class keys are written only through their dedicated host-area doors (retention, trim, observability, decision model, model access, automations), never through this generic writer.",
      client:
        "Client-local keys write the desktop's own client store, which VC-577 builds; the channel is then client-local.",
    },
  },
  "volli:worktree-remove": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Ticket checkout on the host or worker.",
  },
  "volli:worktree-recreate": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Ticket checkout on the host or worker.",
  },
  "volli:worktree-branches": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Project git read on the host.",
  },
  // VC-574 E5: orphan scanning and cleanup is VC-573's (orphan cleanup is in
  // its title); trim stays with worktrees.
  "volli:worktree-orphans": {
    placement: "host",
    owner: "VC-573",
    reason: `Scans the host's worktree home across every project. ${HOST_SCOPED}`,
  },
  "volli:worktree-orphan-cleanup": {
    placement: "host",
    owner: "VC-573",
    reason: `Destructive cleanup over the host's worktree home. ${HOST_SCOPED}`,
  },
  "volli:worktree-orphan-delete": {
    placement: "host",
    owner: "VC-573",
    reason: `Deletes one orphan from the host's worktree home. ${HOST_SCOPED}`,
  },
  "volli:worktree-trim-scan": {
    placement: "host",
    owner: "VC-566",
    reason: `Every worktree this host owns, across projects. ${HOST_SCOPED}`,
  },
  "volli:worktree-trim": {
    placement: "host",
    owner: "VC-566",
    reason: `Trims across every non-active owned worktree. ${HOST_SCOPED}`,
  },
  "volli:worktree-trim-settings-set": {
    placement: "host",
    owner: "VC-566",
    reason: "Writes the host-level app_state row volli:worktree-trim.",
  },
  "volli:worktree-status": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Ticket checkout read.",
  },
  "volli:worktree-diff": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Ticket checkout read.",
  },
  "volli:worktree-change-set": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Change Set snapshot a remote client renders without filesystem access.",
  },
  "volli:worktree-base-read": {
    placement: "workspace",
    owner: "VC-566",
    reason: "git show at the base on the host.",
  },
  "volli:worktree-change-watch": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Addressed watch delivered to the subscribing connection.",
  },
  "volli:worktree-change-watch-pause": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Pauses the subscribing connection's addressed watch.",
  },
  "volli:worktree-change-watch-resume": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Resumes the subscribing connection's addressed watch.",
  },
  "volli:worktree-change-unwatch": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Ends the subscribing connection's addressed watch.",
  },
  "volli:worktree-commit": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Git write on the checkout.",
  },
  "volli:worktree-push-pr": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Push and PR from the host.",
  },
  "volli:retention-state": {
    placement: "workspace",
    owner: "VC-573",
    reason: "Ticket retention read.",
  },
  "volli:retention-keep": {
    placement: "workspace",
    owner: "VC-573",
    reason: "Durable Keep pin on a ticket.",
  },
  "volli:retention-dismiss": {
    placement: "client-local",
    owner: "VC-573",
    reason:
      "Dismisses the Archive prompt for this launch: host-process memory today, but with several clients a dismissal is one viewer's choice. VC-573 moves it off the host.",
  },
  "volli:retention-archive-clean": {
    placement: "workspace",
    owner: "VC-573",
    reason: "Archives a ticket and removes its worktree.",
  },
  "volli:retention-ttl-get": {
    placement: "host",
    owner: "VC-573",
    reason: "Reads the global Done-TTL setting, host-level app_state volli:retention.",
  },
  "volli:retention-ttl-set": {
    placement: "host",
    owner: "VC-573",
    reason: "Writes the global Done-TTL setting, host-level app_state volli:retention.",
  },
  "volli:retention-poll": {
    placement: "host",
    owner: "VC-573",
    reason: "Triggers the host's merge-watch poll over every workspace it serves.",
  },

  // ---- VolliFileIpcContract ----------------------------------------------
  "volli:file-index": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Project or worktree file index built on the host.",
  },
  "volli:file-read": { placement: "workspace", owner: "VC-567", reason: "Host file read." },
  "volli:search": { placement: "workspace", owner: "VC-567", reason: "Host search." },
  "volli:file-write": { placement: "workspace", owner: "VC-567", reason: "Host file write." },
  "volli:file-create": { placement: "workspace", owner: "VC-567", reason: "Host file write." },
  "volli:dir-create": { placement: "workspace", owner: "VC-567", reason: "Host file write." },
  "volli:file-rename": { placement: "workspace", owner: "VC-567", reason: "Host file write." },
  "volli:file-duplicate": { placement: "workspace", owner: "VC-567", reason: "Host file write." },
  "volli:file-delete": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Moves a host file to the trash through host-core's trash port, not shell.trashItem.",
  },
  "volli:artifact-create": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Writes .volli/artifacts/ in the project.",
  },
  // Not split: neither scope has a client half. The command is project-scoped
  // (it always names a projectId and rides that workspace's connection); its
  // `personal` scope writes the host-level <userData>/commands/ that the same
  // host merges into every workspace's picker.
  "volli:prompt-template-create": {
    placement: "host",
    owner: "VC-567",
    reason:
      "Orchestrator ruling (VC-574): mixed host/workspace resources, no client half. Scope project writes the authorized workspace's .volli/commands/; scope personal writes host-wide <userData>/commands/. Validate projectId against the actor's workspace grant before accessing workspace resources. " +
      HOST_SCOPED,
  },
  "volli:file-reveal": {
    placement: "split",
    owner: "VC-567",
    reason: "Resolves a host path, then reveals it in Finder.",
    split: {
      scope: "workspace",
      host: "Resolves the file's path inside the workspace.",
      client: `Reveals it in Finder. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:external-app-list": {
    placement: "client-local",
    owner: "stays",
    reason: "The editors and terminals installed on the viewing device.",
  },
  "volli:external-app-open-file": {
    placement: "split",
    owner: "VC-567",
    reason: "Launches a client application with a host-resolved file path.",
    split: {
      scope: "workspace",
      host: "Resolves the main- or worktree-scoped file path inside the workspace.",
      client: `Launches the allowlisted local application on it. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:external-app-open-worktree": {
    placement: "split",
    owner: "VC-567",
    reason: "Launches a client application with a host-resolved worktree root.",
    split: {
      scope: "workspace",
      host: "Resolves the ticket's worktree root inside the workspace.",
      client: `Launches the allowlisted local application on it. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:worktree-reveal": {
    placement: "split",
    owner: "VC-567",
    reason: "Resolves a ticket's worktree root, then reveals it in Finder.",
    split: {
      scope: "workspace",
      host: "Resolves the ticket's worktree root inside the workspace.",
      client: `Reveals it in Finder. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:file-watch": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Addressed watch stream on the host's client event sink.",
  },
  "volli:file-unwatch": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Ends an addressed file watch.",
  },
  "volli:dir-watch": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Addressed watch stream on the host's client event sink.",
  },
  "volli:dir-unwatch": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Ends an addressed directory watch.",
  },
  // Not split, for the same reason as prompt-template-create: no client half.
  "volli:prompt-templates": {
    placement: "host",
    owner: "VC-567",
    reason:
      "Orchestrator ruling (VC-574): reads the authorized workspace's .volli/commands/ and skills under its skill rules, merged over host-wide <userData>/commands/. No client half. Validate projectId against the actor's workspace grant before reading workspace resources. " +
      HOST_SCOPED,
  },

  // ---- VolliHarnessIpcContract -------------------------------------------
  "volli:harness-pending": {
    placement: "host",
    owner: "VC-572",
    reason: "Harness manifests discovered on the host's disk.",
  },
  "volli:harness-trust-set": {
    placement: "host",
    owner: "VC-572",
    reason: "Machine-local trust verdict; backups exclude it on purpose.",
  },
  "volli:harness-registered": {
    placement: "host",
    owner: "VC-572",
    reason: "What the host's launch path resolves.",
  },

  // ---- VolliCliIpcContract -----------------------------------------------
  "volli:cli-status": {
    placement: "host",
    owner: "VC-572",
    reason: "The CLI shim and Session PATH on the machine Sessions run on.",
  },
  "volli:cli-doctor": {
    placement: "host",
    owner: "VC-572",
    reason: "Audits the CLI shim and Session PATH on the machine Sessions run on.",
  },
  "volli:cli-repair": {
    placement: "host",
    owner: "VC-572",
    reason: "Repairs the host's login PATH adoption.",
  },

  // ---- VolliSupportIpcContract -------------------------------------------
  "volli:support-info": {
    placement: "split",
    owner: "VC-573",
    reason:
      "Mixes facts about the client (app version, platform, arch, update channel) with the host database's schema version.",
    split: {
      scope: "host",
      host: "The attached host's version and its database schema version.",
      client: "This desktop's app version, platform, arch and update channel.",
    },
  },

  // ---- VolliThemeIpcContract ---------------------------------------------
  "volli:theme-state": {
    placement: "split",
    owner: "VC-565",
    reason:
      "One read over two sources: the viewing device's Ghostty files and the project's theme override row.",
    split: {
      scope: "workspace",
      host: "The project's theme override columns on the projects row.",
      client:
        "The terminal theme chain read off this device's Ghostty config and Volli's overlay files.",
    },
  },
  "volli:theme-set-project": {
    placement: "workspace",
    owner: "VC-565",
    reason: THEME_OWNER_RULING,
  },
  "volli:theme-canvas-set-global": {
    placement: "client-local",
    owner: "stays",
    reason: "Global authored canvas (app_state theme), a viewing preference on this device.",
  },
  "volli:theme-appearance-set-global": {
    placement: "client-local",
    owner: "stays",
    reason: "Global light/dark/auto (app_state appearance), resolved against this device's OS.",
  },
  "volli:theme-canvas-set-project": {
    placement: "workspace",
    owner: "VC-565",
    reason: THEME_OWNER_RULING,
  },
  "volli:theme-appearance-set-project": {
    placement: "workspace",
    owner: "VC-565",
    reason: THEME_OWNER_RULING,
  },
  "volli:theme-first-paint-set": {
    placement: "client-local",
    owner: "stays",
    reason:
      "The first-paint hint main reads synchronously before the window exists; meaningless off this device.",
  },
  "volli:theme-terminal-overlay-write": {
    placement: "client-local",
    owner: "stays",
    reason:
      "Writes Volli's Ghostty overlay files in this device's userData; the scope picks a file, never a path.",
  },

  // ---- VolliModelAccessIpcContract ---------------------------------------
  "volli:model-access-sign-in-begin": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Pi provider sign-in runs on the host; the authorization URL opens on the asking connection (F2 open-external and VC-572's callback relay).",
  },
  "volli:model-access-sign-in-respond": {
    placement: "host",
    owner: "VC-572",
    reason: "Delivers a pasted code to the host's sign-in flow.",
  },
  "volli:model-access-sign-in-cancel": {
    placement: "host",
    owner: "VC-572",
    reason: "Cancels the host's sign-in flow.",
  },
  "volli:model-access-sign-out": {
    placement: "host",
    owner: "VC-572",
    reason: "Deletes a host-held provider credential.",
  },

  // ---- VolliWebAccessIpcContract -----------------------------------------
  "volli:web-access-get": {
    placement: "host",
    owner: "VC-572",
    reason: "Host setting; answers availability only.",
  },
  "volli:web-access-set-provider": {
    placement: "host",
    owner: "VC-572",
    reason: "Host setting.",
  },
  "volli:web-access-set-key": {
    placement: "host",
    owner: "VC-572",
    reason: "The key travels once to the host and is never readable back.",
  },
  "volli:web-access-clear-key": {
    placement: "host",
    owner: "VC-572",
    reason: "Deletes a host-held credential.",
  },

  // ---- VolliDecisionModelIpcContract -------------------------------------
  "volli:decision-model-get": {
    placement: "host",
    owner: "VC-572",
    reason: "Reads host-level app_state volli:decision-model.",
  },
  "volli:decision-model-set": {
    placement: "host",
    owner: "VC-572",
    reason: "Writes host-level app_state volli:decision-model.",
  },
  "volli:decision-model-test": {
    placement: "host",
    owner: "VC-572",
    reason: "Runs a model call from the host.",
  },

  // ---- VolliAgentObservabilityIpcContract --------------------------------
  "volli:agent-observability-get": {
    placement: "host",
    owner: "VC-573",
    reason: "Reads host-level app_state volli:agent-observability.",
  },
  "volli:agent-observability-set": {
    placement: "host",
    owner: "VC-573",
    reason: "Writes host-level app_state volli:agent-observability.",
  },

  // ---- VolliNotificationIpcContract --------------------------------------
  "volli:notifications-get": {
    placement: "client-local",
    owner: "VC-578",
    reason:
      "Notification preferences and delivery facts on this device: each device filters what it shows, and the host delivers attention per VC-578.",
  },
  "volli:notifications-set": {
    placement: "client-local",
    owner: "VC-578",
    reason:
      "Writes this device's notification preferences: each device filters, and the host delivers attention per VC-578.",
  },
  "volli:notifications-pending-activation": {
    placement: "client-local",
    owner: "VC-578",
    reason: "A native alert clicked while no window existed, taken once by this device.",
  },

  // ---- VolliBrowserIpcContract -------------------------------------------
  "volli:browser-open": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Tab in the workspace's tab registry on the host's backend (standalone Chromium).",
  },
  "volli:browser-close": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Tab in the workspace's tab registry.",
  },
  "volli:browser-list": {
    placement: "workspace",
    owner: "VC-571",
    reason: "The workspace's tab registry.",
  },
  "volli:browser-navigate": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Drives a host tab.",
  },
  "volli:browser-back": { placement: "workspace", owner: "VC-571", reason: "Drives a host tab." },
  "volli:browser-forward": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Drives a host tab.",
  },
  "volli:browser-reload": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Drives a host tab.",
  },
  "volli:browser-set-bounds": {
    placement: "client-local",
    owner: "VC-571",
    reason:
      "Native view placement in this window; stays IPC for the local view, which VC-571 turns into a viewer.",
  },
  "volli:browser-capture": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Screenshot of a host tab.",
  },
  "volli:browser-show": {
    placement: "client-local",
    owner: "VC-571",
    reason: "Attaches the native view in this window.",
  },
  "volli:browser-hide": {
    placement: "client-local",
    owner: "VC-571",
    reason: "Detaches the native view in this window.",
  },
  "volli:browser-toggle-devtools": {
    placement: "client-local",
    owner: "VC-571",
    reason:
      "DevTools of the local native view. A remote tab has no local DevTools; VC-571, as the screencast owner, decides availability there.",
  },
  "volli:browser-set-presentation": {
    placement: "workspace",
    owner: "VC-571",
    reason: "headless / preview / tab is tab-registry state.",
  },
  "volli:browser-picture": {
    placement: "workspace",
    owner: "VC-571",
    reason: "A host-held picture by id.",
  },
  "volli:browser-traces": {
    placement: "workspace",
    owner: "VC-571",
    reason: "A Session's kept Browser Traces.",
  },
  "volli:browser-take-over": {
    placement: "workspace",
    owner: "VC-571",
    reason: "The browser hold is host state.",
  },
  "volli:browser-hand-back": {
    placement: "workspace",
    owner: "VC-571",
    reason: "The browser hold is host state.",
  },
  "volli:browser-ask-to-leave": {
    placement: "workspace",
    owner: "VC-571",
    reason: "The browser hold is host state.",
  },

  // ---- VolliShellIpcContract (VC-574 E5: the process and terminal family) --
  "volli:shell-list": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Session-owned background shells running on the host (VC-574 E5).",
  },
  "volli:shell-tail": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Reads a background shell's output on the host (VC-574 E5).",
  },
  "volli:shell-kill": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Stops a background shell on the host (VC-574 E5).",
  },

  // ---- VolliAutomationIpcContract ----------------------------------------
  "volli:automation-list": {
    placement: "host",
    owner: "VC-569",
    reason:
      "Orchestrator ruling (VC-574 N1): reads a project's Automations plus every global Automation (null project_id), a mixed workspace/host-wide set. Validate projectId against the actor's workspace grant before reading workspace resources. " +
      HOST_SCOPED,
  },
  "volli:automation-create": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Automation command.",
  },
  "volli:automation-update": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Automation command.",
  },
  "volli:automation-delete": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Automation command.",
  },
  "volli:automation-run": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Starts a run on the host.",
  },
  "volli:automation-runs-for-ticket": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Run history read.",
  },
  "volli:automation-arming-list": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Column arming, per machine on the host side.",
  },
  "volli:automation-arm": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Column arming, per machine on the host side.",
  },
  "volli:automation-column-order-list": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Armed-column order.",
  },
  "volli:automation-set-column-order": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Armed-column order.",
  },
  "volli:automation-runs-for-project": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Run history read.",
  },
  "volli:automation-runs-for-automation": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Run history read.",
  },
  "volli:automation-skips-for-automation": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Skipped-occurrence read.",
  },
  "volli:automation-enablement": {
    placement: "host",
    owner: "VC-569",
    reason:
      "Orchestrator ruling (VC-574 N1): no-argument read of the whole host-wide enablement set keyed by automation id, including global Automations (null project_id). Filter workspace entries by the actor's workspace grant before returning them. " +
      HOST_SCOPED,
  },
  "volli:automation-set-enabled": {
    placement: "workspace",
    owner: "VC-569",
    reason:
      "Durable Automation command switching one Automation on or off. VC-574 E10: workspace state, carried by a workspace move (M4).",
  },
  "volli:automation-pending-armed-runs": {
    placement: "workspace",
    owner: "VC-569",
    reason: "The pending armed-run countdown projection.",
  },
  "volli:automation-cancel-pending-armed-run": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Cancels one pending armed arrival.",
  },
  "volli:automation-retry-pending-armed-run": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Retries one pending armed arrival.",
  },
  "volli:automation-skips-for-project": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Skipped-occurrence read.",
  },
  "volli:automation-run-for-project": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Starts a project-scoped run on the host.",
  },

  // ---- VolliSystemIpcContract --------------------------------------------
  "volli:pick-project-folder": {
    placement: "client-local",
    owner: "stays",
    reason:
      "Native folder chooser on this device. Its path is valid only for a same-machine host; remote selection uses a host listing.",
  },
  "volli:sync-project-roots": {
    placement: "host",
    owner: "VC-565",
    reason:
      "The renderer pushes the host's filesystem allowlist into host-core. Delete: the host derives roots from its own projects, never from a client.",
  },
  "volli:list-directory": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Host filesystem listing under project roots and the worktree home.",
  },
  "volli:reveal-in-finder": {
    placement: "split",
    owner: "VC-567",
    reason: "Finder reveal of a host path.",
    split: {
      scope: "workspace",
      host: "Validates the path against the workspace's roots.",
      client: `Reveals it in Finder. ${SAME_MACHINE_ONLY}`,
    },
  },
  "volli:window-is-fullscreen": {
    placement: "client-local",
    owner: "stays",
    reason: "Window state.",
  },
  "volli:terminal-create": {
    placement: "workspace",
    owner: "VC-568",
    reason: "PTY supervisor on the host or worker.",
  },
  "volli:terminal-write": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Input to a host PTY.",
  },
  "volli:terminal-resize": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Host PTY size; resize ownership per VC-568.",
  },
  "volli:terminal-kill": { placement: "workspace", owner: "VC-568", reason: "Ends a host PTY." },
  "volli:terminal-park": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Parks a host PTY.",
  },
  "volli:terminal-wake": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Wakes a parked host PTY.",
  },
  "volli:terminal-keep-awake": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Keep-awake on a host PTY.",
  },
  "volli:terminal-busy": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Whether a host PTY is busy.",
  },
  "volli:terminal-run": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Runs a command in a host PTY.",
  },
  "volli:ghostty-config-get": {
    placement: "client-local",
    owner: "stays",
    reason: "The person's Ghostty config on the viewing device (decision #26).",
  },

  // ---- VolliUpdateIpcContract --------------------------------------------
  "volli:update-state-get": {
    placement: "client-local",
    owner: "stays",
    reason: "Desktop updater state.",
  },
  "volli:update-check": { placement: "client-local", owner: "stays", reason: "Desktop updater." },
  "volli:update-install": {
    placement: "client-local",
    owner: "stays",
    reason: "Desktop updater install and relaunch.",
  },
  "volli:update-live-work": {
    placement: "split",
    owner: "VC-577",
    reason:
      "Counts busy PTYs and open agent Sessions (host) beside unsaved drafts (client). Once hosts outlive app quit (VC-577), a desktop restart no longer stops the host's work, so the host half changes meaning there.",
    split: {
      scope: "host",
      host: "Answers whether work is live on the host: busy PTYs and open agent Sessions.",
      client: "Asks before an install restart, and counts this device's own unsaved editor drafts.",
    },
  },
  "volli:update-channel-get": {
    placement: "client-local",
    owner: "stays",
    reason: "This install's release line (app_state volli:update-allow-prerelease).",
  },
  "volli:update-channel-set": {
    placement: "client-local",
    owner: "stays",
    reason:
      "Moves this install between release lines; an attached hostd follows the desktop's exact version (Decided 1).",
  },

  // ---- VolliSessionRpcIpcContract ----------------------------------------
  "volli:session-rpc": {
    placement: "workspace",
    owner: "VC-564",
    reason:
      "The Session tRPC edge; moves to the WebSocket (VC-564) and the generic IPC bridge (VC-608). Its session.*/sessions.* catalog entries are workspace-scoped; settings.* and modelAccess.* are host-scoped entries VC-572 refines (D3).",
  },

  // ---- VolliSendContract -------------------------------------------------
  "volli:unsaved-documents": {
    placement: "client-local",
    owner: "stays",
    reason: "Feeds this desktop's quit gate.",
  },
  "volli:client-state-flushed": {
    placement: "client-local",
    owner: "stays",
    reason: "This window's ack that its app_state writes reached main before it is destroyed.",
  },
  "volli:terminal-ack": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Flow-control ack on a host terminal stream.",
  },
  "volli:notification-active-target": {
    placement: "workspace",
    owner: "VC-578",
    reason:
      "What this window shows; becomes the F2 per-connection presence {focused, visibleSessionIds} the host unions per workspace.",
  },
  "volli:terminal-set-visible": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Visibility drives auto-park; per-connection presence on the host.",
  },
  "volli:session-rpc-cancel": {
    placement: "workspace",
    owner: "VC-564",
    reason: "Cancels a Session tRPC subscription.",
  },
  "volli:renderer-log": {
    placement: "client-local",
    owner: "stays",
    reason: "This window's warnings into this machine's log; never sent to a host.",
  },

  // ---- VolliPiSessionOrphanIpcContract -----------------------------------
  "volli:pi-session-orphans-scan": {
    placement: "host",
    owner: "VC-573",
    reason: "Pi session logs on the host.",
  },
  "volli:pi-session-orphans-reclaim": {
    placement: "host",
    owner: "VC-573",
    reason: "Unlinks Pi session logs on the host.",
  },

  // ---- VolliOrphanProcessIpcContract -------------------------------------
  "volli:orphan-processes-scan": {
    placement: "host",
    owner: "VC-573",
    reason: "The host's process table.",
  },
  "volli:orphan-processes-reap": {
    placement: "host",
    owner: "VC-573",
    reason: "Signals processes in the host's process table.",
  },
  "volli:orphan-processes-policy": {
    placement: "host",
    owner: "VC-573",
    reason: "Auto-reap policy, host-level app_state volli:orphan-processes.",
  },

  // ---- VolliDatabaseRecoveryIpcContract ----------------------------------
  "volli:database-recovery-list": {
    placement: "host",
    owner: "VC-573",
    reason: "The host database's safety copies.",
  },
  "volli:database-recovery-restore": {
    placement: "host",
    owner: "VC-573",
    reason: "Restores the host database from a safety copy.",
  },
  "volli:database-recovery-fault": {
    placement: "host",
    owner: "VC-573",
    reason: "Why the host database failed to open.",
  },
  "volli:database-recovery-quit": {
    placement: "client-local",
    owner: "stays",
    reason: "Quits this app from the recovery screen.",
  },

  // ---- VolliSecretIpcContract --------------------------------------------
  "volli:secrets-list": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Host-held secrets, availability only; an optional projectId narrows the listing to one project's scope.",
  },
  "volli:secret-submit": {
    placement: "host",
    owner: "VC-572",
    reason: "The value travels once from the secure field to the host's store.",
  },
  "volli:secret-decline": {
    placement: "host",
    owner: "VC-572",
    reason: "The host's secret store.",
  },
  "volli:secret-revoke": {
    placement: "host",
    owner: "VC-572",
    reason: "The host's secret store.",
  },
  "volli:secret-replace": {
    placement: "host",
    owner: "VC-572",
    reason: "The host's secret store.",
  },
  "volli:secrets-unlock": {
    placement: "host",
    owner: "VC-572",
    reason: "Retries the host's locked stored secrets (VC-641).",
  },
  "volli:secrets-reset": {
    placement: "host",
    owner: "VC-572",
    reason: "Sets the host's locked stored secrets aside (VC-641).",
  },

  // ---- VolliIpcEvent (main → renderer pushes) ----------------------------
  "volli:fullscreen-changed": {
    placement: "client-local",
    owner: "stays",
    reason: "Window state.",
  },
  "volli:client-state-flush": {
    placement: "client-local",
    owner: "stays",
    reason: "Asks this window to flush its debounced app_state writes before main destroys it.",
  },
  "volli:browser-tab-state": {
    placement: "workspace",
    owner: "VC-571",
    reason: "Tab-registry overlay; skips the bus today.",
  },
  "volli:shell-state": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Background-shell overlay (VC-574 E5).",
  },
  "volli:terminal-data": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Terminal output; becomes binary frames on the host protocol.",
  },
  "volli:terminal-exit": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Terminal stream.",
  },
  "volli:terminal-park-state": {
    placement: "workspace",
    owner: "VC-568",
    reason: "Terminal stream.",
  },
  "volli:ghostty-config-changed": {
    placement: "client-local",
    owner: "stays",
    reason: "Watch over this device's Ghostty config.",
  },
  "volli:data-changed": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "Workspace planning invalidations can name ticketId/projectId; replaced by VC-565's Workspace change feed (F1). The untargeted {} bus payload alone is a host-scoped interim notice (VC-564 D12/VC-664), not permission to broadcast targeted Workspace data across grants.",
  },
  "volli:pending-armed-runs-changed": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Pending armed-run overlay.",
  },
  "volli:pending-armed-run-settled": {
    placement: "workspace",
    owner: "VC-569",
    reason: "Armed-run settlement notice.",
  },
  "volli:sessions-interrupted": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Fired by a backward ticket move.",
  },
  "volli:session-retitled": {
    placement: "workspace",
    owner: "VC-565",
    reason: "Session listing fact (VC-574 E5).",
  },
  "volli:notification-activated": {
    placement: "client-local",
    owner: "VC-578",
    reason: "A native alert click routed to one window.",
  },
  "volli:notification-settings": {
    placement: "client-local",
    owner: "VC-578",
    reason: "This device's notification preferences view; follows notifications-get/set.",
  },
  "volli:ui-zoom-command": {
    placement: "client-local",
    owner: "stays",
    reason: "Native View menu zoom.",
  },
  "volli:file-changed": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Addressed file watch stream.",
  },
  "volli:dir-changed": {
    placement: "workspace",
    owner: "VC-567",
    reason: "Addressed directory watch stream.",
  },
  "volli:worktree-changed": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Addressed worktree watch stream.",
  },
  "volli:worktree-watch-error": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Addressed worktree watch stream fault.",
  },
  "volli:worktree-phase": {
    placement: "workspace",
    owner: "VC-566",
    reason: "Worktree-ensure phase overlay.",
  },
  "volli:system-appearance-changed": {
    placement: "client-local",
    owner: "stays",
    reason: "nativeTheme light/dark flip on the viewing device.",
  },
  "volli:harness-event": {
    placement: "workspace",
    owner: "VC-572",
    reason: "Terminal-harness hook event resolved to its Session (VC-574 E5: harness settings).",
  },
  "volli:session-harness": {
    placement: "workspace",
    owner: "VC-572",
    reason:
      "A different harness now runs in a Session's terminal, announced by its launch wrapper (VC-574 E5: harness settings).",
  },
  // VC-574 E5: VC-564 owns only the Session tRPC router, so the Session
  // listing's pushes move with the listing reads.
  "volli:session-started": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "Notice that a Session started on a ticket from outside this window (VC-574 E5: Session data).",
  },
  "volli:session-activity": {
    placement: "workspace",
    owner: "VC-565",
    reason:
      "The Session listing's push, which replaced the session-list poll (VC-574 E5: Session data).",
  },
  "volli:session-rpc-event": {
    placement: "workspace",
    owner: "VC-564",
    reason: "Session tRPC subscription frames.",
  },
  "volli:update-state": {
    placement: "client-local",
    owner: "stays",
    reason: "Desktop updater state.",
  },
  "volli:model-access-sign-in": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Sent to the window that began a provider sign-in; becomes a request to the asking connection (F2).",
  },

  // ---- Cursor overlay wire (cursor-contract.ts) --------------------------
  // Main ↔ the cursor overlay page main owns, not the app renderer.
  "volli:cursor-state": {
    placement: "client-local",
    owner: "stays",
    reason: "Main to the cursor overlay view it places: window placement, not domain.",
  },
  "volli:cursor-settled": {
    placement: "client-local",
    owner: "stays",
    reason: "Overlay page to main: a drawn state.",
  },
  "volli:cursor-size": {
    placement: "client-local",
    owner: "stays",
    reason: "Overlay page to main: the drawing's size.",
  },
  "volli:cursor-take-over": {
    placement: "client-local",
    owner: "stays",
    reason: "Overlay button; main forwards it to the browser hold command (VC-571).",
  },
  "volli:cursor-ask-to-leave": {
    placement: "client-local",
    owner: "stays",
    reason: "Overlay button; main forwards it to the browser hold command (VC-571).",
  },
};

/** One channel moved onto the bridge's desktop-only tier: its key, and the placement it carried there. */
type BridgedChannel = {
  [Key in DesktopKey]: {
    readonly key: Key;
    /** The row's placement, which IS the entry's whole policy (`desktopCatalogEntry`). */
    readonly placement: Extract<DesktopEntry, { key: Key }>["placement"];
    readonly owner: AreaOwner;
    readonly reason: string;
  };
}[DesktopKey];

/**
 * Channels moved off per-channel IPC onto the router-generic bridge's
 * desktop-only tier (VC-608; `DESKTOP_ENTRIES`, `@volli/shared`). The channel
 * is gone from the catalog, and so from {@link CHANNEL_PLACEMENT}; its row
 * moved here, beside the key that replaced it, so the area ticket that owns it
 * still finds it. The type holds each row's placement to its entry's, so the
 * policy a desktop-only command runs under is the placement VC-574 gave its
 * channel, and nothing else.
 */
export const BRIDGED_CHANNELS = {
  "volli:project-reorder": {
    key: "project.reorder",
    placement: "host",
    owner: "VC-565",
    reason: `Rewrites projects.sort_order across every workspace: a cross-workspace ordering of the owner's board. ${HOST_SCOPED}`,
  },
  "volli:worktree-trim-settings-get": {
    key: "worktree.trimSettings",
    placement: "host",
    owner: "VC-566",
    reason: "Reads the host-level app_state row volli:worktree-trim.",
  },
} as const satisfies Readonly<Record<`volli:${string}`, BridgedChannel>>;

type AssertNever<Type extends never> = Type;

/** A bridged channel is no live one: the area moved it, and deleted it, in one PR. */
export type BridgedChannelsRetired = AssertNever<
  Extract<keyof typeof BRIDGED_CHANNELS, PlacedChannel>
>;
