/** Volli's durable Pi sidecar boundary; unchanged Pi 0.99.2 v3/v4 disk contracts. */
export { JsonlSessionRepo } from "./vendor/pi-harness/session/jsonl/repo";
export type {
  JsonlSessionMetadata,
  JsonlSessionCreateOptions,
  JsonlSessionListOptions,
  JsonlSessionRepoOptions,
} from "./vendor/pi-harness/session/jsonl/types";
export type {
  Branch,
  CompactionEntry,
  CustomEntry,
  Entry,
  EntryProjector,
  JsonValue,
  MessageEntry,
  NewEntry,
  Session,
  SessionCreateOptions,
  SessionMetadata,
  SessionRepo,
} from "./vendor/pi-harness/session/types";
export { insertEntry, insertUsage } from "./vendor/pi-harness/session/commit";
export {
  appendList,
  branchTip,
  branchTipInventoryPrefix,
  deleteList,
  deleteValue,
  list,
  setValue,
  value,
} from "./vendor/pi-harness/session/values";
export {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  type SessionContextBuildOptions,
} from "./vendor/pi-harness/session/context";
