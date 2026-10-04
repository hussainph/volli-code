/**
 * `volli-hostd operator-token`: issue and revoke the operator token (VC-623).
 *
 *   sudo volli-hostd operator-token --for <login>
 *   sudo volli-hostd operator-token --revoke <login>
 *
 * Run as root, and only as root. Issuing is the one act that makes a person
 * out of a credential, so it happens at the host's shell with root's
 * authority, never over the socket (no verb mints) and never as the service
 * account (which owns nothing this writes). It:
 *
 * 1. refuses the service account itself, which is what every Session runs as;
 * 2. mints 256 random bits, and writes them to `~<login>/.config/volli/
 *    operator-token` BY A CHILD RUNNING AS THAT LOGIN — root never follows a
 *    path a user controls, so a symlink planted there can only ever point the
 *    write at something the user could already write;
 * 3. only then records the verifier (a SHA-256) in the root-owned operators
 *    file, atomically: a temporary file in the same directory, renamed over.
 *
 * Re-issuing for a login replaces its entry, so the previous token stops
 * working. hostd re-reads the file per request: neither act needs a restart.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

import { OPERATOR_TOKEN_HOME_PATH } from "@volli/shared";

import {
  formatOperators,
  inspectOperatorsFile,
  isOperatorLogin,
  mintOperatorToken,
  operatorVerifier,
  type OperatorEntry,
} from "./operators";

export interface OperatorTokenCommand {
  readonly kind: "operator-token";
  readonly action: "issue" | "revoke";
  readonly login: string;
  readonly operatorsFile: string;
  /** The account hostd and its Sessions run as; never issued a token. */
  readonly serviceUser: string;
}

export interface SystemUser {
  readonly login: string;
  readonly uid: number;
  readonly gid: number;
}

export interface OperatorTokenPorts {
  /** The uid this command runs as. */
  readonly uid: () => number;
  /** Root's uid in production; a test names its own. Owns the operators file. */
  readonly rootUid: number;
  readonly lookupUser: (login: string) => SystemUser | null;
  /** Writes the token as `user`, answering the path written; throws a sentence. */
  readonly writeTokenAsUser: (user: SystemUser, token: string) => string;
  readonly now: () => Date;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** sysexits' `EX_NOPERM`: not run as root. */
export const EXIT_NOPERM = 77;

export function runOperatorToken(command: OperatorTokenCommand, ports: OperatorTokenPorts): number {
  const fail = (message: string, code = 1): number => {
    ports.err(`volli-hostd operator-token: ${message}\n`);
    return code;
  };
  if (ports.uid() !== ports.rootUid) {
    return fail(
      "run it as root (sudo): it writes the root-owned operators file, which is what keeps the service account from minting one.",
      EXIT_NOPERM,
    );
  }
  const { login, operatorsFile } = command;
  if (!isOperatorLogin(login)) return fail(`${JSON.stringify(login)} is not a login name.`);
  const current = inspectOperatorsFile(operatorsFile, ports.rootUid);
  if (current.state === "unsafe") return fail(`not writing to it: ${current.reason}.`);
  const entries = current.state === "ok" ? current.entries : [];
  const service = ports.lookupUser(command.serviceUser);

  if (command.action === "revoke") {
    if (!entries.some((entry) => entry.login === login)) {
      ports.out(`${login} holds no operator token in ${operatorsFile}; nothing to revoke.\n`);
      return 0;
    }
    writeOperatorsFile(
      operatorsFile,
      entries.filter((entry) => entry.login !== login),
      ports.rootUid,
      service,
    );
    ports.out(
      `Revoked ${login}'s operator token. hostd refuses it from the next request.\n` +
        `Their token file is now inert; they may delete ~/${OPERATOR_TOKEN_HOME_PATH.join("/")}.\n`,
    );
    return 0;
  }

  const user = ports.lookupUser(login);
  if (user === null) return fail(`no user named ${login} on this host.`);
  if (login === command.serviceUser || (service !== null && service.uid === user.uid)) {
    return fail(
      `${login} is the service account hostd and every Session run as; it is never issued an operator token. Name the person's own login.`,
    );
  }
  if (service === null) {
    ports.err(
      `volli-hostd operator-token: no service account named ${command.serviceUser}, so the token's owner could not be checked against it (pass --service-user).\n`,
    );
  }
  const token = mintOperatorToken();
  let written: string;
  try {
    written = ports.writeTokenAsUser(user, token);
  } catch (error) {
    return fail(`could not write ${login}'s token file: ${(error as Error).message}`);
  }
  const entry: OperatorEntry = {
    login,
    uid: user.uid,
    verifier: operatorVerifier(token),
    issuedAt: ports.now().toISOString(),
  };
  writeOperatorsFile(
    operatorsFile,
    [...entries.filter((existing) => existing.login !== login), entry],
    ports.rootUid,
    service,
  );
  ports.out(
    [
      `Issued an operator token for ${login}.`,
      `  token     ${written} (0600, readable by ${login} alone)`,
      `  verifier  ${operatorsFile}`,
      "hostd reads the verifier on every request: no restart is needed.",
      `${login} reaches the socket through its group: sudo usermod -aG ${command.serviceUser} ${login}, then log in again.`,
      `Revoke it with: sudo volli-hostd operator-token --revoke ${login}`,
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Replaces the operators file atomically, owned by root and readable by the
 * service account's group (or by everyone, when there is no such account: the
 * file holds hashes of 256-bit secrets, never a secret).
 */
function writeOperatorsFile(
  path: string,
  entries: readonly OperatorEntry[],
  rootUid: number,
  service: SystemUser | null,
): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, formatOperators(entries));
    // Created by root, so owned by root; only the group needs naming.
    if (service !== null) fchownSync(fd, rootUid, service.gid);
    fchmodSync(fd, service === null ? 0o644 : 0o640);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** `id -u` and `id -g`, which every Linux and macOS host has. */
export function lookupSystemUser(login: string): SystemUser | null {
  const id = (flag: string): number | null => {
    const result = spawnSync("id", [flag, login], { encoding: "utf8" });
    const value = result.stdout.trim();
    return result.status === 0 && /^\d+$/.test(value) ? Number(value) : null;
  };
  const uid = id("-u");
  const gid = id("-g");
  return uid === null || gid === null ? null : { login, uid, gid };
}

/**
 * The child that writes the token, running as the operator. Its home comes
 * from the password database (`os.userInfo`), never from root's environment.
 * It creates `~/.config/volli` 0700, writes a fresh 0600 file beside the old
 * one, and renames it into place, printing the path.
 */
const WRITE_TOKEN_AS_USER = `
try {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const segments = ${JSON.stringify(OPERATOR_TOKEN_HOME_PATH)};
  const home = process.argv[1] || os.userInfo().homedir;
  const file = path.join(home, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const token = fs.readFileSync(0, "utf8");
  const temporary = file + "." + process.pid + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  fs.writeSync(fd, token + "\\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(temporary, file);
  process.stdout.write(file);
} catch (error) {
  process.stderr.write(String(error && error.message));
  process.exit(1);
}
`;

/**
 * Runs {@link WRITE_TOKEN_AS_USER} as `user`, with the token on stdin rather
 * than argv (which `ps` shows every user). `home` is empty in production,
 * which means the password database's answer; a test names a scratch one.
 */
export function writeTokenAsUser(user: SystemUser, token: string, home: string): string {
  const result = spawnSync(process.execPath, ["-e", WRITE_TOKEN_AS_USER, home], {
    uid: user.uid,
    gid: user.gid,
    cwd: "/",
    env: {},
    input: token,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  // The child reports its own failure as one sentence on stderr.
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
