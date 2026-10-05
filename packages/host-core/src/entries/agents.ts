/**
 * `@volli/host-core/agents`: what agents reach: the socket, its verb table, the tool door, watches, harnesses and the CLI install.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export { createAgentCommandService } from "../agent-commands";
export { acquireVolliAppProfile, ensureVolliCliShim, volliRuntimePaths } from "../host-profile";
export { createHostAgentCommands, createHostAgentSocket } from "../agent-services";
export {
  createAgentSocketLifecycle,
  type ShutdownAgentSocket,
  startAgentSocket,
} from "../agent-socket";
export {
  cleanupLegacyGlobalCliLink,
  detectHarnesses,
  ensureUserBinOnPath,
  ensureUserCliLink,
  installHarnessSkills,
  LEGACY_GLOBAL_CLI_LINK,
  loginPathHasUserBin,
  removeUserBinPathBlock,
  removeUserCliLinkIfOurs,
  resolveOnPath,
  uninstallAllHarnessSkills,
  userCliLinkPath,
} from "../agent-tools";
export type { HarnessUninstallResult, ManagedConflict } from "../harness-install";
export {
  type DecidedHarnessManifest,
  decideRegisteredHarnesses,
  type HarnessManifestScan,
  MAX_MANIFEST_BYTES,
  MAX_SCANNED_HARNESS_DIRS,
  recordHarnessDelivery,
  scanHarnessManifests,
  type ScannedHarnessManifest,
  trustedHarnessAdapters,
} from "../harness-registry";
