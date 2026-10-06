/**
 * `@volli/host-core/worktree`: ticket worktrees: git, ensure/trim/remove, snapshots, activity and the cleanup engine.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export { credentialHelperIssues } from "../credential-helper-diagnostics";
export {
  orphanCleanupEngine,
  worktreeDeps,
  worktreeHomeDir,
  worktreesHome,
} from "../worktree-runtime";
export type { BusyWorktreeSite, BusyWorktreeSites } from "../worktree/activity";
export {
  type AgentSiteRuntime,
  agentSitesWithin,
  releaseAgentSites,
} from "../worktree/agent-sites";
export { createCoalescer, RAIL_READ_SHARE_WINDOW_MS } from "../worktree/coalesce";
export { isOwnedWorktreePath, ownedContainers, projectContainerName } from "../worktree/containers";
export { acquireDeletionLease } from "../worktree/deletion-lease";
export {
  type AgentSiteReleaseReport,
  agentTurnOpenWithin,
  archiveAndClean,
  busyRefusal,
  busySiteWithin,
  cleanupOrphans,
  commitTicketRemaining,
  countOpenAgentTurns,
  ensure,
  getRetentionTtlDays,
  getTrimSettings,
  listBranches,
  liveShellWorktreeSites,
  OrphanCleanupRefused,
  publishTicketBranch,
  readVenue,
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readWorktreeDiff,
  readWorktreeStatus,
  reconcileInterruptedCleanups,
  remove,
  resolveWorktreeTarget,
  type RunGitAsync,
  runGitCapturing,
  runGitCapturingAsync,
  runNet,
  scanOrphans,
  scanTrimTargets,
  setRetentionTtlDays,
  setTrimSettings,
  trimAllWorktrees,
  trimFinishedWorktree,
  WorktreeChangeWatchManager,
} from "../worktree";
export { canonicalize, isInside } from "../worktree/paths";
export { getWorktreeSnapshots } from "../worktree/snapshot";
