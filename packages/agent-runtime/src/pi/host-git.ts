/**
 * The parts of the user's git configuration a contained `git` is handed
 * (VC-45).
 *
 * A Scoped Session cannot read `~/.gitconfig` — it is on the denylist, since
 * it can carry a credential in a URL rewrite — and git refuses to run at all
 * when its global config exists and cannot be read. So a contained git is
 * pointed at NO global config (`GIT_CONFIG_GLOBAL=/dev/null`) and handed,
 * through `GIT_CONFIG_COUNT`, exactly the settings that change what it does to
 * the user's work, read here on the host where the file is readable:
 *
 * - **Commit identity**, as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
 * - **`core.excludesFile` and `core.attributesFile`**, whose files the runtime
 *   grants read-only. Pointing them at `/dev/null` let `git add -A` commit a
 *   globally ignored `.env.local`.
 * - **`safe.directory`**, so a repository owned by another account still opens.
 * - **`commit.gpgsign` / `tag.gpgsign`.** Passed through so a contained commit
 *   that should be signed FAILS — the signing key and agent are out of reach —
 *   rather than silently producing an unsigned commit.
 *
 * Deliberately never passed: `core.hooksPath`, `core.fsmonitor`, credential
 * helpers, aliases, `url.*.insteadOf` — anything that runs a program or holds
 * a credential stays outside the walls.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** The commit identity a contained `git` is handed in place of the denied `~/.gitconfig`. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** What the host's git configuration contributes to a contained git. */
export interface HostGitSettings {
  identity: GitIdentity | null;
  /** An existing excludes file, or null. */
  excludesFile: string | null;
  /** An existing attributes file, or null. */
  attributesFile: string | null;
  safeDirectories: readonly string[];
  signCommits: boolean;
  signTags: boolean;
}

/** No settings at all: what a contained git gets when nothing could be read. */
export const NO_HOST_GIT: HostGitSettings = {
  identity: null,
  excludesFile: null,
  attributesFile: null,
  safeDirectories: [],
  signCommits: false,
  signTags: false,
};

type GitConfigReader = (args: readonly string[]) => Promise<string>;

function hostReader(root: string): GitConfigReader {
  const run = promisify(execFile);
  return async (args) => {
    try {
      return (await run("git", ["config", ...args], { cwd: root, timeout: 5_000 })).stdout;
    } catch {
      return "";
    }
  };
}

/** The XDG default for a per-user git file, when it exists. */
function xdgGitFile(name: string, environment: NodeJS.ProcessEnv): string | null {
  const configHome = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const path = join(configHome, "git", name);
  return existsSync(path) ? path : null;
}

/** An existing configured path, or the XDG default, or null. */
function existingOr(configured: string, fallback: string | null): string | null {
  const path = configured.trim();
  if (path !== "") return existsSync(path) ? path : null;
  return fallback;
}

/**
 * Read the host's git settings for `root`, outside any sandbox. Never rejects:
 * a setting that cannot be read is a setting not handed over.
 */
export async function readHostGitSettings(
  root: string,
  read: GitConfigReader = hostReader(root),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostGitSettings> {
  const [name, email, excludes, attributes, safe, signCommits, signTags] = await Promise.all([
    read(["--get", "user.name"]),
    read(["--get", "user.email"]),
    read(["--get", "--path", "core.excludesFile"]),
    read(["--get", "--path", "core.attributesFile"]),
    read(["--get-all", "safe.directory"]),
    read(["--get", "--bool", "commit.gpgsign"]),
    read(["--get", "--bool", "tag.gpgsign"]),
  ]);
  return {
    identity:
      name.trim() !== "" && email.trim() !== "" ? { name: name.trim(), email: email.trim() } : null,
    excludesFile: existingOr(excludes, xdgGitFile("ignore", environment)),
    attributesFile: existingOr(attributes, xdgGitFile("attributes", environment)),
    safeDirectories: safe
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    signCommits: signCommits.trim() === "true",
    signTags: signTags.trim() === "true",
  };
}

/** The files a contained git must be able to read: the global excludes and attributes. */
export function hostGitReadables(settings: HostGitSettings): string[] {
  return [settings.excludesFile, settings.attributesFile].filter(
    (path): path is string => path !== null,
  );
}

/** The environment a contained `git` is handed, from the host's settings. */
export function gitVariables(settings: HostGitSettings): Record<string, string> {
  const entries: [string, string][] = [
    ["core.excludesFile", settings.excludesFile ?? "/dev/null"],
    ["core.attributesFile", settings.attributesFile ?? "/dev/null"],
    ...settings.safeDirectories.map((directory): [string, string] => ["safe.directory", directory]),
    ...(settings.signCommits ? [["commit.gpgsign", "true"] as [string, string]] : []),
    ...(settings.signTags ? [["tag.gpgsign", "true"] as [string, string]] : []),
  ];
  const variables: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  for (const [index, [key, value]] of entries.entries()) {
    variables[`GIT_CONFIG_KEY_${index}`] = key;
    variables[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (settings.identity !== null) {
    variables.GIT_AUTHOR_NAME = settings.identity.name;
    variables.GIT_AUTHOR_EMAIL = settings.identity.email;
    variables.GIT_COMMITTER_NAME = settings.identity.name;
    variables.GIT_COMMITTER_EMAIL = settings.identity.email;
  }
  return variables;
}
