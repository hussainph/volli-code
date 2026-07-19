/**
 * Test-only scripted `RunGit`: records every invocation and delegates to a
 * handler the test supplies (which returns stdout or throws to simulate a
 * non-zero git exit). Not a `*.test.ts` file, so the main test project never
 * treats it as a suite — it's imported BY the worktree suites. Kept next to the
 * module so the injected-git seam every pipeline step relies on is exercised
 * with a fake, never real git.
 */
import type { RunGit } from "./types";

export interface GitCall {
  args: readonly string[];
  cwd: string;
}

export interface ScriptedGit {
  git: RunGit;
  calls: GitCall[];
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
  const git: RunGit = (args, cwd) => {
    calls.push({ args, cwd });
    return handler(args, cwd);
  };
  return {
    git,
    calls,
    countMatching: (prefix) =>
      calls.filter((call) => prefix.every((token, i) => call.args[i] === token)).length,
  };
}
