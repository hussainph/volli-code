/**
 * `volli-hostd credentials reset`: give up saved credentials this host cannot
 * open (VC-641; `docs/plans/sealed-credential-store.md` §7).
 *
 *   volli-hostd credentials reset --data-dir <dir> [--yes]
 *
 * Run as the service user, with hostd stopped and with the service's own
 * `VOLLI_SECRET_KEY_FILE`. It is local-admin intent at the host's shell,
 * never a socket verb or an agent tool. It:
 *
 * 1. refuses a data directory boot would refuse (missing, not a directory,
 *    another user's, or writable by every user);
 * 2. takes the data directory's instance lock, so it never races a running
 *    host over the sealed file. The lock file, `hostd.lock`, is the one hostd
 *    itself creates and keeps: leaving it behind is harmless;
 * 3. opens saved credentials exactly as hostd's boot does, and does nothing
 *    when they open (`ready`) or there are none (`empty`);
 * 4. refuses, whatever `--yes` says, when the key configuration is
 *    `refused` (a relative `VOLLI_SECRET_KEY_FILE`, an unsafe key file): a
 *    reset cannot fix that, and a typo in the environment must not move a
 *    store the right key opens;
 * 5. without `--yes`, says what it found and what a reset would do, and stops;
 * 6. with `--yes`, moves the sealed file aside to
 *    `session-secrets.enc.locked-<time>-<random>` beside it
 *    (`archiveSealedStore`): never over anything, never deleting, and a crash
 *    leaves the bytes under at least one name. It is not atomic, and a
 *    directory that cannot be synced is reported. The archive stays,
 *    excluded from backups, until the operator deletes it; the printed `mv`
 *    undoes the reset.
 *
 * The next save seals under the key file that is there, or makes a new one
 * when none is.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { credentialsUnavailable, SECRET_STORE_FILE_NAME } from "@volli/host-core/secrets";

import { HostdBootError } from "./boot-error";
import { acquireInstanceLock } from "./instance-lock";
import { openHeadlessSecrets } from "./secrets";

export interface CredentialsResetCommand {
  readonly kind: "credentials-reset";
  readonly dataDir: string;
  /** `--yes`: the operator accepts that saved secrets must be entered again. */
  readonly confirmed: boolean;
}

export interface CredentialsResetIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Exit codes: 0 reset or nothing to reset, 1 refused or failed. */
export function runCredentialsReset(
  command: CredentialsResetCommand,
  io: CredentialsResetIo,
): number {
  const { dataDir } = command;
  const unsafe = unsafeDataDir(dataDir);
  if (unsafe !== null) {
    io.err(`volli-hostd: ${unsafe}\n`);
    return 1;
  }
  let lock;
  try {
    lock = acquireInstanceLock(dataDir);
  } catch (error) {
    io.err(`volli-hostd: ${(error as HostdBootError).message} Stop it before a reset.\n`);
    return 1;
  }
  try {
    const secrets = openHeadlessSecrets(dataDir, io.env);
    const { status } = secrets;
    if (!credentialsUnavailable(status)) {
      io.out(`Saved credentials are ${status.state}; there is nothing to reset.\n`);
      return 0;
    }
    io.out(
      `Saved credentials are ${status.state}${status.reason === null ? "" : ` (${status.reason})`}.\n` +
        `${secrets.problem}\n`,
    );
    if (status.state === "refused") {
      io.err(
        "A reset cannot fix a refused key configuration, so nothing was moved. Fix it, " +
          "then restart hostd.\n",
      );
      return 1;
    }
    if (!command.confirmed) {
      io.err(
        "A reset sets the sealed store aside, keeps it, and starts with no saved secrets: " +
          "every Project and Always secret is entered again. If the key file is only " +
          "misplaced, put it back and restart instead. To reset, run again with --yes.\n",
      );
      return 1;
    }
    let reset;
    try {
      reset = secrets.store.reset(io.now());
    } catch (error) {
      io.err(`volli-hostd: ${(error as Error).message}\n`);
      return 1;
    }
    const store = join(dataDir, SECRET_STORE_FILE_NAME);
    if (reset.archive !== null) {
      const archive = join(dataDir, reset.archive);
      io.out(
        `Set ${store} aside as ${archive}.\n` +
          "To undo, with hostd stopped and before any secret is saved again: " +
          `mv ${shellQuote(archive)} ${shellQuote(store)}\n`,
      );
    }
    if (!reset.synced) {
      io.err(
        "volli-hostd: warning: the data directory could not be synced, so a power cut " +
          "now could leave the store under its old name as well as the new one.\n",
      );
    }
    io.out(`Saved credentials are now ${reset.status.state}.\n`);
    if (credentialsUnavailable(reset.status)) io.out(`${secrets.store.problem()}\n`);
    return 0;
  } finally {
    lock.release();
  }
}

/** One POSIX shell word: single-quoted, with each `'` written as `'\''`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Boot's data-directory rule (`prepareDataDir` in `hostd.ts`), without
 * creating anything: a directory another user owns or every user can write
 * is one they could swap the store or key inside.
 */
function unsafeDataDir(dataDir: string): string | null {
  let stat;
  try {
    stat = statSync(dataDir);
  } catch {
    return `The data directory ${dataDir} does not exist, so there is nothing to reset.`;
  }
  if (!stat.isDirectory()) return `The data directory ${dataDir} is not a directory.`;
  const uid = process.getuid!();
  if (stat.uid !== uid) {
    return (
      `The data directory ${dataDir} belongs to uid ${stat.uid}, not to this user ` +
      `(uid ${uid}). Run the reset as the user volli-hostd runs as.`
    );
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o002) !== 0) {
    return (
      `Permissions ${mode.toString(8).padStart(4, "0")} on the data directory ${dataDir} let ` +
      `every user write it, so it will not be used. Run: chmod 700 ${dataDir}`
    );
  }
  return null;
}
