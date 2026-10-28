/**
 * What the purge of an aborted move deletes, table by table, and how it
 * finds the rows (`projectImportPurge.ts` runs it).
 *
 * Every row is reached by an index whose leading field is the moved project's
 * id, or the id of a row already reached that way (one of its Sessions,
 * tickets, Automations, repositories or Session viewers). Nothing is found by
 * scanning a table, and no row of another project is ever read for deletion:
 * a row reached this way that names another project stops the purge instead
 * ({@link PurgeStop}).
 *
 * Rows of other projects that point INTO the moved one (a watch on one of
 * its Sessions, a delegation whose parent was one of them, a link to one of
 * its tickets) belong to those projects and are left as they are: they name
 * something that no longer exists, as after any move, and a purge never
 * writes outside the moved project.
 *
 * That covers more than the import's own streams. A move rolled back after
 * its commit (`uncommit`, then `abort`) was shown, so the backend may have
 * derived rows there (a fold, attention, streamed text, runner work); they
 * go with the project, or a move of it again would meet them.
 *
 * {@link PURGE_TABLES} names every table in the schema, so a new table must
 * say whether a purge deletes it (and the test proves the plan reaches it) or
 * why not: `test/projectImportPurge.test.ts`.
 */

import type { TableNames } from "../_generated/dataModel.js";
import type { Row } from "./migrationImport";

/** One table's rows under one owner row: read by `index`, whose first field is `field`. */
export interface PurgeNode {
  readonly table: TableNames;
  readonly index: string;
  readonly field: string;
  /** The value `field` equals, from the owner row. Default: the owner's `id`. */
  readonly value?: (owner: Row) => unknown;
  /** Rows under each row of this table, deleted before it. */
  readonly children?: readonly PurgeNode[];
}

const bySession = (table: TableNames, index: string, field = "sessionId"): PurgeNode => ({
  table,
  index,
  field,
});

/**
 * Under the project: its Sessions (and what hangs off each), its tickets
 * (and theirs), its Automations and repositories (and theirs), then the rows
 * that name the project directly. The project row itself goes last, after the
 * audit rows the import wrote ({@link isImportedAuditRow}).
 */
export const PROJECT_PURGE: readonly PurgeNode[] = [
  {
    table: "sessions",
    index: "by_project_activity",
    field: "projectId",
    children: [
      bySession("sessionEvents", "by_session_sequence"),
      bySession("sessionIntake", "by_session"),
      bySession("sessionStates", "by_session"),
      bySession("sessionTurns", "by_session_started"),
      bySession("transcriptArtifacts", "by_session_digest"),
      bySession("transcriptSegments", "by_session_first"),
      bySession("eventArchives", "by_session_first"),
      bySession("piLogSegments", "by_session_file_offset"),
      bySession("streamChunks", "by_session_message_seq"),
      {
        ...bySession("sessionViewers", "by_session"),
        children: [{ table: "sessionViewerHeartbeats", index: "by_viewer", field: "viewerId" }],
      },
      bySession("sessionFollowUpRevisions", "by_session"),
      bySession("sessionFollowUpQueues", "by_session"),
      // The Session's own delegation (it is the child) and the extensions it granted.
      bySession("delegations", "by_child", "childSessionId"),
      bySession("delegationExtensions", "by_parent_call", "parentSessionId"),
      bySession("sessionGrants", "by_session_verb"),
      bySession("watches", "by_watcher", "watcherSessionId"),
      bySession("readMarkers", "by_session"),
      bySession("attentionItems", "by_session"),
    ],
  },
  {
    table: "tickets",
    index: "by_project_number",
    field: "projectId",
    children: [
      { table: "ticketBodies", index: "by_ticket", field: "ticketId" },
      { table: "ticketComments", index: "by_ticket", field: "ticketId" },
      { table: "ticketSignals", index: "by_ticket_kind", field: "ticketId" },
      { table: "ticketLinks", index: "by_from", field: "fromTicketId" },
      { table: "workingCopies", index: "by_ticket_runner_repo", field: "ticketId" },
      { table: "attentionItems", index: "by_ticket", field: "ticketId" },
    ],
  },
  {
    table: "automations",
    index: "by_project_name",
    field: "projectId",
    children: [{ table: "automationSchedules", index: "by_automation", field: "automationId" }],
  },
  {
    table: "projectRepos",
    index: "by_project",
    field: "projectId",
    children: [{ table: "recipeStatus", index: "by_repo_ref", field: "projectRepoId" }],
  },
  // Also by project: an imported one may name a ticket the profile no longer had.
  { table: "workingCopies", index: "by_project", field: "projectId" },
  { table: "runnerJobs", index: "by_project_kind_status", field: "projectId" },
  { table: "boardEvents", index: "by_project_seq", field: "projectId" },
  { table: "labels", index: "by_project_name_key", field: "projectId" },
  { table: "blobLinks", index: "by_blob", field: "projectId" },
  { table: "blobs", index: "by_project_sha", field: "projectId" },
  { table: "automationArmings", index: "by_project_status", field: "projectId" },
  { table: "automationColumnOrder", index: "by_project_status", field: "projectId" },
  { table: "automationRuns", index: "by_project", field: "projectId" },
  { table: "environmentRuns", index: "by_project_started", field: "projectId" },
  { table: "environmentSnapshots", index: "by_project_size", field: "projectId" },
  // Project-level entries only: a person's own entries are theirs.
  {
    table: "configEntries",
    index: "by_scope_kind_name",
    field: "scopeKey",
    value: (project) => `p:${project.id as string}`,
  },
  // Project-scoped credentials go with the project: the id may next be moved into
  // another Workspace, which must not inherit values sealed for this one. A
  // person's own entries for the project (`u:<userId>/p:<projectId>`) stay theirs.
  {
    table: "secrets",
    index: "by_scope_name",
    field: "scopeKey",
    value: (project) => `p:${project.id as string}`,
  },
  {
    table: "modelConnections",
    index: "by_scope",
    field: "scopeKey",
    value: (project) => `p:${project.id as string}`,
  },
  { table: "memberProjectPrefs", index: "by_project", field: "projectId" },
  { table: "projectCheckouts", index: "by_project", field: "projectId" },
  { table: "projectEnvironment", index: "by_project", field: "projectId" },
  { table: "projectCounters", index: "by_project", field: "projectId" },
  { table: "projectMoves", index: "by_project", field: "projectId" },
];

/**
 * An audit row the import wrote (an MCP operation of the moved project, the
 * only audit rows a person's move carries). Told apart by shape: nothing in
 * the backend writes `mcp_*` audit rows, only an import does. The backend's
 * own audit rows about the move (`project.imported`, `project.import_*`) stay.
 */
export function isImportedAuditRow(
  doc: Row,
  move: { projectId: string; workspaceId: string },
): boolean {
  const detail = doc.detail as Row | null;
  return (
    doc.workspaceId === move.workspaceId &&
    typeof doc.kind === "string" &&
    doc.kind.startsWith("mcp_") &&
    doc.targetKind === "mcp_server" &&
    detail !== null &&
    typeof detail === "object" &&
    detail.projectId === move.projectId
  );
}

/** How a purge treats one table. */
export type PurgeDisposition =
  /** Rows reached through {@link PROJECT_PURGE}. */
  | "deleted"
  /** The project row, deleted last. */
  | "project"
  /** Only the rows the import wrote, read through the Workspace ({@link isImportedAuditRow}). */
  | "imported_only"
  /** Never deleted by a purge, and why. */
  | { kept: string };

const PERSON = "a person's account, sign-in or preferences, not a project's";
const RUNNER = "a runner's own state, not a project's";
const WORKSPACE = "the Workspace's, not a project's";
const BILLING = "usage and billing keep the Workspace the spend happened in";

/** Every table, and what a purge does with it. */
export const PURGE_TABLES: Readonly<Record<TableNames, PurgeDisposition>> = {
  previewAccess: { kept: PERSON },
  users: { kept: PERSON },
  authIdentities: { kept: PERSON },
  externalAccounts: { kept: PERSON },
  clientSessions: { kept: PERSON },
  githubConnections: { kept: PERSON },
  githubFlows: { kept: PERSON },
  githubWebhookDeliveries: { kept: "GitHub's delivery log, named by no project" },
  userPrefs: { kept: PERSON },
  workspaces: { kept: WORKSPACE },
  workspaceMembers: { kept: WORKSPACE },
  workspaceInvites: { kept: WORKSPACE },
  workspacePolicies: { kept: WORKSPACE },
  githubInstallations: { kept: WORKSPACE },
  projects: "project",
  projectCounters: "deleted",
  projectRepos: "deleted",
  projectMoves: "deleted",
  projectImports: { kept: "the move's own record, which ends `purged`" },
  projectImportStreams: { kept: "the move's accumulators: counts and digests, never content" },
  projectEnvironment: "deleted",
  recipeStatus: "deleted",
  memberProjectPrefs: "deleted",
  tickets: "deleted",
  ticketBodies: "deleted",
  labels: "deleted",
  ticketComments: "deleted",
  ticketSignals: "deleted",
  ticketLinks: "deleted",
  boardEvents: "deleted",
  boardReceipts: { kept: "a command's answer to its own retries, gone after seven days" },
  blobs: "deleted",
  workspaceBlobs: { kept: WORKSPACE },
  userBlobs: { kept: PERSON },
  blobLinks: "deleted",
  runners: { kept: RUNNER },
  runnerPresence: { kept: RUNNER },
  runnerCredentials: { kept: RUNNER },
  runnerInstallTokens: { kept: RUNNER },
  runnerLinkRequests: { kept: RUNNER },
  runnerLinkAttempts: { kept: RUNNER },
  runnerLinkRateLimits: { kept: RUNNER },
  runnerEvents: { kept: RUNNER },
  releaseChannels: { kept: "the deployment's release feed" },
  runnerLocalCredentials: { kept: RUNNER },
  runnerPrefs: { kept: RUNNER },
  workingCopies: "deleted",
  projectCheckouts: "deleted",
  sessions: "deleted",
  sessionIntake: "deleted",
  sessionStates: "deleted",
  sessionEvents: "deleted",
  sessionTurns: "deleted",
  transcriptArtifacts: "deleted",
  transcriptSegments: "deleted",
  eventArchives: "deleted",
  piLogSegments: "deleted",
  streamChunks: "deleted",
  sessionViewers: "deleted",
  sessionViewerHeartbeats: "deleted",
  sessionFollowUpRevisions: "deleted",
  sessionFollowUpQueues: "deleted",
  delegations: "deleted",
  delegationExtensions: "deleted",
  sessionGrants: "deleted",
  watches: "deleted",
  watchReceipts: { kept: "a watch command's answer to its own retries, gone after it expires" },
  readMarkers: "deleted",
  runnerJobs: "deleted",
  attentionItems: "deleted",
  configEntries: "deleted",
  secrets: "deleted",
  secretKeys: { kept: "per-Workspace and per-person data keys" },
  modelConnections: "deleted",
  mcpCredentials: { kept: "a person's own MCP credentials, keyed by person and entry" },
  environmentRuns: "deleted",
  environmentSnapshots: "deleted",
  usageDaily: { kept: BILLING },
  gatewayUsage: { kept: BILLING },
  billingAccounts: { kept: BILLING },
  subscriptions: { kept: BILLING },
  entitlements: { kept: BILLING },
  seatSync: { kept: BILLING },
  stripeEvents: { kept: BILLING },
  billingAudit: { kept: BILLING },
  cloudTrial: { kept: BILLING },
  automations: "deleted",
  automationArmings: "deleted",
  automationColumnOrder: "deleted",
  automationSchedules: "deleted",
  automationRuns: "deleted",
  deletionRequests: { kept: "account deletion requests, named by no project" },
  legalHolds: { kept: WORKSPACE },
  auditLog: "imported_only",
};

/** A row reached through the moved project that names another project: the purge stops. */
export class PurgeStop extends Error {
  constructor(readonly code: string) {
    super(`The purge stopped: ${code}`);
    this.name = "PurgeStop";
  }
}
