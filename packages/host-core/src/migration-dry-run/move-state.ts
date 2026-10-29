/** A private recovery file is never checked and then reopened for writing.
 * Bind every read/patch to one O_NOFOLLOW descriptor; exclusive creation is
 * the existence check. Calls are serialized by the parent/child lifecycle.
 */
import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import type { MoveJob } from "./move-worker";

export type MoveRecoveryState = MoveJob & { cleanupMoves?: string[]; uiReady?: boolean };
const MAX_STATE_BYTES = 1024 * 1024;

function readDescriptor(fd: number): MoveRecoveryState {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES)
    throw new Error("invalid_rehearsal_state_file");
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new Error("rehearsal_state_changed_while_reading");
    offset += read;
  }
  return JSON.parse(bytes.toString("utf8")) as MoveRecoveryState;
}

export function createMoveState(file: string, state: MoveRecoveryState): void {
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(state));
  } finally {
    closeSync(fd);
  }
}

export function readMoveState(file: string): MoveRecoveryState {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readDescriptor(fd);
  } finally {
    closeSync(fd);
  }
}

export function patchMoveState(file: string, patch: Partial<MoveRecoveryState>): void {
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const state = { ...readDescriptor(fd), ...patch };
    ftruncateSync(fd, 0);
    // readDescriptor used positional reads, leaving this descriptor at zero.
    writeFileSync(fd, JSON.stringify(state));
  } finally {
    closeSync(fd);
  }
}
