/**
 * The Volli Cloud schema: every table, its validators and its indexes.
 *
 * Conventions (see `SCHEMA-NOTES.md` for the full list and the deviations
 * from the data-model sketch):
 * - Every entity has an `id`: our lowercase UUID, minted by its originator and
 *   checked by the writing mutation. References between tables are these
 *   strings. Convex `_id`s never leave `convex/`. Each entity table has a
 *   `by_uuid` index (Convex reserves `by_id`); 1:1 side tables are keyed by
 *   their owner's id.
 * - Uniqueness ("unique by mutation") is enforced by the writing mutation
 *   with an index lookup; Convex has no unique constraint.
 * - High-volume rows carry `projectId`, never `workspaceId`, so a project can
 *   move Workspace in a handful of writes. Usage and billing rows are the
 *   exception: they keep the Workspace the spend happened in.
 * - Hot fields (counters, presence, credentials, intake cursors, heartbeats,
 *   ticket bodies) live in their own small documents so list subscriptions do
 *   not re-run when they change.
 * - `json` fields are validated by a shared codec inside the mutation.
 *
 * This file is validators and indexes only. Functions live in their own
 * modules, one area per file.
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  BOARD_EVENT_KINDS,
  CHECKOUT_MODES,
  JOB_KINDS,
  JOB_PRIORITIES,
  JOB_STATUSES,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  RUNNER_INSTALL_MODES,
  RUNNER_KINDS,
  RUNNER_LINK_METHODS,
  RUNNER_LOCAL_CREDENTIAL_KINDS,
  RUNNER_STATUSES,
  SECRET_EXPOSURES,
  SECRET_KINDS,
  SESSION_VISIBILITIES,
  SESSION_VISIBILITY_REASONS,
  TICKET_LINK_KINDS,
  TICKET_PRIORITIES,
  TICKET_SIGNAL_KINDS,
  TICKET_SIGNAL_VERDICTS,
  TICKET_STATUSES,
  WHO_CAN_INVITE,
  WORKING_COPY_STATES,
} from "@volli/shared/cloud";

import { actor, deletion, json, literals, nullable, sealed, time, uuid } from "./lib/validators";

const ticketStatus = literals(TICKET_STATUSES);
const memberRole = literals(MEMBER_ROLES);
const configLevel = literals(["personal", "workspace", "project"]);
const blobRow = {
  sha256: v.string(),
  mime: v.string(),
  sizeBytes: v.number(),
  originalName: v.string(),
  width: nullable(v.number()),
  height: nullable(v.number()),
  key: v.string(),
  uploadedBy: actor,
  createdAt: time,
};

export default defineSchema({
  // ── identity ───────────────────────────────────────────────────────────────
  users: defineTable({
    id: uuid,
    // Nullable because a purge nulls PII and keeps the row as a tombstone.
    primaryEmail: nullable(v.string()),
    emailVerified: v.boolean(),
    displayName: v.string(),
    avatarKey: nullable(v.string()),
    status: literals(["active", "deletion_pending", "deleted"]),
    deletionRequestedAt: nullable(time),
    purgeAfter: nullable(time),
    trialSeededWorkspaceId: nullable(uuid),
    createdAt: time,
    lastSeenAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_email", ["primaryEmail"]),
  authIdentities: defineTable({
    userId: uuid,
    issuer: v.string(),
    subject: v.string(),
    tokenIdentifier: v.string(),
    createdAt: time,
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_user", ["userId"]),
  externalAccounts: defineTable({
    userId: uuid,
    provider: literals(["github", "google"]),
    providerUserId: v.string(),
    login: nullable(v.string()),
    email: nullable(v.string()),
    linkedAt: time,
  })
    .index("by_provider_user", ["provider", "providerUserId"])
    .index("by_user", ["userId"]),
  clientSessions: defineTable({
    userId: uuid,
    providerSessionId: v.string(),
    clientKind: literals(["desktop", "web", "phone", "cli"]),
    label: v.string(),
    lastSeenAt: time,
    revokedAt: nullable(time),
  })
    .index("by_user", ["userId"])
    .index("by_provider_session", ["providerSessionId"]),
  githubConnections: defineTable({
    userId: uuid,
    githubUserId: v.string(),
    accessToken: sealed,
    refreshToken: sealed,
    accessExpiresAt: time,
    refreshExpiresAt: time,
    revokedAt: nullable(time),
  }).index("by_user", ["userId"]),
  userPrefs: defineTable({
    userId: uuid,
    defaultRunnerId: nullable(uuid),
    notification: nullable(json),
    modelPickerView: nullable(json),
    railOrder: nullable(json),
  }).index("by_user", ["userId"]),

  // ── Workspaces and Members ─────────────────────────────────────────────────
  workspaces: defineTable({
    id: uuid,
    name: v.string(),
    slug: v.string(),
    iconKey: nullable(v.string()),
    createdByUserId: uuid,
    planKey: v.string(),
    activeMemberCount: v.number(),
    ssoOrganizationId: v.optional(v.string()),
    overage: v.optional(v.object({ enabled: v.boolean(), capHours: v.number() })),
    createdAt: time,
    ...deletion,
  })
    .index("by_uuid", ["id"])
    .index("by_slug", ["slug"]),
  workspaceMembers: defineTable({
    id: uuid,
    workspaceId: uuid,
    userId: uuid,
    role: memberRole,
    status: literals(MEMBER_STATUSES),
    // Open set: "free" | "team" in 0.3.
    billingTier: v.string(),
    joinedAt: time,
    suspendedAt: nullable(time),
    leftAt: nullable(time),
    invitedByUserId: nullable(uuid),
  })
    .index("by_uuid", ["id"])
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_user", ["userId"])
    .index("by_workspace_status", ["workspaceId", "status"]),
  workspaceInvites: defineTable({
    id: uuid,
    workspaceId: uuid,
    // Normalized; null for a link invite, which anyone signed in may accept once.
    email: nullable(v.string()),
    role: memberRole,
    invitedByUserId: uuid,
    tokenHash: v.string(),
    expiresAt: time,
    acceptedByUserId: nullable(uuid),
    acceptedAt: nullable(time),
    revokedAt: nullable(time),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_token", ["tokenHash"])
    .index("by_workspace_email", ["workspaceId", "email"])
    .index("by_email", ["email"]),
  workspacePolicies: defineTable({
    workspaceId: uuid,
    shareAll: v.boolean(),
    whoCanInvite: literals(WHO_CAN_INVITE),
    revision: v.number(),
    updatedByUserId: uuid,
    updatedAt: time,
    // 1.0 slots: allow-lists, model policy, commit-author policy, retention.
    slots: v.optional(json),
  }).index("by_workspace", ["workspaceId"]),
  githubInstallations: defineTable({
    id: uuid,
    workspaceId: uuid,
    installationId: v.string(),
    accountLogin: v.string(),
    accountType: literals(["user", "org"]),
    repositorySelection: literals(["all", "selected"]),
    installedByUserId: uuid,
    suspendedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_installation", ["installationId"])
    .index("by_workspace", ["workspaceId"]),

  // ── projects ───────────────────────────────────────────────────────────────
  projects: defineTable({
    id: uuid,
    // The only mutable owner pointer: a project move patches this and nothing else.
    workspaceId: uuid,
    name: v.string(),
    description: v.string(),
    iconKey: nullable(v.string()),
    colorIndex: v.number(),
    // Fixed for the project's life (ticket keys survive moves).
    ticketPrefix: v.string(),
    // `blank`: made empty in a Workspace, before it has a repository (VC-889).
    origin: literals(["github", "promoted_local", "migrated", "blank"]),
    shipBehaviour: literals(["commit", "push", "pr", "custom"]),
    customShipPrompt: nullable(v.string()),
    coAuthorDefault: v.boolean(),
    cloudSize: v.optional(v.string()),
    countsTowardCap: v.boolean(),
    createdByUserId: uuid,
    createdAt: time,
    updatedAt: time,
    archivedAt: nullable(time),
    ...deletion,
  })
    .index("by_uuid", ["id"])
    .index("by_workspace", ["workspaceId", "deletedAt", "name"])
    // Not unique: a move or a migration may bring in a duplicate prefix.
    .index("by_workspace_prefix", ["workspaceId", "ticketPrefix"]),
  projectCounters: defineTable({
    projectId: uuid,
    nextTicketNumber: v.number(),
    boardSeq: v.number(),
  }).index("by_project", ["projectId"]),
  projectRepos: defineTable({
    id: uuid,
    projectId: uuid,
    role: literals(["primary", "additional"]),
    position: v.string(),
    provider: literals(["github", "none"]),
    githubRepoId: nullable(v.string()),
    installationId: nullable(v.string()),
    owner: nullable(v.string()),
    name: v.string(),
    baseBranch: nullable(v.string()),
    defaultBranchCache: nullable(v.string()),
    dirName: v.string(),
  })
    .index("by_uuid", ["id"])
    .index("by_project", ["projectId", "position"]),
  projectMoves: defineTable({
    id: uuid,
    projectId: uuid,
    fromWorkspaceId: uuid,
    toWorkspaceId: uuid,
    movedByUserId: uuid,
    movedAt: time,
    commandId: uuid,
  })
    .index("by_uuid", ["id"])
    .index("by_project", ["projectId", "movedAt"]),
  projectEnvironment: defineTable({
    projectId: uuid,
    storedSetup: nullable(v.string()),
    storedResume: nullable(v.string()),
    storedSetupMode: literals(["script", "legacy_command"]),
    revision: v.number(),
    setupTimeoutSec: v.number(),
    resumeWaitSec: v.number(),
    runsOn: v.array(literals(["mac", "linux", "cloud"])),
    requiresOs: literals(["any", "macos", "linux"]),
  }).index("by_project", ["projectId"]),
  recipeStatus: defineTable({
    projectRepoId: uuid,
    ref: v.string(),
    commitSha: v.string(),
    setupBlobSha: nullable(v.string()),
    resumeBlobSha: nullable(v.string()),
    checkedAt: time,
  }).index("by_repo_ref", ["projectRepoId", "ref"]),
  memberProjectPrefs: defineTable({
    userId: uuid,
    projectId: uuid,
    commitEmail: nullable(v.string()),
    coAuthor: nullable(v.boolean()),
    railPosition: v.string(),
    themeCanvas: nullable(json),
    themeAppearance: nullable(v.string()),
  })
    .index("by_user_project", ["userId", "projectId"])
    .index("by_project", ["projectId"]),

  // ── board ──────────────────────────────────────────────────────────────────
  tickets: defineTable({
    id: uuid,
    projectId: uuid,
    number: v.number(),
    title: v.string(),
    status: ticketStatus,
    priority: literals(TICKET_PRIORITIES),
    // Fractional-index key within the status column (`@volli/shared/cloud` positions).
    position: v.string(),
    labelIds: v.array(uuid),
    assigneeUserId: nullable(uuid),
    checkoutMode: literals(CHECKOUT_MODES),
    preferredHarnessId: v.string(),
    branch: nullable(v.string()),
    baseBranch: nullable(v.string()),
    pullRequests: v.array(
      v.object({
        projectRepoId: nullable(uuid),
        url: v.string(),
        number: nullable(v.number()),
        state: literals(["open", "merged", "closed"]),
        mergedAt: nullable(time),
      }),
    ),
    retentionKeep: v.boolean(),
    placeRunnerId: nullable(uuid),
    createdBy: actor,
    createdAt: time,
    updatedAt: time,
    archivedAt: nullable(time),
    ...deletion,
  })
    .index("by_uuid", ["id"])
    .index("by_project_number", ["projectId", "number"])
    .index("by_board", ["projectId", "archivedAt", "status", "position"])
    .index("by_project_archived", ["projectId", "archivedAt"])
    .index("by_assignee", ["assigneeUserId", "status"]),
  ticketBodies: defineTable({
    ticketId: uuid,
    body: v.string(),
    revision: v.number(),
    updatedBy: actor,
    updatedAt: time,
  }).index("by_ticket", ["ticketId"]),
  labels: defineTable({
    id: uuid,
    projectId: uuid,
    name: v.string(),
    nameKey: v.string(),
    color: nullable(v.string()),
    mergedIntoId: nullable(uuid),
    mergedAt: nullable(time),
    mergedBy: nullable(actor),
    createdAt: time,
    updatedAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_project_name_key", ["projectId", "nameKey"]),
  ticketComments: defineTable({
    id: uuid,
    ticketId: uuid,
    projectId: uuid,
    sessionId: nullable(uuid),
    author: actor,
    body: v.string(),
    createdAt: time,
    editedAt: nullable(time),
    deletedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_ticket", ["ticketId", "createdAt"]),
  ticketSignals: defineTable({
    id: uuid,
    ticketId: uuid,
    projectId: uuid,
    sessionId: nullable(uuid),
    actor,
    kind: literals(TICKET_SIGNAL_KINDS),
    verdict: literals(TICKET_SIGNAL_VERDICTS),
    detail: nullable(v.string()),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_ticket_kind", ["ticketId", "kind", "createdAt"]),
  ticketLinks: defineTable({
    id: uuid,
    fromTicketId: uuid,
    toTicketId: uuid,
    kind: literals(TICKET_LINK_KINDS),
    source: literals(["body", "comment", "manual"]),
    createdBy: actor,
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_from", ["fromTicketId"])
    .index("by_to", ["toTicketId"]),
  boardEvents: defineTable({
    id: uuid,
    projectId: uuid,
    ticketId: nullable(uuid),
    // Per-project total order from `projectCounters.boardSeq`.
    seq: v.number(),
    kind: literals(BOARD_EVENT_KINDS),
    actor,
    occurredAt: time,
    payload: json,
  })
    .index("by_uuid", ["id"])
    .index("by_project_seq", ["projectId", "seq"])
    .index("by_ticket_seq", ["ticketId", "seq"]),
  boardReceipts: defineTable({
    commandId: uuid,
    projectId: uuid,
    operation: v.string(),
    intentDigest: v.string(),
    reply: json,
    createdAt: time,
    expiresAt: time,
  })
    .index("by_command", ["commandId"])
    .index("by_expiry", ["expiresAt"]),
  blobs: defineTable({ projectId: uuid, ...blobRow }).index("by_project_sha", [
    "projectId",
    "sha256",
  ]),
  workspaceBlobs: defineTable({ workspaceId: uuid, ...blobRow }).index("by_workspace_sha", [
    "workspaceId",
    "sha256",
  ]),
  userBlobs: defineTable({ userId: uuid, ...blobRow }).index("by_user_sha", ["userId", "sha256"]),
  blobLinks: defineTable({
    id: uuid,
    projectId: uuid,
    sha256: v.string(),
    owner: v.object({ kind: literals(["ticket", "session", "comment"]), id: uuid }),
    label: v.string(),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_owner", ["owner.kind", "owner.id"])
    .index("by_blob", ["projectId", "sha256"]),

  // ── runners and Working copies ─────────────────────────────────────────────
  runners: defineTable({
    id: uuid,
    ownerUserId: uuid,
    kind: literals(RUNNER_KINDS),
    name: v.string(),
    status: literals(RUNNER_STATUSES),
    statusReason: nullable(v.string()),
    statusChangedAt: time,
    version: v.string(),
    platform: v.object({
      os: v.string(),
      distro: nullable(v.string()),
      kernel: nullable(v.string()),
      arch: v.string(),
      glibc: nullable(v.string()),
    }),
    // Versioned capability report (git, docker, terminals, browser, maxConcurrentSessions, …).
    capabilities: json,
    installMode: literals(RUNNER_INSTALL_MODES),
    linkedVia: literals(RUNNER_LINK_METHODS),
    linkedAt: time,
    autoUpdate: v.object({
      enabled: v.boolean(),
      channel: v.string(),
      pinnedVersion: nullable(v.string()),
    }),
    update: nullable(json),
    revokedAt: nullable(time),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_owner_name", ["ownerUserId", "name"])
    .index("by_status", ["status"]),
  // Written every 30 s; never subscribed by clients.
  runnerPresence: defineTable({
    runnerId: uuid,
    lastHeartbeatAt: time,
    bootId: v.string(),
    load: v.object({
      activeSessions: v.number(),
      activeTurns: v.number(),
      queueDepth: v.number(),
      freeDiskMb: v.number(),
      freeMemMb: v.number(),
    }),
    lastIp: nullable(v.string()),
  })
    .index("by_runner", ["runnerId"])
    .index("by_heartbeat", ["lastHeartbeatAt"]),
  runnerCredentials: defineTable({
    runnerId: uuid,
    currentHash: v.string(),
    previousHash: nullable(v.string()),
    currentFirstUsedAt: nullable(time),
    generation: v.number(),
    rotatedAt: time,
    lastUsedAt: time,
    lastUsedIp: nullable(v.string()),
  })
    .index("by_runner", ["runnerId"])
    .index("by_current_hash", ["currentHash"])
    .index("by_previous_hash", ["previousHash"]),
  runnerInstallTokens: defineTable({
    id: uuid,
    tokenHash: v.string(),
    createdByUserId: uuid,
    nameHint: nullable(v.string()),
    defaultWorkspaceId: nullable(uuid),
    expiresAt: time,
    usedAt: nullable(time),
    usedByRunnerId: nullable(uuid),
    revokedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_token", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),
  runnerLinkRequests: defineTable({
    id: uuid,
    userCodeHash: v.string(),
    pollSecretHash: v.string(),
    host: v.object({
      hostname: v.string(),
      os: v.string(),
      distro: nullable(v.string()),
      arch: v.string(),
      ip: nullable(v.string()),
    }),
    status: literals(["pending", "approved", "denied", "expired", "consumed"]),
    approvedByUserId: nullable(uuid),
    runnerId: nullable(uuid),
    expiresAt: time,
    createdAt: time,
    // How the box was installed, so the runner row starts right (added with the link flow).
    installMode: v.optional(literals(RUNNER_INSTALL_MODES)),
  })
    .index("by_uuid", ["id"])
    .index("by_code", ["userCodeHash", "status"])
    .index("by_poll_secret", ["pollSecretHash"])
    .index("by_expiry", ["expiresAt"]),
  // Failed device-code entries per person in a fixed window, so a code cannot be guessed.
  runnerLinkAttempts: defineTable({
    userId: uuid,
    windowStartedAt: time,
    failures: v.number(),
  }).index("by_user", ["userId"]),
  runnerEvents: defineTable({
    runnerId: uuid,
    // Open set: linked, token_reuse, revoked, ip_changed, update_*, rolled_back.
    kind: v.string(),
    at: time,
    detail: json,
  })
    .index("by_runner", ["runnerId", "at"])
    .index("by_at", ["at"]),
  releaseChannels: defineTable({
    channel: v.string(),
    version: v.string(),
    minVersion: v.string(),
    manifestUrl: v.string(),
    publishedAt: time,
  }).index("by_channel", ["channel"]),
  // Availability only, never a value; replaced wholesale from each capabilities report.
  runnerLocalCredentials: defineTable({
    runnerId: uuid,
    providerId: v.string(),
    kind: literals(RUNNER_LOCAL_CREDENTIAL_KINDS),
    expiresAt: nullable(time),
  }).index("by_runner", ["runnerId"]),
  runnerPrefs: defineTable({
    runnerId: uuid,
    runSetup: v.boolean(),
    injectSecrets: v.boolean(),
  }).index("by_runner", ["runnerId"]),
  // One row per (ticket, runner, repo). The absolute path never appears here:
  // it lives in the runner's local SQLite.
  workingCopies: defineTable({
    id: uuid,
    ticketId: uuid,
    projectId: uuid,
    runnerId: uuid,
    projectRepoId: uuid,
    kind: literals(["worktree", "main_checkout", "clone", "sandbox"]),
    state: literals(WORKING_COPY_STATES),
    failure: nullable(json),
    branch: nullable(v.string()),
    baseBranch: nullable(v.string()),
    headSha: nullable(v.string()),
    upstreamSha: nullable(v.string()),
    ahead: v.number(),
    behind: v.number(),
    dirty: v.object({
      files: v.number(),
      insertions: v.number(),
      deletions: v.number(),
      untracked: v.number(),
      truncated: v.boolean(),
    }),
    changeSetRevision: nullable(v.string()),
    firstRun: v.object({
      copy: literals(["pending", "claimed", "done", "failed", "skipped"]),
      setup: literals(["pending", "claimed", "done", "failed", "skipped"]),
    }),
    setupRecipeSha: nullable(v.string()),
    setupOutcome: nullable(v.string()),
    lastResumeAt: nullable(time),
    lastResumeBootId: nullable(v.string()),
    reportedAt: time,
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_ticket_runner_repo", ["ticketId", "runnerId", "projectRepoId"])
    .index("by_runner", ["runnerId"]),
  projectCheckouts: defineTable({
    runnerId: uuid,
    projectId: uuid,
    projectRepoId: uuid,
    kind: literals(["main", "managed_clone"]),
    headBranch: nullable(v.string()),
    reportedAt: time,
  })
    .index("by_runner_repo", ["runnerId", "projectRepoId"])
    .index("by_project", ["projectId"]),

  // ── Sessions ───────────────────────────────────────────────────────────────
  // The listing row: written only when a listing-visible field changes.
  sessions: defineTable({
    id: uuid,
    projectId: uuid,
    ticketId: nullable(uuid),
    role: literals(["project", "ticket", "subagent"]),
    parentSessionId: nullable(uuid),
    ownerUserId: uuid,
    // SessionOrigin (`@volli/shared` session-origin), codec-checked.
    origin: json,
    title: nullable(v.string()),
    visibility: literals(SESSION_VISIBILITIES),
    visibilityReason: literals(SESSION_VISIBILITY_REASONS),
    sharedAt: nullable(time),
    status: literals(["open", "archived"]),
    turnActive: v.boolean(),
    lastTurnOutcome: nullable(v.string()),
    signal: nullable(
      v.object({
        signal: literals(["done", "blocked"]),
        reason: nullable(v.string()),
        at: time,
      }),
    ),
    stopped: nullable(v.object({ at: time, reason: nullable(v.string()) })),
    needsUser: v.boolean(),
    attentionCount: v.number(),
    placeRunnerId: uuid,
    model: nullable(
      v.object({
        providerId: v.string(),
        modelId: v.string(),
        reasoningLevel: v.string(),
        // "local" or a `modelConnections` id.
        connectionId: v.string(),
      }),
    ),
    usageTotals: json,
    createdAt: time,
    // Coarse: refreshed at turn boundaries, signals and attention changes.
    lastActivityAt: time,
    ...deletion,
  })
    .index("by_uuid", ["id"])
    .index("by_project_activity", ["projectId", "lastActivityAt"])
    .index("by_ticket_activity", ["ticketId", "lastActivityAt"])
    .index("by_owner_activity", ["ownerUserId", "lastActivityAt"])
    .index("by_parent", ["parentSessionId"]),
  // The per-Session head document: the claim and the accepted cursor.
  sessionIntake: defineTable({
    sessionId: uuid,
    claim: v.object({ runnerId: uuid, generation: v.number() }),
    acceptedThrough: v.number(),
    lastEventId: nullable(v.string()),
    lastAcceptedAt: nullable(time),
    state: literals(["active", "releasing", "released"]),
  })
    .index("by_session", ["sessionId"])
    .index("by_runner", ["claim.runnerId"]),
  // The bounded cloud fold (≤ 64 KB by contract), stored as its JSON text.
  sessionStates: defineTable({
    sessionId: uuid,
    throughSequence: v.number(),
    foldVersion: v.number(),
    state: json,
    // When a catch-up (or refold) over the accepted history was last scheduled; null when caught up.
    catchUpAt: v.optional(nullable(time)),
    // The last fact whose derived rows (turns, attention, receipts) were written; a refold keeps it.
    derivedThrough: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),
  // Accepted, immutable Session facts: the shared envelope plus backend metadata.
  sessionEvents: defineTable({
    sessionId: uuid,
    sequence: v.number(),
    // The envelope's `id`, a frozen derived id unique within the Session.
    eventId: v.string(),
    kind: v.string(),
    kindKnown: v.boolean(),
    quarantine: nullable(v.object({ code: v.string(), detail: v.string() })),
    occurredAt: time,
    recordedAt: time,
    acceptedAt: time,
    attachmentId: nullable(v.string()),
    commandId: nullable(v.string()),
    provenance: json,
    payload: json,
    bytes: v.number(),
  })
    .index("by_session_sequence", ["sessionId", "sequence"])
    .index("by_session_event", ["sessionId", "eventId"])
    .index("by_session_kind", ["sessionId", "kind", "sequence"]),
  sessionTurns: defineTable({
    sessionId: uuid,
    turnId: v.string(),
    attachmentId: v.string(),
    startedSequence: v.number(),
    endedSequence: nullable(v.number()),
    outcome: nullable(v.string()),
    origin: nullable(json),
    startedAt: time,
    endedAt: nullable(time),
    usage: nullable(json),
    segmentId: nullable(uuid),
  })
    .index("by_session_started", ["sessionId", "startedSequence"])
    .index("by_session_turn", ["sessionId", "turnId"]),
  // Staging for message bodies until a transcript pack covers them.
  transcriptArtifacts: defineTable({
    sessionId: uuid,
    digest: v.string(),
    mediaType: v.string(),
    bytes: v.number(),
    body: nullable(v.string()),
    spillKey: nullable(v.string()),
    firstSequence: nullable(v.number()),
    uploadedBy: literals(["runner", "client"]),
    packedSegmentId: nullable(uuid),
    expiresAt: nullable(time),
    createdAt: time,
  })
    .index("by_session_digest", ["sessionId", "digest"])
    .index("by_expiry", ["expiresAt"]),
  transcriptSegments: defineTable({
    id: uuid,
    sessionId: uuid,
    projectId: uuid,
    firstSequence: v.number(),
    lastSequence: v.number(),
    turnIds: v.array(v.string()),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    artifactCount: v.number(),
    format: v.string(),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_session_first", ["sessionId", "firstSequence"]),
  eventArchives: defineTable({
    id: uuid,
    sessionId: uuid,
    firstSequence: v.number(),
    lastSequence: v.number(),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    eventCount: v.number(),
    format: v.string(),
    source: literals(["compaction", "migration"]),
    createdAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_session_first", ["sessionId", "firstSequence"]),
  piLogSegments: defineTable({
    sessionId: uuid,
    attachmentId: v.string(),
    piFileId: v.string(),
    startOffset: v.number(),
    endOffset: v.number(),
    key: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    createdAt: time,
  }).index("by_session_file_offset", ["sessionId", "piFileId", "startOffset"]),
  // Ephemeral streaming deltas, sent only while someone views the Session.
  streamChunks: defineTable({
    sessionId: uuid,
    messageId: v.string(),
    seq: v.number(),
    turnId: nullable(v.string()),
    delta: json,
    createdAt: time,
  })
    .index("by_session_message_seq", ["sessionId", "messageId", "seq"])
    .index("by_created", ["createdAt"]),
  sessionViewers: defineTable({
    id: uuid,
    sessionId: uuid,
    // The Session's claimed runner, so the runner's one subscription is by index.
    runnerId: uuid,
    userId: uuid,
    clientSessionId: v.string(),
    openedAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_runner", ["runnerId"])
    .index("by_session", ["sessionId"]),
  sessionViewerHeartbeats: defineTable({ viewerId: uuid, expiresAt: time })
    .index("by_viewer", ["viewerId"])
    .index("by_expiry", ["expiresAt"]),
  delegations: defineTable({
    childSessionId: uuid,
    parentSessionId: uuid,
    ticketId: nullable(uuid),
    depth: v.number(),
    toolCallId: v.string(),
    createCommandId: v.string(),
    status: literals(["starting", "running", "answered", "failed", "stopped"]),
    answerRef: nullable(json),
    createdAt: time,
    settledAt: nullable(time),
  })
    .index("by_child", ["childSessionId"])
    .index("by_parent_call", ["parentSessionId", "toolCallId"]),
  delegationExtensions: defineTable({
    parentSessionId: uuid,
    toolCallId: v.string(),
    approvedByUserId: uuid,
    createdAt: time,
  }).index("by_parent_call", ["parentSessionId", "toolCallId"]),
  sessionGrants: defineTable({
    sessionId: uuid,
    verb: v.string(),
    scope: v.string(),
    maxDepth: v.number(),
    maxChildren: v.number(),
  }).index("by_session_verb", ["sessionId", "verb"]),
  watches: defineTable({
    id: uuid,
    watcherSessionId: uuid,
    target: v.object({ kind: literals(["session", "ticket"]), id: uuid }),
    createdBy: actor,
    createdAt: time,
    endedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_target", ["target.kind", "target.id", "endedAt"])
    .index("by_watcher", ["watcherSessionId", "endedAt"]),
  readMarkers: defineTable({
    userId: uuid,
    sessionId: uuid,
    unreadSince: nullable(time),
    readThroughSequence: nullable(v.number()),
  })
    .index("by_user_session", ["userId", "sessionId"])
    .index("by_user_unread", ["userId", "unreadSince"]),

  // ── the runner inbox ───────────────────────────────────────────────────────
  runnerJobs: defineTable({
    // Equals `commandId` when the job carries a command.
    id: uuid,
    runnerId: uuid,
    kind: literals(JOB_KINDS),
    projectId: uuid,
    sessionId: nullable(uuid),
    ticketId: nullable(uuid),
    workingCopyId: nullable(uuid),
    commandId: nullable(uuid),
    payload: json,
    priority: literals(JOB_PRIORITIES),
    // 0 urgent, 1 normal (`jobRank`): the ready index sorts on it.
    rank: v.number(),
    status: literals(JOB_STATUSES),
    availableAt: time,
    lease: nullable(v.object({ bootId: v.string(), expiresAt: time, attempt: v.number() })),
    // The engine's receipt, mirrored by the accept fold (the second stage).
    receipt: nullable(
      v.object({
        status: literals(["accepted", "rejected", "completed", "unreconciled"]),
        code: nullable(v.string()),
        detail: nullable(v.string()),
        at: time,
      }),
    ),
    result: nullable(json),
    createdBy: actor,
    createdAt: time,
    completedAt: nullable(time),
    expiresAt: nullable(time),
    // The last failure: reported by the runner, or a lease that ran out (`by: "backend"`).
    // A retry keeps it, so "retrying after <code>" and the dead letter both say why.
    failure: v.optional(
      nullable(
        v.object({
          attempt: v.number(),
          code: v.string(),
          detail: nullable(v.string()),
          retryable: v.boolean(),
          by: literals(["runner", "backend"]),
          at: time,
        }),
      ),
    ),
  })
    .index("by_uuid", ["id"])
    .index("by_runner_ready", ["runnerId", "status", "rank", "availableAt"])
    .index("by_session", ["sessionId", "createdAt"])
    .index("by_ticket", ["ticketId", "createdAt"])
    .index("by_expiry", ["expiresAt"])
    // Queued work of one kind by age (the notice expiry sweep).
    .index("by_kind_status", ["kind", "status", "createdAt"]),

  // ── attention / Needs-you ──────────────────────────────────────────────────
  attentionItems: defineTable({
    // Derived and frozen for Session items (`s:{sessionId}:{sourceId}`), a UUID otherwise.
    id: v.string(),
    userId: uuid,
    projectId: uuid,
    ticketId: nullable(uuid),
    sessionId: nullable(uuid),
    source: literals([
      "session_attention",
      "interaction",
      "session_blocked",
      "review_requested",
      "mention",
      "environment_failed",
      "runner_alert",
      "billing",
    ]),
    sourceId: v.string(),
    kind: v.string(),
    title: v.string(),
    detail: nullable(v.string()),
    raisedAt: time,
    clearedAt: nullable(time),
    clearedReason: nullable(literals(["resolved", "access_lost", "superseded", "deleted"])),
    seenAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_user_open", ["userId", "clearedAt", "raisedAt"])
    .index("by_session", ["sessionId", "clearedAt"]),

  // ── config, secrets, model connections ─────────────────────────────────────
  configEntries: defineTable({
    id: uuid,
    level: configLevel,
    // `u:{userId}` | `u:{userId}/p:{projectId}` | `w:{workspaceId}` | `p:{projectId}`
    scopeKey: v.string(),
    userId: nullable(uuid),
    workspaceId: nullable(uuid),
    projectId: nullable(uuid),
    // Open set: skill, plugin, agent, instruction, prompt_template, mcp_server, …
    kind: v.string(),
    name: v.string(),
    state: literals(["on", "off", "inherit"]),
    definition: nullable(json),
    bundleKey: nullable(v.string()),
    digest: nullable(v.string()),
    required: nullable(v.boolean()),
    revision: v.number(),
    updatedBy: actor,
    updatedAt: time,
  })
    .index("by_uuid", ["id"])
    .index("by_scope_kind_name", ["scopeKey", "kind", "name"]),
  secrets: defineTable({
    id: uuid,
    scope: configLevel,
    scopeKey: v.string(),
    name: v.string(),
    kind: literals(SECRET_KINDS),
    plain: nullable(v.string()),
    // `kid` names the `secretKeys` row the value is sealed under (SCHEMA-NOTES).
    sealed: nullable(sealed),
    exposure: literals(SECRET_EXPOSURES),
    requestedBySessionId: nullable(uuid),
    last4: nullable(v.string()),
    createdBy: actor,
    updatedAt: time,
    lastUsedAt: nullable(time),
    valueVersion: v.number(),
  })
    .index("by_uuid", ["id"])
    .index("by_scope_name", ["scopeKey", "name"]),
  // The data keys `secrets` values are sealed under: one per Workspace
  // (`w:{workspaceId}`) and one per person (`u:{userId}`), each wrapped by the
  // root key named `rootKid`. Never returned by a query (`lib/sealing.ts`).
  secretKeys: defineTable({
    id: uuid,
    owner: v.string(),
    rootKid: v.string(),
    wrapped: v.bytes(),
    createdAt: time,
    rewrappedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_owner", ["owner"])
    .index("by_root_kid", ["rootKid"]),
  // Sealed client-side to the gateway: the backend cannot open `sealedKey`.
  modelConnections: defineTable({
    id: uuid,
    scope: configLevel,
    scopeKey: v.string(),
    kind: v.string(),
    label: v.string(),
    upstreamBaseUrl: v.string(),
    api: v.string(),
    extraHeaders: nullable(json),
    sealedKey: sealed,
    keyVersion: v.number(),
    delivery: literals(["relay", "direct"]),
    status: literals(["active", "disabled"]),
    createdBy: actor,
    createdAt: time,
    rotatedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_scope", ["scopeKey"]),
  mcpCredentials: defineTable({
    userId: uuid,
    configEntryId: uuid,
    kind: literals(["oauth", "static"]),
    sealed,
    expiresAt: nullable(time),
  }).index("by_user_entry", ["userId", "configEntryId"]),

  // ── environment ────────────────────────────────────────────────────────────
  environmentRuns: defineTable({
    // Idempotent by the job id that ran it.
    id: uuid,
    projectId: uuid,
    projectRepoId: uuid,
    workingCopyId: nullable(uuid),
    snapshotId: nullable(uuid),
    runnerId: uuid,
    runnerKind: literals(["mac", "linux", "cloud"]),
    sessionId: nullable(uuid),
    ticketId: nullable(uuid),
    script: literals(["setup", "resume", "verify"]),
    source: literals(["repo", "stored", "legacy_command"]),
    scriptSha: v.string(),
    reason: v.string(),
    clean: v.boolean(),
    startedAt: time,
    endedAt: nullable(time),
    outcome: nullable(literals(["succeeded", "failed", "timed_out", "cancelled", "skipped"])),
    exitCode: nullable(v.number()),
    // ≤ 16 KB, redacted.
    tail: v.string(),
    logKey: nullable(v.string()),
    triggeredBy: actor,
  })
    .index("by_uuid", ["id"])
    .index("by_project_started", ["projectId", "startedAt"])
    .index("by_working_copy", ["workingCopyId", "startedAt"]),
  environmentSnapshots: defineTable({
    id: uuid,
    projectId: uuid,
    size: v.string(),
    repoShas: json,
    recipeHash: v.string(),
    providerSnapshotId: nullable(v.string()),
    status: v.string(),
    builtAt: nullable(time),
    expiresAt: nullable(time),
    buildRunId: nullable(uuid),
  })
    .index("by_uuid", ["id"])
    .index("by_project_size", ["projectId", "size"]),

  // ── usage: carries the Workspace the spend happened in ─────────────────────
  usageDaily: defineTable({
    workspaceId: uuid,
    userId: uuid,
    projectId: uuid,
    connectionId: v.string(),
    providerId: v.string(),
    modelId: v.string(),
    // UTC `YYYY-MM-DD`.
    day: v.string(),
    source: literals(["gateway", "self_reported"]),
    calls: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheWriteTokens: v.number(),
    costUsd: v.number(),
  })
    .index("by_key", [
      "workspaceId",
      "day",
      "userId",
      "projectId",
      "connectionId",
      "providerId",
      "modelId",
      "source",
    ])
    .index("by_user_day", ["userId", "day"]),
  gatewayUsage: defineTable({
    // The `x-volli-call-id` the runner's `usage.recorded` also carries.
    callId: v.string(),
    grantJti: v.string(),
    workspaceId: uuid,
    userId: uuid,
    sessionId: uuid,
    runnerId: uuid,
    connectionId: uuid,
    keyVersion: v.number(),
    providerId: v.string(),
    modelId: v.string(),
    tokens: json,
    costUsd: nullable(v.number()),
    status: v.string(),
    upstreamStatus: nullable(v.number()),
    startedAt: time,
    ttftMs: nullable(v.number()),
    durationMs: v.number(),
    partial: v.boolean(),
  })
    .index("by_call", ["callId"])
    .index("by_session", ["sessionId", "startedAt"]),

  // ── billing: outlives a Workspace purge, keyed by its UUID ─────────────────
  billingAccounts: defineTable({
    workspaceId: uuid,
    stripeCustomerId: v.string(),
    billingEmail: v.string(),
    merchantMode: literals(["direct", "managed_payments"]),
    createdAt: time,
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_stripe_customer", ["stripeCustomerId"]),
  subscriptions: defineTable({
    workspaceId: uuid,
    stripeSubscriptionId: v.string(),
    status: v.string(),
    planKey: v.string(),
    items: json,
    meteredItemId: nullable(v.string()),
    currentPeriodStart: time,
    currentPeriodEnd: time,
    cancelAtPeriodEnd: v.boolean(),
    canceledAt: nullable(time),
    pastDueSince: nullable(time),
    latestInvoice: nullable(json),
    stripeObjectUpdatedAt: time,
    syncedAt: time,
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_stripe_subscription", ["stripeSubscriptionId"]),
  // The only read path for what a Workspace may do.
  entitlements: defineTable({
    workspaceId: uuid,
    value: json,
    version: v.number(),
    computedAt: time,
  }).index("by_workspace", ["workspaceId"]),
  seatSync: defineTable({
    workspaceId: uuid,
    lastPushedQuantity: v.number(),
    lastPushedAt: nullable(time),
    pendingJobId: nullable(v.string()),
    seatVersion: v.number(),
  }).index("by_workspace", ["workspaceId"]),
  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    objectId: v.string(),
    createdAt: time,
    receivedAt: time,
    status: v.string(),
  })
    .index("by_event", ["eventId"])
    .index("by_received", ["receivedAt"]),
  billingAudit: defineTable({
    workspaceId: uuid,
    actor,
    kind: v.string(),
    at: time,
    detail: json,
  }).index("by_workspace", ["workspaceId", "at"]),
  cloudTrial: defineTable({
    workspaceId: uuid,
    grantedHours: v.number(),
    usedHours: v.number(),
    seededByUserId: uuid,
  }).index("by_workspace", ["workspaceId"]),
  // Later: usageSegments, hourGrants, usageDebits, meterReports — same id and Actor rules.

  // ── Automations ────────────────────────────────────────────────────────────
  automations: defineTable({
    id: uuid,
    projectId: uuid,
    name: v.string(),
    instructions: v.string(),
    runtime: nullable(json),
    triggerSpec: nullable(json),
    createdBy: actor,
    createdAt: time,
    updatedAt: time,
    deletedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_project_name", ["projectId", "name"]),
  automationArmings: defineTable({
    projectId: uuid,
    status: ticketStatus,
    automationId: uuid,
    armedByUserId: uuid,
    // The armer's chosen runner (default their Mac).
    runnerId: uuid,
    armedAt: time,
  })
    .index("by_project_status", ["projectId", "status"])
    .index("by_automation", ["automationId"]),
  automationColumnOrder: defineTable({
    projectId: uuid,
    status: ticketStatus,
    rankedIds: v.array(v.string()),
    orderedAt: time,
  }).index("by_project_status", ["projectId", "status"]),
  automationSchedules: defineTable({
    automationId: uuid,
    armedByUserId: uuid,
    runnerId: uuid,
    spec: json,
    timezone: v.string(),
    nextFireAt: time,
    lastFiredAt: nullable(time),
  })
    .index("by_automation", ["automationId"])
    .index("by_next_fire", ["nextFireAt"]),
  automationRuns: defineTable({
    id: uuid,
    automationId: nullable(uuid),
    automationName: nullable(v.string()),
    projectId: uuid,
    ticketId: nullable(uuid),
    sessionId: nullable(uuid),
    trigger: literals(["arrival", "schedule", "manual"]),
    status: literals(["queued", "started", "skipped", "failed"]),
    skipReason: nullable(json),
    missedCount: nullable(v.number()),
    dueAt: nullable(time),
    model: nullable(json),
    attendance: nullable(v.string()),
    armedByUserId: nullable(uuid),
    runnerId: nullable(uuid),
    createdAt: time,
    // A failed arrival attempt's error, and the command id its Retry replays under.
    error: v.optional(v.string()),
    retryCommandId: v.optional(v.string()),
  })
    .index("by_uuid", ["id"])
    .index("by_automation", ["automationId", "createdAt"])
    .index("by_ticket", ["ticketId", "createdAt"])
    .index("by_project", ["projectId", "createdAt"]),

  // ── retention, deletion, audit ─────────────────────────────────────────────
  deletionRequests: defineTable({
    id: uuid,
    targetKind: literals(["user", "workspace", "project", "ticket", "session"]),
    targetId: uuid,
    requestedBy: actor,
    requestedAt: time,
    purgeAfter: time,
    status: literals(["pending", "cancelled", "purging", "purged", "blocked"]),
    blockedBy: nullable(v.string()),
    cursor: nullable(json),
  })
    .index("by_uuid", ["id"])
    .index("by_status_purge", ["status", "purgeAfter"])
    .index("by_target", ["targetKind", "targetId"]),
  legalHolds: defineTable({
    id: uuid,
    workspaceId: uuid,
    scope: json,
    createdBy: actor,
    createdAt: time,
    releasedAt: nullable(time),
  })
    .index("by_uuid", ["id"])
    .index("by_workspace", ["workspaceId"]),
  auditLog: defineTable({
    id: uuid,
    workspaceId: nullable(uuid),
    actor,
    kind: v.string(),
    targetKind: v.string(),
    targetId: v.string(),
    at: time,
    // Never a secret value.
    detail: json,
  })
    .index("by_uuid", ["id"])
    .index("by_workspace_at", ["workspaceId", "at"])
    .index("by_target", ["targetKind", "targetId", "at"]),
});
