/**
 * The PATH the user actually has, as opposed to the one Electron was handed.
 *
 * A macOS app opened from Finder or the Dock inherits launchd's environment —
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every coding agent worth
 * detecting installs somewhere else (`/opt/homebrew/bin`, `~/.local/bin`,
 * `~/.bun/bin`), so `process.env.PATH` in main is a launcher accident rather
 * than a fact about the host: it is right under `pnpm dev`, where a terminal
 * exported the login shell's environment, and wrong in every real install.
 *
 * The login shell is the authority, and it is the same authority the PTYs
 * already use — {@link resolveShell} picks the shell a terminal session spawns,
 * and this asks that exact shell what it exports. A harness Volli detects is
 * therefore a harness the session PTY could actually run, which is the only
 * question detection is asking.
 *
 * Resolving it costs a shell spawn, so the answer is cached for the launch.
 * Failure is reported as `null` and never as an empty PATH: "we could not ask"
 * and "there is nothing there" lead to opposite decisions downstream.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveShell } from "@volli/shared";

const execFileAsync = promisify(execFile);

/**
 * Generous next to a shell's own startup, tight next to a boot. A profile that
 * hangs (a stalled version manager, a network mount) costs this much once and
 * then leaves detection reporting that it could not run.
 */
const SHELL_TIMEOUT_MS = 3000;

/**
 * `printenv` rather than an `echo $PATH`: it prints what the shell *exports* to
 * a child process, which is the colon-joined string every harness lookup wants,
 * and it is the one spelling that survives fish — where `$PATH` is a list and
 * `echo` would join it with spaces.
 */
const PRINT_PATH_COMMAND = "printenv PATH";

export interface LoginShellDeps {
  env: Record<string, string | undefined>;
  /** Runs the shell and resolves its stdout. Rejects exactly as `execFile` does. */
  runShell(file: string, args: readonly string[]): Promise<string>;
}

async function runLoginShell(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: SHELL_TIMEOUT_MS,
    encoding: "utf8",
  });
  return stdout;
}

function processDeps(): LoginShellDeps {
  return { env: process.env, runShell: runLoginShell };
}

/** Asks one login shell for its exported PATH. `null` when it could not answer. */
export async function readLoginShellPath(deps: LoginShellDeps): Promise<string | null> {
  const { file, args } = resolveShell(deps.env);
  let stdout: string;
  try {
    stdout = await deps.runShell(file, [...args, "-c", PRINT_PATH_COMMAND]);
  } catch {
    // A missing shell, a profile that exits nonzero, a startup that timed out.
    return null;
  }
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}

let cached: Promise<string | null> | undefined;

/**
 * The login shell's PATH, resolved once per launch. Detection runs on the boot
 * path and again on every skill refresh, and none of them should pay for a
 * second shell startup.
 */
export function loginShellPath(deps: LoginShellDeps = processDeps()): Promise<string | null> {
  cached ??= readLoginShellPath(deps);
  return cached;
}

/** Test seam: drops the per-launch cache so the next call resolves again. */
export function resetLoginShellPathCache(): void {
  cached = undefined;
}
