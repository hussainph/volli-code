/**
 * Runner-managed clones: how a runner with no folder of the person's (a Linux
 * box, a VPS) gets a project's repository.
 *
 * One clone per repository, under the runner's data directory:
 *
 * - `<root>/<repoId>.git` — a bare repository holding the objects every
 *   working copy shares. Its only refs are origin's, fetched into
 *   `refs/remotes/origin/*` (no local branches shadow them), so a new ticket
 *   branch starts from what is pushed, never from a stale local `main`.
 * - `<root>/<repoId>` — a detached worktree at origin's default branch. It is
 *   the checkout the location resolver registers (kind `managed_clone`):
 *   ticket worktrees are added from it, and a project Session works in it.
 *   While it is detached and clean, each refresh moves it to origin's newest
 *   default branch.
 *
 * The first clone is staged in a temporary sibling and renamed into place, so
 * a crash never leaves a half-fetched repository that looks finished. A later
 * refresh fetches; if that fails, the working copies already on disk keep
 * working from what was fetched last, and the failure is reported to
 * `onWarning`.
 *
 * Network git here runs as the runner itself, never as an agent: the GitHub
 * token (from {@link ManagedCloneCredentials}) rides in command-scope
 * configuration for that one command (`http.<origin>.extraHeader`), never in
 * a URL, an argument or a file. Without one, the box's own git credentials
 * apply (a user install's `~/.gitconfig` and SSH keys).
 *
 * Commits made in these clones carry a `Co-authored-by: Volli` trailer: the
 * bare repository's `prepare-commit-msg` hook adds it. A repository that sets
 * its own `core.hooksPath` replaces the hook, and the trailer with it. Volli
 * never commits or pushes here on its own.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeGitRemoteUrl, type RunnerGithubTokenClaim } from "@volli/shared/cloud";

import { appendGitConfig } from "../host-sign-ins/git-credentials";

/** The trailer the hook adds. */
export const VOLLI_CO_AUTHOR_TRAILER = "Co-authored-by: Volli <noreply@volli.app>";

/** How long one network git command (clone, fetch) may run: a first-attach preparation's ceiling. */
export const MANAGED_CLONE_NETWORK_TIMEOUT_MS = 10 * 60_000;
/** How long one local git command may run. */
const LOCAL_TIMEOUT_MS = 120_000;

/** Git as the runner runs it here: arguments, a directory, extra environment. Rejects on failure. */
export type RunnerGit = (
  args: readonly string[],
  options: { cwd: string; env?: Readonly<Record<string, string>>; timeoutMs?: number },
) => Promise<string>;

export class ManagedCloneGitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ManagedCloneGitError";
  }
}

/**
 * The real {@link RunnerGit}: `execFile`, no shell, git's terminal prompt
 * off, the process environment plus the command's own. A failure names the
 * git subcommand and carries git's stderr, never the environment.
 */
export function createRunnerGit(options: { file?: string } = {}): RunnerGit {
  const file = options.file ?? "git";
  return (args, { cwd, env = {}, timeoutMs = LOCAL_TIMEOUT_MS }) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const verb = args.find((arg) => !arg.startsWith("-")) ?? "git";
          const trimmed = stderr.trim();
          reject(
            new ManagedCloneGitError(
              `git ${verb} failed${trimmed === "" ? "" : `: ${trimmed.split("\n").at(-1)}`}`,
              stderr,
            ),
          );
        },
      );
    });
}

/** What a runner's own clone or fetch authenticates with: a token for one host, or `null`. */
export interface ManagedCloneCredentials {
  forRemote(input: {
    remoteUrl: string;
    projectRepoId: string;
    claim: RunnerGithubTokenClaim;
  }): Promise<{ host: string; token: string } | null>;
}

export class ManagedCloneUnavailable extends Error {
  readonly code = "managed_clone_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ManagedCloneUnavailable";
  }
}

export interface ManagedCloneOptions {
  /** `<data>/repos`: absolute. */
  root: string;
  git?: RunnerGit;
  credentials?: ManagedCloneCredentials;
  onWarning?(message: string, error: unknown): void;
}

export interface ManagedCloneRequest {
  projectRepoId: string;
  remoteUrl: string;
  claim: RunnerGithubTokenClaim;
}

const HOOK = `#!/bin/sh
# Installed by Volli in this runner-managed clone: credits Volli on commits made here.
case "$2" in merge|squash) exit 0 ;; esac
exec git interpret-trailers --in-place --if-exists addIfDifferent --trailer '${VOLLI_CO_AUTHOR_TRAILER}' "$1"
`;

/** The `scheme://host/` an HTTP remote's credentials are scoped to, or `null` for other transports. */
function httpOrigin(remoteUrl: string): { origin: string; host: string } | null {
  if (!/^https?:\/\//iu.test(remoteUrl)) return null;
  const url = new URL(remoteUrl);
  return { origin: `${url.protocol}//${url.host}/`, host: url.host };
}

export function createManagedClones(options: ManagedCloneOptions) {
  const git = options.git ?? createRunnerGit();
  const flights = new Map<string, Promise<{ checkoutPath: string; created: boolean }>>();

  const checkoutPath = (projectRepoId: string) => join(options.root, projectRepoId);
  const commonDir = (projectRepoId: string) => join(options.root, `${projectRepoId}.git`);

  /** Command-scope configuration authenticating this remote's fetch, or nothing. */
  async function authEnv(request: ManagedCloneRequest): Promise<Record<string, string>> {
    const http = httpOrigin(request.remoteUrl);
    if (http === null || options.credentials === undefined) return {};
    const credential = await options.credentials.forRemote(request);
    if (credential === null || credential.host !== http.host) return {};
    const basic = Buffer.from(`x-access-token:${credential.token}`).toString("base64");
    return appendGitConfig({}, [
      [`http.${http.origin}.extraHeader`, `AUTHORIZATION: basic ${basic}`],
    ]);
  }

  async function fetchOrigin(directory: string, request: ManagedCloneRequest): Promise<void> {
    const env = await authEnv(request);
    const network = { cwd: directory, env, timeoutMs: MANAGED_CLONE_NETWORK_TIMEOUT_MS };
    await git(["fetch", "--prune", "--no-tags", "origin"], network);
    // origin/HEAD names the default branch; an empty repository has none yet.
    await git(["remote", "set-head", "origin", "--auto"], network).catch(() => undefined);
  }

  async function stage(request: ManagedCloneRequest): Promise<void> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const staging = join(options.root, `.${request.projectRepoId}.${randomUUID()}.tmp.git`);
    try {
      await git(["init", "--quiet", "--bare", staging], { cwd: options.root });
      const local = { cwd: staging };
      await git(["config", "remote.origin.url", request.remoteUrl], local);
      await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], local);
      await git(["config", "volli.managedClone", "true"], local);
      await fetchOrigin(staging, request);
      const hook = join(staging, "hooks", "prepare-commit-msg");
      await mkdir(join(staging, "hooks"), { recursive: true });
      await writeFile(hook, HOOK, { mode: 0o755 });
      await chmod(hook, 0o755);
      await rename(staging, commonDir(request.projectRepoId));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async function defaultStart(bare: string, remoteUrl: string): Promise<string> {
    const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
      cwd: bare,
    }).then(
      (out) => out.trim(),
      () => "",
    );
    if (head !== "") return head;
    const refs = (
      await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"], { cwd: bare })
    )
      .split("\n")
      .filter((ref) => ref !== "" && ref !== "refs/remotes/origin/HEAD");
    if (refs.length === 0) {
      throw new ManagedCloneUnavailable(`${remoteUrl} has no branches to work from yet.`);
    }
    return refs.includes("refs/remotes/origin/main") ? "refs/remotes/origin/main" : refs[0]!;
  }

  /** Moves a detached, clean main worktree to origin's newest default branch. */
  async function advance(directory: string, bare: string, remoteUrl: string): Promise<void> {
    const attached = await git(["symbolic-ref", "--quiet", "HEAD"], { cwd: directory }).then(
      () => true,
      () => false,
    );
    if (attached) return;
    const status = await git(["status", "--porcelain", "--untracked-files=no"], {
      cwd: directory,
    });
    if (status.trim() !== "") return;
    const start = await defaultStart(bare, remoteUrl);
    await git(["checkout", "--quiet", "--detach", start], { cwd: directory });
  }

  async function run(request: ManagedCloneRequest) {
    if (normalizeGitRemoteUrl(request.remoteUrl, []) === null) {
      throw new ManagedCloneUnavailable(
        "This project's remote isn't one a runner can clone. Push it to a git host.",
      );
    }
    const bare = commonDir(request.projectRepoId);
    const directory = checkoutPath(request.projectRepoId);
    let created = false;
    let fetched = false;
    if (!existsSync(join(bare, "HEAD"))) {
      await stage(request);
      created = true;
      fetched = true;
    } else {
      await git(["config", "remote.origin.url", request.remoteUrl], { cwd: bare });
      try {
        await fetchOrigin(bare, request);
        fetched = true;
      } catch (error) {
        if (!existsSync(directory)) throw error;
        options.onWarning?.(
          "Couldn't refresh a managed clone; using what was fetched last.",
          error,
        );
      }
    }
    if (!existsSync(directory)) {
      await git(["worktree", "prune"], { cwd: bare });
      const start = await defaultStart(bare, request.remoteUrl);
      await git(["worktree", "add", "--quiet", "--detach", directory, start], { cwd: bare });
    } else if (fetched) {
      await advance(directory, bare, request.remoteUrl).catch((error: unknown) =>
        options.onWarning?.("Couldn't move a managed clone to origin's newest commit.", error),
      );
    }
    return { checkoutPath: directory, created };
  }

  return {
    root: options.root,
    /** The registered checkout of a repository's managed clone: its main worktree. */
    checkoutPath,
    /**
     * Clones the repository on first use, otherwise refreshes it, and returns
     * its main worktree. Single-flight per repository.
     */
    ensure(request: ManagedCloneRequest): Promise<{ checkoutPath: string; created: boolean }> {
      const existing = flights.get(request.projectRepoId);
      if (existing !== undefined) return existing;
      const flight = run(request).finally(() => flights.delete(request.projectRepoId));
      flights.set(request.projectRepoId, flight);
      return flight;
    },
  };
}

export type ManagedClones = ReturnType<typeof createManagedClones>;
