import type { RendererLogEntry } from "@volli/shared";
import type { IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";
import type {
  FileMutationResult,
  FileReadResult,
  FileWriteResult,
  FileSearchResult,
  ArtifactCreateResult,
} from "@volli/shared";
export type {
  FileMutationResult,
  FileContent,
  FileReadResult,
  FileWriteResult,
  FileSearchMatch,
  FileSearchFile,
  FileSearchLimit,
  FileSearchResult,
  ArtifactCreateResult,
} from "@volli/shared";
export type { FileChangedEvent, DirChangedEvent } from "@volli/shared";
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
  PiSessionOrphanReclaimInput,
  PiSessionOrphanInventory,
  PiSessionOrphanReclaimReport,
} from "@volli/shared";
export type {
  PiSessionOrphanReclaimInput,
  PiSessionOrphanCandidate,
  PiSessionOrphanSkipped,
  PiSessionOrphanInventory,
  PiSessionOrphanKept,
  PiSessionOrphanReclaimReport,
} from "@volli/shared";

import type {
  Result,
  ModelAccessSignInBeginResult,
  WebAccessProvider,
  KeyedWebAccessProvider,
  WebAccessSettingsView,
  DecisionModelSettingsView,
  DecisionModelTestView,
  DecisionModelScope,
} from "@volli/shared";
export type {
  Result,
  ModelAccessSignInBeginResult,
  WebAccessProvider,
  KeyedWebAccessProvider,
  WebAccessKeyState,
  WebAccessSettingsView,
  DecisionModelSettingsView,
  DecisionModelTestView,
  DecisionModelScope,
} from "@volli/shared";

import type {
  OrphanProcessReapInput,
  OrphanProcessInventory,
  OrphanProcessReapReport,
  DatabaseSafetyCopy,
} from "@volli/shared";
export type {
  OrphanProcessReapInput,
  OrphanProcessInventory,
  OrphanProcessKept,
  OrphanProcessReapReport,
  DatabaseSafetyCopy,
} from "@volli/shared";

import type { ExternalAppId } from "../external-app-ids";
import type {
  CredentialsResult,
  SecretReplaceInput,
  SecretSubmitInput,
  SecretsResult,
} from "./secrets";

import type {
  WorktreeBranchListing,
  DirtyWorktreeOrphan,
  RemovableWorktreeOrphan,
  KeptWorktreeOrphan,
  PrunableWorktreeMetadata,
  KeptWorktreeMetadata,
  UnreadableWorktreeProject,
  WorktreeTrimScanEntry,
  WorktreeTrimSweepReport,
  WorktreeTrimSettings,
  WorktreeTrimSettingsInput,
  WorktreeDiffMode,
  TicketRetentionState,
  BrowserTrace,
  BrowserTabBounds,
  BrowserTabCreatedBy,
  BrowserTabPresentation,
  BrowserTabState,
  Appearance,
  ArchivedTicket,
  AutoReapPolicy,
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  AutomationRunTarget,
  AutomationSkippedOccurrence,
  AutomationTrigger,
  ColumnArming,
  ColumnAutomationOrder,
  BlobLinkView,
  NamedBlobLink,
  Canvas,
  ChangeSetSnapshot,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  DiffStat,
  DirEntry,
  DoctorCheck,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  HarnessAdapter,
  HarnessChannelStatus,
  HarnessId,
  HarnessTrustPrompt,
  HarnessTrustVerdict,
  IndexedFile,
  Label,
  LatestSessionSignal,
  LegacyProject,
  ManifestError,
  McpConnectionBlock,
  McpServerAccess,
  McpServerDraft,
  McpOperationRecord,
  McpServerRecord,
  ModelAccessSignInType,
  DecisionModelSetting,
  DeliberateMoveChoice,
  ModelSelection,
  NotificationEvent,
  NotificationPreferences,
  NotificationProducer,
  NotificationTarget,
  OrphanAgeBasis,
  OrphanCleanupItem,
  OrphanCleanupItemKind,
  OrphanCleanupItemState,
  OrphanCleanupReceipt,
  OrphanCleanupRejectionCode,
  OrphanCleanupRun,
  OrphanCleanupSource,
  OrphanKeptReason,
  OrphanMetadataKeptReason,
  PendingArmedRun,
  PendingArmedRunFailure,
  Project,
  ProjectFolderState,
  ProjectRelinkAftermath,
  ProjectRelinkRefusal,
  ProjectThemeOverride,
  PromptTemplate,
  FirstPaintHint,
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  SessionEnvInteractiveProvenance,
  SessionEnvProvenance,
  RequirableSessionEnvTool,
  SessionEnvTool,
  SessionListingRow,
  SessionPeekContent,
  SessionReadState,
  SessionUsageGrouping,
  SessionUsageReport,
  SessionUsageScope,
  SkillReference,
  TerminalBusyResult,
  TerminalCommandResult,
  TerminalIoResult,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketPriority,
  TicketStatus,
  TicketStatusEntry,
  TicketSummary,
  ValidAutomationRuntime,
  VenueReading,
  WorkspaceDependenciesStatus,
  AutomationRunStartResult,
  DataChangeKind,
  DataChangedEvent,
  HarnessEventNotice,
  PendingArmedRunSettledNotice,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionRetitledEvent,
  SessionStartedNotice,
  SessionsInterruptedEvent,
  WorktreePhase,
  WorktreePhaseEvent,
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

/**
 * Point an existing project at the folder it moved to (VC-430).
 *
 * Deliberately NOT part of {@link ProjectUpdateInput}: every other field there
 * is a preference, and this one re-homes the project. It is judged against the
 * disk before it is saved, it can be refused, and it is the only write that
 * can move `projects.path` after creation.
 */
export interface ProjectRelinkInput {
  id: string;
  /** The replacement folder, absolute. */
  path: string;
}

/**
 * One project's per-skill rules (VC-111, migration 023). The WHOLE map every
 * time, not a delta: the surface holds every switch on screen at once, so a
 * per-slug channel would turn one visible state into N writes that can land
 * out of order and half-fail.
 */
export interface ProjectSkillModesInput {
  id: string;
  /** Slug → `"manual"` / `"off"`. Only departures; an empty map clears the column. */
  modes: Record<string, string>;
}

/**
 * One project's actor policy and delegation budget departures (VC-172).
 *
 * The whole override every time and `null` to inherit the defaults, matching
 * `ProjectSkillModesInput`.
 *
 * Typed `unknown` on the wire ON PURPOSE. This is the one project write whose
 * payload is a nested document rather than a flat row, and the renderer is not
 * the thing that gets to say it is well-formed — `validateAuthorityPolicyOverride`
 * in main is. Declaring it as `AuthorityPolicyOverride` here would let a
 * compile-time claim stand in for the runtime check on the surface whose entire
 * job is to be the trustworthy door to policy.
 */
export interface ProjectAuthorityPolicyInput {
  id: string;
  /** An `AuthorityPolicyOverride`-shaped document, or `null` to inherit everything. */
  override: unknown;
}

export interface McpProjectInput {
  projectId: string;
}

export interface McpServerInput extends McpProjectInput {
  server: McpServerDraft;
  /**
   * Secret values typed into the editor and not stored yet, by slot
   * (`header:authorization`, `env:API_KEY`, `oauth:client-secret`). They cross
   * this boundary once, renderer to main, and are never sent back: every read
   * reports only which slots hold a value (VC-470).
   */
  secrets?: Readonly<Record<string, string>>;
}

export interface McpSaveInput extends McpServerInput {
  enabledTools: readonly string[];
}

/** Sign in to a saved server (`serverId`) or to the editor's unsaved draft (`server`). */
export interface McpSignInInput extends McpProjectInput {
  serverId?: string;
  server?: McpServerDraft;
  secrets?: Readonly<Record<string, string>>;
}

export type McpSignInResult =
  | { ok: true; message: string }
  | { ok: false; cancelled: boolean; error: string };

export interface McpServerIdInput extends McpProjectInput {
  serverId: string;
}

export interface McpSetEnabledInput extends McpServerIdInput {
  enabled: boolean;
}

export interface McpSetToolsInput extends McpServerIdInput {
  enabledTools: readonly string[];
}

export type McpServersResult =
  | {
      ok: true;
      servers: readonly McpServerRecord[];
      /**
       * This project's MCP management history, newest first (VC-380).
       *
       * Carried by the same read that fetches the servers rather than by a
       * channel of its own: it is the same project scope, wanted at the same
       * moment, and a removal's record is the one a person most needs to see
       * precisely when its server is no longer in the list beside it.
       */
      operations: readonly McpOperationRecord[];
      /**
       * Each server's sign-in state and which stored secrets are missing, by
       * server id (VC-470). Labels and states only — never a value.
       */
      access: Readonly<Record<string, McpServerAccess>>;
    }
  | { ok: false; error: string };
export type McpServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; error: string; server?: McpServerRecord; blocked?: McpConnectionBlock };
export type McpCatalogResult =
  | { ok: true; catalog: McpServerRecord["catalog"] }
  | { ok: false; error: string; blocked?: McpConnectionBlock };

/**
 * A policy write that was refused, with every reason.
 *
 * Distinct from `ProjectUpdateResult` because this is the one project write a
 * person can get WRONG rather than merely unlucky: `error` carries the summary
 * and `errors` the per-field detail, so any caller that can show per-field
 * refusals may. Every reason at once — fixing one field to be told about the
 * next is the interaction this avoids. (The Authority pane itself routes
 * through `writeThrough`, which toasts the summary; its controls are all
 * constrained, so it cannot produce the document `errors` describes.)
 */
export type ProjectAuthorityPolicyResult =
  | { ok: true; project: Project }
  | { ok: false; error: string; errors?: readonly string[] };

/** One project's Chat model default; `null` means inherit (VC-111, migration 023). */
export interface ProjectSessionDefaultsInput {
  id: string;
  model: ModelSelection | null;
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

/** One-card form of `volli:ticket-move`. */
export interface TicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
  toIndex: number;
  /** The Option-drag target, when that gesture supplied this renderer move. */
  choice?: DeliberateMoveChoice;
}

/** Multi-card form of `volli:ticket-move`; persisted atomically in one board transaction. */
export interface TicketMoveManyInput {
  projectId: string;
  ticketIds: string[];
  toStatus: TicketStatus;
  /** Destination slot after the selected tickets have been removed. */
  toIndex: number;
  /** The Option-drag target applied to every Ticket in this deliberate group move. */
  choice?: DeliberateMoveChoice;
}

/** `volli:ticket-move` accepts a single card or one selected card group. */
export type TicketMoveRequest = TicketMoveInput | TicketMoveManyInput;

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

/**
 * One attach gesture (VC-50). `bytes` and `sourcePath` are alternatives, not a
 * pair: a paste has only bytes, a native-picker choice has only a path, and a
 * drop can have both. `sourcePath` is what makes a repo file eligible to be
 * named live with `@` instead of snapshotted, so a drop that supplies it gets
 * the better behaviour.
 */
export interface BlobAttachInput {
  fileName: string;
  bytes?: Uint8Array;
  sourcePath?: string;
  mime?: string;
  label?: string;
  /** Absolute workspace root an `@` ref would resolve against. */
  refRoot?: string;
  /** Exactly one owner, or `unowned` for a Ticket still being composed. */
  owner: { ticketId: string } | { sessionId: string } | { unowned: true };
}

/** Lists what is attached to one Ticket or one Session. */
export interface BlobListInput {
  ticketId?: string;
  sessionId?: string;
}

/**
 * The attachments materialized into one Session's checkout — BOTH owners at
 * once, unlike {@link BlobListInput} (VC-273).
 *
 * Markdown that names `.volli/attachments/spec.png` is naming a file on disk,
 * and what is on disk is the Session's links and its Ticket's together, in one
 * order, under names a collision rule derives from that order. Asking for the
 * two halves separately and concatenating them would re-derive different names
 * the moment two attachments shared a basename, so this is one query.
 */
export interface BlobMaterializedInput {
  ticketId?: string | undefined;
  sessionId?: string | undefined;
}

export interface BlobLinkIdInput {
  linkId: string;
}

/**
 * Attaches Blobs imported before their owner existed. The new-Ticket composer
 * imports eagerly (so size is refused and previews drawn while the file is
 * still in hand) and calls this once `ticket.create` has returned an id; a
 * promoted chat Draft (VC-358) imports the same way and calls this once its
 * `session.create` has returned the id its staged blobs were waiting beside.
 * Exactly one owner — the `blob_links` CHECK enforces the same thing durably.
 */
export type BlobLinkDraftsInput = {
  blobs: { blobHash: string; label?: string }[];
} & ({ ticketId: string; sessionId?: undefined } | { sessionId: string; ticketId?: undefined });

/** `{ sessionId, title }` with a non-blank title — the rename handler trims before persisting. */
export interface SessionRenameInput {
  sessionId: string;
  title: string;
  /**
   * Present only on the automatic heuristic rename (VC-81): the first user
   * message, from which main may derive a sharper title with one model call
   * once this rename has stuck.
   *
   * A rider on the rename rather than a channel of its own, because it is the
   * same surface and the same moment — `docs/BOUNDARIES.md` asks new work to
   * migrate the raw channels it touches, not to add another beside them. It
   * also removes the window a second round-trip opened, in which the title
   * could change between the write and the request that names its baseline.
   * A person's rename never carries it, which is what keeps title calls at
   * zero for a Session someone named.
   */
  refineFrom?: string;
}

/** The window a Session-start read covers: an inclusive epoch-ms lower bound. */
export interface SessionStartsInput {
  sinceMs: number;
}

/**
 * What a usage read is asking about (VC-87).
 *
 * The scope is the ledger's own tagged union rather than three optional ids,
 * so "every project" and "a project I have not named" cannot be spelled the
 * same way across the wire. `sinceMs` is inclusive and `untilMs` exclusive, so
 * adjacent windows tile without counting a boundary operation twice.
 */
export interface UsageReportInput {
  scope: SessionUsageScope;
  sinceMs?: number;
  untilMs?: number;
  groupBy?: SessionUsageGrouping;
}

/**
 * Whose venue to measure. The pair is the Session's own scope, not a path — a
 * renderer never names a directory main will run git in; main resolves it from
 * its own rows, by the rule the Session runtime binds a directory with.
 */
export interface VenueSnapshotInput {
  projectId: string;
  /** `null` for a Board Session, which runs in the project's main checkout. */
  ticketId: string | null;
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

/**
 * `{ refresh: true }` re-runs the READ-ONLY orphan scan (the Storage pane's
 * Scan); omitted/`false` returns the launch's cached scan. Neither shape
 * changes anything on disk — cleanup is its own confirmed channel (VC-284).
 */
export interface WorktreeOrphansInput {
  refresh?: boolean;
}

/**
 * The Storage pane's confirmed cleanup, as a COMMAND rather than a list of
 * paths (VC-284 review, S1/C1).
 *
 * It carries no paths at all. `scanRevision` names the read-only scan a person
 * reviewed, `itemIds` selects items out of the proposal main itself minted for
 * that revision, and `commandId` is the caller's UUID — the same command id
 * replayed answers with the first run's receipt instead of removing anything a
 * second time. A revision main no longer holds, or an item id that revision
 * never proposed, is REFUSED: a client cannot name a directory that no
 * completed scan offered.
 */
export interface WorktreeOrphanCleanupInput {
  /** Caller-minted UUID. Idempotent: one command id can only ever run once. */
  commandId: string;
  /** The opaque revision of the scan whose proposal was confirmed. */
  scanRevision: string;
  /** Ids of the proposed items to act on, from that scan's plan. */
  itemIds: string[];
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

// ---- file-channel input shapes (global artifacts) --------------------------

/**
 * The scope pair the index is listed for — the same `{ projectId, ticketId }`
 * shape read/reveal/watch already take (see {@link FilePathInput}), resolved
 * through the same seam: with no `ticketId`, the project's MAIN checkout; with
 * one, that ticket's live worktree, while `.volli/artifacts/**` still comes
 * from Main (decision #6, the rule the index and a read cannot disagree on).
 */
export interface FileIndexInput {
  projectId: string;
  ticketId?: string;
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
 * One find-across-files request (plan §4.7): the same `{ projectId, ticketId }`
 * scope pair a read takes, plus the literal text to look for.
 *
 * `query` is a LITERAL, not a pattern — v1 is find-only and never interprets
 * what was typed as a regex, so a search for `foo(bar)` finds `foo(bar)`. Main
 * trims it and refuses an empty one rather than listing the whole checkout.
 */
export interface FileSearchInput {
  projectId: string;
  ticketId?: string;
  query: string;
}

/** A known macOS app that can open a safely resolved Files target. */
export type { ExternalAppId } from "../external-app-ids";

export type ExternalAppKind = "editor" | "terminal";

/** Renderer-safe app metadata; bundle ids and application paths stay in main. */
export interface ExternalApp {
  id: ExternalAppId;
  label: string;
  kind: ExternalAppKind;
}

/** A file or folder target plus one allowlisted external application. */
export interface ExternalAppOpenFileInput extends FilePathInput {
  appId: ExternalAppId;
}

/** The ticket's live worktree root plus one allowlisted external application. */
export interface ExternalAppOpenWorktreeInput {
  projectId: string;
  ticketId: string;
  appId: ExternalAppId;
}

/** A ticket's live worktree root, resolved in main before Finder sees it. */
export interface WorktreeRevealInput {
  projectId: string;
  ticketId: string;
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

/**
 * `rename`'s destination — a second project-relative path, resolved through the
 * SAME scope as `relPath` (plan §4.5). A destination that would resolve against
 * a different root than the source (`.volli/**` always resolves to Main, the
 * repo half follows the ticket's worktree) is refused rather than silently
 * moving a file across checkouts.
 */
export interface FileRenameInput extends FilePathInput {
  toRelPath: string;
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
  /**
   * One project's live tickets (bodies excluded) and labels — the read a
   * targeted refresh makes in place of a whole-board bootstrap (VC-387).
   */
  "volli:data-project-roster": { args: [input: ProjectIdInput]; result: ProjectRosterResult };
  /** Main owns the database path; an omitted action reads its size. */
  "volli:database": { args: [action?: DatabaseAction]; result: DatabaseResult };
  /** One-time localStorage → SQLite import; a no-op (returns current state) once the db is non-empty. */
  "volli:legacy-import": { args: [request: LegacyImportRequest]; result: LegacyImportResult };

  "volli:project-create": { args: [input: ProjectCreateInput]; result: ProjectCreateResult };
  /** Updates the project's pinned automation base branch and/or worktree setup command. */
  "volli:project-update": { args: [input: ProjectUpdateInput]; result: ProjectUpdateResult };
  /** Replaces this project's per-skill rules wholesale (VC-111). */
  "volli:project-skill-modes": {
    args: [input: ProjectSkillModesInput];
    result: ProjectUpdateResult;
  };
  /** Replaces this project's Chat model default (VC-111). */
  "volli:project-session-defaults": {
    args: [input: ProjectSessionDefaultsInput];
    result: ProjectUpdateResult;
  };
  /**
   * Replaces this project's actor policy and delegation budget departures (VC-172).
   *
   * APP-ONLY, and that is the security property rather than an oversight. There
   * is no agent verb behind this channel and there must not be: writing the
   * policy that governs a Session is control tier, `verb-registry.ts` refuses a
   * `cli` access mode on control-tier verbs outright, and the socket attributes
   * its caller without authenticating one. The agent must not be able to author
   * the policy that governs it — VC-44's non-negotiable. Reads may go on the
   * socket; this does not.
   */
  "volli:project-authority-policy": {
    args: [input: ProjectAuthorityPolicyInput];
    result: ProjectAuthorityPolicyResult;
  };
  /** App-owned per-project MCP settings. No repository configuration is read. */
  "volli:mcp-list": { args: [input: McpProjectInput]; result: McpServersResult };
  "volli:mcp-test": { args: [input: McpServerInput]; result: McpCatalogResult };
  "volli:mcp-save": { args: [input: McpSaveInput]; result: McpServerResult };
  "volli:mcp-refresh": { args: [input: McpServerIdInput]; result: McpServerResult };
  "volli:mcp-set-enabled": { args: [input: McpSetEnabledInput]; result: McpServerResult };
  "volli:mcp-set-tools": { args: [input: McpSetToolsInput]; result: McpServerResult };
  "volli:mcp-remove": { args: [input: McpServerIdInput]; result: Result };
  /** Opens the server's OAuth page in the browser and waits for the loopback redirect (VC-470). */
  "volli:mcp-sign-in": { args: [input: McpSignInInput]; result: McpSignInResult };
  /** Stops a sign-in still waiting on the browser. */
  "volli:mcp-cancel-sign-in": { args: [input: McpServerIdInput]; result: Result };
  /** Deletes a server's stored OAuth tokens and registration. */
  "volli:mcp-sign-out": { args: [input: McpServerIdInput]; result: Result };
  /** Forgets credentials gathered for an editor draft that was never saved. */
  "volli:mcp-discard-draft": { args: [input: McpServerIdInput]; result: Result };
  /**
   * Points an existing project at the folder it moved to (VC-430).
   *
   * App-only, and note WHERE that comes from: no data channel is reachable from
   * the agent socket at all — the socket dispatches verbs from
   * `verb-registry.ts`, and this has none. So unlike
   * `volli:project-authority-policy`, which argues for a boundary that must
   * never be crossed, this is simply the ordinary state of a renderer channel.
   * It stays that way on the same grounds: re-homing a project changes where
   * every Session it starts will run, so no agent verb may ever be added behind
   * it. The folder is validated here before it is saved.
   */
  "volli:project-relink": { args: [input: ProjectRelinkInput]; result: ProjectRelinkResult };
  /** Whether one project's registered folder is still on disk (VC-430). */
  "volli:project-folder-check": { args: [input: ProjectIdInput]; result: ProjectFolderResult };
  /** Deletes a project; cascades its tickets/labels/events in SQLite. */
  "volli:project-remove": { args: [id: string]; result: ProjectMutationResult };

  "volli:ticket-create": { args: [input: TicketCreateInput]; result: TicketResult };
  "volli:ticket-move": { args: [input: TicketMoveRequest]; result: TicketsResult };
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
  /** One ticket's Markdown body — read by the ticket that is OPEN, since the refresh roster no longer carries it (VC-387). */
  "volli:ticket-body": { args: [input: TicketIdInput]; result: TicketBodyResult };
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

  /**
   * Attaches one file (VC-50). Decides in main whether the file is named live
   * as an `@` ref or snapshotted into the Blob store, because only main knows
   * the workspace and only main may read the bytes.
   */
  "volli:blob-attach": { args: [input: BlobAttachInput]; result: BlobAttachResult };
  /** A Ticket's or a Session's attachments, chronological. */
  "volli:blob-list": { args: [input: BlobListInput]; result: BlobLinksResult };
  /** Both owners' attachments in materialize order, for resolving image paths. */
  "volli:blob-materialized": {
    args: [input: BlobMaterializedInput];
    result: BlobMaterializedResult;
  };
  /** Detaches one attachment. Leaves the bytes for collection. */
  "volli:blob-remove": { args: [input: BlobLinkIdInput]; result: Result };
  /** Attaches Blobs that were imported before their Ticket existed. */
  "volli:blob-link-drafts": { args: [input: BlobLinkDraftsInput]; result: BlobLinksResult };

  /** Every durable session record in a project (ticket-scoped and project-scoped), newest first. */
  "volli:session-list": { args: [input: ProjectIdInput]; result: SessionsResult };
  /** A ticket's durable session records, newest first — backs the right-rail linked-sessions list. */
  "volli:session-list-for-ticket": { args: [input: TicketIdInput]; result: SessionsResult };
  /** Renames a session (project- or ticket-scoped); the title is trimmed and must be non-empty in main. */
  "volli:session-rename": { args: [input: SessionRenameInput]; result: SessionRenameResult };
  /**
   * Marks a Session read or unread (VC-30).
   *
   * Persists the receipt and then re-publishes that Session's listing row on
   * `volli:session-activity` — the same broadcast the push channel uses — so a
   * mark made in one sidebar reaches the other sidebar, the ticket rail, and
   * every other window.
   */
  "volli:session-read-set": { args: [input: SessionReadSetInput]; result: SessionReadSetResult };
  /**
   * One fold of a Session's tail plus the question it is asking, for a peek
   * card (VC-30). Read-only: it adopts nothing and subscribes to nothing.
   */
  "volli:session-peek-content": {
    args: [input: SessionPeekContentInput];
    result: SessionPeekContentResult;
  };
  /**
   * Stops a Session's work as the person (VC-269): records `session.stop`
   * with the `user` actor, interrupts the open turn and releases the live
   * attachment — the agent tool's three acts, by id. The Session stays
   * openable; a person can reattach it.
   */
  /**
   * When Sessions were started, across EVERY project, from `sinceMs` onward
   * (VC-55). Stamps only: the Home empty chat draws a count per day, and
   * `session-list` would fold every Session's whole history to answer it.
   */
  "volli:session-starts": { args: [input: SessionStartsInput]; result: SessionStartsResult };
  /**
   * What a scope consumed over a window, optionally broken down (VC-87).
   *
   * One indexed read over the usage projection plus one pass of arithmetic —
   * no Session histories folded and no transcript artifacts opened. It carries
   * only metadata: token counts, a cost, a basis and ids. No prompt, reply,
   * path, credential or provider error prose crosses this channel.
   */
  "volli:usage-report": { args: [input: UsageReportInput]; result: UsageReportResult };
  /**
   * The venue a Session of this scope runs in, measured (VC-55): the checkout,
   * its branch, the four-state file partition, and the lines moved against the
   * base. `ticketId: null` is a Board Session, which stands in the project's
   * main checkout.
   */
  "volli:venue-snapshot": { args: [input: VenueSnapshotInput]; result: VenueSnapshotResult };
  "volli:label-set-color": { args: [input: LabelSetColorInput]; result: LabelResult };
  "volli:app-state-set": { args: [key: string, value: string]; result: AppStateSetResult };

  // Ticket worktrees. `ensure` runs implicitly
  // inside terminal-create (§1) and on a Session boot; `worktree-recreate`
  // below is its ONE explicit door, for putting back a checkout that something
  // outside the app deleted (VC-113).
  /** The "Remove worktree…" escape hatch; `force` discards uncommitted work when the caller has confirmed. */
  "volli:worktree-remove": { args: [input: WorktreeRemoveInput]; result: WorktreeRemoveResult };
  /** Re-materializes a ticket's worktree on its existing branch after the directory went missing. */
  "volli:worktree-recreate": { args: [input: TicketIdInput]; result: WorktreeRecreateResult };
  /** A project's local branch names, for the base-branch picker. */
  "volli:worktree-branches": { args: [input: ProjectIdInput]; result: WorktreeBranchesResult };
  /**
   * The launch's cached orphan SCAN — read-only in every shape (VC-284), so a
   * renderer reload costs nothing and changes nothing. `{ refresh: true }` runs
   * the scan again. `opts` is optional on the wire (the existing test suite
   * invokes this with no argument at all) — the preload always sends `opts ??
   * {}`, so both `[]` and `[{ refresh? }]` are live.
   */
  "volli:worktree-orphans": {
    args: [opts?: WorktreeOrphansInput];
    result: WorktreeOrphansResult;
  };
  /** The confirmed, destructive cleanup of scanned orphans; main re-checks every target first. */
  "volli:worktree-orphan-cleanup": {
    args: [input: WorktreeOrphanCleanupInput];
    result: WorktreeOrphanCleanupResult;
  };
  /** User-confirmed deletion of one dirty orphan dir; main re-validates it lives inside the worktree home. */
  "volli:worktree-orphan-delete": {
    args: [input: WorktreeOrphanDeleteInput];
    result: WorktreeOrphanDeleteResult;
  };
  /**
   * The build-artifact read (VC-340): every worktree this database owns, how many
   * git-ignored paths a trim would take from it, and whether it is off limits.
   * Removes nothing and measures no sizes — sizing the whole set is the walk that
   * stalled for thirty seconds in the audit behind this ticket.
   */
  "volli:worktree-trim-scan": { args: []; result: WorktreeTrimScanResult };
  /**
   * The trim itself, across every non-active owned worktree. Takes no argument:
   * the only thing a caller could vary is the dry run, and no surface offers one,
   * so a destructive channel keeps the smallest input it can. Git metadata is
   * untouched — pruning is the confirmed orphan cleanup's act, not this one's.
   */
  "volli:worktree-trim": { args: []; result: WorktreeTrimResult };
  /**
   * Writes the preserved-configuration allowlist and the automatic-trim
   * opt-out. Read through `worktree.trimSettings` on the bridge (VC-608).
   */
  "volli:worktree-trim-settings-set": {
    args: [input: WorktreeTrimSettingsInput];
    result: WorktreeTrimSettingsResult;
  };

  // Done flow: the
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
  /** Releases one background subscriber without forgetting it, so focus can cheaply resume it. */
  "volli:worktree-change-watch-pause": { args: [input: TicketIdInput]; result: Result };
  /** Re-arms a paused worktree root and requests one catch-up Change Set refresh. */
  "volli:worktree-change-watch-resume": { args: [input: TicketIdInput]; result: Result };
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
 * Global artifacts + `@file` refs, the
 * Project Files workspace (issue #106), and Files' external-app launch/reveal
 * surface — the file channels `src/main/volli-fs-ipc.ts` owns.
 */
export interface VolliFileIpcContract {
  /** The scoped file index the `@` picker and quick-open rank over (git-listed + `.volli/artifacts/`). Fetched fresh per picker open. */
  "volli:file-index": { args: [input: FileIndexInput]; result: FileIndexResult };
  /** Reads any repo/artifact file worktree-awarely: text (capped), image (data URI), or binary stub. */
  "volli:file-read": { args: [input: FilePathInput]; result: FileReadResult };
  /**
   * Find across files (plan §4.7), through the same `{ projectId, ticketId }`
   * seam a read resolves through: literal text, gitignore-respecting, capped in
   * both matches and time, with the cap that ended it reported.
   */
  "volli:search": { args: [input: FileSearchInput]; result: FileSearchResult };
  /** Writes utf8 text to an existing file (images/binary/oversize refused), `expectedMtime` conflict-guarded. Resolves with the fresh mtime. */
  "volli:file-write": { args: [input: FileWriteInput]; result: FileWriteResult };
  /**
   * The sanctioned creation track (plan §4.5), through the same two-layer path
   * safety and `{ projectId, ticketId }` worktree resolution every read uses.
   * Creates an EMPTY file; refuses rather than overwriting whatever is there.
   */
  "volli:file-create": { args: [input: FilePathInput]; result: FileMutationResult };
  /** Creates one directory (missing parents included); refuses an occupied name. */
  "volli:dir-create": { args: [input: FilePathInput]; result: FileMutationResult };
  /** Renames/moves a file or directory within one checkout; refuses to clobber an occupied destination. */
  "volli:file-rename": { args: [input: FileRenameInput]; result: FileMutationResult };
  /** Copies a file to the first free `… copy` name beside it, and resolves with that name. */
  "volli:file-duplicate": { args: [input: FilePathInput]; result: FileMutationResult };
  /** Moves a file or directory to the TRASH (`shell.trashItem`) — never an in-place `rm`. */
  "volli:file-delete": { args: [input: FilePathInput]; result: Result };
  /** Creates a new, minimally-templated `.md` in `.volli/artifacts/`. Resolves with its `@ref`-able relPath. */
  "volli:artifact-create": { args: [input: ArtifactCreateInput]; result: ArtifactCreateResult };
  /** Creates one `<name>.md` prompt template, refusing rather than clobbering (VC-111). */
  "volli:prompt-template-create": {
    args: [input: PromptTemplateCreateInput];
    result: PromptTemplateCreateResult;
  };
  /** Reveals the resolved file in Finder. */
  "volli:file-reveal": { args: [input: FilePathInput]; result: Result };
  /** The currently installed allowlisted editor and terminal applications. */
  "volli:external-app-list": { args: []; result: ExternalAppListResult };
  /** Launches one allowlisted application with a safe main- or worktree-scoped file path. */
  "volli:external-app-open-file": {
    args: [input: ExternalAppOpenFileInput];
    result: Result;
  };
  /** Launches one allowlisted application with the ticket's resolved worktree root. */
  "volli:external-app-open-worktree": {
    args: [input: ExternalAppOpenWorktreeInput];
    result: Result;
  };
  /** Reveals the ticket's resolved worktree root in Finder. */
  "volli:worktree-reveal": { args: [input: WorktreeRevealInput]; result: Result };
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

// ---- bring-your-own harness trust ------------------------------------------

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
 *
 * `CliSessionPathStatus` keeps Session PATH separate from the interactive
 * login-shell PATH: the two paths must be comparable in Settings because one
 * is what a person's shell says and the other is what Session commands inherit.
 */
/** One known malformed entry in macOS's system login-PATH configuration. */
export interface CliSystemPathIssue {
  kind: "dotnet-cli-tools-literal-tilde";
  /** The root-owned `/etc/paths.d/*` file containing the entry. */
  file: string;
  /** The literal value `path_helper` appends to every login PATH. */
  entry: string;
}

// The Git credential-helper diagnosis is deliberately NOT here (VC-159/R8).
// `osxkeychain` is the stock macOS Git setup, so a status read that carries it
// invites a pane to warn about a default. It stays main-local
// (`credential-helper-diagnostics.ts`) and is asked for at the point of use:
// the explanation rides the failed `git push` it can account for.

export interface CliSessionPathStatus {
  /** The exact colon-delimited PATH a Session command inherits. */
  path: string;
  /** What the non-interactive boot adoption could establish. */
  provenance: SessionEnvProvenance;
  /** What the later interactive pass could establish, if it has landed. */
  interactiveProvenance: SessionEnvInteractiveProvenance;
  /** Where each measured Session tool resolves, or `null` when it does not. */
  tools: Readonly<Record<SessionEnvTool, string | null>>;
  /**
   * The subset of {@link tools} the scoped project implies — a repository
   * implies `git`, a JavaScript workspace implies its lockfile's manager and
   * the runtime that manager needs (`@volli/shared`'s
   * `requiredSessionEnvTools`). Only these absences are faults; empty when no
   * project workspace was supplied.
   */
  requiredTools: readonly RequirableSessionEnvTool[];
  /** Project-scoped dependency state; `null` when no project workspace was supplied. */
  dependencies: WorkspaceDependenciesStatus;
  /**
   * The command that installs the scoped workspace's dependencies, judged by
   * its lockfile (`@volli/shared`'s `workspaceInstallCommand`); `null` when
   * no project workspace was supplied or none encloses it. Settings and the
   * dependency offer's vocabulary only — `volli identify`'s env block
   * deliberately stays the exact field set the contract published.
   *
   * The offer RUNS this string (VC-156), which is the whole reason it must be
   * measured rather than assumed: a button that pnpm-installs a yarn
   * workspace is worse than no button.
   */
  installCommand: string | null;
}

export interface CliToolStatus {
  /** `~/.local/bin/volli`: `ours` links this app's shim; `foreign`/`not-symlink` were left alone. */
  link: {
    path: string;
    state: "ours" | "missing" | "foreign" | "not-symlink";
    target: string | null;
  };
  /** Whether the login shell reaches `~/.local/bin`; `unknown` means the shell could not be asked. */
  path: { binDir: string; state: "reachable" | "missing" | "unknown" };
  /**
   * Both PATH facts the app can otherwise accidentally conflate: the login
   * shell's current answer and the PATH Session commands will actually get.
   * `loginPath: null` means that shell could not be asked, never an empty PATH.
   */
  environment: {
    loginPath: string | null;
    session: CliSessionPathStatus;
    /** A read-only diagnosis of known malformed system PATH entries. */
    systemPathIssues: CliSystemPathIssue[];
  };
  /** The agent socket this launch owns; `live` is measured at call time, not latched at boot. */
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

/** A project root for the Session environment and Git credential reports, when one is in scope. */
export interface CliStatusInput {
  cwd?: string;
}

/** `fix: true` runs main's idempotent repair (regenerate + reinstall) before the probe. */
export interface CliDoctorInput {
  fix: boolean;
  /**
   * The project root to run the probe IN, when one is in scope.
   *
   * Which tool absences are faults is a fact about a directory (VC-157), and
   * `volli doctor` reads it from its own cwd. A probe spawned without this
   * inherits main's cwd — `/` for an app launched from Finder — which implies
   * no project and so can never fault a missing `git`. The pane would then
   * contradict the banner that sent the user to it, which is the
   * two-surfaces-disagree failure VC-94 was about.
   */
  cwd?: string;
}

/**
 * A real `volli doctor` run: main spawns the user's login shell, which resolves
 * `volli` off its own PATH — the environment agents outside Volli actually get.
 */
export type CliDoctorResult =
  | { ok: true; checks: DoctorCheck[]; summary: string }
  | { ok: false; error: string };

/**
 * What main's idempotent Session-environment repair established — `volli doctor
 * --fix`'s first half, without the login-shell doctor probe behind it.
 *
 * Its own verb because the launch banner's Fix now button needs exactly this
 * work and nothing more (VC-159/R7): the probe spawns a login shell and waits
 * up to fifteen seconds for it, which is the very shell a PATH fault says is
 * not answering. Settings → CLI still runs the full `doctor --fix`.
 */
export type CliRepairResult = { ok: true } | { ok: false; error: string };

/** The Settings → CLI surface (`src/main/cli-ipc.ts`). */
export interface VolliCliIpcContract {
  "volli:cli-status": { args: [input?: CliStatusInput]; result: CliStatusResult };
  "volli:cli-doctor": { args: [input: CliDoctorInput]; result: CliDoctorResult };
  "volli:cli-repair": { args: []; result: CliRepairResult };
}

export type CliIpcChannel = keyof VolliCliIpcContract;

// ---- support metadata -------------------------------------------------------

/**
 * The six facts a support report needs and the renderer cannot know (VC-293, VC-633).
 *
 * An ALLOWLIST, and written as a closed shape for that reason: every field is
 * named here, main assembles exactly these, and the report prints them. The
 * report is a thing a user pastes into a public issue, so what is absent
 * matters as much as what is present — no environment, no credential or
 * secret-store value, no database contents beyond the schema number.
 *
 * There is no separate packaged build id in this app, so {@link appVersion} IS
 * the build version; inventing a second version field or a source revision
 * would be reporting something nothing measures.
 */
export interface SupportInfo {
  /** `app.getVersion()` — the running build's version. */
  appVersion: string;
  /** The configured release line. A report is unavailable when it cannot be read. */
  channel: UpdateChannel;
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** SQLite's `PRAGMA user_version`. A report is unavailable when it cannot be read. */
  schemaVersion: number;
  /**
   * What the file's applied-migration history says against this build's lock
   * (VC-633): one sentence, `consistent` or the versions another lineage ran.
   * Version numbers and words only; never a row of data.
   */
  migrationHistory: string;
}

export type SupportInfoResult = Result<{ info: SupportInfo }>;

/** The About metadata surface (`src/main/support-info.ts`). Read-only, and takes no argument. */
export interface VolliSupportIpcContract {
  "volli:support-info": { args: []; result: SupportInfoResult };
}

export type SupportIpcChannel = keyof VolliSupportIpcContract;

// ---- theming ----------------------------------------------------------------

/** `{ projectId? }` — a theme read is global unless a project scopes it (#69). */
export interface ThemeStateInput {
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
 * TERMINAL chain (which has to be read off the filesystem) and the
 * migration-013 row that surface still lives on. The app surface is not here —
 * its `{canvas, appearance}` pair rides the bootstrap payload — and neither is
 * the editor, which since VC-123 is derived from that pair rather than stored.
 */
export interface ThemeStatePayload {
  /** The scoping project's per-surface override; null when unscoped or fully inheriting. */
  projectOverride: ProjectThemeOverride | null;
  /** The project the state was resolved for, echoed back; null for the global scope. */
  projectId: string | null;
  /** The terminal appearance with the full overlay chain (and provenance) applied for that scope. */
  terminal: GhosttyAppearancePayload;
}

// ---- canvas theming writes --------------------------------------------------
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
 * The first-paint hint is persisted by the host's theme repo, so its shape is
 * `@volli/shared`'s; re-exported because every desktop process reads channel
 * types from this one file.
 */
export type { FirstPaintHint };

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
  /** The resolved terminal chain for a scope, plus the migration-013 row. */
  "volli:theme-state": { args: [input: ThemeStateInput]; result: ThemeStateResult };
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

export type WebAccessResult = Result<{ settings: WebAccessSettingsView }>;

/**
 * Bring-your-own web search, configured in Settings.
 *
 * Its own surface rather than a Session RPC namespace, for the reason
 * {@link VolliModelAccessIpcContract} gives: one argument here is an API key,
 * every RPC procedure is wrapped by a diagnostic recorder with a live
 * subscription tap on it, and a secret and a log tap do not belong on one wire.
 * Nothing on these four channels is recorded.
 *
 * The traffic is one-way for the secret. A key crosses inbound, once, and every
 * answer on every channel is a {@link WebAccessSettingsView} — a shape with no
 * field a key could occupy. There is deliberately no "read the key back"
 * channel, not even a masked one: a renderer that can display the last four
 * characters is a renderer that was sent them.
 */
export interface VolliWebAccessIpcContract {
  /** The current setting. Safe to call on every Settings open. */
  "volli:web-access-get": { args: []; result: WebAccessResult };
  /**
   * Chooses the provider, and for SearXNG the instance to call.
   *
   * The URL is judged by `admitSearchEndpoint` before it is stored, so a LAN
   * address is an error in Settings rather than a refusal in the middle of
   * somebody's turn six hours later.
   */
  "volli:web-access-set-provider": {
    args: [provider: WebAccessProvider, searxngUrl: string | null];
    result: WebAccessResult;
  };
  /**
   * Stores one keyed provider's API key. The one inbound secret on this surface.
   *
   * It crosses once and is never echoed, returned, logged, or included in an
   * error string. It is saved in the profile database, in the clear, which
   * stays its one source of truth until the read switch (VC-644); a sealed
   * copy follows (VC-643), and the answer's `sealing` says whether that copy
   * is current ("saved; sealing pending" when it is not). Nothing here claims
   * the key is encrypted.
   */
  "volli:web-access-set-key": {
    args: [provider: KeyedWebAccessProvider, key: string];
    result: WebAccessResult;
  };
  /** Forgets one provider's stored key. The provider choice, and the other key, are left alone. */
  "volli:web-access-clear-key": {
    args: [provider: KeyedWebAccessProvider];
    result: WebAccessResult;
  };
}

export type WebAccessIpcChannel = keyof VolliWebAccessIpcContract;

// ---- decision models (VC-478) ---------------------------------------------

export type DecisionModelResult = Result<{
  settings: DecisionModelSettingsView;
  /** The project row as the write left it, when the write was a project's. */
  project?: Project;
}>;

export type DecisionModelTestResult = Result<{ test: DecisionModelTestView }>;

/**
 * The decision model setting (VC-478), on its own door.
 *
 * Nothing on this surface carries a secret, and it cannot start carrying one:
 * a setting names a provider and a model or a loopback URL, and main re-reads
 * every write through `parseDecisionModelSetting`, which keeps only those
 * fields. A cloud model's key is entered through Model Access sign-in and
 * lives in Pi's own `auth.json`; this door only reports whether one exists.
 */
export interface VolliDecisionModelIpcContract {
  /** The app-wide setting, a project's override when named, and the cloud catalog. */
  "volli:decision-model-get": {
    args: [projectId: string | null];
    result: DecisionModelResult;
  };
  /**
   * Stores one scope's setting. `null` clears a project's override back to
   * inheriting; the app-wide setting cannot be null (`none` turns it off). A
   * cloud setting must carry the person's opt-in, which main time-stamps.
   */
  "volli:decision-model-set": {
    args: [scope: DecisionModelScope, setting: DecisionModelSetting | null];
    result: DecisionModelResult;
  };
  /**
   * Asks a local server or a cloud model one fixed question, end to end. Sends
   * a probe sentence Volli wrote, never a Session's data, so it needs no
   * opt-in; it is how a person checks a URL or a sign-in before relying on it.
   */
  "volli:decision-model-test": {
    args: [setting: DecisionModelSetting];
    result: DecisionModelTestResult;
  };
}

export type DecisionModelIpcChannel = keyof VolliDecisionModelIpcContract;

/** Whether agent telemetry is exported, and whether it is actually landing. */
export interface AgentObservabilityView {
  enabled: boolean;
  /** The collector's address, normalized to its origin by main before storage. */
  endpoint: string;
  status: "off" | "exporting" | "failed";
  /**
   * One sentence about why nothing is being exported, latched. Null when there
   * is nothing to say. Never a dependency's message, a stack, or an address.
   */
  problem: string | null;
}

export type AgentObservabilityResult = Result<{ settings: AgentObservabilityView }>;

/**
 * The opt-in agent-telemetry export setting (VC-119).
 *
 * Its own two-channel surface for the same reason Web Access has one: the
 * Session RPC wire is instrumented, and a switch that governs instrumentation
 * has no business being observed by it.
 *
 * Nothing on this surface carries a secret, and it cannot start carrying one:
 * main refuses a collector address with credentials in it rather than storing
 * a password that Settings would then read back and display.
 */
export interface VolliAgentObservabilityIpcContract {
  /** The current setting plus whatever the exporter has since found out. */
  "volli:agent-observability-get": { args: []; result: AgentObservabilityResult };
  /**
   * Records the switch and the address together, because they are one decision:
   * turning export on names where it goes. The address is judged before it is
   * stored, so a refusal is a correction to what was just typed.
   */
  "volli:agent-observability-set": {
    args: [enabled: boolean, endpoint: string];
    result: AgentObservabilityResult;
  };
}

export type AgentObservabilityIpcChannel = keyof VolliAgentObservabilityIpcContract;

// ---- notifications (VC-295) ------------------------------------------------

/**
 * What Settings → Notifications draws.
 *
 * Two delivery facts and no third: `supported` is `Notification.isSupported()`,
 * and `deliveryFailure` is the most recent delivery Electron itself reported as
 * failed this launch. There is deliberately no `permission` field — Electron
 * gives this app no trustworthy read of the OS authorization state, and a
 * Settings page that guessed one would be wrong in exactly the case that
 * matters (a denied notification's `show()` succeeds silently).
 */
export interface NotificationSettingsView {
  preferences: NotificationPreferences;
  supported: boolean;
  deliveryFailure: { producer: NotificationProducer; message: string; at: number } | null;
}

export type NotificationSettingsResult = Result<{ settings: NotificationSettingsView }>;

export type NotificationPendingActivationResult = Result<{ target: NotificationTarget | null }>;

/**
 * The notification preference surface (VC-295), on its own door rather than the
 * generic `app_state` write.
 *
 * docs/BOUNDARIES.md rule 5: a domain surface takes a validated command with
 * IPC as dumb transport. The generic string→string write cannot refuse a
 * category this build does not have; this can, and its refusal is the sentence
 * the pane shows.
 */
export interface VolliNotificationIpcContract {
  /** The preferences plus what is known about delivery on this machine. */
  "volli:notifications-get": { args: []; result: NotificationSettingsResult };
  /**
   * One switch move. `event: null` is the master switch. Answers with the whole
   * view read back from the stored row — never an echo of the request — so the
   * pane can only ever show a value the write actually produced.
   */
  "volli:notifications-set": {
    args: [update: { event: NotificationEvent | null; enabled: boolean }];
    result: NotificationSettingsResult;
  };
  /**
   * The target of a notification clicked while no window existed, taken once.
   * A window that opens because of a click asks for it as it subscribes; a
   * push into a page that has not subscribed yet would simply be lost.
   */
  "volli:notifications-pending-activation": {
    args: [];
    result: NotificationPendingActivationResult;
  };
}

export type NotificationIpcChannel = keyof VolliNotificationIpcContract;

// ---- Browser Tabs (VC-110) -------------------------------------------------

/**
 * A tab's provenance, presentation and renderer-safe state are domain
 * vocabulary every client of a host reads (VC-561), so their shapes are
 * `@volli/shared`'s; re-exported because every desktop process reads channel
 * types from this one file.
 */
export type { BrowserTabCreatedBy, BrowserTabPresentation, BrowserTabState };

/**
 * A person's request to open a Browser Tab in one workspace scope. Provenance
 * is deliberately absent: renderer-originated tabs are always `user`, while a
 * Session opens its own tabs through the main-process host port.
 */
export interface BrowserTabOpenInput {
  projectId: string;
  ticketId?: string;
  url: string;
}

/** A scoped registry read; omitting `ticketId` lists the whole project. */
export interface BrowserTabListInput {
  projectId: string;
  ticketId?: string;
}

/** An opaque Browser Tab target shared by operations that carry no other input. */
export interface BrowserTabIdInput {
  tabId: string;
}

/** One address-bar navigation, separate from history-direction commands. */
export interface BrowserTabNavigateInput extends BrowserTabIdInput {
  url: string;
}

export type { BrowserTabBounds };

/** One measured host plane paired with the opaque tab it belongs to. */
export interface BrowserTabSetBoundsInput extends BrowserTabIdInput {
  bounds: BrowserTabBounds;
}

/**
 * A person's request to draw a Session's tab somewhere else (VC-238): hide it,
 * pin it above the owning chat's composer, or promote it into the strip. Main
 * refuses it for a person's own tab, which is always in the strip.
 */
export interface BrowserTabSetPresentationInput extends BrowserTabIdInput {
  presentation: BrowserTabPresentation;
}

/** One picture the host took of a tab, by the id the transcript carries. */
export interface BrowserPictureInput {
  pictureId: string;
}

/**
 * The picture as an `<img src>`, or null when the host no longer has it: a
 * live capture the bounded set let go of, or an id this launch never minted.
 * Null is an answer, not a failure — the card says the picture is gone.
 */
export type BrowserPictureResult = Result<{ dataUrl: string | null }>;

/** Whose Browser Traces a replay asks for (VC-453). */
export interface BrowserTracesInput {
  sessionId: string;
}

/**
 * A Session's kept Browser Traces, oldest first — the portable record from
 * `@volli/shared`, frames named by picture id and read through
 * `volli:browser-picture`. Empty is an answer: nothing recorded, or swept.
 */
export type BrowserTracesResult = Result<{ traces: BrowserTrace[] }>;

/** A Browser Tab mutation/read that answers with the current chrome snapshot. */
export type BrowserTabResult = Result<{ tab: BrowserTabState }>;

/**
 * One inert bitmap captured from a native Browser surface.
 *
 * Bounds are relative to the renderer's measured Browser plane. `kind` keeps
 * the page and its optional docked DevTools frame distinct without making a
 * data URL part of renderer identity.
 */
export interface BrowserTabCaptureFrame {
  kind: "page" | "devtools";
  dataUrl: string;
  bounds: BrowserTabBounds;
}

/**
 * The frozen pixels the renderer paints while an app overlay covers the native
 * Browser plane. No remote DOM, script, storage, or WebContents handle crosses
 * with them; the frame is display-only and discarded when the overlay closes.
 */
export type BrowserTabCaptureResult = Result<{ frames: BrowserTabCaptureFrame[] }>;

/** The scoped Browser Tab registry, containing no page-derived body data. */
export type BrowserTabListResult = Result<{ tabs: BrowserTabState[] }>;

/**
 * The Browser workspace's renderer→main command surface. Every native-surface
 * operation names Volli's opaque tab id; none accepts a Chromium index,
 * partition name, preload, or WebContents id.
 */
export interface VolliBrowserIpcContract {
  "volli:browser-open": { args: [input: BrowserTabOpenInput]; result: BrowserTabResult };
  "volli:browser-close": { args: [input: BrowserTabIdInput]; result: Result };
  "volli:browser-list": { args: [input: BrowserTabListInput]; result: BrowserTabListResult };
  "volli:browser-navigate": {
    args: [input: BrowserTabNavigateInput];
    result: BrowserTabResult;
  };
  "volli:browser-back": { args: [input: BrowserTabIdInput]; result: BrowserTabResult };
  "volli:browser-forward": { args: [input: BrowserTabIdInput]; result: BrowserTabResult };
  "volli:browser-reload": { args: [input: BrowserTabIdInput]; result: BrowserTabResult };
  "volli:browser-set-bounds": { args: [input: BrowserTabSetBoundsInput]; result: Result };
  "volli:browser-capture": {
    args: [input: BrowserTabIdInput];
    result: BrowserTabCaptureResult;
  };
  "volli:browser-show": { args: [input: BrowserTabIdInput]; result: Result };
  "volli:browser-hide": { args: [input: BrowserTabIdInput]; result: Result };
  "volli:browser-toggle-devtools": { args: [input: BrowserTabIdInput]; result: Result };
  "volli:browser-set-presentation": {
    args: [input: BrowserTabSetPresentationInput];
    result: BrowserTabResult;
  };
  "volli:browser-picture": { args: [input: BrowserPictureInput]; result: BrowserPictureResult };
  "volli:browser-traces": { args: [input: BrowserTracesInput]; result: BrowserTracesResult };
  /**
   * The person's three hold controls (VC-239). Explicit, never inferred from
   * input: main cannot tell a person's click in the native view from a
   * Session's synthetic one, so only these channels move the hold.
   */
  "volli:browser-take-over": { args: [input: BrowserTabIdInput]; result: BrowserTabResult };
  "volli:browser-hand-back": { args: [input: BrowserTabIdInput]; result: BrowserTabResult };
  "volli:browser-ask-to-leave": { args: [input: BrowserTabIdInput]; result: Result };
}

/** Every Browser workspace invoke channel, derived from its one contract. */
export type BrowserIpcChannel = keyof VolliBrowserIpcContract;

/**
 * A complete Browser Tab chrome snapshot pushed whenever URL, title, loading,
 * history reachability, or generation changes. A full snapshot avoids merging
 * partial events from different navigations out of order.
 */
export type BrowserTabStateEvent =
  | { tab: BrowserTabState; closedTabId?: never }
  | { tab?: never; closedTabId: string };
// ---- background shells (VC-270) ---------------------------------------------

/**
 * Renderer-safe state for one background shell a Session started. Product
 * identity and bounded chrome facts cross IPC; the process handle, the
 * environment it was spawned with and its output never do — the tail is a
 * separate, explicit read.
 *
 * Shells are live resources, not ledger facts: they die with the attachment
 * that started them, do not survive a relaunch, and the tool calls that
 * started and read them are the durable record.
 */
/**
 * One background shell as the host holds it. Client wire vocabulary in
 * `@volli/shared` (VC-632), re-exported here so the renderer contract stays in
 * one place; this contract never depends on host-core.
 */
export type { BackgroundShellState } from "@volli/shared";
import type { BackgroundShellState } from "@volli/shared";

/**
 * A complete shell snapshot pushed on start and on exit, or the id of a shell
 * the host forgot when its Session's attachment ended.
 */
export type BackgroundShellStateEvent =
  | { shell: BackgroundShellState; removedShellId?: never }
  | { shell?: never; removedShellId: string };

export interface BackgroundShellIdInput {
  shellId: string;
}

/** Every live shell the host holds, across Sessions; the renderer filters by Session. */
export type BackgroundShellListResult = Result<{ shells: BackgroundShellState[] }>;

/**
 * A shell's whole retained output for a person's read, with its chrome. Read
 * on demand rather than pushed: output is bounded but not small, and only an
 * open output tab wants it. Moves no cursor of the model's.
 */
export type BackgroundShellTailResult = Result<{ output: string; shell: BackgroundShellState }>;

/**
 * The renderer's command surface for background shells (VC-270). Host IPC,
 * not a durable domain API (docs/BOUNDARIES.md #5): shells are ephemeral
 * machine resources like PTY planes, and nothing here writes history.
 * A person's kill is a no-op on a shell already exited, not an error — they
 * pressed the row, and the row is gone either way.
 */
export interface VolliShellIpcContract {
  "volli:shell-list": { args: []; result: BackgroundShellListResult };
  "volli:shell-tail": { args: [input: BackgroundShellIdInput]; result: BackgroundShellTailResult };
  "volli:shell-kill": { args: [input: BackgroundShellIdInput]; result: Result };
}

export type ShellIpcChannel = keyof VolliShellIpcContract;

// ---- automations (VC-112, tracer VC-126) -----------------------------------

/** What a create carries. `projectId: null` is global Ownership. */
export interface AutomationCreateInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  projectId: string | null;
  name: string;
  instructions: string;
  /**
   * Which columns offer this Automation (VC-128).
   *
   * Required, and carried as the union's explicit `{ kind: "none" }` rather
   * than left off: docs/BOUNDARIES.md rule 3 keeps RPC payloads JSON-safe, and
   * an optional field says "Nothing else" only on a transport that survives
   * `undefined` — Electron's structured clone does, JSON does not, so the
   * spelling that means the default has to be a value. The union already has a
   * member for it, which is why `none` exists at all.
   */
  trigger: AutomationTrigger;
  /**
   * The pinned selection, whole; a named tier to resolve when each Run starts
   * (VC-259); or `null` to inherit. Never the invalid row — that shape is read
   * off a record that needs repairing, never authored into one.
   */
  runtime: ValidAutomationRuntime;
}

/** An update rewrites the editable fields; Ownership is identity and never moves. */
export interface AutomationUpdateInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  automationId: string;
  name: string;
  instructions: string;
  /** Rewritten whole like every other editable field, and present like it too. */
  trigger: AutomationTrigger;
  runtime: ValidAutomationRuntime;
}

/**
 * Arming one column, or disarming it with `automationId: null` (VC-128).
 *
 * A `commandId` like every write above it, and for the reason
 * {@link AutomationSetEnabledInput} states: the PROJECTION this lands in is
 * machine-local (the `automation_column_arming` table, which never travels with
 * a project), while the INTENT is an ordinary durable command — arming decides
 * whether work starts without a person, and docs/BOUNDARIES.md rule 5 governs
 * exactly that. A retry repeats the same command and replays its receipt rather
 * than arming twice.
 */
export interface AutomationArmInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  projectId: string;
  status: TicketStatus;
  automationId: string | null;
}

/**
 * Arranging one column's Offered list — which Automation reads as digit `1`
 * when a card is dragged over it (VC-132).
 *
 * A `commandId` like every write above it, for the reason {@link AutomationArmInput}
 * states: the PROJECTION is machine-local (`automation_column_order`, which
 * never travels with a project), while the INTENT is an ordinary durable
 * command — the rank decides which Automation a release aims at.
 *
 * The whole list travels, never a moved id and an index: a JSON transport
 * carries an array perfectly well, and "the new order" is a value the caller
 * already holds, while a pair of indices would be a second spelling of the same
 * arrangement that main would have to re-derive against a list it cannot see.
 * An EMPTY list is "never arranged", which is a value rather than an absent
 * field (docs/BOUNDARIES.md rule 3).
 */
export interface AutomationSetColumnOrderInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  projectId: string;
  status: TicketStatus;
  /** Automation ids, best rank first. Ids the column no longer offers are inert. */
  rankedAutomationIds: string[];
}

export interface AutomationIdInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  automationId: string;
}

/**
 * One Run request: which Ticket, what it runs, and what it runs it on.
 *
 * `target` is the union rather than a nullable `automationId` beside nullable
 * Instructions, so an Unbound Run (VC-129) is a Run this shape can spell and a
 * Run that is somehow both, or neither, is one it cannot. Both fields are
 * REQUIRED and explicitly nullable where they can be absent — an optional
 * property admits `undefined`, which the Electron transport carries and an HTTP
 * one would mangle (docs/BOUNDARIES.md rule 3).
 */
export interface AutomationRunInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  /** The saved Automation to run, or an Unbound Run's own Instructions. */
  target: AutomationRunTarget;
  ticketId: string;
  /**
   * The Runtime THIS invocation runs on, or `null` to resolve the ordinary way
   * — the Automation's own pin, then the project's preferences, then the global
   * record (VC-112). A per-invocation override is never stored: the Run records
   * the model it RESOLVED, which is the only durable evidence either way.
   */
  modelOverride: ModelSelection | null;
}

/**
 * Running an Automation against a PROJECT rather than a Ticket (VC-130).
 *
 * Its own input and its own channel rather than a nullable `ticketId` on the
 * one above: the two are different Targets with different Session Roles, and a
 * nullable field on the wire would let a caller ask for a Board Session by
 * FORGETTING something. docs/BOUNDARIES.md rule 3 wants the shape to say what
 * it means, so the shape that means "the Project" names a project.
 *
 * The renderer reaches it from a Skipped occurrence's "Run now" — a schedule
 * that did not fire, started by hand, at the Target it would have used.
 */
export interface AutomationRunForProjectInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  automationId: string;
  projectId: string;
}

/**
 * Turning one Automation on or off ON THIS MACHINE (VC-127).
 *
 * Enablement is deliberately NOT a field on the {@link Automation} record.
 * VC-112 puts the shareable half of an Automation in git as a Skill and keeps
 * the record local; enablement is one step more local still — the same tier as
 * a column's arming, which that ruling also declares per machine. So its
 * PROJECTION lives in `app_state`, beside the global runtime-preferences record
 * that ruling cites, and a project cannot carry it anywhere.
 *
 * The INTENT is an ordinary durable command all the same, hence the
 * `commandId`: docs/BOUNDARIES.md rule 5 governs new domain surfaces, and a
 * switch that decides whether an Automation fires is one. A retry repeats the
 * same command and replays its receipt rather than flipping anything twice.
 *
 * It governs what starts an Automation BESIDES a person. Running by hand is
 * universal (VC-112), so an Automation that is off is still runnable from
 * every surface that lists it — it simply never fires on its own.
 */
export interface AutomationSetEnabledInput {
  /** Caller-minted UUID: a transport retry repeats this exact command. */
  commandId: string;
  automationId: string;
  enabled: boolean;
}

/**
 * The ENABLED set, whole, rather than one automation's boolean.
 *
 * Whole, so a caller never reconstructs what it now believes from what it just
 * asked for. Enabled rather than disabled, because VC-112 rules that a machine
 * fires nothing until someone turns something on there: absent has to mean
 * off, and a disabled-set shape cannot tell "never asked here" from "on".
 */
export type AutomationEnablementResult = Result<{ enabledAutomationIds: string[] }>;

/** The same set, plus the receipt for the command that changed it. */
export type AutomationSetEnabledResult = Result<{
  enabledAutomationIds: string[];
  receipt: AutomationCommandReceipt;
}>;

export type AutomationsResult = Result<{ automations: Automation[] }>;
export type AutomationResult = Result<{
  automation: Automation;
  receipt: AutomationCommandReceipt;
}>;
export type AutomationDeleteResult = Result<{ receipt: AutomationCommandReceipt }>;
/**
 * One Automation's history inside one project (VC-297).
 *
 * Both ids, because neither answers alone: a global Automation is listable in
 * every project but each Run it produced happened in ONE, so the pair is the
 * whole question. A read, so it carries no `commandId` — unlike
 * {@link AutomationIdInput}, which is a command's.
 */
export interface AutomationHistoryScopeInput {
  projectId: string;
  automationId: string;
}

export type AutomationRunsResult = Result<{ runs: AutomationRun[] }>;
/** One project's Skipped occurrences — the other half of its Run history (VC-130). */
export type AutomationSkipsResult = Result<{ skips: AutomationSkippedOccurrence[] }>;
/** Every armed column in the project — the whole truth, so a caller reconstructs nothing. */
export type AutomationArmingsResult = Result<{ armings: ColumnArming[] }>;

/** The same set, plus the receipt for the command that changed it. */
export type AutomationArmResult = Result<{
  armings: ColumnArming[];
  receipt: AutomationCommandReceipt;
}>;

/** Every arranged column in the project — whole, so a caller reconstructs nothing. */
export type AutomationColumnOrdersResult = Result<{ orders: ColumnAutomationOrder[] }>;

/** The same set, plus the receipt for the command that changed it. */
export type AutomationSetColumnOrderResult = Result<{
  orders: ColumnAutomationOrder[];
  receipt: AutomationCommandReceipt;
}>;

/** Main's complete countdown and retained-failure projection. */
export type PendingArmedRunsResult = Result<{
  pending: PendingArmedRun[];
  failures: PendingArmedRunFailure[];
}>;

/** Cancel identifies one exact arrival, never whichever later move shares its Ticket. */
export interface PendingArmedRunCancelInput {
  id: string;
}

export type PendingArmedRunCancelResult = Result<{ cancelled: boolean }>;

/** Retry also names the exact move; main supplies its retained command id. */
export interface PendingArmedRunRetryInput {
  id: string;
}

export type PendingArmedRunRetryResult = Result<{ retrying: boolean }>;

/**
 * The Automations planning surface (VC-126): the record's CRUD plus the one
 * Run door. Same stance as the rest of the planning data — typed channels,
 * JSON-safe payloads (docs/BOUNDARIES.md rule 3: no Date, no Map, no
 * undefined-bearing shapes), main-owned writes, `volli:data-changed` fan-out.
 */
export interface VolliAutomationIpcContract {
  /** A project's own Automations plus every global one — the Offered universe for its surfaces. */
  "volli:automation-list": { args: [input: ProjectIdInput]; result: AutomationsResult };
  /** Creates one Automation. Main re-validates the draft and any Runtime pin before writing. */
  "volli:automation-create": { args: [input: AutomationCreateInput]; result: AutomationResult };
  /** Rewrites one Automation's editable fields, under the same validation as create. */
  "volli:automation-update": { args: [input: AutomationUpdateInput]; result: AutomationResult };
  /** A record delete — Runs retain their Automation id/name snapshot. */
  "volli:automation-delete": { args: [input: AutomationIdInput]; result: AutomationDeleteResult };
  /**
   * Runs one Automation — or one Unbound Run's own Instructions (VC-129) — by
   * hand on a Ticket: one fresh chat Session, one Run row, either way.
   */
  "volli:automation-run": { args: [input: AutomationRunInput]; result: AutomationRunStartResult };
  /** A Ticket's Runs, newest first. */
  "volli:automation-runs-for-ticket": {
    args: [input: TicketIdInput];
    result: AutomationRunsResult;
  };
  /** One project's armed columns — machine-local, never listed with the record. */
  "volli:automation-arming-list": {
    args: [input: ProjectIdInput];
    result: AutomationArmingsResult;
  };
  /** Arms one column with one offered Automation, or disarms it. */
  "volli:automation-arm": { args: [input: AutomationArmInput]; result: AutomationArmResult };
  /** One project's arranged columns — machine-local, like the arming beside it. */
  "volli:automation-column-order-list": {
    args: [input: ProjectIdInput];
    result: AutomationColumnOrdersResult;
  };
  /** Arranges one column's Offered list, and answers with the project's whole new set. */
  "volli:automation-set-column-order": {
    args: [input: AutomationSetColumnOrderInput];
    result: AutomationSetColumnOrderResult;
  };
  /**
   * Every Run in this project, newest first — the Automations page's Run
   * history (VC-127). Scoped through each Run's own durable evidence (the
   * Session it opened, which names the project) rather than through the
   * Automation: a global Automation is listable everywhere, but a Run it
   * produced happened in ONE project.
   */
  "volli:automation-runs-for-project": {
    args: [input: ProjectIdInput];
    result: AutomationRunsResult;
  };
  /**
   * ONE Automation's Runs in one project, newest first — what the editor's
   * history shows (VC-297).
   *
   * Narrower than the project read above it, and a separate door rather than a
   * filter the client applies: a caller that is not this process should ask for
   * the list it draws, not download a project's whole history to find it. Main
   * has the index for both questions (`idx_automation_runs_automation`).
   */
  "volli:automation-runs-for-automation": {
    args: [input: AutomationHistoryScopeInput];
    result: AutomationRunsResult;
  };
  /** The same Automation's Skipped occurrences, read beside its Runs (VC-297). */
  "volli:automation-skips-for-automation": {
    args: [input: AutomationHistoryScopeInput];
    result: AutomationSkipsResult;
  };
  /** Which Automations are switched on on this machine. */
  "volli:automation-enablement": { args: []; result: AutomationEnablementResult };
  /** Switches one Automation on or off here, and answers with the whole new set. */
  "volli:automation-set-enabled": {
    args: [input: AutomationSetEnabledInput];
    result: AutomationSetEnabledResult;
  };
  /** Main's whole durable pending-countdown projection, for a new renderer window. */
  "volli:automation-pending-armed-runs": { args: []; result: PendingArmedRunsResult };
  /** Cancels one exact pending arrival; idempotent when it already settled or was replaced. */
  "volli:automation-cancel-pending-armed-run": {
    args: [input: PendingArmedRunCancelInput];
    result: PendingArmedRunCancelResult;
  };
  /** Retries one expired arrival with the Run command id main retained for it. */
  "volli:automation-retry-pending-armed-run": {
    args: [input: PendingArmedRunRetryInput];
    result: PendingArmedRunRetryResult;
  };
  /**
   * Every due time this project's schedules missed, newest first (VC-130).
   *
   * A read of its own beside `volli:automation-runs-for-project`, because a
   * skip and a Run are different records with different actions — a Run opens
   * its Session, a skip offers to start one. The page interleaves them by time;
   * merging them on the wire would need a discriminant nothing else wants.
   */
  "volli:automation-skips-for-project": {
    args: [input: ProjectIdInput];
    result: AutomationSkipsResult;
  };
  /**
   * Runs an Automation against the PROJECT: one fresh Board Session, one Run
   * row naming no Ticket. The schedule's own Target, reachable by hand so a
   * Skipped occurrence is recoverable (VC-112).
   */
  "volli:automation-run-for-project": {
    args: [input: AutomationRunForProjectInput];
    result: AutomationRunStartResult;
  };
}

export type AutomationIpcChannel = keyof VolliAutomationIpcContract;

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
  /**
   * Types one Volli-offered command into a live session's shell and resolves
   * when it finishes. Stays pending for as long as the command runs — an
   * install is slow, and the point of the channel is the outcome (VC-156).
   */
  "volli:terminal-run": {
    args: [sessionId: string, command: string];
    result: TerminalCommandResult;
  };
  /** Reads the user's resolved Ghostty config as the renderer's terminal appearance. */
  "volli:ghostty-config-get": { args: []; result: GhosttyConfigResult };
}

// ---- self-update UI (VC-59, atop VC-24's silent updater) -------------------

/**
 * Where the updater is in its check→download→install lifecycle, as the
 * renderer's download icon renders it. `idle` covers both "never checked" and
 * "checked, up to date" — either way there is nothing to show or do beyond
 * offering a manual check.
 */
export type UpdatePhase = "idle" | "checking" | "downloading" | "downloaded" | "error";

/**
 * The updater's whole user-facing state (VC-59): one snapshot the renderer
 * can render truthfully at any moment, pushed on every transition over
 * `volli:update-state` and readable on demand via `volli:update-state-get`.
 */
export interface UpdateUiState {
  /**
   * False on a dev run (`!app.isPackaged`, matching the updater's own dev
   * guard) — the renderer hides the whole update surface: `pnpm start` has no
   * app-update.yml and nothing meaningful to install.
   */
  supported: boolean;
  phase: UpdatePhase;
  /** The running build's version — the "from" of any update on offer. */
  currentVersion: string;
  /** The version being downloaded / ready to install; null when none is known. */
  targetVersion: string | null;
  /** Download progress 0–100 while `downloading`; null otherwise. */
  percent: number | null;
  /** The last failure's message while `error`; null otherwise. */
  error: string | null;
}

export type UpdateStateResult = Result<{ state: UpdateUiState }>;

/**
 * The release line an install follows. `stable` sees full releases only;
 * `canary` also sees the prerelease-tagged builds electron-builder marks as
 * GitHub pre-releases.
 *
 * One-way by construction, and that is a property of the underlying toggle
 * rather than of this type: `canary` FORCES prereleases on, while `stable`
 * leaves electron-updater's own per-install default in place. Forcing stable
 * onto a canary install would strand it reading a `releases/latest` feed that
 * 404s while only prereleases exist — see `main/auto-update.ts`.
 */
export type UpdateChannel = "stable" | "canary";

export type UpdateChannelResult = Result<{ channel: UpdateChannel }>;

/**
 * What the explicit-install dialog counts before it may promise a restart
 * (`volli:update-live-work`): the dialog is the ONE prompt on the install path
 * — the native gates behind it stand down — so it must carry the whole warning
 * itself. Three surfaces, counted and named separately, because collapsing
 * them into one "live sessions" number would mean something different here
 * than in the confirms this dialog replaces.
 */
export type UpdateLiveWorkResult = Result<{
  /** The foreground process of each busy PTY (`ptyManager.busySessions()`) — the same input both native gates read. */
  busyCommands: string[];
  /** Open structured agent Sessions — turns open right now, a plane that outlives any one PTY. */
  openAgentSessions: number;
  /**
   * Running background shells (VC-577) — a dev server a turn started. Counted
   * only with the `cloud` flag on, from the host's live work; 0 otherwise.
   */
  backgroundShells: number;
  /** Display names of editor tabs holding unsaved drafts — the one thing a restart destroys unrecoverably. */
  unsavedDrafts: string[];
}>;

/**
 * The self-update door (VC-59): how the sidebar's download icon drives the
 * VC-24 updater. Deliberately NOT session-rpc: that edge requires a live
 * SessionRuntime, which is null exactly when the db is broken — and a broken
 * db must not strand the install on a stale build (an update may be what
 * fixes it). These channels ride the same guarded invoke surface the
 * retention watch uses.
 */
export interface VolliUpdateIpcContract {
  /** The updater's current snapshot — what a freshly-opened renderer primes its store from. */
  "volli:update-state-get": { args: []; result: UpdateStateResult };
  /** Fire-and-forget explicit check (the idle icon's click); outcomes arrive as `volli:update-state` pushes. */
  "volli:update-check": { args: []; result: Result };
  /** The confirmed install: raises the quit latch, then `quitAndInstall()` — refused unless a download is staged. */
  "volli:update-install": { args: []; result: Result };
  /** The live work the install dialog must name before promising a restart. */
  "volli:update-live-work": { args: []; result: UpdateLiveWorkResult };
  /** Which release line this install follows (VC-111) — replaces the hand-run `sqlite3` INSERT. */
  "volli:update-channel-get": { args: []; result: UpdateChannelResult };
  /** Moves this install between release lines; takes effect on the next check. */
  "volli:update-channel-set": {
    args: [channel: UpdateChannel];
    result: UpdateChannelResult;
  };
}

export type UpdateIpcChannel = keyof VolliUpdateIpcContract;

/**
 * The native Session tRPC edge (`src/main/session-rpc-ipc.ts`): ONE invoke
 * channel carrying every routed procedure, because the router — not this
 * contract — is where a Session procedure's input and output are declared.
 * The wire shapes are the router-generic bridge's (`@volli/host-protocol/ipc`,
 * VC-608); the renderer's terminating tRPC link is the only thing that should
 * ever speak them directly.
 */
export interface VolliSessionRpcIpcContract {
  /** Runs one served procedure; a subscription acknowledges with a subscription id instead. */
  "volli:session-rpc": { args: [request: IpcRequest]; result: IpcResponse };
}

/**
 * The send-based channels (`ipcRenderer.send`, not `invoke`) — declared
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
  // Send-based (ipcRenderer.send, not invoke): what this window is showing
  // right now (VC-295), so main can suppress a native alert for a target the
  // person is already looking at. It flips on every nav, needs no reply, and
  // main's copy is advisory — a report that never arrives costs a duplicate
  // alert, which is the harmless direction.
  "volli:notification-active-target": { args: [target: NotificationTarget | null] };
  // Send-based (ipcRenderer.send, not invoke): visibility flips on every board
  // ⇄ session nav, needs no reply, and round-tripping an invoke per flip would
  // add latency to navigation for nothing.
  "volli:terminal-set-visible": { args: [sessionId: string, visible: boolean] };
  // Send-based (ipcRenderer.send, not invoke): main answers a cancellation by
  // stopping the frames, which the renderer is already listening for — an ack
  // would only be a second way to learn the same thing, later.
  "volli:session-rpc-cancel": { args: [subscriptionId: string] };
  // Send-based (ipcRenderer.send, not invoke): a renderer warning or error
  // for main's log (VC-699). Nobody waits on a log line, and an invoke per
  // line would put a round-trip on the path of whatever is failing.
  "volli:renderer-log": { args: [entry: RendererLogEntry] };
  // Send-based (ipcRenderer.send, not invoke): the renderer's answer to a
  // `volli:client-state-flush` push (VC-577) — every pending client-local
  // write it held has been acknowledged by main. Main asked, so main is the
  // one waiting; an invoke from the renderer would have no question to answer.
  "volli:client-state-flushed": { args: [requestId: string] };
}

/**
 * Pi session-log orphan cleanup has its own main-process seam. It is separate
 * from worktree cleanup: scanning is read-only, and only the second, confirmed
 * call can unlink files that main itself proposed in the named revision.
 */
export interface VolliPiSessionOrphanIpcContract {
  "volli:pi-session-orphans-scan": { args: []; result: PiSessionOrphanScanResult };
  "volli:pi-session-orphans-reclaim": {
    args: [input: PiSessionOrphanReclaimInput];
    result: PiSessionOrphanReclaimResult;
  };
}

export type PiSessionOrphanIpcChannel = keyof VolliPiSessionOrphanIpcContract;

/**
 * The orphan PROCESS sweep (VC-341), separate from both of the above for the
 * same reason they are separate from each other: scanning is read-only, and
 * only a second call, naming the revision it was shown under, may signal
 * anything. The policy door is a third channel because turning automatic
 * reaping on is a preference, not a scan and not a kill.
 */
export interface VolliOrphanProcessIpcContract {
  "volli:orphan-processes-scan": { args: []; result: OrphanProcessScanResult };
  "volli:orphan-processes-reap": {
    args: [input: OrphanProcessReapInput];
    result: OrphanProcessReapResult;
  };
  "volli:orphan-processes-policy": {
    args: [policy: AutoReapPolicy];
    result: OrphanProcessPolicyResult;
  };
}

export type OrphanProcessIpcChannel = keyof VolliOrphanProcessIpcContract;

export type DatabaseRecoveryListResult = Result<{ backups: DatabaseSafetyCopy[] }>;
export type DatabaseRecoveryRestoreResult = Result<{ restoredBackup: string }>;

/**
 * Why the database failed to open, as far as the recovery screen needs to
 * know: `newer-version` names the "database is from a newer Volli" variant
 * (VC-602); everything else is `unreadable`.
 */
export type DatabaseOpenFault = "unreadable" | "newer-version";
export type DatabaseRecoveryFaultResult = Result<{ fault: DatabaseOpenFault }>;

export interface VolliDatabaseRecoveryIpcContract {
  "volli:database-recovery-list": { args: []; result: DatabaseRecoveryListResult };
  "volli:database-recovery-restore": { args: []; result: DatabaseRecoveryRestoreResult };
  "volli:database-recovery-fault": { args: []; result: DatabaseRecoveryFaultResult };
  /** Quits Volli from the recovery screen; only while the database is unavailable. */
  "volli:database-recovery-quit": { args: []; result: Result };
}

/** Person-only credentials: a dedicated handler group, never generic data or Session IPC. */
export interface VolliSecretIpcContract {
  "volli:secrets-list": { args: [projectId?: string]; result: SecretsResult };
  "volli:secret-submit": { args: [input: SecretSubmitInput]; result: Result };
  "volli:secret-decline": { args: [id: string]; result: Result };
  "volli:secret-revoke": { args: [id: string]; result: Result };
  "volli:secret-replace": { args: [input: SecretReplaceInput]; result: Result };
  /** Tries locked stored secrets again (VC-641). */
  "volli:secrets-unlock": { args: []; result: CredentialsResult };
  /** Sets locked stored secrets aside, kept, and starts empty (VC-641). */
  "volli:secrets-reset": { args: []; result: CredentialsResult };
}

export type SecretIpcChannel = keyof VolliSecretIpcContract;

/** Every invoke channel with a contract entry — the full catalog. */
export interface VolliInvokeContract
  extends
    VolliDataIpcContract,
    VolliDatabaseRecoveryIpcContract,
    VolliSecretIpcContract,
    VolliPiSessionOrphanIpcContract,
    VolliOrphanProcessIpcContract,
    VolliFileIpcContract,
    VolliHarnessIpcContract,
    VolliCliIpcContract,
    VolliThemeIpcContract,
    VolliModelAccessIpcContract,
    VolliWebAccessIpcContract,
    VolliDecisionModelIpcContract,
    VolliAgentObservabilityIpcContract,
    VolliBrowserIpcContract,
    VolliShellIpcContract,
    VolliAutomationIpcContract,
    VolliSessionRpcIpcContract,
    VolliSupportIpcContract,
    VolliSystemIpcContract,
    VolliNotificationIpcContract,
    VolliUpdateIpcContract {}

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
  // Main is about to destroy this window without an unload (VC-577: menu-bar
  // mode, after the quit's confirms already answered), so `beforeunload` will
  // not flush the debounced client-local writes. The renderer sends them now
  // and answers `volli:client-state-flushed` with the request id once main
  // has acknowledged every one; main waits for that, bounded, then destroys.
  | "volli:client-state-flush"
  | "volli:browser-tab-state"
  // A background shell started, exited, or was forgotten with its Session's
  // attachment (VC-270): one push, one store, the island's shell feed.
  | "volli:shell-state"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:terminal-park-state"
  | "volli:ghostty-config-changed"
  | "volli:data-changed"
  // Main owns one durable armed-column countdown projection. Every window
  // receives the same whole snapshot, and settlement is announced separately
  // so renderer surfaces can react without owning the timer that decided it.
  | "volli:pending-armed-runs-changed"
  | "volli:pending-armed-run-settled"
  // Backward-move interrupt announcement (issue #78, CONCEPT #20): fired after
  // a ticket move out of the active columns actually Esc'd live agent sessions,
  // so every window can surface the automated de-escalation where the mover is
  // looking (a toast with a jump-to-ticket action) — never silently.
  | "volli:sessions-interrupted"
  // A Session was retitled by main rather than by a person (VC-81's auto-title
  // model call). Every other retitle originates in the renderer, which moves
  // its own labels optimistically; this one has no such writer, and
  // `session.retitle` goes straight to the ledger WITHOUT the runtime publish
  // (see chat/rename.ts), so nothing on screen would learn the title changed
  // until an unrelated refresh. The durable write is still the truth — this
  // only tells the windows to catch up.
  | "volli:session-retitled"
  // A native alert was clicked (VC-295). Main has already brought the window
  // forward; the payload is the alert's target, and routing to it — selecting
  // the Session, then revealing the question or failure it named, or saying so
  // when that item has since resolved — is the renderer's own knowledge. Sent
  // to ONE window (the focused one, or the first live one), not fanned out:
  // this is a navigation, and two windows obeying it would be two places the
  // person did not ask to go.
  | "volli:notification-activated"
  // Settings → Notifications moved (VC-295): a switch was written, or a delivery
  // Electron reported as failed landed or was retired by a later one that
  // showed. The payload is the WHOLE `NotificationSettingsView`, never a delta,
  // so a page that missed an earlier push is whole again on the next one. Every
  // window, because a failure is a machine fact and a page open in two windows
  // must not disagree about it.
  | "volli:notification-settings"
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
  // One Session's listing row, re-derived because its durable history moved —
  // see {@link SessionActivityNotice}. This is the PUSH channel that replaced
  // the ten-second `volli:session-list` poll every Session listing used to
  // run: a turn opening, a question being asked, an attachment closing and a
  // retitle all reach the sidebar and the board on the same frame main learns
  // them, instead of within ten seconds of it.
  | "volli:session-activity"
  // Ordered frames for one live Session RPC subscription — see
  // `IpcEvent` (`@volli/host-protocol/ipc`). Every subscription shares this channel and is
  // told apart by the id main acknowledged the request with.
  | "volli:session-rpc-event"
  // The updater's user-facing state changed (VC-59) — one full {@link
  // UpdateUiState} snapshot per transition, fanned out from broadcast.ts so
  // the sidebar icon in every window renders the same truth. The renderer
  // still primes itself with `volli:update-state-get` on boot: a download
  // that finished before this window existed must still light the badge.
  | "volli:update-state"
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
 * What main announces to every window, as domain vocabulary (VC-554). The
 * payloads live in `@volli/shared` (`host-events.ts`) so host-core's event bus
 * can name them; the channels that carry them stay here.
 */
export type {
  AutomationRunStartResult,
  DataChangeKind,
  DataChangedEvent,
  HarnessEventNotice,
  PendingArmedRunSettledNotice,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionRetitledEvent,
  SessionStartedNotice,
  SessionsInterruptedEvent,
  WorktreePhase,
  WorktreePhaseEvent,
};

export type { TicketMovedNotice } from "@volli/shared";

/**
 * The app-owned database actions. `undefined` reads its size; neither action
 * accepts a renderer-supplied path.
 */
export type DatabaseAction = "reveal" | "export";

/** The database's on-disk size, returned after a read or action. */
export type DatabaseResult = Result<{ sizeBytes: number }>;

/**
 * What one attach produced (VC-50). `relPath` is present when the file was
 * named live as an `@` ref; `blob` when bytes were stored. A repository image
 * carries both.
 */
export type BlobAttachResult = Result<{
  relPath: string | null;
  blob: BlobLinkView | null;
}>;

export type BlobLinksResult = Result<{ blobs: BlobLinkView[] }>;

/**
 * The links behind a Session's materialized `.volli/attachments/` directory, in
 * the order the names are derived from. Pair with `materializedBlobNames` (or
 * `attachmentHashesByName`) to learn what each file on disk is called.
 */
export type BlobMaterializedResult = Result<{ links: NamedBlobLink[] }>;

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

/**
 * One project's live board — the read a targeted `volli:data-changed` makes
 * instead of re-reading every project (VC-387). The rows are
 * {@link TicketSummary}: bodies are ~90% of a board's bytes (measured: 1056 KiB
 * of payload becomes 123 KiB without them) and no board surface renders one, so
 * a body rides in once on the boot payload and after that only the OPEN ticket
 * reads its own through {@link TicketBodyResult}.
 *
 * `labels` is the project's label set, which a label rename/retire moves in step
 * with the tickets that carry it, so the two travel together exactly as they do
 * in the boot payload.
 */
export type ProjectRosterResult = Result<{ tickets: TicketSummary[]; labels: Label[] }>;

/** One ticket's Markdown body — what the roster no longer carries (VC-387). */
export type TicketBodyResult = Result<{ body: string }>;

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

/**
 * A committed relink, plus what the move could not take with it (VC-430).
 *
 * The AFTERMATH travels, not the sentences derived from it: the renderer turns
 * it into notices through `@volli/shared`'s `projectRelinkNotices`, so the
 * facts main measured and the words a person reads cannot drift apart. A
 * refusal carries the shared `ProjectRelinkRefusal` id beside its sentence, so
 * a surface may react to WHICH refusal it was without matching on prose.
 */
export type ProjectRelinkResult =
  | { ok: true; project: Project; aftermath: ProjectRelinkAftermath }
  | { ok: false; error: string; refusal?: ProjectRelinkRefusal };

/** Whether a project's registered folder is still on disk (VC-430). */
export type ProjectFolderResult =
  | { ok: true; path: string; state: ProjectFolderState }
  | { ok: false; error: string };

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

/**
 * A person's own read decision (VC-30): `U`, the context menu, opening a
 * Session, or answering it from a peek card.
 *
 * `unread: true` stamps it as of main's clock rather than the caller's — the
 * receipt is main's record and a renderer clock never writes into it.
 */
export interface SessionReadSetInput {
  sessionId: string;
  unread: boolean;
}

/**
 * What the receipt says after the write. The caller already moved its row
 * optimistically; this is what it reverts to if the write failed, and the
 * authoritative row follows on `volli:session-activity` for every other window.
 */
export type SessionReadSetResult = Result<{ read: SessionReadState }>;

/** One peek's fold (VC-30). How much it holds is `SESSION_PEEK_ENTRIES`, not the caller's to pick. */
export interface SessionPeekContentInput {
  sessionId: string;
  /** Explicit summary demand. Absent/false reads local content without model work. */
  refine?: boolean;
}

/**
 * What a peek card draws, or `null` for a Session the ledger no longer has.
 *
 * A pull with no subscription behind it: hovering a row must not adopt a
 * Session or open a stream (see `packages/host-core/src/session-control/peek-content.ts`).
 */
export type SessionPeekContentResult = Result<{ content: SessionPeekContent | null }>;

/** Session creation stamps in the requested window, ascending — every project's. */
export type SessionStartsResult = Result<{ startedAt: number[] }>;

/**
 * One usage rollup (`usage-report`): a total, its optional breakdown, and the
 * metered-Session count that keeps an honest gap visible.
 */
export type UsageReportResult = Result<{ report: SessionUsageReport }>;

/**
 * One venue reading (`venue-snapshot`); the error arm carries git's own message.
 *
 * The success arm is a {@link VenueReading} rather than a snapshot because
 * "there is no checkout to measure yet" is an ANSWER, not a failure (VC-286):
 * a ticket whose isolated worktree has not materialised has no venue, and
 * saying so is what stops a surface from drawing the main checkout in its place.
 */
export type VenueSnapshotResult = Result<{ reading: VenueReading }>;

// ---- global artifacts + @file refs -----------------------------------------

/**
 * The file index the `@` picker and quick-open rank over — returned by
 * `volli:file-index`. Built fresh on each picker open from `git ls-files`
 * (gitignore-respecting) in the scope's checkout, plus a walk of Main's
 * `.volli/artifacts/`; `truncated` is set when the ~20k entry cap was hit.
 */
export type FileIndexResult = Result<{ files: IndexedFile[]; truncated: boolean }>;

/** The installed subset of the allowlisted editor and terminal catalogue. */
export type ExternalAppListResult = Result<{ apps: ExternalApp[] }>;

/**
 * A new `/command` (VC-111). `scope` picks which of the two directories the
 * reader already merges it lands in — the same choice the Commands table's
 * Source column reports back.
 */
export interface PromptTemplateCreateInput {
  projectId: string;
  scope: "project" | "personal";
  name: string;
  description: string;
  body: string;
}

/**
 * Where the template landed. The path is returned so the surface can offer to
 * reveal the file it just made — the file, not this dialog, is the real
 * interface to a command.
 */
export type PromptTemplateCreateResult = Result<{ path: string }>;

/** The composer's `/` picker is project-scoped, exactly like the file index. */
export interface PromptTemplateIndexInput {
  projectId: string;
  /**
   * Apply this project's skill rules (`skill_modes`) to the returned skills.
   * The default, and what the composer wants: an `off` skill must not be
   * offered. The Skills pane passes `false`, because it EDITS the rules and
   * so must see every installed skill — under the ruled read, a skill set to
   * `off` vanished from the one surface that could turn it back on.
   */
  ruled?: boolean;
}

/**
 * Everything the composer's `/` picker can offer — returned by
 * `volli:prompt-templates`: the prompt templates, already merged (project over
 * global) and sorted, and the project's skills (`.agents/skills/<slug>/SKILL.md`),
 * shadowed names not yet resolved — that is the renderer's
 * `resolveSlashNamespace` call, beside the ranking that consumes it.
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

// ---- find across files (plan §4.7) ----------------------------------------

// ---- ticket worktrees ------------------------------------------------------

// Service vocabulary lives in @volli/shared; the Electron channels stay here.
export type {
  WorktreeChangedEvent,
  WorktreeWatchErrorEvent,
  WorktreeBranchListing,
  DirtyWorktreeOrphan,
  RemovableWorktreeOrphan,
  KeptWorktreeOrphan,
  PrunableWorktreeMetadata,
  KeptWorktreeMetadata,
  UnreadableWorktreeProject,
  WorktreeTrimRemoval,
  WorktreeTrimKeep,
  WorktreeTrimReport,
  WorktreeTrimScanEntry,
  WorktreeTrimSweepReport,
  WorktreeTrimSettings,
  WorktreeTrimSettingsInput,
  WorktreeDiffMode,
  PrCheckState,
  PrCheck,
  TicketRetentionState,
} from "@volli/shared";

/** Where a worktree dir stands relative to what git knows — the live half of worktree state. */
export type WorktreeDiskState = "present" | "missing" | "unregistered";

/** Ack for a `volli:worktree-remove` (the "Remove worktree…" escape hatch). */
export type WorktreeRemoveResult = Result;

/** A project's branch refs — returned by `volli:worktree-branches` for the base-branch pickers. */
export type WorktreeBranchesResult = Result<WorktreeBranchListing>;

/**
 * The orphan scan/cleanup DOMAIN vocabulary is `@volli/shared`'s (VC-284
 * review S1): the run projection, its item states, the acceptance receipt and
 * the rejection codes describe the act itself, not the wire it crosses, so the
 * core that mints and folds them never imports this catalog. They are
 * re-exported here because every desktop process reads the channel types from
 * this one file.
 */
export type {
  OrphanAgeBasis,
  OrphanCleanupItem,
  OrphanCleanupItemKind,
  OrphanCleanupItemState,
  OrphanCleanupReceipt,
  OrphanCleanupRejectionCode,
  OrphanCleanupRun,
  OrphanCleanupSource,
  OrphanKeptReason,
  OrphanMetadataKeptReason,
};

/**
 * A `volli:worktree-orphans` SCAN report (VC-284): read-only by construction.
 * It names what a cleanup would remove, the metadata it would prune, what it
 * keeps and why, the retention window those verdicts came from, and the
 * cleanup history that lets Storage label past removals truthfully.
 */
export type WorktreeOrphansResult = Result<{
  /** The opaque revision a cleanup command must name to act on this proposal. */
  revision: string;
  scannedAt: number;
  retentionDays: number;
  prunable: PrunableWorktreeMetadata[];
  removable: RemovableWorktreeOrphan[];
  keptRecent: KeptWorktreeOrphan[];
  keptMetadata: KeptWorktreeMetadata[];
  unreadableProjects: UnreadableWorktreeProject[];
  dirty: DirtyWorktreeOrphan[];
  runs: OrphanCleanupRun[];
}>;

/**
 * Ack for a `volli:worktree-orphan-cleanup` — the confirmed, destructive half
 * of the Storage pane. It answers with the local acceptance receipt and the
 * durable run, so the caller shows exactly what was removed, what was skipped,
 * what failed, and why. A refusal carries a code, because "scan again" and
 * "this already ran" are different recoveries.
 */
export type WorktreeOrphanCleanupResult =
  | { ok: true; receipt: OrphanCleanupReceipt; run: OrphanCleanupRun }
  | { ok: false; error: string; code: OrphanCleanupRejectionCode };

/**
 * Ack for a `volli:worktree-orphan-delete` — the Settings list's explicit,
 * user-confirmed deletion of a dirty orphan dir. Main re-validates the path
 * lives inside a container this database owns before touching anything.
 */
export type WorktreeOrphanDeleteResult = Result;

// ---- worktree trim (VC-340) ------------------------------------------------

/** The scan behind Settings → Storage → Build artifacts. Reads only; never removes. */
export type WorktreeTrimScanResult = Result<{ worktrees: WorktreeTrimScanEntry[] }>;

/** Ack for `volli:worktree-trim` — the sweep report the Settings action renders. */
export type WorktreeTrimResult = Result<{ report: WorktreeTrimSweepReport }>;

/** The trim settings — returned by `volli:worktree-trim-settings-get`/`-set`. */
export type WorktreeTrimSettingsResult = Result<{ settings: WorktreeTrimSettings }>;

export type PiSessionOrphanScanResult = Result<{ inventory: PiSessionOrphanInventory }>;
export type PiSessionOrphanReclaimResult = Result<{ report: PiSessionOrphanReclaimReport }>;

export type OrphanProcessScanResult = Result<{
  inventory: OrphanProcessInventory;
  policy: AutoReapPolicy;
}>;
export type OrphanProcessReapResult = Result<{ report: OrphanProcessReapReport }>;
export type OrphanProcessPolicyResult = Result<{ policy: AutoReapPolicy }>;

/**
 * A `volli:worktree-recreate` ack (VC-113): the path the checkout was put back
 * at. The branch is unchanged — recreating is a re-materialization of the same
 * identity, never a new one.
 */
export type WorktreeRecreateResult = Result<{ worktreePath: string }>;

// ---- Done flow -------------------------------------------------------------

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
