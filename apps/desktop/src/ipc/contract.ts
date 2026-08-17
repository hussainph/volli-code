// The Electron IPC catalog: every channel this app speaks, declared once.
//
// Type-only module, and it must stay that way. All three desktop processes may
// `import type` from it; preload and renderer must never import it at RUNTIME.
// The pack config requires main and preload to stay dependency-disjoint (see
// CAUTION in apps/desktop/vite.config.ts), and a value export here would give a
// preload import something to actually require — splitting a shared chunk out
// of preload.cjs that the sandboxed preload cannot resolve. The runtime half of
// the contract is src/main/ipc-descriptors.ts, which only main can reach.
//
// It lives in the app rather than in @volli/shared because a transport catalog
// is knowledge of Electron, and that package is pure domain code.

import type {
  Appearance,
  ArchivedTicket,
  Canvas,
  ChangeSetSnapshot,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  DiffStat,
  DirEntry,
  DoctorCheck,
  FileKind,
  FileSource,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  HarnessAdapter,
  HarnessChannelStatus,
  HarnessEvent,
  HarnessEventOrder,
  HarnessId,
  HarnessTrustPrompt,
  HarnessTrustVerdict,
  IndexedFile,
  Label,
  LatestSessionSignal,
  LegacyProject,
  ManifestError,
  ModelAccessSignInType,
  Project,
  ProjectThemeOverride,
  PromptTemplate,
  ResolvedAppearance,
  RetentionReason,
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  SessionListingRow,
  SessionRpcIpcRequest,
  SessionRpcIpcResponse,
  ShippedEditorThemeId,
  SkillReference,
  TerminalBusyResult,
  TerminalIoResult,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketEventActorKind,
  TicketPriority,
  TicketStatus,
  TicketStatusEntry,
} from "@volli/shared";

// ---- request contract (issue #98) ------------------------------------------
// Each invoke request is declared ONCE here as `{ args, result }`; the runtime
// descriptor table in src/main/ipc-descriptors.ts is keyed by these channels and its
// guards are compile-checked against the `args` tuples, so channel membership,
// argument shape, and validator can no longer drift apart.

// ---- request input shapes ---------------------------------------------------
// Grouped to match the handler groups in src/main/data-ipc.ts.

export interface ProjectCreateInput {
  path: string;
  name: string;
}

export interface ProjectUpdateInput {
  id: string;
  baseBranch: string | null;
  /** `undefined` (untouched), `null` (clear), or a `string` (set) — the same shape as ticket-update's worktree-identity fields. */
  setupCommand?: string | null;
}

/** `{ projectId }` — shared by every project-scoped read (session list, worktree branches). */
export interface ProjectIdInput {
  projectId: string;
}

export interface TicketCreateInput {
  projectId: string;
  status: TicketStatus;
  title: string;
  priority?: TicketPriority;
  /** Markdown; defaults to `""`. Becomes the agent prompt on kickoff. */
  body?: string;
  /** Label names; defaults to `[]`. Persisted as shared, name-deduped label rows (the setLabels path). */
  labels?: string[];
  /** Whether the ticket boots its agent in an isolated worktree; defaults to `true`. */
  usesWorktree?: boolean;
  /** The ticket's persisted default harness (set on kickoff); defaults to the DB default. */
  preferredHarnessId?: HarnessId;
  /**
   * The ref the ticket's worktree branches from, chosen in the composer.
   * Omitted (or `null`) leaves it unset, and `resolveBaseBranch` detects the
   * project's default at worktree time — the behavior every caller had before
   * the composer could name one. The command layer re-validates the name.
   */
  baseBranch?: string | null;
}

/** `volli:ticket-move` — runs the shared board move + persists it. */
export interface TicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
  toIndex: number;
}

export interface TicketSetPriorityInput {
  ticketId: string;
  priority: TicketPriority;
}

export interface TicketUpdateInput {
  ticketId: string;
  title?: string;
  body?: string;
  /** First-class worktree identity (migration 003); `null` explicitly clears the field, `undefined` leaves it untouched. */
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  /**
   * Worktree scoping (VC-16): isolated worktree vs Main checkout. The command
   * layer refuses a change once the ticket's worktree has materialized, so
   * this is only honored while `worktreePath` is still null.
   */
  usesWorktree?: boolean;
}

export interface TicketSetLabelsInput {
  ticketId: string;
  labels: string[];
}

/** The `{ ticketId }` shape shared by every single-ticket-scoped read/mutation (archive/unarchive/delete/events/comment-list/session-list-for-ticket/worktree-status/retention-*). */
export interface TicketIdInput {
  ticketId: string;
}

export interface CommentCreateInput {
  ticketId: string;
  body: string;
  sessionId?: string | null;
}

export interface CommentUpdateInput {
  commentId: string;
  body: string;
}

export interface CommentIdInput {
  commentId: string;
}

/** `{ sessionId, title }` with a non-blank title — the rename handler trims before persisting. */
export interface SessionRenameInput {
  sessionId: string;
  title: string;
}

export interface LabelSetColorInput {
  labelId: string;
  color: string | null;
}

export interface WorktreeRemoveInput {
  ticketId: string;
  force: boolean;
}

export interface WorktreeDiffInput {
  ticketId: string;
  mode: WorktreeDiffMode;
}

/** `{ ticketId, path }` — a worktree-relative path to read at the Change Set base. */
export interface WorktreeBaseReadInput {
  ticketId: string;
  path: string;
  /**
   * Pin the read to a specific base revision — normally the `baseRevision` of
   * the snapshot the caller is rendering. Without it main re-resolves the merge
   * base, which can have moved since (the agent committed, someone fetched), so
   * a diff would show one side from one revision and the other from another.
   * Omit to read against whatever the base resolves to right now.
   */
  baseRevision?: string;
}

/**
 * The one-click commit's payload. Both extra fields are OPTIONAL and both
 * default to what the command did before they existed, so a caller written
 * against the old `{ ticketId }` shape — and every commit already recorded by
 * one — keeps its exact meaning.
 *
 * `message` blank or absent means "generate one" (the `chore(<DISPLAY-ID>)`
 * line); anything else is used verbatim. `includeUnstaged` absent means `true`
 * — stage everything, the historical `git add -A`. `false` commits only what is
 * ALREADY in the index, which is the one combination that can find nothing to
 * do on a dirty tree; main answers that with an error, never a silent no-op.
 */
export interface WorktreeCommitInput {
  ticketId: string;
  message?: string;
  includeUnstaged?: boolean;
}

/** `{ rescan: true }` forces a fresh orphan sweep (Settings → Worktrees rescan); omitted/`false` returns the launch's cached report. */
export interface WorktreeOrphansInput {
  rescan?: boolean;
}

/** `{ path }` — the Settings list's explicit, user-confirmed dirty-orphan deletion target. */
export interface WorktreeOrphanDeleteInput {
  path: string;
}

/** `{ ticketId, keep }` — sets/clears the durable retention pin. */
export interface RetentionKeepInput {
  ticketId: string;
  keep: boolean;
}

/** `{ days }` — the new global Done-TTL; `setRetentionTtlDays` clamps it to ≥ 1 day. */
export interface RetentionTtlSetInput {
  days: number;
}

// ---- file-channel input shapes (docs/plans/global-artifacts.md) -----------

/** The whole-project file index is always read from the project's MAIN checkout. */
export interface FileIndexInput {
  projectId: string;
}

/**
 * The shape shared by read/reveal/watch/unwatch: a project-relative path,
 * resolved worktree-awarely when `ticketId` is given (decision #6, `.volli/**`
 * always resolves to the main checkout regardless), else against the
 * project's main checkout.
 */
export interface FilePathInput {
  projectId: string;
  ticketId?: string;
  relPath: string;
}

/**
 * One expanded directory of the Project Files tree, watched for changes
 * (issue #106). Project Files is always MAIN-rooted (CONCEPT #54), so there is
 * deliberately no `ticketId`: the subscription can't drift to a worktree copy.
 * `relPath` is the project-relative directory, with the empty string meaning
 * the project root itself — `"."` is rejected, so there is exactly one spelling.
 */
export interface DirPathInput {
  projectId: string;
  relPath: string;
}

/** `write`'s extra fields: the new content, and an optional mtime conflict guard (decision #7). */
export interface FileWriteInput extends FilePathInput {
  content: string;
  expectedMtime?: number;
}

/** `name` is forced to `.md` inside `.volli/artifacts/` (decision #8). */
export interface ArtifactCreateInput {
  projectId: string;
  name: string;
}

/**
 * The DB-backed request surface `src/main/data-ipc.ts` owns. Args are the raw
 * `ipcRenderer.invoke` argument tuples — positional shapes (e.g. app-state-set's
 * `[key, value]`) stay positional so the wire format is unchanged.
 */
export interface VolliDataIpcContract {
  "volli:data-bootstrap": { args: []; result: BootstrapResult };
  /** One-time localStorage → SQLite import; a no-op (returns current state) once the db is non-empty. */
  "volli:legacy-import": { args: [request: LegacyImportRequest]; result: LegacyImportResult };

  "volli:project-create": { args: [input: ProjectCreateInput]; result: ProjectCreateResult };
  /** Updates the project's pinned automation base branch and/or worktree setup command. */
  "volli:project-update": { args: [input: ProjectUpdateInput]; result: ProjectUpdateResult };
  /** Deletes a project; cascades its tickets/labels/events in SQLite. */
  "volli:project-remove": { args: [id: string]; result: ProjectMutationResult };
  /** Rewrites rail `sort_order` to `0..n-1` following `orderedIds`. */
  "volli:project-reorder": { args: [orderedIds: string[]]; result: ProjectMutationResult };

  "volli:ticket-create": { args: [input: TicketCreateInput]; result: TicketResult };
  "volli:ticket-move": { args: [input: TicketMoveInput]; result: TicketsResult };
  /** Resolves with just the mutated ticket (patched into the list by id), not the whole project. */
  "volli:ticket-set-priority": { args: [input: TicketSetPriorityInput]; result: TicketResult };
  "volli:ticket-update": { args: [input: TicketUpdateInput]; result: TicketResult };
  /** Replaces a ticket's labels by name; unknown names are created (`color: null`) per project. */
  "volli:ticket-set-labels": { args: [input: TicketSetLabelsInput]; result: TicketResult };
  /** Archives a ticket — it leaves the board but the row, labels, and event log survive (reversible). */
  "volli:ticket-archive": { args: [input: TicketIdInput]; result: Result };
  /** Returns an archived ticket to the board (appended to its retained column); resolves with the revived live ticket. */
  "volli:ticket-unarchive": { args: [input: TicketIdInput]; result: TicketResult };
  /** Hard-deletes an archived ticket (cascades its labels + events). The only destructive act — rejects a live ticket. */
  "volli:ticket-delete": { args: [input: TicketIdInput]; result: Result };
  /** The project's archived tickets, newest first — loaded on demand for the Archive view. */
  "volli:ticket-list-archived": { args: [projectId: string]; result: ArchivedTicketsResult };
  /** A ticket's full event history, chronological — backs the Activity feed. */
  "volli:ticket-events": { args: [input: TicketIdInput]; result: TicketEventsResult };
  /** The latest durable Session outcome per ticket — one batched read backing the sidebar's attention rows. */
  "volli:ticket-latest-signals": {
    args: [input: ProjectIdInput];
    result: TicketLatestSignalsResult;
  };
  /** When each non-archived ticket entered its current status — one batched read backing the sidebar. */
  "volli:ticket-status-entries": {
    args: [input: ProjectIdInput];
    result: TicketStatusEntriesResult;
  };

  /** A ticket's comments, chronological — the work-log feed. */
  "volli:comment-list": { args: [input: TicketIdInput]; result: TicketCommentsResult };
  /** Posts a comment as the human user; also records a `commented` event in the same transaction. */
  "volli:comment-create": { args: [input: CommentCreateInput]; result: TicketCommentResult };
  /** Edits a comment's body; touches `updatedAt` only, no event. */
  "volli:comment-update": { args: [input: CommentUpdateInput]; result: TicketCommentResult };
  /** Hard-deletes a comment; no event. */
  "volli:comment-remove": { args: [input: CommentIdInput]; result: Result };

  /** Every durable session record in a project (ticket-scoped and project-scoped scratch), newest first. */
  "volli:session-list": { args: [input: ProjectIdInput]; result: SessionsResult };
  /** A ticket's durable session records, newest first — backs the right-rail linked-sessions list. */
  "volli:session-list-for-ticket": { args: [input: TicketIdInput]; result: SessionsResult };
  /** Renames a session (scratch or ticket-scoped); the title is trimmed and must be non-empty in main. */
  "volli:session-rename": { args: [input: SessionRenameInput]; result: SessionRenameResult };
  "volli:label-set-color": { args: [input: LabelSetColorInput]; result: LabelResult };
  "volli:app-state-set": { args: [key: string, value: string]; result: AppStateSetResult };

  // Ticket worktrees (docs/plans/worktree-support.md). `ensure` has no channel
  // on purpose — it only ever runs implicitly inside terminal-create (§1).
  /** The "Remove worktree…" escape hatch; `force` discards uncommitted work when the caller has confirmed. */
  "volli:worktree-remove": { args: [input: WorktreeRemoveInput]; result: WorktreeRemoveResult };
  /** A project's local branch names, for the base-branch picker. */
  "volli:worktree-branches": { args: [input: ProjectIdInput]; result: WorktreeBranchesResult };
  /**
   * The launch's cached orphan report — the destructive sweep runs once per
   * launch (main), so this never re-sweeps. `{ rescan: true }` forces the
   * explicit Settings → Worktrees rescan. `opts` is optional on the wire (the
   * existing test suite invokes this with no argument at all) — the preload
   * always sends `opts ?? {}`, so both `[]` and `[{ rescan? }]` are live.
   */
  "volli:worktree-orphans": {
    args: [opts?: WorktreeOrphansInput];
    result: WorktreeOrphansResult;
  };
  /** User-confirmed deletion of one dirty orphan dir; main re-validates it lives inside the worktree home. */
  "volli:worktree-orphan-delete": {
    args: [input: WorktreeOrphanDeleteInput];
    result: WorktreeOrphanDeleteResult;
  };

  // Done flow (docs/plans/done-flow.md §"Persistence, IPC, events"): the
  // Details-rail diff/commit/push-PR affordances. `status`/`diff` are read-only;
  // `commit` records an event; `push-pr` composes fetch→push→PR and is async.
  "volli:worktree-status": { args: [input: TicketIdInput]; result: WorktreeStatusResult };
  /** `"working-tree"` (uncommitted now) or `"merge-base"` (the PR delta). */
  "volli:worktree-diff": { args: [input: WorktreeDiffInput]; result: WorktreeDiffResult };
  /**
   * The composed Change Set snapshot (CONCEPT #47): the ticket worktree's
   * complete current outcome relative to its recorded base.
   */
  "volli:worktree-change-set": {
    args: [input: TicketIdInput];
    result: WorktreeChangeSetResult;
  };
  /**
   * Reads one file's contents at the Change Set's stamped base revision without
   * mutating the checkout (`git show`). `{ missing: true }` when the path was
   * absent at the base (added/untracked originals).
   */
  "volli:worktree-base-read": {
    args: [input: WorktreeBaseReadInput];
    result: WorktreeBaseReadResult;
  };
  /** Starts a debounced recursive watch on the ticket worktree for Change Set refresh. */
  "volli:worktree-change-watch": { args: [input: TicketIdInput]; result: Result };
  "volli:worktree-change-unwatch": { args: [input: TicketIdInput]; result: Result };
  /** The one-click "commit remaining work" safety net; the message and the staging breadth are the caller's, with the historical defaults. */
  "volli:worktree-commit": { args: [input: WorktreeCommitInput]; result: WorktreeCommitResult };
  /** Push the branch and open (or re-discover) its draft PR; persists `pr_url`. */
  "volli:worktree-push-pr": { args: [input: TicketIdInput]; result: WorktreePushPrResult };

  // Retention (CONCEPT #16, issue #76): the merge-watch/Done-TTL surface. `state`
  // is a read; `keep`/`dismiss`/`archive-clean`/`ttl-set` mutate; `poll` is the
  // renderer-side trigger of an immediate poll (e.g. on window focus).
  "volli:retention-state": { args: [input: TicketIdInput]; result: RetentionStateResult };
  /** Sets/clears the durable Keep pin — exempts the ticket from BOTH retention paths. */
  "volli:retention-keep": { args: [input: RetentionKeepInput]; result: RetentionKeepResult };
  /** Dismisses the Archive prompt for this launch (re-offered next launch — NOT the Keep pin). */
  "volli:retention-dismiss": { args: [input: TicketIdInput]; result: RetentionDismissResult };
  /** Archives the ticket + removes its worktree (dirty refuses); branch retained. */
  "volli:retention-archive-clean": {
    args: [input: TicketIdInput];
    result: RetentionArchiveCleanResult;
  };
  "volli:retention-ttl-get": { args: []; result: RetentionTtlResult };
  /** `setRetentionTtlDays` clamps to ≥ 1 day; resolves with the stored value. */
  "volli:retention-ttl-set": { args: [input: RetentionTtlSetInput]; result: RetentionTtlResult };
  /** Fire-and-forget trigger of an immediate merge-watch poll; the poll itself broadcasts on change. */
  "volli:retention-poll": { args: []; result: RetentionPollResult };
}

export type DataIpcChannel = keyof VolliDataIpcContract;

/**
 * Global artifacts + `@file` refs (docs/plans/global-artifacts.md) plus the
 * Project Files workspace (issue #106) — the file channels
 * `src/main/volli-fs.ts` owns.
 */
export interface VolliFileIpcContract {
  /** The whole-project file index the `@` picker ranks over (git-listed + `.volli/artifacts/`). Fetched fresh per picker open. */
  "volli:file-index": { args: [input: FileIndexInput]; result: FileIndexResult };
  /** Reads any repo/artifact file worktree-awarely: text (capped), image (data URI), or binary stub. */
  "volli:file-read": { args: [input: FilePathInput]; result: FileReadResult };
  /** Writes utf8 text to an existing file (images/binary/oversize refused), `expectedMtime` conflict-guarded. Resolves with the fresh mtime. */
  "volli:file-write": { args: [input: FileWriteInput]; result: FileWriteResult };
  /** Creates a new, minimally-templated `.md` in `.volli/artifacts/`. Resolves with its `@ref`-able relPath. */
  "volli:artifact-create": { args: [input: ArtifactCreateInput]; result: ArtifactCreateResult };
  /** Reveals the resolved file in Finder. */
  "volli:file-reveal": { args: [input: FilePathInput]; result: Result };
  /** Watches one open file tab (debounced main→renderer change events); pair with `unwatch` on unmount. */
  "volli:file-watch": { args: [input: FilePathInput]; result: Result };
  "volli:file-unwatch": { args: [input: FilePathInput]; result: Result };
  /**
   * Watches ONE expanded Project Files directory (non-recursive, main checkout)
   * so the tree can re-list just what changed instead of hydrating the repo;
   * pair with `dir-unwatch` on collapse.
   */
  "volli:dir-watch": { args: [input: DirPathInput]; result: Result };
  "volli:dir-unwatch": { args: [input: DirPathInput]; result: Result };
  /** The `/` picker's prompt templates: the project's `.volli/commands/` over the global `<userData>/commands/`. */
  "volli:prompt-templates": {
    args: [input: PromptTemplateIndexInput];
    result: PromptTemplateIndexResult;
  };
}

export type FileIpcChannel = keyof VolliFileIpcContract;

/**
 * Every open document currently holding an unsaved draft, as the renderer last
 * saw it — the input to main's quit gate.
 *
 * Names, not paths: the only thing main does with this is decide whether to stop
 * a quit and tell the user what is about to be destroyed, and a basename is what
 * belongs in that sentence. Sending the whole path would leak more of the user's
 * filesystem into a process that has no use for it.
 */
export interface UnsavedDocumentsReport {
  /** Display names of the documents with unsaved work, in tab order. */
  names: readonly string[];
}

// ---- bring-your-own harness trust (docs/plans/harness-events.md §Trust) ----

/**
 * A manifest Volli found on disk and will not launch until someone confirms it,
 * carried with everything the confirmation has to state.
 *
 * {@link HarnessTrustPrompt} supplies the claim — the slug, the resolved binary,
 * the exact argv, the claimed events. The two fields added here are what the
 * ANSWER is filed against: a verdict is about bytes, so the hash the user was
 * shown travels back with it (see {@link HarnessTrustSetInput}), and the path
 * says which file on disk those bytes came from.
 */
export interface PendingHarnessManifest extends HarnessTrustPrompt {
  manifestPath: string;
  /** SHA-256 of the bytes this confirmation describes. */
  manifestSha256: string;
}

/**
 * A manifest that was found but could not become an adapter — unparseable
 * JSON, a failed validation, a slug disagreeing with its directory.
 *
 * Carried on the pending read rather than dropped in main, because dropped is
 * what it was: a broken manifest is not pending (there is no command line to
 * confirm) and not registered (there is nothing to launch), so without this
 * field the person who just wrote it gets total silence from every surface.
 */
export interface BrokenHarnessManifest {
  slug: string;
  manifestPath: string;
  errors: readonly ManifestError[];
}

/** The manifests waiting on a human — empty is the ordinary case. */
export type HarnessPendingResult =
  | { ok: true; pending: PendingHarnessManifest[]; broken: BrokenHarnessManifest[] }
  | { ok: false; error: string };

/**
 * One verdict, about one version of one manifest.
 *
 * `manifestSha256` is not redundant with `slug`: it is the hash the user was
 * actually shown, and main refuses the write when the file no longer hashes to
 * it. Without that, a manifest edited between the dialog opening and the button
 * being pressed would be trusted on the strength of a command line nobody read.
 */
export interface HarnessTrustSetInput {
  slug: string;
  manifestSha256: string;
  decision: HarnessTrustVerdict;
}

/**
 * The registered harnesses a launch would accept right now — every manifest
 * someone confirmed the bytes of, as main resolved them for the wrappers it
 * last generated. Built-ins are absent by construction: the renderer compiles
 * those in, so this channel carries only what it could not otherwise know.
 *
 * Whole adapters rather than a summary, because an adapter is pure data
 * (`harness/types.ts`) and that is the point of it: the renderer reads a
 * registered harness's tier and its declared events with the exact functions it
 * reads a built-in's, instead of a parallel shape that would have to be widened
 * every time an adapter grows a field.
 *
 * `channels` rides the same read rather than earning a channel of its own: this
 * is already the per-harness metadata the picker fetches when it opens, and a
 * second round-trip would only give the two answers different ages. Unlike
 * `harnesses` it covers the BUILT-INS too — they are the ones the durable record
 * was switched off for — and it carries only harnesses something has been
 * observed about. A harness absent from it is `unproven`, which is also what a
 * renderer that never looks at the field believes about all of them.
 */
export type HarnessRegisteredResult =
  | { ok: true; harnesses: HarnessAdapter[]; channels: HarnessChannelStatus[] }
  | { ok: false; error: string };

/**
 * The bring-your-own-harness surface (`src/main/harness-ipc.ts`): ask what is
 * waiting, answer one of them, and ask what the answers add up to. A registered
 * manifest is inert until a verdict lands here, so the first two channels are
 * the whole difference between a manifest on disk and a harness that can
 * launch — and the third is how anything but main gets to hear that it did.
 */
export interface VolliHarnessIpcContract {
  /** Every discovered manifest nobody has ruled on, re-read and re-hashed per call. */
  "volli:harness-pending": { args: []; result: HarnessPendingResult };
  /** Records a human's verdict about the exact bytes they were shown. */
  "volli:harness-trust-set": { args: [input: HarnessTrustSetInput]; result: Result };
  /** The trusted registered harnesses, as the launch path would resolve them. */
  "volli:harness-registered": { args: []; result: HarnessRegisteredResult };
}

export type HarnessIpcChannel = keyof VolliHarnessIpcContract;

// ---- CLI install detection (VC-52) ----------------------------------------

/**
 * What is true of the background CLI install right now, measured at call time
 * by `src/main/cli-status.ts`. Every field is detection, not configuration:
 * the pane this feeds exists because the install is silent, and a silent
 * install with no truthful surface is indistinguishable from a broken one.
 */
export interface CliToolStatus {
  /** `~/.local/bin/volli`: `ours` links this app's shim; `foreign`/`not-symlink` were left alone. */
  link: {
    path: string;
    state: "ours" | "missing" | "foreign" | "not-symlink";
    target: string | null;
  };
  /** Whether the login shell reaches `~/.local/bin`; `unknown` means the shell could not be asked. */
  path: { binDir: string; state: "reachable" | "missing" | "unknown" };
  /** The agent socket this launch owns, and whether it came up. */
  socket: { path: string; live: boolean };
  /** Harness wrapper command names the last runtime regeneration produced. */
  wrappers: { commands: string[] };
  /** The login shell, whether the zsh-only chain supports it, and whether the chain exists. */
  shell: { name: string; supported: boolean; chainActive: boolean };
  /** The retired admin-owned `/usr/local/bin/volli` link, when one survives migration. */
  legacy: { path: string; state: "absent" | "ours" | "foreign" };
  /** The File → Remove tombstone: background install stands down until reinstalled. */
  installSuppressed: boolean;
}

export type CliStatusResult = { ok: true; status: CliToolStatus } | { ok: false; error: string };

/** `fix: true` runs main's idempotent repair (regenerate + reinstall) before the probe. */
export interface CliDoctorInput {
  fix: boolean;
}

/**
 * A real `volli doctor` run: main spawns the user's login shell, which resolves
 * `volli` off its own PATH — the environment agents outside Volli actually get.
 */
export type CliDoctorResult =
  | { ok: true; checks: DoctorCheck[]; summary: string }
  | { ok: false; error: string };

/** The Settings → CLI surface (`src/main/cli-ipc.ts`). */
export interface VolliCliIpcContract {
  "volli:cli-status": { args: []; result: CliStatusResult };
  "volli:cli-doctor": { args: [input: CliDoctorInput]; result: CliDoctorResult };
}

export type CliIpcChannel = keyof VolliCliIpcContract;

// ---- theming ----------------------------------------------------------------

/** `{ projectId? }` — a theme read is global unless a project scopes it (#69). */
export interface ThemeStateInput {
  projectId?: string;
}

/**
 * Persists the global Monaco/shiki theme id (`app_state.theme_editor`).
 * `null` clears it back to the shipped default editor theme, independent of
 * appearance.
 */
export interface ThemeSetGlobalEditorInput {
  editorThemeId: ShippedEditorThemeId | null;
  /**
   * The scope the CALLER is in — not a second write target (#123). The write
   * is global from every scope; this only says which scope's state to answer
   * with, so a window showing a project that overrides a surface keeps wearing
   * that override instead of being repainted to the new global.
   */
  projectId?: string;
}

export interface ThemeSetProjectInput {
  projectId: string;
  /** Per-surface override; `null` clears every surface back to inheriting the global theme. */
  override: ProjectThemeOverride | null;
}

/**
 * A terminal-overlay write. `scope` picks WHICH overlay file — never a path:
 * the renderer cannot name a file to write, so decision #67's "Volli never
 * writes the user's ghostty config" holds at the boundary as well as at the
 * write path.
 */
export type TerminalOverlayWriteInput = {
  edits: Record<string, string | null>;
} & ({ scope: "global" } | { scope: "project"; projectId: string });

/**
 * What a scope needs that `volli:data-bootstrap` cannot ship: the resolved
 * TERMINAL chain (which has to be read off the filesystem), plus the editor id
 * and the migration-013 row those two surfaces still live on. The app surface is
 * not here — its `{canvas, appearance}` pair rides the bootstrap payload.
 */
export interface ThemeStatePayload {
  /**
   * Global Monaco/shiki theme id from `app_state`. `null` means the shipped
   * default editor theme (appearance-independent) — never a resolved token set.
   */
  editorThemeId: ShippedEditorThemeId | null;
  /** The scoping project's per-surface override; null when unscoped or fully inheriting. */
  projectOverride: ProjectThemeOverride | null;
  /** The project the state was resolved for, echoed back; null for the global scope. */
  projectId: string | null;
  /** The terminal appearance with the full overlay chain (and provenance) applied for that scope. */
  terminal: GhosttyAppearancePayload;
}

// ---- canvas theming writes (docs/plans/arc-theming-migration.md) ------------
// WRITES ONLY. There is no `volli:canvas-state` read channel and there must not
// be one: the global canvas, the global appearance and the first-paint hint are
// `app_state` rows, and every project's canvas is a `projects` column — so
// `volli:data-bootstrap` already ships all of it, in one round trip, at the one
// moment the renderer needs it. A second read path would be a second answer to
// "what is the theme?", which is exactly the drift the single-authoritative-
// pair rule exists to prevent.

/** `{ canvas }` — the authored gradient, replacing whatever the global scope held. */
export interface CanvasSetGlobalInput {
  canvas: Canvas;
}

/** `{ appearance }` — light, dark, or follow-the-system, at the global scope. */
export interface AppearanceSetGlobalInput {
  appearance: Appearance;
}

/** `{ projectId, canvas }` — `null` clears the override back to inheriting the global canvas. */
export interface CanvasSetProjectInput {
  projectId: string;
  canvas: Canvas | null;
}

/** `{ projectId, appearance }` — `null` clears the override back to inheriting the global appearance. */
export interface AppearanceSetProjectInput {
  projectId: string;
  appearance: Appearance | null;
}

/**
 * The first-paint HINT: the mode the renderer resolved to, and the canvas
 * background it painted.
 *
 * This is a cache, not an authority. `{canvas, appearance}` remains the only
 * authoritative pair — this row exists solely because main has to answer "what
 * color is this window's edge, and is it light or dark?" *synchronously, at
 * window construction*, before any renderer exists to ask. Whenever the two
 * disagree, the pair wins and this row is overwritten on the next paint.
 *
 * It is NOT a violation of "never persist the resolved token set" (`apply.ts`):
 * what is stored is one enum and one hex — the two values main physically
 * cannot derive without the renderer — not the 31-token ladder. Persisting the
 * ladder would let a stale copy of it out-vote the authored canvas, which is the
 * bug that rule is about; one background color cannot, because nothing reads it
 * after first paint.
 */
export interface FirstPaintHint {
  /** `auto` already resolved — main stamps this mode before the renderer boots. */
  appearance: ResolvedAppearance;
  /** The canvas background as a hex color; `BrowserWindow`'s `backgroundColor`. */
  background: string;
}

export type ThemeStateResult = Result<{ value: ThemeStatePayload }>;
export type ThemeSetProjectResult = Result<{ project: Project; value: ThemeStatePayload }>;
/**
 * A project-scoped canvas/appearance write answers with the authoritative row —
 * the `volli:project-*` precedent — so the renderer adopts the stored
 * `row_version`/`updatedAt` instead of predicting them.
 */
export type ProjectCanvasWriteResult = Result<{ project: Project }>;
/** Resolves with the overlay file written and the freshly re-resolved terminal appearance, so the renderer can repaint without a second round trip. */
export type TerminalOverlayWriteResult = Result<{
  path: string;
  terminal: GhosttyAppearancePayload;
}>;

/**
 * The theming channels `src/main/theme-ipc.ts` owns.
 *
 * One read and a set of writes. The read exists only because the terminal chain
 * has to be resolved off the filesystem; everything the canvas stores is an
 * `app_state` row or a `projects` column, which `volli:data-bootstrap` already
 * ships — so a canvas write answers with a bare ack rather than fresh state.
 */
export interface VolliThemeIpcContract {
  /** The resolved terminal chain for a scope, plus the editor id and the migration-013 row. */
  "volli:theme-state": { args: [input: ThemeStateInput]; result: ThemeStateResult };
  /**
   * Persists the global editor theme id (`app_state.theme_editor`). `null` clears
   * it back to the shipped default editor theme, independent of appearance.
   * Resolves with fresh state.
   */
  "volli:theme-set-global-editor": {
    args: [input: ThemeSetGlobalEditorInput];
    result: ThemeStateResult;
  };
  /** Persists one project's per-surface override (migration 013); `null` clears it. */
  "volli:theme-set-project": { args: [input: ThemeSetProjectInput]; result: ThemeSetProjectResult };
  /**
   * Persists the authored global canvas (`app_state.theme`). Answers with a bare
   * ack: the caller already holds what it sent, and every reader gets the row
   * back through `volli:data-bootstrap`.
   */
  "volli:theme-canvas-set-global": { args: [input: CanvasSetGlobalInput]; result: Result };
  /** Persists the global appearance (`app_state.appearance`). */
  "volli:theme-appearance-set-global": { args: [input: AppearanceSetGlobalInput]; result: Result };
  /** Persists one project's canvas override (migration 014); `null` clears it. */
  "volli:theme-canvas-set-project": {
    args: [input: CanvasSetProjectInput];
    result: ProjectCanvasWriteResult;
  };
  /** Persists one project's appearance override (migration 014); `null` clears it. */
  "volli:theme-appearance-set-project": {
    args: [input: AppearanceSetProjectInput];
    result: ProjectCanvasWriteResult;
  };
  /**
   * Records what the renderer actually resolved and painted, so the NEXT launch
   * can construct its window with the right edge color and the right mode class
   * before anything runs. A hint, never an authority — see {@link FirstPaintHint}.
   */
  "volli:theme-first-paint-set": { args: [input: FirstPaintHint]; result: Result };
  /** Rewrites keys in a Volli ghostty overlay — global or per-project. Never the user's own config. */
  "volli:theme-terminal-overlay-write": {
    args: [input: TerminalOverlayWriteInput];
    result: TerminalOverlayWriteResult;
  };
}

export type ThemeIpcChannel = keyof VolliThemeIpcContract;

/**
 * One provider sign-in, conducted inside the app.
 *
 * Its own surface rather than a Session RPC namespace, and the reason is the
 * one argument on it that is a credential. Every Session RPC procedure is
 * wrapped by a diagnostic-recording middleware whose ring buffer a lab
 * subscription can tap; routing an API key through the one component built to
 * write things down would put the secret and the log tap on the same wire, and
 * "never logged" is the property this channel exists to keep. Nothing on these
 * four channels is recorded, and there is no resume cursor and no replay: an
 * attempt lives as long as the window that started it.
 *
 * Cancellable from both ends. The renderer cancels through
 * `volli:model-access-sign-in-cancel`; main abandons the attempt when the
 * window that owns it goes away, because a flow parked on a prompt nobody can
 * answer would otherwise hold a provider's one attempt slot until quit.
 */
export interface VolliModelAccessIpcContract {
  /**
   * Starts an attempt and answers with the id every later message carries.
   *
   * The method is the caller's, not a default: a provider may offer both an API
   * key and a subscription, they are different accounts, and picking for the
   * user would silently sign them in to the wrong one.
   */
  "volli:model-access-sign-in-begin": {
    args: [providerId: string, type: ModelAccessSignInType];
    result: ModelAccessSignInBeginResult;
  };
  /**
   * Answers the step an attempt is parked on.
   *
   * `value` is the one inbound secret in the app. It crosses once, is handed
   * straight to the provider's flow, and is never stored by anything on this
   * side of the call, never echoed back, and never included in an error string.
   * An answer naming a prompt that is no longer pending is refused rather than
   * applied to whatever is pending now.
   */
  "volli:model-access-sign-in-respond": {
    args: [attemptId: string, promptId: string, value: string];
    result: Result;
  };
  /** Abandons an attempt; the parked prompt rejects and the flow unwinds. */
  "volli:model-access-sign-in-cancel": { args: [attemptId: string]; result: Result };
  /** Deletes this profile's stored credential for a provider. Ambient sources are untouched. */
  "volli:model-access-sign-out": { args: [providerId: string]; result: Result };
}

export type ModelAccessIpcChannel = keyof VolliModelAccessIpcContract;

/** The attempt id every later message about one sign-in is correlated by. */
export type ModelAccessSignInBeginResult = Result<{ attemptId: string }>;

/**
 * Type-only entries for every remaining invoke channel — these live outside
 * `src/main/data-ipc.ts`/`volli-fs.ts` (in `src/main/ipc.ts`/`pty.ts`/
 * `ghostty-config.ts`) and have no runtime descriptor table yet, but are
 * declared here so the whole invoke catalog is contract-complete and
 * {@link VolliIpcChannel} can be derived rather than hand-maintained.
 */
export interface VolliSystemIpcContract {
  "volli:pick-project-folder": { args: []; result: PickFolderResult };
  "volli:sync-project-roots": { args: [paths: string[]]; result: void };
  "volli:list-directory": { args: [absPath: string]; result: ListDirectoryResult };
  "volli:reveal-in-finder": { args: [absPath: string]; result: RevealResult };
  "volli:window-is-fullscreen": { args: []; result: boolean };
  /** Boots a PTY session; resolves with its id or a typed error. */
  "volli:terminal-create": {
    args: [req: CreateTerminalSessionRequest];
    result: CreateTerminalSessionResult;
  };
  /** Writes raw input bytes to a session's PTY. */
  "volli:terminal-write": { args: [sessionId: string, data: string]; result: TerminalIoResult };
  /** Resizes a session's PTY to the given grid. */
  "volli:terminal-resize": {
    args: [sessionId: string, cols: number, rows: number];
    result: TerminalIoResult;
  };
  /** Kills a session's PTY. */
  "volli:terminal-kill": { args: [sessionId: string]; result: TerminalIoResult };
  /** Parks a session (SIGSTOP its tree) on user request; bypasses the auto-park guards. */
  "volli:terminal-park": { args: [sessionId: string]; result: TerminalIoResult };
  /** Wakes a parked session (SIGCONT its tree). */
  "volli:terminal-wake": { args: [sessionId: string]; result: TerminalIoResult };
  /** Pins/unpins a session against auto-park; waking it if already parked. */
  "volli:terminal-keep-awake": {
    args: [sessionId: string, keepAwake: boolean];
    result: TerminalIoResult;
  };
  /** Foreground-process probe: is the session running something beyond its shell? */
  "volli:terminal-busy": { args: [sessionId: string]; result: TerminalBusyResult };
  /** Reads the user's resolved Ghostty config, mapped onto restty's appearance model. */
  "volli:ghostty-config-get": { args: []; result: GhosttyConfigResult };
}

/**
 * The native Session tRPC edge (`src/main/session-rpc-ipc.ts`): ONE invoke
 * channel carrying every routed procedure, because the router — not this
 * contract — is where a Session procedure's input and output are declared.
 * The wire shapes live in `session-rpc-wire.ts`; the renderer's terminating
 * tRPC link is the only thing that should ever speak them directly.
 */
export interface VolliSessionRpcIpcContract {
  /** Runs one routed procedure; `session.subscribe` acknowledges with a subscription id instead. */
  "volli:session-rpc": { args: [request: SessionRpcIpcRequest]; result: SessionRpcIpcResponse };
}

/**
 * The 4 send-based channels (`ipcRenderer.send`, not `invoke`) — declared
 * separately from {@link VolliInvokeContract} because they have no result to
 * await.
 */
export interface VolliSendContract {
  // Send-based (ipcRenderer.send, not invoke): main cannot ASK the renderer
  // whether quitting is safe — `before-quit` needs a synchronous verdict to
  // preventDefault against, and by then the renderer may already be tearing
  // down. So the renderer pushes what it knows and main answers from the last
  // report, exactly as the terminal gate answers from `busySessions()`. There is
  // no reply to await, and the report rides a dirty transition in an editor the
  // user is typing in, so an invoke round-trip would tax the keystroke.
  "volli:unsaved-documents": { args: [report: UnsavedDocumentsReport] };
  // Send-based (ipcRenderer.send, not invoke): a fire-and-forget flow-control
  // ack needs no reply, and awaiting one per data event would defeat it.
  "volli:terminal-ack": { args: [sessionId: string, chars: number] };
  // Send-based (ipcRenderer.send, not invoke): visibility flips on every board
  // ⇄ session nav, needs no reply, and round-tripping an invoke per flip would
  // add latency to navigation for nothing.
  "volli:terminal-set-visible": { args: [sessionId: string, visible: boolean] };
  // Send-based (ipcRenderer.send, not invoke): main answers a cancellation by
  // stopping the frames, which the renderer is already listening for — an ack
  // would only be a second way to learn the same thing, later.
  "volli:session-rpc-cancel": { args: [subscriptionId: string] };
}

/** Every invoke channel with a contract entry — the full catalog. */
export interface VolliInvokeContract
  extends
    VolliDataIpcContract,
    VolliFileIpcContract,
    VolliHarnessIpcContract,
    VolliCliIpcContract,
    VolliThemeIpcContract,
    VolliModelAccessIpcContract,
    VolliSessionRpcIpcContract,
    VolliSystemIpcContract {}

export type IpcArgs<C extends keyof VolliInvokeContract> = VolliInvokeContract[C]["args"];
export type IpcResult<C extends keyof VolliInvokeContract> = VolliInvokeContract[C]["result"];

/**
 * Channel names for the preload's `contextBridge` API — every invoke channel
 * (the full contract) plus the 2 send-based ones. Derived, so a channel can no
 * longer be added to one side (a handler, a preload call) and forgotten on the
 * other: every literal channel string in main/preload carries a `satisfies
 * VolliIpcChannel`, so an omission here fails the whole desktop compile.
 */
export type VolliIpcChannel = keyof VolliInvokeContract | keyof VolliSendContract;

/** Channel names for main→renderer push events (`webContents.send`). */
export type VolliIpcEvent =
  | "volli:fullscreen-changed"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:terminal-park-state"
  | "volli:ghostty-config-changed"
  | "volli:data-changed"
  // Backward-move interrupt announcement (issue #78, CONCEPT #20): fired after
  // a ticket move out of the active columns actually Esc'd live agent sessions,
  // so every window can surface the automated de-escalation where the mover is
  // looking (a toast with a jump-to-ticket action) — never silently.
  | "volli:sessions-interrupted"
  // Fired by the native View menu's zoom items. The renderer applies CSS zoom
  // to the content row (below the chrome band) rather than letting Electron
  // scale the whole page — see menu.ts for why the zoom roles are replaced.
  | "volli:ui-zoom-command"
  // Debounced fs.watch broadcast (~250ms) for a single watched file tab —
  // see volli-fs.ts's FileWatchManager.
  | "volli:file-changed"
  // The same debounced broadcast for one expanded Project Files directory —
  // see volli-fs.ts's DirWatchManager. Carries no listing: the renderer
  // re-reads the one directory it owns, so the tree never mirrors the repo.
  | "volli:dir-changed"
  // Debounced recursive watch over a live ticket worktree — see
  // worktree/change-set-watch.ts. Carries only the ticketId; the renderer
  // refetches the Change Set snapshot.
  | "volli:worktree-changed"
  // A ticket's worktree watch FAULTED and was dropped — see
  // worktree/change-set-watch.ts. The Change Set the renderer is showing is now
  // frozen, so it must say so rather than quietly going stale forever.
  | "volli:worktree-watch-error"
  // Transient worktree-ensure phase transitions (never persisted; the renderer
  // mirrors them in a keyed store map, the `starting[ticketId]` pattern).
  | "volli:worktree-phase"
  // A real OS light↔dark flip — `nativeTheme`'s `updated`, carrying
  // `shouldUseDarkColors`. Main is the only process that can see one: Chromium
  // resolves the renderer's `prefers-color-scheme` query against the root
  // element's used `color-scheme`, which this app stamps itself, so over there
  // the query only ever reports the mode already painted. Every scope on `auto`
  // re-resolves off this.
  | "volli:system-appearance-changed"
  // One canonical harness event (harness-events): a hook the wrapper
  // configured fired, and main resolved which session it belongs to. This is
  // the involuntary channel — the renderer learns what the agent is doing
  // without the agent having chosen to say so.
  | "volli:harness-event"
  // A different harness is now running in one session's terminal, announced by
  // its own launch wrapper. The other involuntary channel, and the one that
  // reaches the tiers hooks cannot — see {@link SessionHarnessNotice}.
  | "volli:session-harness"
  // A structured chat Session was started on a ticket from OUTSIDE this window
  // (the agent socket's `session.start`, VC-13). The renderer shows a toast
  // whose action opens that session's chat tab — and does nothing else: the
  // app must never navigate or steal focus because a start landed.
  | "volli:session-started"
  // Ordered frames for one live Session RPC subscription — see
  // {@link SessionRpcIpcEvent}. Every subscription shares this channel and is
  // told apart by the id main acknowledged the request with.
  | "volli:session-rpc-event"
  // Everything main has to say about one in-app provider sign-in — see
  // {@link ModelAccessSignInUpdate}. ONE channel for prompts, withdrawals,
  // events and the verdict, because the order across those kinds is the
  // meaning: an OAuth flow asks for a code, then withdraws the question when
  // the browser callback wins the race, and a renderer that saw those two
  // swapped would leave a dead input box waiting for a code nothing consumes.
  // Sent to the window that began the attempt, never broadcast.
  | "volli:model-access-sign-in";

// ---- session-rpc wire agreement ---------------------------------------------
// @volli/shared owns the three Session RPC channel NAMES (session-rpc-wire.ts)
// because both ends of the tRPC edge need them and the package is the only
// place both can reach. It cannot check them against this catalog itself: it is
// pure domain code that knows nothing about Electron transport, and a package
// may never import from the app that consumes it.
//
// So the agreement is asserted from this side, app → package. Each constant
// must still name a channel the contract declares — renaming one in shared, or
// dropping its declaration here, is a compile error in the desktop build
// instead of a channel that quietly answers nothing at runtime.
type Assert<Covered extends true> = Covered;
type Declares<Channel extends string, Catalog extends string> = Channel extends Catalog
  ? true
  : false;

export type SessionRpcInvokeChannelIsDeclared = Assert<
  Declares<typeof SESSION_RPC_IPC_CHANNEL, keyof VolliInvokeContract & string>
>;
export type SessionRpcCancelChannelIsDeclared = Assert<
  Declares<typeof SESSION_RPC_CANCEL_CHANNEL, keyof VolliSendContract & string>
>;
export type SessionRpcEventChannelIsDeclared = Assert<
  Declares<typeof SESSION_RPC_EVENT_CHANNEL, VolliIpcEvent>
>;

/** Direction of a `volli:ui-zoom-command` event: step in/out one rung, or reset. */
export type UiZoomCommand = "in" | "out" | "reset";

/**
 * A coarse hint at WHAT a {@link DataChangedEvent} touched — advisory only
 * (diagnostics, possible future routing). Readers decide whether to refire from
 * `ticketId`, never from this. Kept a small closed union so every producer names
 * its change.
 */
export type DataChangeKind = "ticket" | "comment" | "session" | "worktree" | "retention";

/**
 * Main→renderer invalidation after a planning mutation that happened OUTSIDE the
 * renderer's own request/response cycle (a socket-originated agent command, a
 * session-lifecycle worktree boot, a worktree/retention side effect). The
 * renderer always re-hydrates the board wholesale on receipt (cheap SQLite reads
 * — the recovery guarantee); the optional scope only lets a per-ticket surface
 * skip a refetch when the change PROVABLY targets a different ticket.
 *
 * An UNTARGETED payload — one with no `ticketId` — means "anything may have
 * changed" and every reader must still react to it (the conservative arm). A
 * targeted payload carries the affected `ticketId` (and, when the producer knows
 * it, its `projectId`), so a reader watching that ticket refreshes promptly
 * while readers for other tickets stand down.
 */
export interface DataChangedEvent {
  entity: "tickets";
  /** The ticket the change targets; omitted for an untargeted (anything-changed) broadcast. */
  ticketId?: string;
  /** The project the change belongs to, when the producer knows it. */
  projectId?: string;
  /** Advisory hint at what changed — never the basis of a reader's refire decision. */
  kind?: DataChangeKind;
}

/**
 * Main→renderer announcement that a backward move interrupted live agent
 * sessions (issue #78, CONCEPT #20). Fired only when `sessionIds` is
 * non-empty — an empty interrupt announces nothing, mirroring the event log.
 */
export interface SessionsInterruptedEvent {
  ticketId: string;
  sessionIds: string[];
}

/**
 * One canonical harness event, as it reaches the renderer (harness-events). The
 * involuntary channel: a hook the wrapper configured fired, `volli hook`
 * forwarded it over the socket, and main resolved which session it belongs to.
 * Harness-native event names never get this far — the union is the whole
 * vocabulary.
 *
 * `sessionId` is the FULL session id (the same key terminal data/exit events
 * carry), not the short public handle, because this addresses the renderer's
 * live session state rather than a human reader.
 */
export interface HarnessEventNotice {
  sessionId: string;
  projectId: string;
  /** The ticket this session drives, or `null` for a scratch session. */
  ticketId: string | null;
  harnessId: HarnessId;
  event: HarnessEvent;
  /**
   * The harness's own session id when the event carried one — already persisted
   * on the session record by the time this fires. `null` on the events that
   * carry none, which is most of them.
   */
  harnessSessionId: string | null;
  /** Epoch ms the event was ingested (main's clock, never the harness's). */
  at: number;
  /**
   * Epoch ms the hook process that reported this event STARTED, off that
   * process's own wall clock — {@link HarnessEventOrder}, and the only field on
   * this notice that says anything about the order the harness fired things in.
   * `null` when the delivery carried none, which an older `volli` always will.
   *
   * `at` is deliberately not that field and cannot be made into it: each event
   * arrives on its own short-lived process over its own connection, so arrival
   * order is a property of the races between them rather than of the agent.
   */
  firedAt: HarnessEventOrder;
}

/**
 * Main→renderer: a different harness is now running in one session's terminal,
 * as announced by its own launch wrapper (`volli session harness <slug>`).
 *
 * A SIBLING of {@link HarnessEventNotice} rather than a member of it, because
 * it is not one: this is not a canonical harness event, it is not in
 * `HARNESS_EVENTS`, it comes from the PATH shim rather than from a hook, and it
 * carries no `firedAt` to be ordered by — the wrapper runs once per launch, so
 * the newest announce IS the running harness and there is no race to settle.
 * Folding it into the event union would have every reader of that union
 * pattern-matching around a member that answers none of its questions.
 *
 * Fired on every announce, INCLUDING the overwhelmingly common one that agrees
 * with what Volli already believes. An announce is a LAUNCH — the wrapper runs
 * once per invocation, from the harness's own process — and a launch is the
 * moment the reporting channel starts owing us an event. Firing only on a
 * changed slug meant quitting a harness and starting the same one again in one
 * terminal left the second launch wearing the first one's reputation.
 */
export interface SessionHarnessNotice {
  /** The FULL session id — this addresses live renderer state, not a human reader. */
  sessionId: string;
  projectId: string;
  /** The ticket this session drives, or `null` for a scratch session. */
  ticketId: string | null;
  /** The harness now running there. The session's LAUNCH harness is unchanged. */
  harnessId: HarnessId;
  /**
   * Whether this announce named a DIFFERENT harness than the session was
   * already believed to be running. Not a gate on the notice — every launch is
   * broadcast — but the durable record only has to be repointed when it moved.
   */
  changed: boolean;
  /** Epoch ms the announce was ingested (main's clock). */
  at: number;
}

/**
 * Main→renderer: a structured chat Session was started on a ticket through the
 * agent socket (`volli session start`, VC-13). The renderer toasts it —
 * "<actor> started a session on VC-4" — with an action that opens the
 * session's chat tab; without the click nothing moves. Board/sidebar surfaces
 * refresh through the ordinary `volli:data-changed` path, so this notice only
 * carries what the toast itself says and where its action goes.
 */
export interface SessionStartedNotice {
  /** The FULL session id — the action addresses live renderer state, not a human reader. */
  sessionId: string;
  projectId: string;
  ticketId: string;
  /** The started ticket's display id, precomputed so the toast never joins. */
  ticketDisplayId: string;
  /** Who started it, as the door derived it (`requestActor`) — never self-declared. */
  actor: TicketEventActorKind;
  /** Display id of the ticket the starting session was itself working, when known. */
  actorTicket: string | null;
  /** Epoch ms the start was ingested (main's clock). */
  at: number;
}

/**
 * Result types below travel as typed discriminated unions rather than
 * thrown errors: `ipcMain.handle` rejections serialize into useless
 * strings across the IPC boundary, and every failure must be surfaceable
 * in the UI.
 *
 * {@link Result} is the shared shape every one of them had by hand: a success
 * carrying payload `T`, or a failure carrying an `error` string. Bare
 * `Result` (no payload) is a plain ok/error ack.
 */
export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export type PickFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; defaultName: string };

export type ListDirectoryResult = Result<{ entries: DirEntry[] }>;

export type RevealResult = Result;

/**
 * The full data snapshot handed to the renderer on boot
 * (`volli:data-bootstrap`): projects/tickets/labels from SQLite, plus the raw
 * `app_state` JSON the ui/workspace persist stores rehydrate from.
 */
export interface BootstrapPayload {
  /** Ordered by `sort_order`. An empty list is the sole signal boot uses to
   * decide whether to attempt the one-time legacy import (see lib/boot.ts) —
   * deliberately NOT coupled to `app_state` emptiness, since normal UI use
   * (sidebar resize, zoom) writes app_state and must not suppress a pending
   * import after a transient failure. */
  projects: Project[];
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
  /** Raw JSON strings by key (`'volli:ui'`, `'volli:workspace'`, `'volli:projects-ui'`). */
  appState: Record<string, string>;
}

export type BootstrapResult = Result<{ data: BootstrapPayload }>;

export interface LegacyImportRequest {
  projects: LegacyProject[];
  appState: Record<string, string>;
  /**
   * The raw, untouched `volli:*` localStorage strings, keyed by their original
   * key. Persisted verbatim into `app_state` (under `LEGACY_BACKUP_APP_STATE_KEY`,
   * exported from `legacy-import.ts`) inside the import transaction, so the
   * source survives in SQLite even after boot clears localStorage — a
   * recoverable backup against a lossy or unreadable import (decision #29:
   * automation never destroys data).
   */
  rawBackup: Record<string, string>;
}

export type LegacyImportResult = Result<{ data: BootstrapPayload; imported: number }>;

/** `created: false` means an existing project at that path was selected instead of inserted. */
export type ProjectCreateResult = Result<{ project: Project; created: boolean }>;

export type ProjectUpdateResult = Result<{ project: Project }>;

export type ProjectMutationResult = Result;

/**
 * A single ticket, returned by a mutation that affects only that one ticket —
 * create, set-priority, update, set-labels. The renderer patches it into the
 * project's list by id (cheaper than, and non-clobbering versus, re-reading the
 * whole list). Contrast {@link TicketsResult}, which move returns because a move
 * genuinely reorders many rows.
 */
export type TicketResult = Result<{ ticket: Ticket }>;

/** The full authoritative project ticket list — returned by `ticket-move`, which reorders many rows. */
export type TicketsResult = Result<{ tickets: Ticket[] }>;

/**
 * A project's archived tickets, newest-archived first — returned by
 * `ticket-list-archived`, which the Archive view loads on demand (archived
 * tickets never ride along in the boot payload; the board only holds live ones).
 */
export type ArchivedTicketsResult = Result<{ tickets: ArchivedTicket[] }>;

export type LabelResult = Result<{ label: Label }>;

export type AppStateSetResult = Result;

/** A ticket's full event history, chronological — returned by `ticket-events` (the Activity feed read). */
export type TicketEventsResult = Result<{ events: TicketEvent[] }>;

/** The latest durable Session outcome per ticket — returned by `ticket-latest-signals` (the sidebar's batched attention read). */
export type TicketLatestSignalsResult = Result<{ signals: LatestSessionSignal[] }>;

/** When each ticket entered its current status — returned by `ticket-status-entries` (what the Previous band's cleanup rules date against). */
export type TicketStatusEntriesResult = Result<{ entries: TicketStatusEntry[] }>;

/** A single comment, returned by a mutation that affects only that one comment — create, update. */
export type TicketCommentResult = Result<{ comment: TicketComment }>;

/** A ticket's comments, chronological — returned by `comment-list` (the work-log read). */
export type TicketCommentsResult = Result<{ comments: TicketComment[] }>;

/** A project's or a ticket's durable Session listing, newest first — returned by `session-list`/`session-list-for-ticket`. */
export type SessionsResult = Result<{ sessions: SessionListingRow[] }>;

/** Ack for a session title rename (`session-rename`); the caller already holds the new title optimistically. */
export type SessionRenameResult = Result;

// ---- global artifacts + @file refs (docs/plans/global-artifacts.md) --------

/**
 * The whole-project file index the `@` picker ranks over — returned by
 * `volli:file-index`. Built fresh on each picker open from `git ls-files`
 * (gitignore-respecting) plus a walk of `.volli/artifacts/`; `truncated` is set
 * when the ~20k entry cap was hit.
 */
export type FileIndexResult = Result<{ files: IndexedFile[]; truncated: boolean }>;

/** The composer's `/` picker is project-scoped, exactly like the file index. */
export interface PromptTemplateIndexInput {
  projectId: string;
}

/**
 * Everything the composer's `/` picker can offer — returned by
 * `volli:prompt-templates`: the prompt templates, already merged (project over
 * global) and sorted, and the project's skills (`.agents/skills/<slug>/SKILL.md`),
 * shadowed names not yet removed — that is the renderer's `visibleSkills` call,
 * beside the ranking that consumes it.
 *
 * A missing directory is an empty list, never an error: most projects have no
 * `.volli/commands/` or `.agents/skills/` and a picker that toasts about it on
 * every open would be reporting the normal case. `ok: false` means a directory
 * that DOES exist could not be read.
 */
export type PromptTemplateIndexResult = Result<{
  templates: PromptTemplate[];
  skills: SkillReference[];
}>;

/**
 * A read file's content, discriminated by how the renderer must render it:
 * `text` (utf8, `truncated` when the ~1 MiB cap was hit), `image` (inline
 * `data:` URI), or `binary` (NUL-sniffed or oversize — stub + reveal only).
 */
export type FileContent =
  | { type: "text"; text: string; truncated: boolean }
  | { type: "image"; dataUrl: string }
  | { type: "binary" };

/**
 * A resolved file read — returned by `volli:file-read`. `source` says which
 * checkout it came from (drives the worktree tab badge); `size`/`mtime` are the
 * on-disk stats; `content` carries the render-ready payload.
 */
export type FileReadResult = Result<{
  source: FileSource;
  kind: FileKind;
  size: number;
  mtime: number;
  content: FileContent;
}>;

/** The post-write mtime (the renderer's fresh conflict-guard baseline) — returned by `volli:file-write`. */
export type FileWriteResult = Result<{ mtime: number }>;

/**
 * A newly-created artifact's project-relative path (`.volli/artifacts/<name>.md`),
 * insertable directly as an `@ref` — returned by `volli:artifact-create`.
 */
export type ArtifactCreateResult = Result<{ relPath: string }>;

/**
 * The last word a watch subscription gets: main has torn the subscription down
 * and will never send for it again (issue #134). Every holder of that watch owes
 * itself a re-arm or an honest "live updates are off" — its `watch()` hold is
 * now a hold on nothing. Only ever `true`; ORDINARY change events omit the field
 * entirely, so `event.final === true` is the whole test.
 *
 * It cannot be inferred from the payload: the dominant teardown (the watched
 * directory is gone for good) does carry `revision: null`, but a watcher that
 * fails to REWIRE over a directory still present sends a final event that reads
 * exactly like ordinary news.
 */
interface FinalWatchEvent {
  final?: true;
}

/** The single watched file a `volli:file-changed` push event fired for. */
export interface FileChangedEvent extends FinalWatchEvent {
  projectId: string;
  /** The worktree owner; Main-checkout files always normalize this to null. */
  ticketId: string | null;
  relPath: string;
  source: FileSource;
  /** Current on-disk mtime after the debounce, or null when the file is unreadable. */
  revision: number | null;
}

/**
 * The single watched directory a `volli:dir-changed` push event fired for
 * (`relPath: ""` is the project root). Always the MAIN checkout, so unlike
 * {@link FileChangedEvent} there is no `source` to disambiguate.
 */
export interface DirChangedEvent extends FinalWatchEvent {
  projectId: string;
  relPath: string;
}

// ---- ticket worktrees (docs/plans/worktree-support.md) ---------------------

/**
 * The transient lifecycle of a worktree `ensure` pipeline. NEVER persisted —
 * on boot, truth is recomputed from disk — so a phase only exists while (or
 * just after) an ensure ran in this app session.
 */
export type WorktreePhase = "creating" | "copying" | "setting-up" | "ready" | "failed";

/** One `volli:worktree-phase` push: the ticket whose ensure moved, and where to. */
export interface WorktreePhaseEvent {
  ticketId: string;
  phase: WorktreePhase;
}

/**
 * Debounced signal that a live ticket worktree's filesystem changed
 * (`volli:worktree-changed`). The renderer refetches the Change Set; the
 * payload carries only the ticket id (no file list).
 */
export interface WorktreeChangedEvent {
  ticketId: string;
}

/**
 * A ticket's worktree watch faulted and has been torn down
 * (`volli:worktree-watch-error`). Emitted exactly once per fault, right before
 * teardown: after this the renderer will receive no further
 * `volli:worktree-changed` for the ticket, so its Change Set is frozen until
 * something re-establishes the watch. Surfaced, never swallowed — a silently
 * dead watch looks identical to a worktree nobody is touching.
 */
export interface WorktreeWatchErrorEvent {
  ticketId: string;
  error: string;
}

/** Where a worktree dir stands relative to what git knows — the live half of worktree state. */
export type WorktreeDiskState = "present" | "missing" | "unregistered";

/** Ack for a `volli:worktree-remove` (the "Remove worktree…" escape hatch). */
export type WorktreeRemoveResult = Result;

/**
 * A project's branch refs, for the base-branch pickers (the Details rail's and
 * the composer's).
 *
 * `remotes` is a SNAPSHOT, not a live reading: a remote-tracking ref only moves
 * on a fetch, so the list is exactly as old as {@link
 * WorktreeBranchListing.fetchedAt} and a picker has to say so. Nothing in the
 * worktree pipeline fetches on the user's behalf before branching, so a base
 * chosen from `remotes` inherits that same age — which is the whole reason this
 * timestamp crosses the boundary instead of staying a main-process detail.
 */
export interface WorktreeBranchListing {
  /** Local branch short names (`refs/heads`), most-recently-committed first. */
  branches: string[];
  /** The project checkout's own branch; `null` when detached or unreadable. */
  current: string | null;
  /** Remote-tracking short names in `origin/main` form, as of {@link WorktreeBranchListing.fetchedAt}. */
  remotes: string[];
  /** Epoch ms of the repo's last fetch (`FETCH_HEAD`'s mtime); `null` when it has never fetched. */
  fetchedAt: number | null;
}

/** A project's branch refs — returned by `volli:worktree-branches` for the base-branch pickers. */
export type WorktreeBranchesResult = Result<WorktreeBranchListing>;

/** One orphan the sweep refused to remove, for the Settings → Worktrees list. */
export interface DirtyWorktreeOrphan {
  path: string;
  projectId?: string;
  reason: string;
}

/**
 * A `volli:worktree-orphans` sweep report: metadata pruned per project, clean
 * orphan dirs auto-removed (branches retained), and dirty orphans left in
 * place for the user (§7 — never auto-removed).
 */
export type WorktreeOrphansResult = Result<{
  pruned: string[];
  removedClean: string[];
  dirty: DirtyWorktreeOrphan[];
}>;

/**
 * Ack for a `volli:worktree-orphan-delete` — the Settings list's explicit,
 * user-confirmed deletion of a dirty orphan dir. Main re-validates the path
 * lives inside the app-owned worktree home before touching anything.
 */
export type WorktreeOrphanDeleteResult = Result;

// ---- Done flow (docs/plans/done-flow.md) -----------------------------------

/**
 * The finer Details-rail worktree status (done-flow §7 "dirty predicate
 * split"), returned by `volli:worktree-status`. Mirrors main's
 * `getWorktreeStatus` report: is the tree uncommitted, is a sequencer op
 * mid-flight (blocks one-click commit), and how far the branch has moved from
 * its base (`null` when the base is unknown or the count could not be read).
 */
export type WorktreeStatusResult = Result<{
  status: {
    uncommitted: boolean;
    sequencerActive: boolean;
    aheadOfBase: number | null;
    behindBase: number | null;
    /** Commits not yet on `origin/<branch>`; null when never pushed / no remote. */
    unpushed: number | null;
  };
}>;

/**
 * A worktree diff summary for `volli:worktree-diff` (done-flow §"diff.ts", the
 * two-mode split): `"working-tree"` is "what the agent is doing right now",
 * `"merge-base"` is "what the PR would contain".
 */
export type WorktreeDiffMode = "working-tree" | "merge-base";
export type WorktreeDiffResult = Result<{ diff: DiffStat }>;

/** The composed Change Set for `volli:worktree-change-set`. */
export type WorktreeChangeSetResult = Result<{ changeSet: ChangeSetSnapshot }>;

/**
 * Base-revision file contents for `volli:worktree-base-read`. Three success
 * arms, none of them an error: `content` is decodable text (`truncated` when
 * the ~1 MiB cap matching live file reads was hit — original side stays
 * read-only), `missing: true` means the path was absent at the base (a file
 * the ticket added), and `binary: true` means the blob is not text — returning
 * its bytes as a string would hand the caller mojibake to render as a diff.
 */
export type WorktreeBaseReadResult = Result<
  | { content: string; truncated: boolean; missing?: undefined; binary?: undefined }
  | { missing: true; content?: undefined; binary?: undefined; truncated?: undefined }
  | { binary: true; content?: undefined; missing?: undefined; truncated?: undefined }
>;

/**
 * Ack for `volli:worktree-commit`. `committed: true` carries the message the
 * commit actually landed with — the caller's, or the generated `chore(<id>)`
 * line when they left it blank; `committed: false` is the clean-tree NO-OP —
 * the status snapshot that offered the commit was stale and there was nothing
 * to stage, which is not an error (a stacked commit→push flow proceeds to
 * push). A dirty tree with an empty index under `includeUnstaged: false` is a
 * different thing entirely and comes back `{ ok: false }`.
 */
export type WorktreeCommitResult = Result<
  { committed: true; message: string } | { committed: false; message: null }
>;

/** Ack for `volli:worktree-push-pr` — the opened/re-discovered PR url, and whether it pre-existed. */
export type WorktreePushPrResult = Result<{ url: string; existing: boolean }>;

// ---- retention (CONCEPT #16, issue #76) ------------------------------------
// `RetentionReason` is domain vocabulary, not transport: @volli/shared's pure
// `computeArchiveReadiness` decides it, so the type is declared there and
// imported above.

/**
 * The composed retention state for ONE ticket, returned by
 * `volli:retention-state`. Everything but `keep` is TRANSIENT (decision #42:
 * persist identity, compute state) — recomputed from the merge-watch's last
 * poll plus the live Done-TTL clock, never stored. `keep` is the durable pin
 * (migration 010). `hasConflicts`/`failingChecks` are surfacing-only (the
 * #44/#45 button-never-gate rule): they explain why a PR can't merge yet, they
 * do not block the wrap-up prompt.
 */
export interface TicketRetentionState {
  ticketId: string;
  /** The watched PR url, or `null` when the ticket has none yet. */
  prUrl: string | null;
  /** The watched PR's state, or `null` when unknown / no PR. */
  prState: "open" | "merged" | "closed" | null;
  /** The PR's base branch conflicts with it (`mergeStateStatus` DIRTY). */
  hasConflicts: boolean;
  /** Display names of the PR's failing/errored checks (may be empty). */
  failingChecks: string[];
  /** Whether the Archive & clean prompt should be offered right now. */
  archiveReady: boolean;
  /** The condition behind `archiveReady` (still set when suppressed by dismissal). */
  reason: RetentionReason | null;
  /** The durable Keep pin — exempts the ticket from BOTH retention paths. */
  keep: boolean;
  /** Whether the prompt was dismissed this launch (re-offered next launch). */
  dismissed: boolean;
}

/** The composed retention state for a ticket — returned by `volli:retention-state`. */
export type RetentionStateResult = Result<{ state: TicketRetentionState }>;

/** Ack for `volli:retention-keep` (set/clear the pin) — carries the new value. */
export type RetentionKeepResult = Result<{ keep: boolean }>;

/** Ack for `volli:retention-dismiss` — the prompt is suppressed until next launch. */
export type RetentionDismissResult = Result;

/** Ack for `volli:retention-archive-clean` — archives + removes the worktree (dirty refuses). */
export type RetentionArchiveCleanResult = Result;

/** The Done-TTL in days — returned by `volli:retention-ttl-get`/`-set`. */
export type RetentionTtlResult = Result<{ days: number }>;

/** Ack for `volli:retention-poll` — the on-focus/manual trigger of the merge-watch poll. */
export type RetentionPollResult = Result;
