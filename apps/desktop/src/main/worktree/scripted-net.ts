/**
 * Test-only scripted `RunNet`: the async sibling of `scripted-git.ts`, for the
 * network verbs (`fetch`/`push`/`gh`). Records every invocation and delegates to
 * a handler that returns `{ stdout, stderr }` or THROWS to simulate a non-zero
 * exit / spawn failure. Not a `*.test.ts` file, so no suite collects it — the
 * net suite imports it. Use {@link netFailure} to throw a realistic execFile
 * rejection carrying `stderr` + `code` (e.g. `"ENOENT"`) for classification.
 */
import type { RunNet } from "./net";

export interface NetCall {
  file: string;
  args: readonly string[];
  cwd: string;
}

export interface ScriptedNet {
  run: RunNet;
  calls: NetCall[];
}

/**
 * A rejection shaped like Node's `execFile` failure: a real `Error` (so
 * `instanceof Error` holds) with `stdout`/`stderr`/`code` attached. `code` is a
 * number for a non-zero exit, or a string like `"ENOENT"` for a spawn failure.
 */
export function netFailure(opts: {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}): Error {
  return Object.assign(new Error(opts.stderr ?? "command failed"), opts);
}

/** Builds a recording `RunNet` from a handler (returns stdout/stderr, or throws). */
export function scriptedNet(
  handler: (
    file: string,
    args: readonly string[],
    cwd: string,
  ) => { stdout?: string; stderr?: string },
): ScriptedNet {
  const calls: NetCall[] = [];
  const run: RunNet = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    const result = handler(file, args, cwd);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
}
