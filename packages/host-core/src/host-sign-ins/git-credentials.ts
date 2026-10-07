/**
 * Git push credentials on a host, and the credential helper Volli controls
 * (VC-702).
 *
 * A Session's `git push` over HTTPS asks git's credential helpers for a user
 * and password. A Session on a host has no person's SSH key and no keychain,
 * so the host injects one helper of its own into every Session command's
 * environment, as command-scope git configuration (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, git 2.31+), and that helper
 * answers from the host's push-credential store. Nothing is written into a
 * repository's or the service user's git configuration, and a token is never
 * put in a remote URL.
 *
 * The helper speaks git's credential protocol (`gitcredentials(7)`): `get`
 * answers the stored user and password for an `https` request to a host it
 * holds; `store` and `erase` are ignored, because the person, not git,
 * decides what this store holds. A plain-`http` request is never answered.
 *
 * Not a sandbox: a Session can run `git credential fill` and read the token,
 * exactly as it could read git's own `store` file. The trust boundary is the
 * one the person accepted when they sent it: "<host> keeps a copy of what
 * this Mac sends."
 */
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeGitHost } from "@volli/shared";

import type { GitCredential, GitCredentialStore } from "./ports";

/** The store's file under a host's data directory: refused to the agent's read tools by name. */
export const GIT_CREDENTIALS_FILE = join("credentials", "git-push.json");

interface GitCredentialFile {
  readonly version: 1;
  readonly hosts: Readonly<Record<string, GitCredential>>;
}

/** Whether a user or password can travel in git's line protocol. */
export function gitCredentialFieldValid(value: string): boolean {
  return value.length > 0 && !/[\n\r\0]/u.test(value);
}

/**
 * A push-credential store in one JSON file, mode 0600, its directory 0700.
 * Every write replaces the file atomically (a temporary sibling, then a
 * rename), so a reader never sees half a file. Writes in this process are
 * serialized; the credential helper only reads.
 */
export function fileGitCredentialStore(path: string): GitCredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<GitCredentialFile> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hosts: {} };
      throw error;
    }
    return parseCredentialFile(text);
  };
  const write = async (file: GitCredentialFile): Promise<void> => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.git-push-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  return {
    hosts: async () => Object.keys((await read()).hosts).toSorted(),
    get: async (host) => {
      const key = normalizeGitHost(host);
      if (key === null) return null;
      const stored = (await read()).hosts[key];
      return stored === undefined ? null : { username: stored.username, password: stored.password };
    },
    set: (host, credential) =>
      serialized(async () => {
        const key = requireHost(host);
        if (
          !gitCredentialFieldValid(credential.username) ||
          !gitCredentialFieldValid(credential.password)
        ) {
          throw new Error("A git credential's user and password must be one line each.");
        }
        const current = await read();
        await write({
          version: 1,
          hosts: {
            ...current.hosts,
            [key]: { username: credential.username, password: credential.password },
          },
        });
      }),
    clear: (host) =>
      serialized(async () => {
        const key = requireHost(host);
        const current = await read();
        if (!Object.hasOwn(current.hosts, key)) return;
        const hosts = { ...current.hosts };
        delete hosts[key];
        await write({ version: 1, hosts });
      }),
  };
}

function requireHost(host: string): string {
  const key = normalizeGitHost(host);
  if (key === null) throw new Error("Not a git host name.");
  return key;
}

/** Reads the store's file, refusing anything but its own shape. Never echoes the text. */
function parseCredentialFile(text: string): GitCredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The git push-credential store is not valid JSON.");
  }
  const hosts =
    parsed !== null && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1
      ? (parsed as { hosts?: unknown }).hosts
      : undefined;
  if (hosts === null || typeof hosts !== "object" || Array.isArray(hosts)) {
    throw new Error("The git push-credential store has an unknown shape.");
  }
  const valid: Record<string, GitCredential> = {};
  for (const [host, value] of Object.entries(hosts as Record<string, unknown>)) {
    const username = (value as { username?: unknown } | null)?.username;
    const password = (value as { password?: unknown } | null)?.password;
    if (
      normalizeGitHost(host) === host &&
      typeof username === "string" &&
      typeof password === "string" &&
      gitCredentialFieldValid(username) &&
      gitCredentialFieldValid(password)
    ) {
      valid[host] = { username, password };
    }
  }
  return { version: 1, hosts: valid };
}

/** One request in git's credential protocol: `key=value` lines up to a blank line. */
export function parseGitCredentialRequest(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/u, "");
    if (trimmed === "") break;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    fields.set(trimmed.slice(0, equals), trimmed.slice(equals + 1));
  }
  return fields;
}

/**
 * The helper's answer to one git invocation: what to write on stdout. Only
 * `get` for an `https` request to a stored host is answered; everything else
 * is the empty answer, which tells git this helper has nothing.
 */
export async function answerGitCredential(
  action: string,
  request: ReadonlyMap<string, string>,
  store: Pick<GitCredentialStore, "get">,
): Promise<string> {
  if (action !== "get") return "";
  if (request.get("protocol") !== "https") return "";
  const host = request.get("host");
  if (host === undefined) return "";
  const stored = await store.get(host);
  if (stored === null) return "";
  const asked = request.get("username");
  if (asked !== undefined && asked !== stored.username) return "";
  return `username=${stored.username}\npassword=${stored.password}\n`;
}

/**
 * `base` with command-scope git configuration (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, git 2.31+) appended after
 * whatever it already holds, never over it: every layer that configures a
 * Session's git (a platform's reset of the helper list, then Volli's helper)
 * composes in order, and none overwrites another's count. The one
 * implementation; hostd's agent git environment uses it too.
 */
export function appendGitConfig(
  base: Readonly<Record<string, string>>,
  entries: readonly (readonly [key: string, value: string])[],
): Record<string, string> {
  const held = Number(base["GIT_CONFIG_COUNT"] ?? "0");
  const start = Number.isSafeInteger(held) && held > 0 ? held : 0;
  const out: Record<string, string> = {
    ...base,
    GIT_CONFIG_COUNT: String(start + entries.length),
  };
  entries.forEach(([key, value], offset) => {
    out[`GIT_CONFIG_KEY_${start + offset}`] = key;
    out[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  });
  return out;
}

/**
 * `base` with Volli's helper installed for one command: command-scope git
 * configuration, appended after every file git reads and after any
 * command-scope entries `base` already holds (a reset of the helper list
 * composes before it).
 *
 * `helperCommand` is a `!`-prefixed shell command git runs with the action
 * appended (`!'/opt/volli-hostd/bin/volli-hostd' git-credential --data-dir '…'`).
 */
export function gitCredentialHelperEnv(
  helperCommand: string,
  base: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return appendGitConfig(base, [["credential.helper", helperCommand]]);
}

/** One POSIX shell word. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
