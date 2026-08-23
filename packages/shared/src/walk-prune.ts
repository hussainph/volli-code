/**
 * The directory names a filesystem walk may skip without looking inside
 * (VC-160).
 *
 * Every walk Volli runs over a user's project — the worktree copy step's
 * `.worktreeinclude` walk, the file index's fallback walk, the Project Files
 * directory watcher — used to name `node_modules` and nothing else, because
 * the checkout the walks were first measured against was this repository. The
 * cost that taught the lesson (VC-16's rainbow wheel: a synchronous walk of a
 * large `node_modules`) is not a JS cost. It is what a walk pays for any
 * ecosystem's dependency or build tree, and a Python, Rust, Go, Ruby or JVM
 * project pays it in full for a list written from ours.
 *
 * MEMBERSHIP RULE, so this stays a short list rather than a general ignore
 * file: a name belongs here only when its contents are, by construction,
 * generated or fetched rather than authored — a package manager or a build
 * wrote them, and re-running that command reproduces them. A directory that is
 * merely large is still walked. That rule is what lets every consumer skip the
 * name without asking the user, and it is why `dist`, `build`, `out` and
 * `.next` are deliberately ABSENT: each is an ordinary source directory name
 * in some repository, and guessing wrong would silently hide a file someone
 * wrote.
 *
 * Not a substitute for `.gitignore`. Where git is usable it already answers
 * this question better (the file index asks `git ls-files` first, and only
 * falls back to a walk when git cannot answer); this is the constant table for
 * the walks that have no repository to ask.
 */

/**
 * Dependency and build-output directories, by ecosystem. Sorted for reading,
 * not for lookup — every consumer builds its own `Set` (or prefix list) from
 * this, usually adding names of its own.
 *
 * Each consumer keeps its own escape hatch: a `.worktreeinclude` line naming
 * one of these puts it back for the copy walk, and the file index prefers
 * `git ls-files` over the walk that reads this list at all.
 */
export const DEPENDENCY_AND_BUILD_DIRS = [
  /** Ruby: bundler's vendored gems and its local config. */
  ".bundle",
  /** JVM: Gradle's per-project caches and build state. */
  ".gradle",
  /** Python: tox's generated per-environment virtualenvs. */
  ".tox",
  /** Python: the conventional in-project virtualenv, both spellings. */
  ".venv",
  "venv",
  /** Python: compiled bytecode, written beside every module it mirrors. */
  "__pycache__",
  /** JS: the original member, and still the heaviest one on this repo. */
  "node_modules",
  /** Rust and Maven: build output, and the one that grows fastest of all. */
  "target",
  /** Go, PHP (composer), Ruby: fetched third-party source. */
  "vendor",
] as const;

export type DependencyOrBuildDir = (typeof DEPENDENCY_AND_BUILD_DIRS)[number];
