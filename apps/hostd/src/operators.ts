/**
 * The operator verifier store (VC-623): who may write to this host's board as
 * the person, kept as hashes in a root-owned file.
 *
 * ## The trust model
 *
 * - `sudo volli-hostd operator-token --for <login>` (`operator-token.ts`) mints
 *   256 bits of randomness, writes the plaintext to that login's own 0600 file,
 *   and appends a VERIFIER — `sha256:` and the hex SHA-256 of the token — here.
 * - hostd only ever reads this file. It runs as the service account, the same
 *   account every Session it starts runs as, so this file must be one that
 *   account cannot write: owned by root, written by nobody else, in a directory
 *   the same is true of. hostd refuses to boot on one that is not, and accepts
 *   no operator token while it is not. Whoever can write this file can mint a
 *   person; that is the whole of the reason for the rule.
 * - A hash is enough, and a slow one would buy nothing: the input is 256 random
 *   bits, not a password, so there is no dictionary to make expensive. The
 *   comparison is constant time across every entry, so a request learns
 *   nothing from how long its refusal took.
 * - It is read again for every request that presents an operator token, so a
 *   revocation (`--revoke`, or deleting the line by hand) holds from the next
 *   request, with no reload and no restart.
 *
 * ## The file
 *
 * One operator per line, `<login> <uid> sha256:<64 hex> <issued ISO time>`,
 * `#` comments and blank lines ignored. A line that does not parse makes the
 * whole file unusable rather than being skipped: a hand edit that broke one
 * entry must be noticed, not half-applied.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { HostdBootError } from "./boot-error";
import type { HostdLogger } from "./log";

/**
 * Where the verifiers live unless `--operators` says otherwise: directly in
 * `/etc`, which root owns and nobody else writes. Not under `/etc/volli-hostd`,
 * which the README tells an operator to give the service account for its key.
 */
export const DEFAULT_OPERATORS_FILE = "/etc/volli-hostd-operators";

/** A token's visible prefix: lets a person and a secret scanner recognise one. */
export const OPERATOR_TOKEN_PREFIX = "volli_op_";

/** 256 bits. */
const TOKEN_BYTES = 32;

/** Far past any token this host mints; a longer one is not hashed at all. */
const MAX_TOKEN_LENGTH = 256;

const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const VERIFIER = /^sha256:([0-9a-f]{64})$/;

export interface OperatorEntry {
  readonly login: string;
  /** The login's uid when the token was issued: evidence for the single-user warning. */
  readonly uid: number;
  /** `sha256:<hex>`. */
  readonly verifier: string;
  readonly issuedAt: string;
}

export function isOperatorLogin(login: string): boolean {
  return LOGIN.test(login);
}

/** A fresh operator token: the prefix and 256 random bits, base64url. */
export function mintOperatorToken(): string {
  return `${OPERATOR_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function operatorVerifier(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Parses the file's text, or throws a sentence naming the first bad line. */
export function parseOperators(text: string): OperatorEntry[] {
  const entries: OperatorEntry[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const [login, uid, verifier, issuedAt, ...rest] = line.split(/\s+/);
    if (
      rest.length > 0 ||
      issuedAt === undefined ||
      !isOperatorLogin(login!) ||
      !/^\d+$/.test(uid!) ||
      !VERIFIER.test(verifier!)
    ) {
      throw new Error(`line ${index + 1} is not \`<login> <uid> sha256:<hex> <issued>\``);
    }
    if (seen.has(login!)) throw new Error(`line ${index + 1} names ${login} a second time`);
    seen.add(login!);
    entries.push({ login: login!, uid: Number(uid), verifier: verifier!, issuedAt });
  });
  return entries;
}

export function formatOperators(entries: readonly OperatorEntry[]): string {
  return [
    "# volli-hostd operator verifiers (VC-623). Written by",
    "# `sudo volli-hostd operator-token`; delete a line to revoke it.",
    "# <login> <uid> sha256:<hex of the token's SHA-256> <issued>",
    ...entries.map((entry) => `${entry.login} ${entry.uid} ${entry.verifier} ${entry.issuedAt}`),
    "",
  ].join("\n");
}

export type OperatorsFileState =
  | { readonly state: "absent" }
  | { readonly state: "ok"; readonly entries: readonly OperatorEntry[] }
  | { readonly state: "unsafe"; readonly reason: string };

/**
 * Reads the operators file, judging it before believing it: a regular file,
 * owned by `trustedOwnerUid` (root in production), that neither group nor
 * others can write, in a directory with the same three properties.
 */
export function inspectOperatorsFile(path: string, trustedOwnerUid: number): OperatorsFileState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unsafe", reason: `${path} could not be read: ${(error as Error).message}` };
  }
  const unsafeOwnership = (what: string, uid: number, mode: number): string | null => {
    if (uid !== trustedOwnerUid) {
      return `${what} belongs to uid ${uid}, not to uid ${trustedOwnerUid}, so its owner could add an operator`;
    }
    if ((mode & 0o022) !== 0) {
      return `${what} can be written by its group or other users (mode ${(mode & 0o777).toString(8).padStart(4, "0")})`;
    }
    return null;
  };
  if (!stat.isFile()) return { state: "unsafe", reason: `${path} is not a regular file` };
  const fileFault = unsafeOwnership(path, stat.uid, stat.mode);
  if (fileFault !== null) return { state: "unsafe", reason: fileFault };
  const directory = dirname(path);
  const parent = statSync(directory);
  const directoryFault = unsafeOwnership(`its directory ${directory}`, parent.uid, parent.mode);
  if (directoryFault !== null) return { state: "unsafe", reason: directoryFault };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { state: "unsafe", reason: `${path} could not be read: ${(error as Error).message}` };
  }
  try {
    return { state: "ok", entries: parseOperators(text) };
  } catch (error) {
    return { state: "unsafe", reason: `${path}: ${(error as Error).message}` };
  }
}

/**
 * The login a token was issued to, comparing against EVERY entry in constant
 * time and without stopping at a match.
 */
export function matchOperator(
  entries: readonly OperatorEntry[],
  token: string,
): OperatorEntry | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const presented = Buffer.from(operatorVerifier(token), "utf8");
  let matched: OperatorEntry | null = null;
  for (const entry of entries) {
    const stored = Buffer.from(entry.verifier, "utf8");
    // Every verifier is `sha256:` and 64 hex digits, so the lengths agree.
    if (timingSafeEqual(presented, stored)) matched = entry;
  }
  return matched;
}

export interface HostdOperators {
  /** The door's verifier: re-reads the file, so a revocation holds at once. */
  verify(token: string): { login: string } | null;
}

/**
 * Judges the operators file at boot, refusing to start on an unsafe one, and
 * returns the verifier the agent socket's door asks per request.
 */
export function openOperators(options: {
  readonly path: string;
  readonly trustedOwnerUid: number;
  readonly processUid: number;
  readonly logger: HostdLogger;
}): HostdOperators {
  const { path, trustedOwnerUid, processUid, logger } = options;
  const boot = inspectOperatorsFile(path, trustedOwnerUid);
  if (boot.state === "unsafe") {
    throw new HostdBootError(
      "operators",
      `Refusing the operators file: ${boot.reason}. Run: sudo chown root:root ${path} && sudo chmod go-w ${path}`,
      { operatorsFile: path },
    );
  }
  if (boot.state === "absent") {
    logger.info("no operators file: this host accepts no operator token", { operatorsFile: path });
  } else {
    logger.info("operators file read", {
      operatorsFile: path,
      operators: boot.entries.map((entry) => entry.login),
    });
    // The documented limit, said where it applies: an operator who IS the
    // service account shares a uid with every Session, which can then read
    // the token file. Nothing separates them; the token still proves only
    // that someone with that uid is acting.
    const sameUid = boot.entries.filter((entry) => entry.uid === processUid);
    if (sameUid.length > 0 || processUid === trustedOwnerUid) {
      logger.warn(
        "operator and Sessions are not separated: an operator shares this host's uid, or the host runs as the operators file's owner",
        { operators: sameUid.map((entry) => entry.login), uid: processUid },
      );
    }
  }
  return {
    verify(token) {
      const current = inspectOperatorsFile(path, trustedOwnerUid);
      if (current.state === "unsafe") {
        logger.error("operator token refused: the operators file is unsafe", {
          reason: current.reason,
        });
        return null;
      }
      const matched = current.state === "ok" ? matchOperator(current.entries, token) : null;
      if (matched === null) {
        logger.warn("operator token refused: not issued by this host, or revoked");
        return null;
      }
      return { login: matched.login };
    },
  };
}
