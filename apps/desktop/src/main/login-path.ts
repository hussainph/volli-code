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
 * Resolving it costs a shell spawn, so a successful answer is cached for the
 * launch. A failure is not: it is reported as `null` and never as an empty PATH
 * ("we could not ask" and "there is nothing there" lead to opposite decisions
 * downstream), and caching that `null` would turn one slow profile at boot into
 * an app that believes detection is impossible until it is restarted.
 */
import { spawn } from "node:child_process";

import { resolveShell } from "@volli/shared";

/**
 * Generous next to a shell's own startup, tight next to a boot. A profile that
 * hangs (a stalled version manager, a network mount) costs this much once and
 * then leaves detection reporting that it could not run — once, and not for the
 * rest of the launch, which is what makes probing an interactive shell at all
 * safe: see {@link loginShellPath}.
 */
const SHELL_TIMEOUT_MS = 3000;

/** What a profile that spews can cost in memory before we stop listening. */
const MAX_OUTPUT_BYTES = 1 << 20;

/**
 * The PTY is an INTERACTIVE login shell — `resolveShell` spawns `$SHELL -l`
 * onto a tty, and a tty on stdin is what makes zsh interactive. A plain `-lc`
 * is login but not interactive, and zsh reads `.zshrc` only in the interactive
 * case: measured against a probe `ZDOTDIR`, a PATH entry added in `.zshrc` is
 * invisible to `-lc` and present under `-lic`. That is where a great many
 * people install their toolchain, so detecting without `-i` means a harness the
 * user can plainly type is missing from detection, from wrapper generation and
 * from the hooks that follow — the exact failure this module exists to avoid.
 */
const INTERACTIVE_FLAG = "-i";

/**
 * `printenv` rather than an `echo $PATH`: it prints what the shell *exports* to
 * a child process, which is the colon-joined string every harness lookup wants,
 * and it is the one spelling that survives fish — where `$PATH` is a list and
 * `echo` would join it with spaces.
 *
 * The marker is what makes the answer findable in an interactive shell's
 * chatter. A profile is allowed to talk, and an interactive one talks on BOTH
 * sides of us — a `TRAPEXIT` or a job-control warning prints after `printenv`
 * has already run, which a "last non-empty line" read would happily return as
 * the user's PATH. Printed without a trailing newline, so the value follows on
 * the same line and no amount of noise around it can be mistaken for it.
 */
const PATH_MARKER = "__VOLLI_PATH__";
const PRINT_PATH_COMMAND = `printf ${PATH_MARKER}; printenv PATH`;

export interface LoginShellDeps {
  env: Record<string, string | undefined>;
  /** Runs the shell and resolves its stdout. Rejects exactly as `execFile` does. */
  runShell(file: string, args: readonly string[]): Promise<string>;
}

/**
 * Runs the shell and returns whatever it printed. Spawned rather than
 * `execFile`d, because with `-i` the file being read is the user's `.zshrc`, and
 * a `.zshrc` does things that are ordinary in a terminal and hostile in a probe.
 * Both hazards were measured, and both are worse than the timeout they look
 * like:
 *
 * **stdin is `/dev/null`, never a pipe.** An rc that reads stdin — a prompt
 * framework asking a question, a version manager confirming an install — blocks
 * on a pipe nothing will ever write to. `execFile` leaves one open: the same rc
 * answers in 200ms against `/dev/null`.
 *
 * **The timeout kills the process GROUP.** A killed shell whose profile left a
 * foreground command running (`sleep`, `exec tmux`) does not end the read: the
 * grandchild inherits the stdout pipe and holds it open, so the call never
 * completes at all — a hang with no timeout, and a stray process per launch.
 * `detached` puts the shell in its own group; killing the group takes down
 * whatever the profile started along with it.
 *
 * A nonzero exit is not treated as a failure. What the shell printed before it
 * left is what the marker vouches for, and a login shell exiting nonzero is
 * ordinary; only an unusable answer becomes `null`, one level up.
 */
async function runLoginShell(file: string, args: readonly string[]): Promise<string> {
  const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length < MAX_OUTPUT_BYTES) output += chunk;
  });
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the kill was after.
    }
  }, SHELL_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      // `close`, not `exit`: the pipe outliving the shell is the whole hazard,
      // so the read is done when nothing is holding it any more.
      child.once("close", () => resolve());
    });
  } finally {
    clearTimeout(timer);
  }
  return output;
}

function processDeps(): LoginShellDeps {
  return { env: process.env, runShell: runLoginShell };
}

/**
 * An interactive shell may put escape sequences on its own stream, and a PATH
 * contains none. A value carrying one was written by something other than our
 * `printf`, and "we could not ask" is the honest report for it — the retry that
 * failure now earns is a better answer than a plausible, wrong PATH.
 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * The PATH out of one shell's output. The LAST marked line wins: a shell run
 * with `xtrace` echoes the command itself — marker and all — before running it,
 * and the echo necessarily precedes the run.
 */
function parseMarkedPath(stdout: string): string | null {
  const value = stdout
    .split("\n")
    .filter((line) => line.includes(PATH_MARKER))
    .map((line) => line.slice(line.lastIndexOf(PATH_MARKER) + PATH_MARKER.length).trim())
    .findLast((line) => line.length > 0);
  return value === undefined || hasControlCharacter(value) ? null : value;
}

/** Asks one login shell for its exported PATH. `null` when it could not answer. */
export async function readLoginShellPath(deps: LoginShellDeps): Promise<string | null> {
  const { file, args } = resolveShell(deps.env);
  let stdout: string;
  try {
    stdout = await deps.runShell(file, [...args, INTERACTIVE_FLAG, "-c", PRINT_PATH_COMMAND]);
  } catch {
    // A missing shell, a profile that exits nonzero, a startup that timed out.
    return null;
  }
  return parseMarkedPath(stdout);
}

let cached: Promise<string | null> | undefined;

/**
 * The login shell's PATH, resolved once per launch. Detection runs on the boot
 * path and again on every skill refresh, and none of them should pay for a
 * second shell startup.
 *
 * An ANSWER is what is cached — never a failure. A profile that hangs once past
 * {@link SHELL_TIMEOUT_MS} at boot is a transient, and latching its `null` would
 * make it permanent: detection stays unanswerable, the adapter census stays
 * `partial`, no stale wrapper is ever reconciled, and `volli doctor --fix`
 * cannot repair it because repair re-asks the same latched cache. Only quitting
 * the app would. So a failed attempt drops itself and the next caller pays for
 * one more shell — the cost of a retry, against an app that is wrong until it
 * is restarted.
 *
 * The retry is also what makes probing an INTERACTIVE shell safe to ship, so
 * the two are not separable: `-i` runs the user's `.zshrc`, and an rc file that
 * wedges the probe is now a boot that costs three seconds rather than a launch
 * that never detects anything again. Removing this as redundant would put that
 * back.
 *
 * In-flight attempts are still shared, so the boot fan-out spawns one shell and
 * not five.
 */
export function loginShellPath(deps: LoginShellDeps = processDeps()): Promise<string | null> {
  if (cached !== undefined) return cached;
  const attempt = readLoginShellPath(deps);
  cached = attempt;
  // Compared by identity, so a `reset` (or a retry that already started) is
  // never clobbered by a straggler resolving late.
  const forget = (): void => {
    if (cached === attempt) cached = undefined;
  };
  void attempt.then((value) => {
    if (value === null) forget();
  }, forget);
  return attempt;
}

/**
 * Drops the per-launch cache so the next call resolves against a fresh shell.
 * Called by tests, and by `ensureUserBinOnPath` (agent-tools.ts) the moment it
 * writes the PATH block into `~/.zprofile` — the cached answer was measured
 * against the profile as it was BEFORE that write, and holding it would leave
 * every later reader (the Settings → CLI pane's Login PATH row above all)
 * describing a shell that no longer exists.
 */
export function resetLoginShellPathCache(): void {
  cached = undefined;
}
