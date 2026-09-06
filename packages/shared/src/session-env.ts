/**
 * The session environment contract (VC-94): what every Volli session gets on
 * `PATH`, identically, and how an agent discovers it without probing failures.
 *
 * This module holds the contract's vocabulary, in one place so the surfaces
 * that speak it cannot drift: `volli identify` reports it, `volli doctor`
 * audits it, and an agent reads either one instead of running a command and
 * learning from the failure. The shared pieces are the census of tools a
 * session's PATH is measured for, the project-implied subset it is actually
 * required to run, and the one resolution rule for what "found" means — the
 * rest of the contract (the adopted PATH, its provenance, the dependency
 * state) is reported by whoever measured it.
 *
 * Pure by design: no filesystem, no Node APIs. Callers inject the two
 * questions that touch disk (`isExecutable`, `pathExists`) so the rules stay
 * unit-testable and the seams stay visible.
 */

import { pathContains } from "./agent-surface";

/**
 * The tools a session's PATH is MEASURED for — what `volli identify` reports
 * and `volli doctor` looks up, not what a project needs. Measuring is cheap
 * (a PATH walk per name) and a measurement is never a fault on its own, so
 * the list is wide enough to answer for whichever package manager a project
 * turns out to name.
 *
 * Requiring is the other question, and it is per-project: see
 * {@link requiredSessionEnvTools}. The two were one list until VC-157, and
 * the conflation was Volli-repo bias wearing a contract's clothes — `gh` and
 * `pnpm` are how VOLLI is developed, so a Python repo or a yarn workspace
 * wore a permanent "missing tools" fault for tools it will never run. A
 * missing `gh` is still reported at the moment a PR action needs it
 * (`GhResult`'s `not-installed` / `not-authenticated`), which is where a
 * tool's absence can name a consequence.
 */
export const SESSION_ENV_TOOLS = ["git", "gh", "node", "npm", "pnpm", "yarn", "bun"] as const;

export type SessionEnvTool = (typeof SESSION_ENV_TOOLS)[number];

/**
 * The measured tools a project can actually IMPLY — the census minus `gh`.
 *
 * `gh` is absent by construction rather than by convention, so "no project
 * implies `gh`" is a fact the compiler keeps: {@link requiredSessionEnvTools}
 * cannot return it, the doctor's remedy table has no entry to reach for it,
 * and a wire payload naming it is dropped at the edge. Stated in
 * {@link SESSION_ENV_TOOLS} order, which is what lets requirement lists read
 * in census order without a second sort.
 */
export const REQUIRABLE_SESSION_ENV_TOOLS = [
  "git",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
] as const satisfies readonly SessionEnvTool[];

export type RequirableSessionEnvTool = (typeof REQUIRABLE_SESSION_ENV_TOOLS)[number];

/**
 * The package managers a JavaScript workspace can name, each of which is also
 * a {@link SessionEnvTool} — a workspace requires THE manager its lockfile
 * names and no other.
 */
export type WorkspacePackageManager = "npm" | "pnpm" | "yarn" | "bun";

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
  /** Where each measured tool resolves on `path`, or `null` when it does not. */
  tools: Readonly<Record<SessionEnvTool, string | null>>;
  /**
   * The subset of {@link tools} this project actually implies
   * ({@link requiredSessionEnvTools}) — the only names whose absence is a
   * fault. Empty when no workspace was in scope, which is the honest answer
   * for a host-wide read: a report with no project cannot imply a tool.
   */
  requiredTools: readonly RequirableSessionEnvTool[];
  /** Dependencies in the supplied workspace, or `null` when none was in scope. */
  dependencies: WorkspaceDependenciesStatus;
}

/** The one disk question a PATH walk needs answered. */
export interface PathResolver {
  /** Whether a path is executable — the same question a shell asks of PATH. */
  isExecutable(path: string): Promise<boolean>;
}

/**
 * One report's worth of `pathExists`, asked at most once per path.
 *
 * The workspace questions overlap by construction: every walk re-checks the
 * same `.git` and `package.json` on its way up, and a caller that wants the
 * requirements AND the dependency state AND the install command pays for the
 * same ancestors three times. Sharing one of these across those calls settles
 * it to a single stat per path.
 *
 * Correctness, not just cost: the answers are meant to describe ONE workspace
 * at one moment, and a memo is what guarantees they cannot straddle a change
 * on disk and disagree. Deliberately per-report and never module-level — a
 * cache that outlived the read would report a repaired workspace as broken.
 */
export function memoizedPathExists(
  pathExists: (path: string) => boolean,
): (path: string) => boolean {
  const seen = new Map<string, boolean>();
  return (path) => {
    const remembered = seen.get(path);
    if (remembered !== undefined) return remembered;
    const answer = pathExists(path);
    seen.set(path, answer);
    return answer;
  };
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** One spelling for directory comparisons: no trailing slash except at `/`. */
function normalizeDirectory(path: string): string {
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** The directory above an absolute `path`. */
function parentDirectory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** One step of a workspace walk: the directory, and whether it ended the walk. */
interface WorkspaceAncestor {
  directory: string;
  /** Whether this directory carries the `.git` marker that bounds the walk. */
  isRepositoryRoot: boolean;
}

/**
 * The ancestors a workspace question may consult: `cwd` up to and including
 * the first of two boundaries. A `.git` marker is the inner boundary (a
 * directory in a primary checkout, a file in a linked worktree), while
 * `projectRoot` is the mandatory outer boundary for a non-repository project.
 * No filesystem ancestor outside that root can answer for the project.
 *
 * When `cwd` is outside `projectRoot` — for example, `identify --project` from
 * another directory — measurement starts at the project root rather than
 * consulting the unrelated cwd. Directory spellings are normalized here so a
 * trailing slash cannot step over the boundary.
 *
 * The repository boundary is REPORTED rather than merely acted on, because
 * one caller ({@link isGitRepository}) wants the marker itself. Asking again
 * from the outside would stat every `.git` twice for one answer the walk
 * already had.
 */
function* workspaceAncestors(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): Generator<WorkspaceAncestor> {
  const root = normalizeDirectory(projectRoot);
  const start = normalizeDirectory(cwd);
  let directory = pathContains(root, start) ? start : root;
  for (;;) {
    const isRepositoryRoot = pathExists(joinPath(directory, ".git"));
    yield { directory, isRepositoryRoot };
    if (isRepositoryRoot || directory === root) return;
    directory = parentDirectory(directory);
  }
}

/**
 * The outer boundary a caller adopts when nothing registered one for it.
 *
 * Main always knows the project a measurement is scoped to and passes that
 * root itself. The CLI does not: `volli doctor` and the degraded `identify`
 * measure the directory this process happens to stand in, and the app that
 * could name its project may not even be running. Bounding those at the cwd
 * would answer a different question than the one asked — a session in
 * `packages/shared` of a pnpm monorepo would stop before the root that holds
 * the lockfile and the `node_modules`, and report npm and a missing install
 * for a workspace that has neither problem.
 *
 * So the marker decides: the enclosing repository root when `cwd` is inside a
 * checkout, `cwd` itself when no repository encloses it. `.git` keeps doing
 * the work it always did for a package subdirectory, and the folder the
 * unbounded walk used to escape — the one no repository encloses — now
 * answers only for itself instead of walking to `/`.
 *
 * A home directory that is itself a checkout still bounds the folders beneath
 * it, exactly as it did before this boundary existed. That is the residual
 * case a search for a marker cannot close and a registered root can, which is
 * why every caller that HAS a root passes it instead of calling this.
 */
export function enclosingWorkspaceRoot(cwd: string, pathExists: (path: string) => boolean): string {
  for (const { directory, isRepositoryRoot } of workspaceAncestors(cwd, "/", pathExists)) {
    if (isRepositoryRoot) return directory;
  }
  return normalizeDirectory(cwd);
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

/** The found-or-missing verdict for every measured tool, keyed by tool name. */
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
 * Walks from the session cwd up to the repository or project-root boundary
 * (see {@link workspaceAncestors}), because a session can start in a package
 * subdirectory of a pnpm workspace: the workspace root may be the only
 * ancestor that carries `node_modules`, and the root's answer is the truth.
 * `installed` when any manifest-bearing ancestor inside those boundaries has
 * its `node_modules`; `absent` when one has a manifest but none has its
 * dependencies (the worktree-provisioning coin flip the contract declares);
 * `null` when no bounded ancestor is a package workspace at all — the honest
 * third answer for a directory an install command has nothing to say about.
 */
export function workspaceDependenciesStatus(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): WorkspaceDependenciesStatus {
  let sawManifest = false;
  for (const { directory } of workspaceAncestors(cwd, projectRoot, pathExists)) {
    if (pathExists(joinPath(directory, "package.json"))) {
      sawManifest = true;
      if (pathExists(joinPath(directory, "node_modules"))) return "installed";
    }
  }
  return sawManifest ? "absent" : null;
}

/**
 * The lockfile spellings that name a workspace's package manager, checked in
 * this order beside each manifest the walk passes.
 */
const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<
  readonly [lockfile: string, manager: WorkspacePackageManager]
> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

/**
 * The package manager the workspace enclosing `cwd` names, judged by the
 * lockfile beside its manifests — the same repository-and-project-bounded walk
 * as {@link workspaceDependenciesStatus}, so every workspace answer describes
 * the same workspace. The nearest manifest's lockfile wins. `null` when no
 * ancestor is a package workspace at all; `npm` when a manifest exists but
 * no lockfile names a manager, because a bare manifest is npm's to install.
 *
 * This is the one place a project's package manager is decided: the install
 * command a user is told to run and the tool a session is required to have
 * are the same answer, so they cannot drift into telling a yarn workspace to
 * `pnpm install` (VC-94 review) or faulting it for a missing `pnpm`
 * (VC-157).
 */
export function workspacePackageManager(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): WorkspacePackageManager | null {
  let sawManifest = false;
  for (const { directory } of workspaceAncestors(cwd, projectRoot, pathExists)) {
    if (!pathExists(joinPath(directory, "package.json"))) continue;
    sawManifest = true;
    for (const [lockfile, manager] of LOCKFILE_PACKAGE_MANAGERS) {
      if (pathExists(joinPath(directory, lockfile))) return manager;
    }
  }
  return sawManifest ? "npm" : null;
}

/**
 * The command that installs the workspace enclosing `cwd`, or `null` when no
 * ancestor is a package workspace — {@link workspacePackageManager}'s answer,
 * spoken as the command a person runs.
 */
export function workspaceInstallCommand(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): string | null {
  const manager = workspacePackageManager(cwd, projectRoot, pathExists);
  return manager === null ? null : `${manager} install`;
}

/**
 * Whether `cwd` stands inside a git repository — the `.git` marker that may
 * end a workspace walk before its project-root boundary, taken from the walk
 * rather than re-statted. A file in a linked worktree, a directory in a
 * primary checkout; existence is the test either way.
 *
 * Module-private: the repository question reaches the outside world as part
 * of {@link requiredSessionEnvTools}'s answer, and a second exported spelling
 * of it would be one more thing to keep in step.
 */
function isGitRepository(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): boolean {
  for (const { isRepositoryRoot } of workspaceAncestors(cwd, projectRoot, pathExists)) {
    if (isRepositoryRoot) return true;
  }
  return false;
}

/**
 * What each package manager implies about the runtime beside it.
 *
 * npm, pnpm and yarn are Node programs: a workspace that names one cannot be
 * installed without `node`, so both are required. Bun is its own runtime and
 * ships its own installer, so a bun workspace implies `bun` alone — telling a
 * bun-only host it is missing `node` would be the same false fault, wearing a
 * different name, that VC-157 exists to delete.
 */
const MANAGER_IMPLICATIONS: Record<WorkspacePackageManager, readonly RequirableSessionEnvTool[]> = {
  npm: ["node", "npm"],
  pnpm: ["node", "pnpm"],
  yarn: ["node", "yarn"],
  bun: ["bun"],
};

/**
 * The tools this project implies, and therefore the only ones whose absence
 * from the Session PATH is a fault (VC-157).
 *
 * Every entry is earned by something on disk: `git` by the repository the
 * folder is, a runtime and one package manager by the manifest and lockfile a
 * JavaScript workspace carries. Nothing is required by Volli's own habits —
 * a Go repo implies `git` and nothing else, a yarn workspace implies `yarn`
 * and never `pnpm`, and no project implies `gh`, whose absence is classified
 * where it has a consequence: the moment a PR action runs.
 *
 * Returned in {@link REQUIRABLE_SESSION_ENV_TOOLS} order — the census order —
 * so two callers listing the same project's requirements produce the same
 * sentence.
 */
export function requiredSessionEnvTools(
  cwd: string,
  projectRoot: string,
  pathExists: (path: string) => boolean,
): readonly RequirableSessionEnvTool[] {
  const required = new Set<RequirableSessionEnvTool>();
  if (isGitRepository(cwd, projectRoot, pathExists)) required.add("git");
  const manager = workspacePackageManager(cwd, projectRoot, pathExists);
  if (manager !== null) {
    for (const implied of MANAGER_IMPLICATIONS[manager]) required.add(implied);
  }
  return REQUIRABLE_SESSION_ENV_TOOLS.filter((tool) => required.has(tool));
}
