/**
 * The session environment contract (VC-94): what every Volli session gets on
 * `PATH`, identically, and how an agent discovers it without probing failures.
 *
 * This module holds the contract's vocabulary, in one place so the surfaces
 * that speak it cannot drift: `volli identify` reports it, `volli doctor`
 * audits it, and an agent reads either one instead of running a command and
 * learning from the failure. The shared piece is the census of tools a
 * session is expected to be able to run and the one resolution rule for what
 * "found" means — the rest of the contract (the adopted PATH, its
 * provenance, the dependency state) is reported by whoever measured it.
 *
 * Pure by design: no filesystem, no Node APIs. Callers inject the two
 * questions that touch disk (`isExecutable`, `pathExists`) so the rules stay
 * unit-testable and the seams stay visible.
 */

/**
 * The tools every session is expected to be able to run. Deliberately short,
 * and deliberately not a census of the whole PATH: these are the outcomes an
 * agent's first commands depend on — `git` to commit, `gh` to open, inspect
 * and merge PRs, `node` and `pnpm` for the pre-commit hook and every Node
 * project. VC-94's failure presented as exactly this shape: `git` answered
 * from `/usr/bin` while `gh` was missing, so the session looked operational
 * and could not do the one thing it was asked to do.
 */
export const SESSION_ENV_TOOLS = ["git", "gh", "node", "pnpm"] as const;

export type SessionEnvTool = (typeof SESSION_ENV_TOOLS)[number];

/**
 * How a session's resolved PATH came to be what it is — initially the boot
 * adoption outcome, and the latest fresh outcome after `doctor --fix`
 * re-runs that pass (`login-path-adoption.ts`). `probe-failed` is the
 * degradation the contract exists to make loud: the PATH is the host
 * process's, the login shell was never heard from.
 */
export type SessionEnvProvenance = "adopted" | "already-complete" | "probe-failed";

/**
 * The same three words, asked of the SECOND adoption pass (VC-94's A3) — the
 * interactive login shell run once after the first window loads — plus the
 * fourth answer only a second pass can give.
 *
 * Two fields rather than four more values on {@link SessionEnvProvenance},
 * because the two passes are independent questions and their answers form a
 * cross-product: a boot `probe-failed` followed by an interactive `adopted` is
 * an ordinary, recoverable host, and a single string could only name it by
 * inventing a compound vocabulary for every pair. Keeping the boot field's
 * three values meaning exactly what `AGENTS.md` has said they mean since C3 is
 * the other half of the reason.
 *
 * `pending` is the honest answer for a session that asks before the second pass
 * has landed: the PATH may still be missing whatever the user's `.zshrc`
 * exports. It is never a failure, and must not be read as one — the pass runs
 * after the first window precisely so nothing waits on it.
 */
export type SessionEnvInteractiveProvenance = SessionEnvProvenance | "pending";

/**
 * Whether the workspace a session stands in has its dependencies installed.
 * `null` means no package workspace was found, or that the caller had no
 * workspace scope to measure.
 */
export type WorkspaceDependenciesStatus = "installed" | "absent" | null;

/**
 * What an explicit Session PATH repair established. Unlike an
 * {@link SessionEnvReport}, both passes have completed here: `doctor --fix`
 * awaits the fresh non-interactive and interactive answers before it reports.
 *
 * `added` and `interactiveAdded` are evidence, not another outcome vocabulary:
 * the two provenance fields retain the contract's existing three words.
 */
export interface SessionEnvRepair {
  /** The exact PATH new Sessions will receive after both repair passes. */
  path: string;
  /** The fresh non-interactive adoption outcome. */
  provenance: SessionEnvProvenance;
  /** Directories the non-interactive pass made reachable, in PATH order. */
  added: readonly string[];
  /** The fresh interactive adoption outcome; a repair never leaves this pending. */
  interactiveProvenance: SessionEnvProvenance;
  /** Directories the interactive pass made reachable, in PATH order. */
  interactiveAdded: readonly string[];
}

/**
 * The `env` block `volli identify` prints. `tools` keys are the whole
 * {@link SESSION_ENV_TOOLS} census — a missing tool is the entry being
 * `null`, never the entry being absent from the record, so a consumer can
 * tell "measured, not found" apart from "never asked".
 */
export interface SessionEnvReport {
  /** The session's resolved PATH, exactly as commands will see it. */
  path: string;
  /**
   * How the latest non-interactive adoption pass established this PATH. `null`
   * when the answering process could not know — a degraded `identify` with no
   * app to ask — which is a different fact from `probe-failed` and must not
   * pose as one.
   */
  provenance: SessionEnvProvenance | null;
  /**
   * What the post-window interactive pass did to that PATH — the directories
   * a user's `.zshrc` exports and a non-interactive boot probe cannot see.
   * `null` for the same reason {@link SessionEnvReport.provenance} is: the
   * answering process never ran either pass.
   */
  interactiveProvenance: SessionEnvInteractiveProvenance | null;
  /** Where each contract tool resolves on `path`, or `null` when it does not. */
  tools: Readonly<Record<SessionEnvTool, string | null>>;
  /** Dependencies in the supplied workspace, or `null` when none was in scope. */
  dependencies: WorkspaceDependenciesStatus;
}

/** The one disk question a PATH walk needs answered. */
export interface PathResolver {
  /** Whether a path is executable — the same question a shell asks of PATH. */
  isExecutable(path: string): Promise<boolean>;
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** The directory above `path`, or `path` itself when there is none to walk into. */
function parentDirectory(path: string): string {
  const withoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = withoutSlash.lastIndexOf("/");
  if (cut === -1) return path;
  return cut === 0 ? "/" : withoutSlash.slice(0, cut);
}

/**
 * The first executable named `command` on `pathEntries` — what a shell would
 * pick, resolved without invoking one. Shared by `volli identify`'s env block
 * and `volli doctor`'s observations so the two surfaces cannot disagree about
 * what "found" means. Volli's own bin dir is deliberately NOT skipped: the
 * contract says it comes first, and a resolution that skipped it would answer
 * a different question than the shell does.
 */
export async function resolveOnPath(
  pathEntries: readonly string[],
  command: string,
  resolver: PathResolver,
): Promise<string | null> {
  for (const directory of pathEntries) {
    const candidate = joinPath(directory, command);
    if (await resolver.isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The found-or-missing verdict for every contract tool, keyed by tool name. */
export async function resolveSessionEnvTools(
  pathEntries: readonly string[],
  resolver: PathResolver,
): Promise<Record<SessionEnvTool, string | null>> {
  const tools = {} as Record<SessionEnvTool, string | null>;
  for (const tool of SESSION_ENV_TOOLS) {
    tools[tool] = await resolveOnPath(pathEntries, tool, resolver);
  }
  return tools;
}

/**
 * Whether the workspace a session stands in has its dependencies installed.
 *
 * Walks from the session cwd to the filesystem root, because a session can
 * start in a package subdirectory of a pnpm workspace: only the workspace
 * root carries `node_modules`, and only the root's answer is the truth.
 * `installed` when any manifest-bearing ancestor has its `node_modules`;
 * `absent` when one has a manifest but none has its dependencies (the
 * worktree-provisioning coin flip the contract declares); `null` when no
 * ancestor is a package workspace at all — the honest third answer for a
 * directory `pnpm install` has nothing to say about.
 */
export function workspaceDependenciesStatus(
  cwd: string,
  pathExists: (path: string) => boolean,
): WorkspaceDependenciesStatus {
  let directory = cwd;
  let sawManifest = false;
  for (;;) {
    if (pathExists(joinPath(directory, "package.json"))) {
      sawManifest = true;
      if (pathExists(joinPath(directory, "node_modules"))) return "installed";
    }
    const parent = parentDirectory(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return sawManifest ? "absent" : null;
}
