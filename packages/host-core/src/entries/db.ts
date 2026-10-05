/**
 * `@volli/host-core/db`: the SQLite database: open, migrations, the transaction gate and the repositories.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export { getAllAppState, getAppState, setAppState } from "../db/app-state-repo";
export {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationsForProject,
  listProjectRunsForAutomation,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForAutomation,
  listSkippedOccurrencesForProject,
  recordAutomationRun,
} from "../db/automations-repo";
export {
  createBlobLink,
  deleteBlobLink,
  getBlob,
  listLinkViews,
  listMaterializableLinks,
} from "../db/blobs-repo";
export { CLOUD_IDENTITY_MIGRATION } from "../db/cloud-identity-migration";
export { deleteComment, getComment, listComments, updateComment } from "../db/comments-repo";
export {
  listTicketEvents,
  listTicketStatusEntries,
  recordSessionResumedOnce,
  recordSessionStartedOnce,
} from "../db/events-repo";
export { buildExportDocument, defaultExportFilename, serializeExportDocument } from "../db/export";
export {
  listHarnessChannels,
  recordHarnessChannelEvent,
  recordHarnessLaunch,
} from "../db/harness-channel-repo";
export {
  getRegisteredHarness,
  listRegisteredHarnesses,
  recordHarnessTrust,
  restoreRegisteredHarness,
} from "../db/harness-registry-repo";
export { openVolliDb } from "../db";
export { listAllLabels, listLabelsByProject, setLabelColor } from "../db/labels-repo";
export { listMcpOperations, recordMcpOperation } from "../db/mcp-operations-repo";
export { checkMigrationHistory, describeMigrationHistory } from "../db/migration-history";
export { migrate, MIGRATIONS, SCHEMA_HEAD } from "../db/migrations";
export { prepared } from "../db/prepared";
export {
  countProjects,
  deleteProject,
  getProjectById,
  insertProject,
  listProjects,
  reorderProjects,
  updateProjectAppearance,
  updateProjectAuthorityPolicy,
  updateProjectBaseBranch,
  updateProjectCanvas,
  updateProjectSessionDefaults,
  updateProjectSetupCommand,
  updateProjectSkillModes,
  updateProjectThemeOverride,
} from "../db/projects-repo";
export { MIN_READER_VERSION_KEY } from "../db/schema-compatibility";
export { hasSecret, readSecret, writeSecret } from "../db/secrets-repo";
export { readSessionProvenance } from "../db/session-provenance-repo";
export { readSessionUnread, writeSessionUnread } from "../db/session-read-repo";
export {
  assertSessionStorageContentUnchanged,
  computeSessionStorageContentDigest,
  computeSessionStorageContentDigestAtPath,
  type SessionStorageContentDigest,
} from "../db/session-storage-digest";
export {
  getFirstPaintHint,
  getGlobalAppearance,
  getGlobalCanvas,
  setFirstPaintHint,
  setGlobalAppearance,
  setGlobalCanvas,
} from "../db/theme-repo";
export {
  deleteTicket,
  getTicket,
  getTicketBody,
  getTicketRow,
  insertTicket,
  listAllTickets,
  listArchivedTicketsByProject,
  listTicketRosterByProject,
  listWorktreePaths,
  nextTicketNumberForProject,
  setTicketRetentionKeep,
  updateTicketFields,
} from "../db/tickets-repo";
export {
  settleTransaction,
  throwTransactionViolation,
  withTransaction,
} from "../db/transaction-gate";
