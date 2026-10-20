/** Product-owned compaction compatibility seam; Session Engine remains the durability authority. */
export {
  compact,
  prepareCompaction,
  findCutPoint,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  shouldCompact,
  type CompactionSettings,
} from "./vendor/pi-harness/compaction/compaction";
export {
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  COMPACTION_SUMMARY_PREFIX,
} from "./vendor/pi-harness/messages";
export { getOrThrow } from "./vendor/pi-harness/types";
