/**
 * One Session's share of the machine, said in the variables toolchains already
 * read (VC-339).
 *
 * Every heavy build tool defaults its parallelism to the core count, and every
 * one of them assumes it is the only thing running. That assumption is false
 * on the machine Volli is used on: a load audit on an 8-core, 16 GB M1 with
 * ~16 working Sessions found three concurrent `vp test` runs holding 19 vitest
 * workers between them, beside a `--coverage` runner at 1.5 GB — on a host
 * whose Sessions, app and browsers already exceeded physical RAM. Nothing was
 * misconfigured; each invocation simply took the whole machine because nobody
 * had told it otherwise.
 *
 * Volli is the only party that knows how many Sessions are working, so Volli
 * does the telling — in the environment, at Session start, in the spelling
 * each toolchain already honours. That is what makes this work for a Rust,
 * Python, Go or C++ Session with no Volli-specific cooperation from the agent
 * at all: `cargo test` reads `CARGO_BUILD_JOBS` whether or not the model
 * knows the variable exists.
 *
 * Pure by design — no `node:os`, no `process.env` — so the rules are unit
 * testable against a stated environment. Who counts the Sessions and who reads
 * the core count lives with the caller
 * (`apps/desktop/src/main/session-concurrency.ts`).
 */

/**
 * Volli's own name for the budget, and the one an agent is told about: the
 * prompt baseline points at it for the tools that read no environment at all
 * (Jest wants `--maxWorkers=$VOLLI_CONCURRENCY_HINT` on the command line).
 *
 * Part of the Session contract that a nested Volli must not inherit — it is
 * scrubbed with `VOLLI_SESSION` and its siblings, so a Volli launched from
 * inside another Volli's terminal recomputes the budget rather than exporting
 * a stale one forever.
 */
export const VOLLI_CONCURRENCY_HINT_ENV = "VOLLI_CONCURRENCY_HINT";

/**
 * How many parallel jobs one Session may assume it has:
 * `max(1, floor(cores / max(1, workingSessions)))`.
 *
 * Deliberately arithmetic rather than adaptive. A scheduler that measured load
 * would be better and is not what this is: the number has to be decided once,
 * before the Session's first command, and be the same answer every tool gets.
 * `workingSessions` is the count of OTHER Sessions working — a Session alone
 * on the machine divides by one and gets every core, which is exactly the
 * behaviour every one of these tools already has by default.
 *
 * Both inputs are clamped rather than trusted: a core count of 0 (or NaN, from
 * a host API that failed) would otherwise produce a budget of 0 and stop a
 * toolchain dead, which is far worse than the over-subscription this exists to
 * prevent. Fractions are floored; the answer is never below 1.
 */
export function concurrencyBudget(cores: number, workingSessions: number): number {
  const usableCores = clampToPositiveInteger(cores);
  const sharers = clampToPositiveInteger(workingSessions);
  return Math.max(1, Math.floor(usableCores / sharers));
}

/** A finite integer ≥ 1, whatever a host API or a caller's arithmetic said. */
function clampToPositiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * How a budget of N is spelled for one toolchain: the variable, and the value
 * it wants N wrapped in.
 *
 * Flag-carrying variables (`MAKEFLAGS`, `GOFLAGS`, `GRADLE_OPTS`) are all-or-
 * nothing by construction — see {@link concurrencyBudgetEnv}. That is the
 * whole reason this table stores a formatter instead of a bare name.
 */
interface BudgetVariable {
  name: string;
  format(budget: number): string;
}

const plain = (name: string): BudgetVariable => ({ name, format: (budget) => String(budget) });

/**
 * Every variable the budget is written into, and who honours it.
 *
 * `GOMAXPROCS` is deliberately absent although the ticket's table names it
 * beside `GOFLAGS`. It caps the OS threads of EVERY Go program the Session
 * runs, not the parallelism of a build — including tools that merely happen to
 * be written in Go (`gh`, `terraform`), whose runtime has nothing to do with
 * this machine's build load. `GOFLAGS=-p=N` is the build/test knob and is the
 * one set here.
 *
 * Jest is absent for the opposite reason: it reads no environment variable at
 * all. Inventing a wrapper for it would put Volli in the business of rewriting
 * command lines; the prompt baseline documents `--maxWorkers=$VOLLI_CONCURRENCY_HINT`
 * instead.
 */
const BUDGET_VARIABLES: readonly BudgetVariable[] = [
  // Volli's own hint, first so it reads as the source the rest are derived from.
  plain(VOLLI_CONCURRENCY_HINT_ENV),
  // vitest, applied AFTER config resolution — it beats both a config value and
  // a `--maxWorkers` flag, which is what lets a busy machine lower a repo's
  // own cap without touching the repo.
  plain("VITEST_MAX_WORKERS"),
  // cargo build / cargo test.
  plain("CARGO_BUILD_JOBS"),
  // cmake --build.
  plain("CMAKE_BUILD_PARALLEL_LEVEL"),
  // pytest -n auto (pytest-xdist).
  plain("PYTEST_XDIST_AUTO_NUM_WORKERS"),
  // libuv's thread pool — Node's own file and DNS work, which every Node tool
  // in the Session shares.
  plain("UV_THREADPOOL_SIZE"),
  // make, and through it most C/C++ builds. `-j<N>` with no space, the spelling
  // make itself writes into MAKEFLAGS for its sub-makes.
  { name: "MAKEFLAGS", format: (budget) => `-j${budget}` },
  // go build / go test: `-p` is the number of packages built in parallel.
  { name: "GOFLAGS", format: (budget) => `-p=${budget}` },
  // gradle's worker count.
  { name: "GRADLE_OPTS", format: (budget) => `-Dorg.gradle.workers.max=${budget}` },
];

/**
 * The budget as environment entries, for every variable the surrounding
 * environment does not already define.
 *
 * **Volli fills gaps; it never clobbers.** A user who exports `MAKEFLAGS=-j16`
 * in their `.zshrc` has said something about their machine that outranks
 * anything derived here, and the same goes for a project's own `CARGO_BUILD_JOBS`.
 * So `existing` — the environment the Session is about to be handed — is
 * consulted for every name, and a name already in it is skipped.
 *
 * Skipped ENTIRELY, never merged, and that matters most for the three
 * flag-carrying variables: `MAKEFLAGS`, `GOFLAGS` and `GRADLE_OPTS` are
 * command lines, not numbers. Appending `-j2` to a user's `MAKEFLAGS` would
 * silently change what their other flags mean and could contradict a `-j` they
 * already wrote; splicing a `-p=` into `GOFLAGS` means parsing Go's flag
 * grammar. A variable the user has touched is theirs.
 *
 * A defined-but-EMPTY value counts as undefined, because that is how the tools
 * themselves read it: vitest gates on `if (process.env.VITEST_MAX_WORKERS)`, so
 * an exported empty string is not a value anyone acts on, and treating it as
 * one would leave a Session with a budget nothing honours.
 */
export function concurrencyBudgetEnv(
  budget: number,
  existing: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const value = Math.max(1, Math.floor(budget));
  const entries: Record<string, string> = {};
  for (const variable of BUDGET_VARIABLES) {
    const already = existing[variable.name];
    if (already !== undefined && already.length > 0) continue;
    entries[variable.name] = variable.format(value);
  }
  return entries;
}
