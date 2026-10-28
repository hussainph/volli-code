/**
 * `@volli/host-core/cloud-move`: "Move to Volli Cloud": the move engine, its
 * journal, the verified kept profile backup and the project freeze.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  createMoveEngine,
  queueOrder,
  type EnqueueInput,
  type MoveEngine,
  type QueueOutcome,
} from "../cloud-move/engine";
export { createMoveBackupPort, type MoveBackupOptions } from "../cloud-move/backup";
export { ProjectFrozenError, projectFreeze } from "../cloud-move/freeze";
export type { MoveFailure, MovePause, MoveRow, QueueRow } from "../cloud-move/journal";
export type {
  MoveBackend,
  MoveBackupPort,
  MoveEnginePorts,
  MoveIdentity,
  MoveLiveWork,
  MoveObjectStore,
  MoveSessionHistory,
  MovedSession,
  MovedSessionUploadReport,
} from "../cloud-move/ports";
export { MOVE_STATES, movePhase, type MovePhase, type MoveState } from "../cloud-move/states";
