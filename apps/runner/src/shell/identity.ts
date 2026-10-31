/**
 * Which daemon the process shell is serving.
 *
 * The shell (`src/shell`) is copied from `apps/hostd`'s process modules
 * (boot errors, the instance lock, logs, eager secrets, the status file,
 * whole-file writes, drain and stop), parameterized by how the daemon names
 * itself, so the copy and hostd's originals can become one module again when
 * hostd retires. Until then hostd keeps its own, frozen.
 */
export interface ShellIdentity {
  /** The binary, as commands in messages spell it: `volli-runner`. */
  readonly program: string;
  /** What a sentence calls the running daemon: `volli-runner`. */
  readonly daemon: string;
  /**
   * The prefix of its files in the data directory (`<prefix>.lock`,
   * `<prefix>-status.json`) and its log component: `runner`. Durable: a
   * running install's files are found by it, so it never changes.
   */
  readonly filePrefix: string;
}

/** `volli-runner`: `runner.lock` and `runner-status.json` in its data directory. */
export const RUNNER: ShellIdentity = {
  program: "volli-runner",
  daemon: "volli-runner",
  filePrefix: "runner",
};
