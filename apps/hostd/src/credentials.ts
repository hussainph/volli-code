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
 * 1. takes the data directory's instance lock, so it never races a running
 *    host over the sealed file;
 * 2. opens saved credentials exactly as hostd's boot does, and does nothing
 *    when they open (`ready`) or there are none (`empty`);
 * 3. without `--yes`, says what it found and what a reset would do, and stops;
 * 4. with `--yes`, moves the sealed file aside to
 *    `session-secrets.enc.locked-<time>-<random>` beside it. Nothing is
 *    deleted: the archive stays, excluded from backups, until the operator
 *    deletes it, and moving it back undoes the reset.
 *
 * The next save seals under the key file that is there, or makes a new one
 * when none is. A key file that is unsafe (`refused`) still has to be fixed:
 * a reset does not make Volli use it.
 */
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
      io.out(`Set ${store} aside as ${archive}. To undo: mv ${archive} ${store}\n`);
    }
    io.out(`Saved credentials are now ${reset.status.state}.\n`);
    if (credentialsUnavailable(reset.status)) io.out(`${secrets.store.problem()}\n`);
    return 0;
  } finally {
    lock.release();
  }
}
