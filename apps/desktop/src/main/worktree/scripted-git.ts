/**
 * Test-only scripted `RunGit`: records every invocation and delegates to a
 * handler the test supplies (which returns stdout or throws to simulate a
 * non-zero git exit). Not a `*.test.ts` file, so the main test project never
 * treats it as a suite — it's imported BY the worktree suites. Kept next to the
 * module so the injected-git seam every pipeline step relies on is exercised
 * with a fake, never real git.
 */
import type { RunGit, RunGitAsync } from "./types";

export interface GitCall {
  args: readonly string[];
  cwd: string;
}

export interface ScriptedGit {
  git: RunGit;
  /**
   * The same scripted handler behind the async runner seam, for the verbs that
   * moved off `execFileSync` (change-set.ts). Suites keep scripting one
   * synchronous handler; a `throw` becomes a rejection.
   */
  gitAsync: RunGitAsync;
  /**
   * Every call through either seam, in observed order. This stays shared because
   * existing suites assert command ordering across a whole operation; the two
   * per-seam lists below add the VC-383 assertion without breaking that evidence.
   */
  calls: GitCall[];
  /** Calls that reached the synchronous runner only. */
  syncCalls: GitCall[];
  /** Calls that reached the asynchronous runner only. */
  asyncCalls: GitCall[];
  /** Count of recorded calls whose args start with `prefix`. */
  countMatching: (prefix: readonly string[]) => number;
}

/**
 * Builds a recording `RunGit` from a handler. The handler receives the args and
 * cwd; return a string to act as stdout, or `throw` (optionally a
 * {@link import("./git").GitError}) to simulate failure.
 */
export function scriptedGit(
  handler: (args: readonly string[], cwd: string) => string,
): ScriptedGit {
  const calls: GitCall[] = [];
  const syncCalls: GitCall[] = [];
  const asyncCalls: GitCall[] = [];
  const git: RunGit = (args, cwd) => {
    const call = { args, cwd };
    calls.push(call);
    syncCalls.push(call);
    return handler(args, cwd);
  };
  const gitAsync: RunGitAsync = async (args, cwd) => {
    const call = { args, cwd };
    calls.push(call);
    asyncCalls.push(call);
    return handler(args, cwd);
  };
  return {
    git,
    gitAsync,
    calls,
    syncCalls,
    asyncCalls,
    countMatching: (prefix) =>
      calls.filter((call) => prefix.every((token, i) => call.args[i] === token)).length,
  };
}
